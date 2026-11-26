import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { allowedPath, apply, collect, lastBackup, pack, pieces, recordBackup, unpack } from "../src/backup.js";

function dataDir(): string {
  const d = mkdtempSync(join(tmpdir(), "hcm-backup-"));
  const put = (p: string, s: string) => {
    mkdirSync(join(d, ...p.split("/").slice(0, -1)), { recursive: true });
    writeFileSync(join(d, ...p.split("/")), s);
  };
  put("matter-server/server-1-fff1/snapshot.json.gz", "fabric");
  put("matter-server/server-1-fff1/wal/0001.jsonl", "wal");
  put("matter-server/server-1-fff1/matter.lock", "lock");
  put("matter-server/vendors/snapshot.json.gz", "cache");
  put("matter-server/certificates/snapshot.json.gz", "cache");
  put("bridge/homecore-bridge/snapshot.json.gz", "bridge fabric");
  put("bridge.json", "{}");
  put("matter-server.sock", "");
  put(".published-device-ids.json", "[]");
  return d;
}

describe("a backup", () => {
  it("holds the pairings and not the caches, locks or anything else", () => {
    expect(Object.keys(collect(dataDir())).sort()).toEqual([
      "bridge.json",
      "bridge/homecore-bridge/snapshot.json.gz",
      "matter-server/server-1-fff1/snapshot.json.gz",
      "matter-server/server-1-fff1/wal/0001.jsonl",
    ]);
  });

  it("comes back as it went", () => {
    const files = collect(dataDir());
    const { backup, files: back } = unpack(pack(files, "0.1.3", new Date("2026-11-26T00:00:00Z")));
    expect(backup).toMatchObject({ format: "hc-matter-backup", version: 1, plugin_version: "0.1.3", created: "2026-11-26T00:00:00.000Z" });
    expect(Object.fromEntries(Object.entries(back).map(([k, v]) => [k, v.toString()]))).toEqual(
      Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v.toString()])));
  });

  it("refuses what isn't one, a newer format, and paths that leave the folder", () => {
    const wrap = (o: object) => gzipSync(Buffer.from(JSON.stringify(o)));
    expect(() => unpack(Buffer.from("nope"))).toThrow(/doesn't unpack/);
    expect(() => unpack(wrap({ format: "other" }))).toThrow(/isn't an hc-matter backup/);
    expect(() => unpack(wrap({ format: "hc-matter-backup", version: 9, files: {} }))).toThrow(/newer hc-matter/);
    expect(() => unpack(wrap({ format: "hc-matter-backup", version: 1, files: { "matter-server/../../etc/x": "" } }))).toThrow(/may not/);
    expect(() => unpack(wrap({ format: "hc-matter-backup", version: 1, files: { "bridge.json": "" } }))).toThrow(/no controller pairings/);
    for (const bad of ["/etc/passwd", "matter-server/../x", "x/y", "matter-server", "matter-server/vendors/a", "bridge/a/matter.pid", "a\\b"]) {
      expect(allowedPath(bad), bad).toBe(false);
    }
  });

  it("is restored over what is there, which is kept aside, not deleted", () => {
    const from = dataDir();
    const files = collect(from);
    const to = mkdtempSync(join(tmpdir(), "hcm-restore-"));
    mkdirSync(join(to, "matter-server", "old"), { recursive: true });
    writeFileSync(join(to, "matter-server", "old", "f"), "old");
    const aside = apply(to, files, new Date("2026-11-26T01:02:03Z"));
    expect(readFileSync(join(to, "matter-server/server-1-fff1/snapshot.json.gz"), "utf8")).toBe("fabric");
    expect(existsSync(join(to, "matter-server", "old"))).toBe(false);
    expect(readFileSync(join(aside, "matter-server", "old", "f"), "utf8")).toBe("old");
    expect(aside).toMatch(/before-restore-2026-11-26T01-02-03-000Z$/);
  });

  it("travels in pieces the broker takes, and remembers when it was made", () => {
    const big = Buffer.alloc(300 * 1024, 7);
    const ps = pieces(big);
    expect(ps.length).toBe(5);
    expect(Math.max(...ps.map((p) => p.length))).toBeLessThanOrEqual(96 * 1024);
    expect(Buffer.from(ps.join(""), "base64").equals(big)).toBe(true);
    const d = dataDir();
    expect(lastBackup(d)).toBeNull();
    recordBackup(d, new Date("2026-11-26T00:00:00Z"));
    expect(lastBackup(d)).toBe("2026-11-26T00:00:00.000Z");
  });
});
