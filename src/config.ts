// The plugin's config file: homeCore's [homecore] table, and its own [matter].
//
//   [matter]
//   fabric_label       = "homeCore"   # how this controller appears in other apps' fabric lists
//   log_level          = "info"       # matter-server's own: debug, info, warn, error
//   primary_interface  = ""           # the network interface for IPv6 link-local, when there are several
//   allow_test_devices = false        # trust Matter test certificates (stand-ins, devkits); never needed for products
//   dcl_offline        = false        # never ask the CSA's DCL about certificates; only what is bundled and stored
//   thread_diagnostics = true         # find Thread border routers and read their diagnostics
//   firmware_updates   = true         # check for and offer device firmware (OTA) updates
//   storage_dir        = ""           # where the fabric and paired devices are kept; default below
//
// The fabric (the keys every paired device trusts) lives in storage_dir. It
// is kept beside the plugin's installed versions, so upgrades and rollbacks
// keep it; losing it means pairing every device again.

import { readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { parse } from "smol-toml";

export const PLUGIN_ID = "plugin.matter";

export interface HomecoreSettings {
  brokerHost: string;
  brokerPort: number;
  pluginId: string;
  password?: string;
}

export interface MatterSettings {
  storageDir: string;
  socketPath: string;
  fabricLabel: string;
  serverLogLevel: "debug" | "info" | "warn" | "error";
  primaryInterface: string | null;
  allowTestDevices: boolean;
  dclOffline: boolean;
  threadDiagnostics: boolean;
  firmwareUpdates: boolean;
}

export interface Config {
  path: string;
  homecore: HomecoreSettings;
  matter: MatterSettings;
}

/**
 * The plugin's own data directory. Under a plugin runtime the config is
 * `<root>/plugins/<id>/<version>/config.toml`, and `<root>/plugins/<id>/data`
 * outlives every version. Run by hand, it is `data/` beside the config.
 */
export function dataDirFor(configPath: string, pluginId: string): string {
  const versionDir = dirname(resolve(configPath));
  const pluginDir = dirname(versionDir);
  if (basename(pluginDir) === pluginId && basename(versionDir)) return join(pluginDir, "data");
  return join(versionDir, "data");
}

/** A unix socket path must fit in sun_path (108 bytes, less on some systems). */
const MAX_SOCKET = 100;

export function socketPathFor(dataDir: string): string {
  const p = join(dataDir, "matter-server.sock");
  return Buffer.byteLength(p) <= MAX_SOCKET ? p : join(tmpdir(), `hc-matter-${process.getuid?.() ?? 0}.sock`);
}

const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

function str(v: unknown, name: string, fallback: string): string {
  if (v === undefined) return fallback;
  if (typeof v !== "string") throw new Error(`[matter] ${name} must be a string`);
  return v;
}

function flag(v: unknown, name: string, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  if (typeof v !== "boolean") throw new Error(`[matter] ${name} must be true or false`);
  return v;
}

export function parseConfig(text: string, path: string): Config {
  const doc = parse(text) as Record<string, unknown>;
  const hc = (doc.homecore ?? {}) as Record<string, unknown>;
  const m = (doc.matter ?? {}) as Record<string, unknown>;
  const pluginId = typeof hc.plugin_id === "string" && hc.plugin_id ? hc.plugin_id : PLUGIN_ID;

  const dataDir = dataDirFor(path, pluginId);
  const storage = str(m.storage_dir, "storage_dir", "");
  const storageDir = storage ? (isAbsolute(storage) ? storage : resolve(dirname(path), storage)) : join(dataDir, "matter-server");
  const level = str(m.log_level, "log_level", "info");
  if (!(LOG_LEVELS as readonly string[]).includes(level)) throw new Error(`[matter] log_level must be one of ${LOG_LEVELS.join(", ")}`);
  const fabricLabel = str(m.fabric_label, "fabric_label", "homeCore");
  if (!fabricLabel.trim() || Buffer.byteLength(fabricLabel) > 32) throw new Error("[matter] fabric_label must be 1 to 32 bytes");

  return {
    path,
    homecore: {
      brokerHost: typeof hc.broker_host === "string" ? hc.broker_host : (process.env.HC_BROKER_HOST ?? "127.0.0.1"),
      brokerPort: typeof hc.broker_port === "number" ? hc.broker_port : Number(process.env.HC_BROKER_PORT ?? 1883),
      pluginId,
      password: typeof hc.password === "string" ? hc.password : process.env.HC_PLUGIN_PASSWORD,
    },
    matter: {
      storageDir,
      socketPath: socketPathFor(dirname(storageDir)),
      fabricLabel,
      serverLogLevel: level as MatterSettings["serverLogLevel"],
      primaryInterface: str(m.primary_interface, "primary_interface", "") || null,
      allowTestDevices: flag(m.allow_test_devices, "allow_test_devices", false),
      dclOffline: flag(m.dcl_offline, "dcl_offline", false),
      threadDiagnostics: flag(m.thread_diagnostics, "thread_diagnostics", true),
      firmwareUpdates: flag(m.firmware_updates, "firmware_updates", true),
    },
  };
}

export function loadConfig(path: string): Config {
  return parseConfig(readFileSync(path, "utf8"), path);
}
