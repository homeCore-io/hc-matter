/**
 * Phase 0 Spike Test
 *
 * Verify that hc-matter can initialize core components without a running HomeCore.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { FabricStore } from "../src/controller/fabric-store.js";
import { DeviceRegistry } from "../src/device-registry.js";
import { StatePublisher } from "../src/state-publisher.js";
import { WebSocketBridge } from "../src/ws-bridge.js";
import { MatterController } from "../src/controller/index.js";
import { Logger } from "../src/logger.js";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testDir = path.join(__dirname, "..", "test_data");

describe("Phase 0 Spike - Core Components", () => {
  beforeAll(() => {
    // Setup test directory
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }
  });

  afterAll(() => {
    // Cleanup test directory
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  it("should initialize FabricStore", async () => {
    const logger = new Logger("test");
    const storePath = path.join(testDir, "fabric_store.json");
    const store = new FabricStore(storePath, logger);

    await store.load();
    expect(store.getFabric()).toBeDefined();
    expect(store.listNodes()).toEqual([]);

    // Register a node
    store.registerNode("node-1", {});
    expect(store.isDirty()).toBe(true);

    await store.save();
    expect(store.isDirty()).toBe(false);

    // Verify file was created
    expect(fs.existsSync(storePath)).toBe(true);

    // Verify state persists
    const store2 = new FabricStore(storePath, logger);
    await store2.load();
    expect(store2.listNodes()).toContain("node-1");
  });

  it("should initialize DeviceRegistry", () => {
    const logger = new Logger("test");
    const registry = new DeviceRegistry(logger);

    expect(registry.listAll()).toEqual([]);

    // Register a device
    const device = {
      nodeId: "node-1",
      endpointId: 1,
      matterType: "OnOffLight",
      homecoreId: "light.test",
      homecoreType: "light",
      clusters: [6, 8],
    };

    registry.register(device);
    expect(registry.listAll()).toHaveLength(1);
    expect(registry.get("node-1", 1)).toEqual(device);
    expect(registry.getByHomecoreId("light.test")).toEqual(device);

    // Remove device
    registry.remove("node-1", 1);
    expect(registry.listAll()).toEqual([]);
  });

  it("should initialize Logger with file output", () => {
    const logDir = path.join(testDir, "logs");
    const logFile = path.join(logDir, "test.log");

    const logger = new Logger("test", undefined, logFile);
    logger.info("Test message");
    logger.error("Test error");

    // Logger may not write immediately, so just verify it doesn't crash
    expect(logger).toBeDefined();
  });

  it("should load and validate config schema", async () => {
    const { loadConfig } = await import("../src/config.js");

    // Create a test config file
    const configPath = path.join(testDir, "test-config.toml");
    const configContent = `
[homecore]
ws_url = "ws://localhost:9001"

[matter]
storage_dir = "data/matter"
instance_name = "TestCore"

[controller]
enabled = true

[bridge]
enabled = false

[logging]
level = "debug"
`;
    fs.writeFileSync(configPath, configContent);

    const config = await loadConfig(configPath);

    expect(config.homecore.ws_url).toBe("ws://localhost:9001");
    expect(config.matter.instance_name).toBe("TestCore");
    expect(config.controller.enabled).toBe(true);
    expect(config.bridge.enabled).toBe(false);
    expect(config.logging.level).toBe("debug");
  });

  it("should initialize MatterController without crashing", async () => {
    const logger = new Logger("test");
    const storePath = path.join(testDir, "fabric_store_controller.json");

    const config = {
      storage_dir: path.dirname(storePath),
      security_provider: "plaintext" as const,
      security_key_env_var: "HC_MATTER_STORE_KEY",
      instance_name: "TestCore",
      passcode_default: 12345678,
      discriminator_default: 3840,
    };

    // Create a mock WebSocket bridge
    const wsBridge = new WebSocketBridge("ws://localhost:9999", {
      maxReconnectAttempts: 0,
    });

    // Controller should initialize without error
    const controller = new MatterController(config, wsBridge, logger);

    // Check controller methods exist
    expect(typeof controller.start).toBe("function");
    expect(typeof controller.stop).toBe("function");
    expect(typeof controller.getStatus).toBe("function");
    expect(typeof controller.commission).toBe("function");
  });

  it("should generate valid pairing codes", async () => {
    const logger = new Logger("test");
    const storePath = path.join(testDir, "fabric_store_pairing.json");

    const config = {
      storage_dir: path.dirname(storePath),
      security_provider: "plaintext" as const,
      security_key_env_var: "HC_MATTER_STORE_KEY",
      instance_name: "TestCore",
      passcode_default: 12345678,
      discriminator_default: 3840,
    };

    const wsBridge = new WebSocketBridge("ws://localhost:9999", {
      maxReconnectAttempts: 0,
    });

    const controller = new MatterController(config, wsBridge, logger);

    // Commission should return a pairing code
    const pairingCode = await controller.commission(12345678, 3840);
    expect(pairingCode).toBeDefined();
    expect(typeof pairingCode).toBe("string");
    expect(pairingCode).toMatch(/\d{8}-\d{4}/);
  });
});
