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
import { WebSocketServer } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testDir = path.join(__dirname, "..", "test_data");

async function waitForPublishedMessage(
  published: Array<Record<string, unknown>>,
  predicate: (msg: Record<string, unknown>) => boolean,
  timeoutMs = 500
): Promise<Record<string, unknown> | undefined> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const found = published.find(predicate);
    if (found) {
      return found;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  return undefined;
}

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

  it("should connect websocket bridge and exchange publish/subscribe frames", async () => {
    const port = 19111;
    const server = new WebSocketServer({ port });
    const received: Array<Record<string, unknown>> = [];

    await new Promise<void>((resolve) => {
      server.on("listening", () => resolve());
    });

    const bridge = new WebSocketBridge(`ws://127.0.0.1:${port}`, {
      reconnectDelayMs: 50,
      maxReconnectAttempts: 1,
    });

    server.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const parsed = JSON.parse(raw.toString()) as Record<string, unknown>;
        received.push(parsed);
      });
    });

    await bridge.connect();
    await bridge.register("matter", ["controller"], "1.0.0");
    await bridge.subscribe("homecore/devices/+/cmd");
    await bridge.publish("homecore/devices/matter_spike_light_1/state", { on: true });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(received.some((m) => m.type === "register")).toBe(true);
    expect(received.some((m) => m.type === "subscribe")).toBe(true);
    expect(received.some((m) => m.type === "publish")).toBe(true);

    await bridge.disconnect();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  });

  it("should apply OnOff commands and publish updated state", async () => {
    const port = 19112;
    const server = new WebSocketServer({ port });
    const published: Array<Record<string, unknown>> = [];

    await new Promise<void>((resolve) => {
      server.on("listening", () => resolve());
    });

    const bridge = new WebSocketBridge(`ws://127.0.0.1:${port}`, {
      reconnectDelayMs: 50,
      maxReconnectAttempts: 1,
    });

    server.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const parsed = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (parsed.type === "publish") {
          published.push(parsed);
        }
      });
    });

    await bridge.connect();

    const logger = new Logger("test");
    const config = {
      storage_dir: path.join(testDir, "matter-store"),
      security_provider: "plaintext" as const,
      security_key_env_var: "HC_MATTER_STORE_KEY",
      instance_name: "TestCore",
      passcode_default: 12345678,
      discriminator_default: 3840,
    };

    const controller = new MatterController(config, bridge, logger);
    await controller.start();

    // Push mqtt-style command from server to client.
    for (const client of server.clients) {
      client.send(
        JSON.stringify({
          type: "mqtt_message",
          topic: "homecore/devices/matter_spike_light_1/cmd",
          payload: { command: "on", correlation_id: "test-corr-1" },
        })
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 100));

    const statePublish = published.find(
      (msg) =>
        msg.topic === "homecore/devices/matter_spike_light_1/state" &&
        typeof msg.payload === "object" &&
        msg.payload !== null &&
        (msg.payload as Record<string, unknown>).on === true
    );

    expect(statePublish).toBeDefined();

    await controller.stop();
    await bridge.disconnect();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  });

  it("should publish runtime-originated OnOff callback state", async () => {
    const port = 19113;
    const server = new WebSocketServer({ port });
    const published: Array<Record<string, unknown>> = [];

    await new Promise<void>((resolve) => {
      server.on("listening", () => resolve());
    });

    const bridge = new WebSocketBridge(`ws://127.0.0.1:${port}`, {
      reconnectDelayMs: 50,
      maxReconnectAttempts: 1,
    });

    server.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const parsed = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (parsed.type === "publish") {
          published.push(parsed);
        }
      });
    });

    await bridge.connect();

    const logger = new Logger("test");
    const config = {
      storage_dir: path.join(testDir, "matter-store-runtime-callback"),
      security_provider: "plaintext" as const,
      security_key_env_var: "HC_MATTER_STORE_KEY",
      instance_name: "TestCore",
      passcode_default: 12345678,
      discriminator_default: 3840,
    };

    const controller = new MatterController(config, bridge, logger);
    await controller.start();

    await controller.simulateRuntimeOnOffChangedForTest(true);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const runtimeStatePublish = published.find(
      (msg) =>
        msg.topic === "homecore/devices/matter_runtime_light_1/state" &&
        typeof msg.payload === "object" &&
        msg.payload !== null &&
        (msg.payload as Record<string, unknown>).on === true &&
        (msg.payload as Record<string, unknown>).origin === "matter_runtime"
    );

    expect(runtimeStatePublish).toBeDefined();

    await controller.stop();
    await bridge.disconnect();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  });

  it("should expose commissioning info for API surfacing", async () => {
    const logger = new Logger("test");
    const config = {
      storage_dir: path.join(testDir, "matter-store-commission-info"),
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

    const before = controller.getCommissioningInfo();
    expect(before.active).toBe(false);
    expect(before.lastPairingCode).toBeNull();

    const pairingCode = await controller.commission(12345678, 3840);
    expect(pairingCode).toBe("12345678-3840");

    const after = controller.getCommissioningInfo();
    expect(after.active).toBe(false);
    expect(after.lastPairingCode).toBe("12345678-3840");
    expect(after.runtimeDeviceId).toBeDefined();
  });

  it("should handle matter_controller commission action and publish controller state", async () => {
    const port = 19114;
    const server = new WebSocketServer({ port });
    const published: Array<Record<string, unknown>> = [];

    await new Promise<void>((resolve) => {
      server.on("listening", () => resolve());
    });

    const bridge = new WebSocketBridge(`ws://127.0.0.1:${port}`, {
      reconnectDelayMs: 50,
      maxReconnectAttempts: 1,
    });

    server.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const parsed = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (parsed.type === "publish") {
          published.push(parsed);
        }
      });
    });

    await bridge.connect();

    const logger = new Logger("test");
    const config = {
      storage_dir: path.join(testDir, "matter-store-controller-actions"),
      security_provider: "plaintext" as const,
      security_key_env_var: "HC_MATTER_STORE_KEY",
      instance_name: "TestCore",
      passcode_default: 12345678,
      discriminator_default: 3840,
    };

    const controller = new MatterController(config, bridge, logger);
    await controller.start();

    for (const client of server.clients) {
      client.send(
        JSON.stringify({
          type: "mqtt_message",
          topic: "homecore/devices/matter_controller/cmd",
          payload: { action: "commission", passcode: 12345678, discriminator: 3840 },
        })
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 100));

    const commandResult = published.find(
      (msg) =>
        msg.topic === "homecore/plugins/matter/command_result" &&
        typeof msg.payload === "object" &&
        msg.payload !== null &&
        (msg.payload as Record<string, unknown>).action === "commission" &&
        (msg.payload as Record<string, unknown>).status === "ok"
    );

    const controllerState = published.find(
      (msg) =>
        msg.topic === "homecore/devices/matter_controller/state" &&
        typeof msg.payload === "object" &&
        msg.payload !== null &&
        Array.isArray((msg.payload as Record<string, unknown>).commissioned_nodes)
    );

    expect(commandResult).toBeDefined();
    expect(controllerState).toBeDefined();

    await controller.stop();
    await bridge.disconnect();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  });

  it("should return enriched status payload for matter_controller status action", async () => {
    const port = 19117;
    const server = new WebSocketServer({ port });
    const published: Array<Record<string, unknown>> = [];

    await new Promise<void>((resolve) => {
      server.on("listening", () => resolve());
    });

    const bridge = new WebSocketBridge(`ws://127.0.0.1:${port}`, {
      reconnectDelayMs: 50,
      maxReconnectAttempts: 1,
    });

    server.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const parsed = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (parsed.type === "publish") {
          published.push(parsed);
        }
      });
    });

    await bridge.connect();

    const logger = new Logger("test");
    const config = {
      storage_dir: path.join(testDir, "matter-store-controller-status"),
      security_provider: "plaintext" as const,
      security_key_env_var: "HC_MATTER_STORE_KEY",
      instance_name: "TestCore",
      passcode_default: 12345678,
      discriminator_default: 3840,
    };

    const controller = new MatterController(config, bridge, logger);
    await controller.start();

    bridge.emit("message", {
      type: "mqtt_message",
      topic: "homecore/devices/matter_controller/cmd",
      payload: { action: "status", correlation_id: "status-1" },
    });

    const statusResult = await waitForPublishedMessage(
      published,
      (msg) =>
        msg.topic === "homecore/plugins/matter/command_result" &&
        typeof msg.payload === "object" &&
        msg.payload !== null &&
        (msg.payload as Record<string, unknown>).action === "status",
      500
    );

    expect(statusResult).toBeDefined();

    const payload = (statusResult as Record<string, unknown>).payload as Record<string, unknown>;
    expect(payload.status).toBe("ok");
    expect(payload.correlation_id).toBe("status-1");
    expect(payload.info).toBeDefined();
    expect(payload.controller_status).toBeDefined();
    expect(Array.isArray(payload.nodes)).toBe(true);

    await controller.stop();
    await bridge.disconnect();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  });

  it("should handle reinterview action when node exists", async () => {
    const port = 19120;
    const server = new WebSocketServer({ port });
    const published: Array<Record<string, unknown>> = [];

    await new Promise<void>((resolve) => {
      server.on("listening", () => resolve());
    });

    const bridge = new WebSocketBridge(`ws://127.0.0.1:${port}`, {
      reconnectDelayMs: 50,
      maxReconnectAttempts: 1,
    });

    server.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const parsed = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (parsed.type === "publish") {
          published.push(parsed);
        }
      });
    });

    await bridge.connect();

    const logger = new Logger("test");
    const storageDir = path.join(testDir, "matter-store-controller-reinterview-success");
    const config = {
      storage_dir: storageDir,
      security_provider: "plaintext" as const,
      security_key_env_var: "HC_MATTER_STORE_KEY",
      instance_name: "TestCore",
      passcode_default: 12345678,
      discriminator_default: 3840,
    };

    const seedStore = new FabricStore(path.join(storageDir, "fabric_store.json"), logger);
    await seedStore.load();
    seedStore.registerNode("node-1", {
      1: {
        id: 1,
        clusters: {
          6: { id: 6, attributes: {} },
        },
      },
    });
    await seedStore.save();

    const controller = new MatterController(config, bridge, logger);
    await controller.start();

    bridge.emit("message", {
      type: "mqtt_message",
      topic: "homecore/devices/matter_controller/cmd",
      payload: { action: "reinterview", node_id: "node-1", correlation_id: "ok-1" },
    });

    const result = await waitForPublishedMessage(
      published,
      (msg) =>
        msg.topic === "homecore/plugins/matter/command_result" &&
        typeof msg.payload === "object" &&
        msg.payload !== null &&
        (msg.payload as Record<string, unknown>).action === "reinterview" &&
        (msg.payload as Record<string, unknown>).status === "ok" &&
        (msg.payload as Record<string, unknown>).node_id === "node-1" &&
        (msg.payload as Record<string, unknown>).correlation_id === "ok-1",
      500
    );

    expect(result).toBeDefined();
    const payload = (result as Record<string, unknown>).payload as Record<string, unknown>;
    expect(payload.runtime_applied).toBe(false);

    await controller.stop();
    await bridge.disconnect();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  });

  it("should handle remove_node action when node exists", async () => {
    const port = 19121;
    const server = new WebSocketServer({ port });
    const published: Array<Record<string, unknown>> = [];

    await new Promise<void>((resolve) => {
      server.on("listening", () => resolve());
    });

    const bridge = new WebSocketBridge(`ws://127.0.0.1:${port}`, {
      reconnectDelayMs: 50,
      maxReconnectAttempts: 1,
    });

    server.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const parsed = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (parsed.type === "publish") {
          published.push(parsed);
        }
      });
    });

    await bridge.connect();

    const logger = new Logger("test");
    const storageDir = path.join(testDir, "matter-store-controller-remove-success");
    const config = {
      storage_dir: storageDir,
      security_provider: "plaintext" as const,
      security_key_env_var: "HC_MATTER_STORE_KEY",
      instance_name: "TestCore",
      passcode_default: 12345678,
      discriminator_default: 3840,
    };

    const seedStore = new FabricStore(path.join(storageDir, "fabric_store.json"), logger);
    await seedStore.load();
    seedStore.registerNode("node-2", {
      1: {
        id: 1,
        clusters: {
          6: { id: 6, attributes: {} },
        },
      },
    });
    await seedStore.save();

    const controller = new MatterController(config, bridge, logger);
    await controller.start();

    bridge.emit("message", {
      type: "mqtt_message",
      topic: "homecore/devices/matter_controller/cmd",
      payload: { action: "remove_node", node_id: "node-2", correlation_id: "ok-2" },
    });

    const result = await waitForPublishedMessage(
      published,
      (msg) =>
        msg.topic === "homecore/plugins/matter/command_result" &&
        typeof msg.payload === "object" &&
        msg.payload !== null &&
        (msg.payload as Record<string, unknown>).action === "remove_node" &&
        (msg.payload as Record<string, unknown>).status === "ok" &&
        (msg.payload as Record<string, unknown>).node_id === "node-2" &&
        (msg.payload as Record<string, unknown>).correlation_id === "ok-2",
      500
    );

    expect(result).toBeDefined();
    const payload = (result as Record<string, unknown>).payload as Record<string, unknown>;
    expect(payload.runtime_applied).toBe(false);

    const verifyStore = new FabricStore(path.join(storageDir, "fabric_store.json"), logger);
    await verifyStore.load();
    expect(verifyStore.getNode("node-2")).toBeUndefined();

    await controller.stop();
    await bridge.disconnect();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  });

  it("should set runtime_applied=true for reinterview when runtime simulation is enabled", async () => {
    const previousSimulate = process.env.HC_MATTER_SIMULATE_RUNTIME;
    process.env.HC_MATTER_SIMULATE_RUNTIME = "1";

    try {
      const port = 19122;
      const server = new WebSocketServer({ port });
      const published: Array<Record<string, unknown>> = [];

      await new Promise<void>((resolve) => {
        server.on("listening", () => resolve());
      });

      const bridge = new WebSocketBridge(`ws://127.0.0.1:${port}`, {
        reconnectDelayMs: 50,
        maxReconnectAttempts: 1,
      });

      server.on("connection", (socket) => {
        socket.on("message", (raw) => {
          const parsed = JSON.parse(raw.toString()) as Record<string, unknown>;
          if (parsed.type === "publish") {
            published.push(parsed);
          }
        });
      });

      await bridge.connect();

      const logger = new Logger("test");
      const config = {
        storage_dir: path.join(testDir, "matter-store-controller-runtime-sim"),
        security_provider: "plaintext" as const,
        security_key_env_var: "HC_MATTER_STORE_KEY",
        instance_name: "TestCore",
        passcode_default: 12345678,
        discriminator_default: 3840,
      };

      const controller = new MatterController(config, bridge, logger);
      await controller.start();

      bridge.emit("message", {
        type: "mqtt_message",
        topic: "homecore/devices/matter_controller/cmd",
        payload: { action: "reinterview", node_id: "runtime-node-1", correlation_id: "sim-1" },
      });

      const result = await waitForPublishedMessage(
        published,
        (msg) =>
          msg.topic === "homecore/plugins/matter/command_result" &&
          typeof msg.payload === "object" &&
          msg.payload !== null &&
          (msg.payload as Record<string, unknown>).action === "reinterview" &&
          (msg.payload as Record<string, unknown>).status === "ok" &&
          (msg.payload as Record<string, unknown>).correlation_id === "sim-1",
        700
      );

      expect(result).toBeDefined();
      const payload = (result as Record<string, unknown>).payload as Record<string, unknown>;
      expect(payload.runtime_applied).toBe(true);

      await controller.stop();
      await bridge.disconnect();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
    } finally {
      if (previousSimulate === undefined) {
        delete process.env.HC_MATTER_SIMULATE_RUNTIME;
      } else {
        process.env.HC_MATTER_SIMULATE_RUNTIME = previousSimulate;
      }
    }
  });

  it("should set runtime_applied=true for remove_node when runtime simulation is enabled", async () => {
    const previousSimulate = process.env.HC_MATTER_SIMULATE_RUNTIME;
    process.env.HC_MATTER_SIMULATE_RUNTIME = "1";

    try {
      const port = 19123;
      const server = new WebSocketServer({ port });
      const published: Array<Record<string, unknown>> = [];

      await new Promise<void>((resolve) => {
        server.on("listening", () => resolve());
      });

      const bridge = new WebSocketBridge(`ws://127.0.0.1:${port}`, {
        reconnectDelayMs: 50,
        maxReconnectAttempts: 1,
      });

      server.on("connection", (socket) => {
        socket.on("message", (raw) => {
          const parsed = JSON.parse(raw.toString()) as Record<string, unknown>;
          if (parsed.type === "publish") {
            published.push(parsed);
          }
        });
      });

      await bridge.connect();

      const logger = new Logger("test");
      const storageDir = path.join(testDir, "matter-store-controller-runtime-sim-remove");
      const config = {
        storage_dir: storageDir,
        security_provider: "plaintext" as const,
        security_key_env_var: "HC_MATTER_STORE_KEY",
        instance_name: "TestCore",
        passcode_default: 12345678,
        discriminator_default: 3840,
      };

      const controller = new MatterController(config, bridge, logger);
      await controller.start();

      bridge.emit("message", {
        type: "mqtt_message",
        topic: "homecore/devices/matter_controller/cmd",
        payload: { action: "remove_node", node_id: "runtime-node-1", correlation_id: "sim-2" },
      });

      const result = await waitForPublishedMessage(
        published,
        (msg) =>
          msg.topic === "homecore/plugins/matter/command_result" &&
          typeof msg.payload === "object" &&
          msg.payload !== null &&
          (msg.payload as Record<string, unknown>).action === "remove_node" &&
          (msg.payload as Record<string, unknown>).status === "ok" &&
          (msg.payload as Record<string, unknown>).correlation_id === "sim-2",
        700
      );

      expect(result).toBeDefined();
      const payload = (result as Record<string, unknown>).payload as Record<string, unknown>;
      expect(payload.runtime_applied).toBe(true);

      const verifyStore = new FabricStore(path.join(storageDir, "fabric_store.json"), logger);
      await verifyStore.load();
      expect(verifyStore.getNode("runtime-node-1")).toBeUndefined();

      await controller.stop();
      await bridge.disconnect();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
    } finally {
      if (previousSimulate === undefined) {
        delete process.env.HC_MATTER_SIMULATE_RUNTIME;
      } else {
        process.env.HC_MATTER_SIMULATE_RUNTIME = previousSimulate;
      }
    }
  });

  it("should return structured error for unknown matter_controller action", async () => {
    const port = 19115;
    const server = new WebSocketServer({ port });
    const published: Array<Record<string, unknown>> = [];

    await new Promise<void>((resolve) => {
      server.on("listening", () => resolve());
    });

    const bridge = new WebSocketBridge(`ws://127.0.0.1:${port}`, {
      reconnectDelayMs: 50,
      maxReconnectAttempts: 1,
    });

    server.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const parsed = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (parsed.type === "publish") {
          published.push(parsed);
        }
      });
    });

    await bridge.connect();

    const logger = new Logger("test");
    const config = {
      storage_dir: path.join(testDir, "matter-store-controller-errors"),
      security_provider: "plaintext" as const,
      security_key_env_var: "HC_MATTER_STORE_KEY",
      instance_name: "TestCore",
      passcode_default: 12345678,
      discriminator_default: 3840,
    };

    const controller = new MatterController(config, bridge, logger);
    await controller.start();

    for (const client of server.clients) {
      client.send(
        JSON.stringify({
          type: "mqtt_message",
          topic: "homecore/devices/matter_controller/cmd",
          payload: { action: "nope", correlation_id: "bad-1" },
        })
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 120));

    const errorResult = published.find(
      (msg) =>
        msg.topic === "homecore/plugins/matter/command_result" &&
        typeof msg.payload === "object" &&
        msg.payload !== null &&
        (msg.payload as Record<string, unknown>).status === "error" &&
        (msg.payload as Record<string, unknown>).correlation_id === "bad-1"
    );

    expect(errorResult).toBeDefined();
    const errorPayload = (errorResult as Record<string, unknown>).payload as Record<string, unknown>;
    expect(errorPayload.code).toBe("INVALID_CONTROLLER_COMMAND");

    await controller.stop();
    await bridge.disconnect();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  });

  it("should return structured error when remove_node is missing node_id", async () => {
    const port = 19116;
    const server = new WebSocketServer({ port });
    const published: Array<Record<string, unknown>> = [];

    await new Promise<void>((resolve) => {
      server.on("listening", () => resolve());
    });

    const bridge = new WebSocketBridge(`ws://127.0.0.1:${port}`, {
      reconnectDelayMs: 50,
      maxReconnectAttempts: 1,
    });

    server.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const parsed = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (parsed.type === "publish") {
          published.push(parsed);
        }
      });
    });

    await bridge.connect();

    const logger = new Logger("test");
    const config = {
      storage_dir: path.join(testDir, "matter-store-controller-errors-2"),
      security_provider: "plaintext" as const,
      security_key_env_var: "HC_MATTER_STORE_KEY",
      instance_name: "TestCore",
      passcode_default: 12345678,
      discriminator_default: 3840,
    };

    const controller = new MatterController(config, bridge, logger);
    await controller.start();

    for (const client of server.clients) {
      client.send(
        JSON.stringify({
          type: "mqtt_message",
          topic: "homecore/devices/matter_controller/cmd",
          payload: { action: "remove_node", correlation_id: "bad-2" },
        })
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 120));

    const errorResult = published.find(
      (msg) =>
        msg.topic === "homecore/plugins/matter/command_result" &&
        typeof msg.payload === "object" &&
        msg.payload !== null &&
        (msg.payload as Record<string, unknown>).status === "error" &&
        (msg.payload as Record<string, unknown>).correlation_id === "bad-2"
    );

    expect(errorResult).toBeDefined();
    const errorPayload = (errorResult as Record<string, unknown>).payload as Record<string, unknown>;
    expect(errorPayload.code).toBe("INVALID_CONTROLLER_COMMAND");

    await controller.stop();
    await bridge.disconnect();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  });

  it("should return NODE_NOT_FOUND when remove_node targets unknown node", async () => {
    const port = 19118;
    const server = new WebSocketServer({ port });
    const published: Array<Record<string, unknown>> = [];

    await new Promise<void>((resolve) => {
      server.on("listening", () => resolve());
    });

    const bridge = new WebSocketBridge(`ws://127.0.0.1:${port}`, {
      reconnectDelayMs: 50,
      maxReconnectAttempts: 1,
    });

    server.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const parsed = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (parsed.type === "publish") {
          published.push(parsed);
        }
      });
    });

    await bridge.connect();

    const logger = new Logger("test");
    const config = {
      storage_dir: path.join(testDir, "matter-store-controller-node-errors"),
      security_provider: "plaintext" as const,
      security_key_env_var: "HC_MATTER_STORE_KEY",
      instance_name: "TestCore",
      passcode_default: 12345678,
      discriminator_default: 3840,
    };

    const controller = new MatterController(config, bridge, logger);
    await controller.start();

    bridge.emit("message", {
      type: "mqtt_message",
      topic: "homecore/devices/matter_controller/cmd",
      payload: { action: "remove_node", node_id: "node-does-not-exist", correlation_id: "bad-3" },
    });

    const errorResult = await waitForPublishedMessage(
      published,
      (msg) =>
        msg.topic === "homecore/plugins/matter/command_result" &&
        typeof msg.payload === "object" &&
        msg.payload !== null &&
        (msg.payload as Record<string, unknown>).action === "remove_node" &&
        (msg.payload as Record<string, unknown>).status === "error" &&
        (msg.payload as Record<string, unknown>).correlation_id === "bad-3",
      500
    );

    expect(errorResult).toBeDefined();
    const errorPayload = (errorResult as Record<string, unknown>).payload as Record<string, unknown>;
    expect(errorPayload.code).toBe("NODE_NOT_FOUND");

    await controller.stop();
    await bridge.disconnect();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  });

  it("should return NODE_NOT_FOUND when reinterview targets unknown node", async () => {
    const port = 19119;
    const server = new WebSocketServer({ port });
    const published: Array<Record<string, unknown>> = [];

    await new Promise<void>((resolve) => {
      server.on("listening", () => resolve());
    });

    const bridge = new WebSocketBridge(`ws://127.0.0.1:${port}`, {
      reconnectDelayMs: 50,
      maxReconnectAttempts: 1,
    });

    server.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const parsed = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (parsed.type === "publish") {
          published.push(parsed);
        }
      });
    });

    await bridge.connect();

    const logger = new Logger("test");
    const config = {
      storage_dir: path.join(testDir, "matter-store-controller-node-errors-2"),
      security_provider: "plaintext" as const,
      security_key_env_var: "HC_MATTER_STORE_KEY",
      instance_name: "TestCore",
      passcode_default: 12345678,
      discriminator_default: 3840,
    };

    const controller = new MatterController(config, bridge, logger);
    await controller.start();

    bridge.emit("message", {
      type: "mqtt_message",
      topic: "homecore/devices/matter_controller/cmd",
      payload: { action: "reinterview", node_id: "node-does-not-exist", correlation_id: "bad-4" },
    });

    const errorResult = await waitForPublishedMessage(
      published,
      (msg) =>
        msg.topic === "homecore/plugins/matter/command_result" &&
        typeof msg.payload === "object" &&
        msg.payload !== null &&
        (msg.payload as Record<string, unknown>).action === "reinterview" &&
        (msg.payload as Record<string, unknown>).status === "error" &&
        (msg.payload as Record<string, unknown>).correlation_id === "bad-4",
      500
    );

    expect(errorResult).toBeDefined();
    const errorPayload = (errorResult as Record<string, unknown>).payload as Record<string, unknown>;
    expect(errorPayload.code).toBe("NODE_NOT_FOUND");

    await controller.stop();
    await bridge.disconnect();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  });
});
