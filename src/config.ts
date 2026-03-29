import * as fs from "fs";
import * as path from "path";
import * as TOML from "@iarna/toml";
import { z } from "zod";

// Configuration schema using Zod
const HomeCorConfigSchema = z.object({
  ws_url: z.string().url().default("ws://localhost:9001"),
  reconnect_delay_secs: z.number().positive().default(5),
  max_reconnect_attempts: z.number().nonnegative().default(0),
});

const MatterConfigSchema = z.object({
  storage_dir: z.string().default("data/matter"),
  security_provider: z.enum(["plaintext", "env"]).default("plaintext"),
  security_key_env_var: z.string().default("HC_MATTER_STORE_KEY"),
  instance_name: z.string().default("HomeCore"),
  passcode_default: z.number().min(1).max(134217727).default(12345678),
  discriminator_default: z.number().min(0).max(4095).optional(),
});

const ControllerConfigSchema = z.object({
  enabled: z.boolean().default(true),
  commissioning_required_for: z.enum(["local-only", "any"]).default("local-only"),
});

const BridgeConfigSchema = z.object({
  enabled: z.boolean().default(false),
  include_ids: z.array(z.string()).default(["*"]),
  exclude_ids: z.array(z.string()).default([]),
  device_type_filter: z.array(z.string()).optional(),
  area_filter: z.array(z.string()).optional(),
});

const LoggingConfigSchema = z.object({
  level: z.enum(["trace", "debug", "info", "warn", "error"]).default("debug"),
  file_appender: z.boolean().default(true),
  file_path: z.string().default("logs/hc-matter.log"),
});

const PluginConfigSchema = z.object({
  homecore: HomeCorConfigSchema,
  matter: MatterConfigSchema,
  controller: ControllerConfigSchema,
  bridge: BridgeConfigSchema,
  logging: LoggingConfigSchema,
});

export type PluginConfig = z.infer<typeof PluginConfigSchema>;
export type HomeCoreConfig = z.infer<typeof HomeCorConfigSchema>;
export type MatterConfig = z.infer<typeof MatterConfigSchema>;
export type ControllerConfig = z.infer<typeof ControllerConfigSchema>;
export type BridgeConfig = z.infer<typeof BridgeConfigSchema>;
export type LoggingConfig = z.infer<typeof LoggingConfigSchema>;

/**
 * Loads and validates plugin configuration from TOML file.
 * Supports environment variable overrides for sensitive values.
 */
export async function loadConfig(configPath: string): Promise<PluginConfig> {
  // Resolve config path
  const resolvedPath = path.isAbsolute(configPath)
    ? configPath
    : path.join(process.cwd(), configPath);

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Configuration file not found: ${resolvedPath}`);
  }

  // Parse TOML
  const tomlContent = fs.readFileSync(resolvedPath, "utf-8");
  const rawConfig = TOML.parse(tomlContent) as Record<string, unknown>;

  // Apply environment variable overrides
  if (process.env.WS_URL) {
    if (!rawConfig.homecore) rawConfig.homecore = {};
    (rawConfig.homecore as Record<string, unknown>).ws_url = process.env.WS_URL;
  }

  // Validate against schema
  const config = PluginConfigSchema.parse(rawConfig);

  // Create storage directories
  const storageDir = path.isAbsolute(config.matter.storage_dir)
    ? config.matter.storage_dir
    : path.join(path.dirname(resolvedPath), "..", config.matter.storage_dir);

  const logDir = path.isAbsolute(config.logging.file_path)
    ? path.dirname(config.logging.file_path)
    : path.join(path.dirname(resolvedPath), "..", path.dirname(config.logging.file_path));

  for (const dir of [storageDir, logDir]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  // Update paths to absolute
  config.matter.storage_dir = storageDir;
  config.logging.file_path = path.join(
    logDir,
    path.basename(config.logging.file_path)
  );

  return config;
}
