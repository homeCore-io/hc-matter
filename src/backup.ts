// Backing up and restoring the pairings.
//
// Everything a paired device trusts lives in the plugin's data folder on the
// runtime, which homeCore's own backup does not hold. Lose that folder and
// every device must be paired again, and the bridge in every app. A backup is
// one file the admin keeps: the controller's storage and the bridge's, without
// what can be fetched again (the CSA's vendor list and certificates, firmware
// images) or lock files.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

export const FORMAT = "hc-matter-backup";
export const FORMAT_VERSION = 1;

/** What a backup holds, under the data folder. */
const ROOTS = ["matter-server", "bridge", "bridge.json"];
/** Caches and run-time files inside those, by path part. */
const SKIP_DIRS = new Set(["vendors", "certificates", "ota"]);
const SKIP_FILES = new Set(["matter.lock", "matter.pid"]);

export interface Backup {
  format: typeof FORMAT;
  version: number;
  created: string;
  plugin_version: string;
  /** Path under the data folder → contents, base64. */
  files: Record<string, string>;
}

/** Whether a path inside a backup may be written: under a root, no way out. */
export function allowedPath(p: string): boolean {
  if (!p || p.startsWith("/") || p.includes("\\") || p.includes("\0")) return false;
  const parts = p.split("/");
  if (parts.some((x) => x === "" || x === "." || x === "..")) return false;
  if (!ROOTS.includes(parts[0])) return false;
  if (parts.length === 1) return parts[0] === "bridge.json";
  return !parts.some((x) => SKIP_DIRS.has(x)) && !SKIP_FILES.has(parts[parts.length - 1]);
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (st.isFile()) out.push(full);
  }
}

/** The files a backup of `dataDir` holds, by path under it. */
export function collect(dataDir: string): Record<string, Buffer> {
  const out: Record<string, Buffer> = {};
  for (const root of ROOTS) {
    const at = join(dataDir, root);
    if (!existsSync(at)) continue;
    const files: string[] = [];
    if (statSync(at).isDirectory()) walk(at, files);
    else files.push(at);
    for (const f of files) {
      const rel = relative(dataDir, f).split(sep).join("/");
      if (allowedPath(rel)) out[rel] = readFileSync(f);
    }
  }
  return out;
}

export function pack(files: Record<string, Buffer>, pluginVersion: string, now = new Date()): Buffer {
  const backup: Backup = {
    format: FORMAT,
    version: FORMAT_VERSION,
    created: now.toISOString(),
    plugin_version: pluginVersion,
    files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v.toString("base64")])),
  };
  return gzipSync(Buffer.from(JSON.stringify(backup)));
}

/** A backup file's contents, checked; throws saying what is wrong with it. */
export function unpack(file: Buffer): { backup: Backup; files: Record<string, Buffer> } {
  let backup: Backup;
  try {
    backup = JSON.parse(gunzipSync(file).toString("utf8"));
  } catch {
    throw new Error("That isn't an hc-matter backup (it doesn't unpack).");
  }
  if (backup?.format !== FORMAT) throw new Error("That isn't an hc-matter backup.");
  if (backup.version > FORMAT_VERSION) throw new Error(`That backup is from a newer hc-matter (format ${backup.version}); update the plugin first.`);
  const files: Record<string, Buffer> = {};
  for (const [p, b64] of Object.entries(backup.files ?? {})) {
    if (!allowedPath(p)) throw new Error(`That backup names a file it may not: ${p}`);
    files[p] = Buffer.from(String(b64), "base64");
  }
  if (!Object.keys(files).some((p) => p.startsWith("matter-server/"))) {
    throw new Error("That backup holds no controller pairings.");
  }
  return { backup, files };
}

/**
 * Put a backup's files in place, after moving what is there now aside (to
 * `before-restore-<time>/`, never deleted here). Returns where the old data went.
 */
export function apply(dataDir: string, files: Record<string, Buffer>, now = new Date()): string {
  const aside = join(dataDir, `before-restore-${now.toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(aside, { recursive: true, mode: 0o700 });
  for (const root of ROOTS) {
    const at = join(dataDir, root);
    if (existsSync(at)) renameSync(at, join(aside, root));
  }
  for (const [p, data] of Object.entries(files)) {
    const to = join(dataDir, ...p.split("/"));
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
    writeFileSync(to, data, { mode: 0o600 });
  }
  return aside;
}

/** Pieces of a file small enough for one stream event each (the broker takes 256 KiB a message). */
export function pieces(data: Buffer, size = 96 * 1024): string[] {
  const b64 = data.toString("base64");
  const out: string[] = [];
  for (let i = 0; i < b64.length; i += size) out.push(b64.slice(i, i + size));
  return out.length ? out : [""];
}

export function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** When the last backup was made, kept beside the data. */
export function lastBackup(dataDir: string): string | null {
  try {
    return JSON.parse(readFileSync(join(dataDir, "backup.json"), "utf8")).last ?? null;
  } catch {
    return null;
  }
}

export function recordBackup(dataDir: string, when = new Date()): void {
  writeFileSync(join(dataDir, "backup.json"), JSON.stringify({ last: when.toISOString() }), { mode: 0o600 });
}
