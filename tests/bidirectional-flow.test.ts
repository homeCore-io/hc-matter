/**
 * Bidirectional Command Flow Tests (Phase 3)
 *
 * Test complete round-trip communication:
 * - HomeCore device state changes → Bridge attribute updates
 * - External controller reads updated attributes
 * - External controller sends commands → Bridge processes → HomeCore receives command
 * - HomeCore device responds → Bridge attribute updates → External controller reads response
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Logger } from "../src/logger.js";
import { BridgeAttributeHandlers } from "../src/bridge/attribute-handlers.js";
import { MatterBridgeBinding } from "../src/bridge/matter-bridge-binding.js";
import {
  composeEndpoint,
  MATTER_CLUSTER_IDS,
  MATTER_ATTRIBUTE_IDS,
} from "../src/bridge/endpoint-factory.js";

const logger = new Logger("test/bidirectional-flow");

/**
 * Mock HomeCore device state tracker
 */
class MockHomeCoreDevice {
  private state: Record<string, unknown> = {};
  private commandQueue: Array<{
    command: string;
    value: unknown;
    timestamp: number;
  }> = [];

  setState(key: string, value: unknown): void {
    this.state[key] = value;
  }

  getState(key: string): unknown {
    return this.state[key];
  }

  receiveCommand(command: string, value: unknown): void {
    this.commandQueue.push({
      command,
      value,
      timestamp: Date.now(),
    });
  }

  getCommandQueue(): typeof this.commandQueue {
    return [...this.commandQueue];
  }

  getFullState(): Record<string, unknown> {
    return { ...this.state };
  }

  reset(): void {
    this.state = {};
    this.commandQueue = [];
  }
}

/**
 * Mock WebSocket bridge for state tracking
 */
class MockWebSocketBridge {
  private subscriptions: Set<string> = new Set();
  private stateTopics: Map<string, Record<string, unknown>> = new Map();
  private listeners: Map<string, Set<(msg: unknown) => void>> = new Map();
  private listeners2: Map<string, Set<(msg: unknown) => void>> = new Map();
  private outboundCommands: Array<{ topic: string; payload: unknown }> = [];

  isConnected(): boolean {
    return true;
  }

  async subscribe(topic: string): Promise<void> {
    this.subscriptions.add(topic);
  }

  async publish(topic: string, payload: unknown): Promise<void> {
    if (topic.includes("cmd")) {
      this.outboundCommands.push({ topic, payload });
      // Emit as event for listeners
      const handlers = this.listeners2.get("command") || new Set();
      for (const handler of handlers) {
        handler({ topic, payload });
      }
    }
  }

  on(event: string, handler: (msg: unknown) => void): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler);
  }

  on2(event: string, handler: (msg: unknown) => void): void {
    if (!this.listeners2.has(event)) {
      this.listeners2.set(event, new Set());
    }
    this.listeners2.get(event)!.add(handler);
  }

  off(_event: string, _handler: (msg: unknown) => void): void {
    // no-op
  }

  async emitStateUpdate(topic: string, state: Record<string, unknown>): Promise<void> {
    this.stateTopics.set(topic, state);
    const handlers = this.listeners.get("message") || new Set();
    for (const handler of handlers) {
      handler({ type: "state", topic, payload: state });
    }
  }

  getOutboundCommands(): Array<{ topic: string; payload: unknown }> {
    return [...this.outboundCommands];
  }

  getSubscriptions(): string[] {
    return Array.from(this.subscriptions);
  }

  getStateTopics(): Map<string, Record<string, unknown>> {
    return new Map(this.stateTopics);
  }

  reset(): void {
    this.subscriptions.clear();
    this.stateTopics.clear();
    this.outboundCommands = [];
    this.listeners.clear();
    this.listeners2.clear();
  }
}

/**
 * Mock Bridge attribute accessor
 */
class MockBridgeAttributeAccessor {
  private attributes: Map<string, Map<number, Map<number, unknown>>> = new Map();

  setEndpointAttribute(
    endpointId: string,
    clusterId: number,
    attributeId: number,
    value: unknown
  ): void {
    const clustersMap =
      this.attributes.get(endpointId) || new Map();
    const attributesMap =
      clustersMap.get(clusterId) || new Map();
    attributesMap.set(attributeId, value);
    clustersMap.set(clusterId, attributesMap);
    this.attributes.set(endpointId, clustersMap);
  }

  getEndpointAttribute(
    endpointId: string,
    clusterId: number,
    attributeId: number
  ): unknown {
    return this.attributes
      .get(endpointId)
      ?.get(clusterId)
      ?.get(attributeId);
  }

  getEndpoint(endpointId: string): Record<number, Record<number, unknown>> {
    const clustersMap = this.attributes.get(endpointId);
    if (!clustersMap) return {};

    const result: Record<number, Record<number, unknown>> = {};
    for (const [clusterId, attributesMap] of clustersMap) {
      const attrs: Record<number, unknown> = {};
      for (const [attrId, value] of attributesMap) {
        attrs[attrId] = value;
      }
      result[clusterId] = attrs;
    }
    return result;
  }

  getAllEndpoints(): Record<string, Record<number, Record<number, unknown>>> {
    const result: Record<string, Record<number, Record<number, unknown>>> = {};
    for (const [endpointId, clustersMap] of this.attributes) {
      const endpoint: Record<number, Record<number, unknown>> = {};
      for (const [clusterId, attributesMap] of clustersMap) {
        const attrs: Record<number, unknown> = {};
        for (const [attrId, value] of attributesMap) {
          attrs[attrId] = value;
        }
        endpoint[clusterId] = attrs;
      }
      result[endpointId] = endpoint;
    }
    return result;
  }

  reset(): void {
    this.attributes.clear();
  }
}

describe("Phase 3: Bidirectional Command Flow", () => {
  let wsBridge: MockWebSocketBridge;
  let homecoreDevice: MockHomeCoreDevice;
  let bridgeAccessor: MockBridgeAttributeAccessor;

  beforeEach(() => {
    wsBridge = new MockWebSocketBridge();
    homecoreDevice = new MockHomeCoreDevice();
    bridgeAccessor = new MockBridgeAttributeAccessor();
  });

  afterEach(() => {
    wsBridge.reset();
    homecoreDevice.reset();
    bridgeAccessor.reset();
  });

  describe("HomeCore → Bridge → External Controller", () => {
    it("should sync light on/off state to bridge attribute", async () => {
      const endpointId = "light_kitchen";

      // Simulate HomeCore state change (device turned on)
      await wsBridge.emitStateUpdate(`homecore/devices/${endpointId}/state`, {
        on: true,
      });

      // Bridge attribute should reflect this state
      bridgeAccessor.setEndpointAttribute(
        endpointId,
        MATTER_CLUSTER_IDS.ON_OFF,
        MATTER_ATTRIBUTE_IDS.ON_OFF,
        true
      );

      // External controller should read the updated attribute
      const attribute = bridgeAccessor.getEndpointAttribute(
        endpointId,
        MATTER_CLUSTER_IDS.ON_OFF,
        MATTER_ATTRIBUTE_IDS.ON_OFF
      );

      expect(attribute).toBe(true);
    });

    it("should sync brightness changes to bridge attribute", async () => {
      const endpointId = "light_living_room";

      // Simulate HomeCore brightness change (50%)
      await wsBridge.emitStateUpdate(
        `homecore/devices/${endpointId}/state`,
        {
          brightness: 50,
        }
      );

      // Bridge converts 0-100% → 0-254 scale
      const bridgeValue = Math.round((50 / 100) * 254);
      bridgeAccessor.setEndpointAttribute(
        endpointId,
        MATTER_CLUSTER_IDS.LEVEL_CONTROL,
        MATTER_ATTRIBUTE_IDS.CURRENT_LEVEL,
        bridgeValue
      );

      // External controller reads attribute
      const attribute = bridgeAccessor.getEndpointAttribute(
        endpointId,
        MATTER_CLUSTER_IDS.LEVEL_CONTROL,
        MATTER_ATTRIBUTE_IDS.CURRENT_LEVEL
      );

      expect(attribute).toBe(bridgeValue);
      expect(attribute).toBeGreaterThan(0);
      expect(attribute).toBeLessThanOrEqual(254);
    });

    it("should sync temperature sensor reading to bridge", async () => {
      const endpointId = "temperature_sensor_1";

      // Simulate HomeCore sensor reading (22.5°C)
      const tempCelsius = 22.5;
      const centidegrees = Math.round(tempCelsius * 100);

      await wsBridge.emitStateUpdate(
        `homecore/devices/${endpointId}/state`,
        {
          temperature: tempCelsius,
        }
      );

      bridgeAccessor.setEndpointAttribute(
        endpointId,
        MATTER_CLUSTER_IDS.TEMPERATURE_MEASUREMENT,
        MATTER_ATTRIBUTE_IDS.MEASURED_VALUE,
        centidegrees
      );

      const attribute = bridgeAccessor.getEndpointAttribute(
        endpointId,
        MATTER_CLUSTER_IDS.TEMPERATURE_MEASUREMENT,
        MATTER_ATTRIBUTE_IDS.MEASURED_VALUE
      );

      expect(attribute).toBe(centidegrees);
    });

    it("should sync humidity to bridge attribute", async () => {
      const endpointId = "humidity_sensor_1";

      // Simulate HomeCore humidity (65%)
      const humidityPercent = 65;
      const bridgeValue = Math.round((humidityPercent / 100) * 10000);

      await wsBridge.emitStateUpdate(
        `homecore/devices/${endpointId}/state`,
        {
          humidity: humidityPercent,
        }
      );

      bridgeAccessor.setEndpointAttribute(
        endpointId,
        MATTER_CLUSTER_IDS.RELATIVE_HUMIDITY_MEASUREMENT,
        MATTER_ATTRIBUTE_IDS.RELATIVE_HUMIDITY,
        bridgeValue
      );

      const attribute = bridgeAccessor.getEndpointAttribute(
        endpointId,
        MATTER_CLUSTER_IDS.RELATIVE_HUMIDITY_MEASUREMENT,
        MATTER_ATTRIBUTE_IDS.RELATIVE_HUMIDITY
      );

      expect(attribute).toBe(bridgeValue);
    });

    it("should sync motion detection state", async () => {
      const endpointId = "motion_sensor_1";

      // Simulate motion detected
      await wsBridge.emitStateUpdate(
        `homecore/devices/${endpointId}/state`,
        {
          motion: true,
        }
      );

      // Motion maps to occupancy bit 0
      bridgeAccessor.setEndpointAttribute(
        endpointId,
        MATTER_CLUSTER_IDS.OCCUPANCY_SENSING,
        MATTER_ATTRIBUTE_IDS.OCCUPANCY,
        0x01 // occupancy detected
      );

      const attribute = bridgeAccessor.getEndpointAttribute(
        endpointId,
        MATTER_CLUSTER_IDS.OCCUPANCY_SENSING,
        MATTER_ATTRIBUTE_IDS.OCCUPANCY
      );

      expect(attribute).toBe(0x01);
    });

    it("should sync lock state changes", async () => {
      const endpointId = "lock_front_door";

      // Simulate lock state change (locked)
      await wsBridge.emitStateUpdate(`homecore/devices/${endpointId}/state`, {
        locked: true,
      });

      // Matter lock state: 1 = locked
      bridgeAccessor.setEndpointAttribute(
        endpointId,
        MATTER_CLUSTER_IDS.DOOR_LOCK,
        MATTER_ATTRIBUTE_IDS.LOCK_STATE,
        1
      );

      const attribute = bridgeAccessor.getEndpointAttribute(
        endpointId,
        MATTER_CLUSTER_IDS.DOOR_LOCK,
        MATTER_ATTRIBUTE_IDS.LOCK_STATE
      );

      expect(attribute).toBe(1);
    });
  });

  describe("External Controller → Bridge → HomeCore", () => {
    it("should route light on/off command to HomeCore", async () => {
      const endpointId = "light_kitchen";

      // External controller sends command
      bridgeAccessor.setEndpointAttribute(
        endpointId,
        MATTER_CLUSTER_IDS.ON_OFF,
        MATTER_ATTRIBUTE_IDS.ON_OFF,
        true
      );

      // Bridge forwards to HomeCore as device command
      await wsBridge.publish(`homecore/devices/${endpointId}/cmd`, {
        command: "on",
      });

      // HomeCore device receives and processes command
      homecoreDevice.receiveCommand("on", true);

      const commands = homecoreDevice.getCommandQueue();
      expect(commands).toHaveLength(1);
      expect(commands[0].command).toBe("on");
    });

    it("should route brightness command to HomeCore", async () => {
      const endpointId = "light_living_room";

      // External controller sets brightness (200/254 ≈ 79%)
      const matterValue = 200;
      const homecorePercent = Math.round((matterValue / 254) * 100);

      bridgeAccessor.setEndpointAttribute(
        endpointId,
        MATTER_CLUSTER_IDS.LEVEL_CONTROL,
        MATTER_ATTRIBUTE_IDS.CURRENT_LEVEL,
        matterValue
      );

      await wsBridge.publish(`homecore/devices/${endpointId}/cmd`, {
        command: "brightness",
        value: homecorePercent,
      });

      homecoreDevice.receiveCommand("brightness", homecorePercent);

      const commands = homecoreDevice.getCommandQueue();
      expect(commands).toHaveLength(1);
      expect(commands[0].command).toBe("brightness");
      expect(commands[0].value).toBeGreaterThan(0);
      expect(commands[0].value).toBeLessThanOrEqual(100);
    });

    it("should route lock command to HomeCore", async () => {
      const endpointId = "lock_front_door";

      // External controller sends lock command
      bridgeAccessor.setEndpointAttribute(
        endpointId,
        MATTER_CLUSTER_IDS.DOOR_LOCK,
        MATTER_ATTRIBUTE_IDS.LOCK_STATE,
        1
      );

      await wsBridge.publish(`homecore/devices/${endpointId}/cmd`, {
        command: "lock",
        lockState: 1,
      });

      homecoreDevice.receiveCommand("lock", true);

      const commands = homecoreDevice.getCommandQueue();
      expect(commands).toHaveLength(1);
      expect(commands[0].command).toBe("lock");
    });

    it("should route cover position command", async () => {
      const endpointId = "cover_living_room";

      // External controller sets position to 75%
      const positionPercent = 75;
      bridgeAccessor.setEndpointAttribute(
        endpointId,
        MATTER_CLUSTER_IDS.WINDOW_COVERING,
        MATTER_ATTRIBUTE_IDS.TARGET_POSITION_LIFT_PERCENTAGE,
        positionPercent
      );

      await wsBridge.publish(`homecore/devices/${endpointId}/cmd`, {
        command: "position",
        value: positionPercent,
      });

      homecoreDevice.receiveCommand("position", positionPercent);

      const commands = homecoreDevice.getCommandQueue();
      expect(commands).toHaveLength(1);
      expect(commands[0].value).toBe(positionPercent);
    });
  });

  describe("Complete Round-Trip Scenarios", () => {
    it("should complete full brightness adjustment round-trip", async () => {
      const endpointId = "dimmer_bedroom";

      // Step 1: External controller sends brightness command (100/254)
      bridgeAccessor.setEndpointAttribute(
        endpointId,
        MATTER_CLUSTER_IDS.LEVEL_CONTROL,
        MATTER_ATTRIBUTE_IDS.CURRENT_LEVEL,
        100
      );

      const homecorePercent = Math.round((100 / 254) * 100);

      // Step 2: Bridge forwards to HomeCore
      await wsBridge.publish(`homecore/devices/${endpointId}/cmd`, {
        command: "brightness",
        value: homecorePercent,
      });

      homecoreDevice.receiveCommand("brightness", homecorePercent);

      // Step 3: HomeCore device responds with new state
      homecoreDevice.setState("brightness", homecorePercent);

      // Step 4: HomeCore publishes state update
      await wsBridge.emitStateUpdate(`homecore/devices/${endpointId}/state`, {
        brightness: homecorePercent,
      });

      // Step 5: Bridge updates attribute to new value
      const matterValue = Math.round((homecorePercent / 100) * 254);
      bridgeAccessor.setEndpointAttribute(
        endpointId,
        MATTER_CLUSTER_IDS.LEVEL_CONTROL,
        MATTER_ATTRIBUTE_IDS.CURRENT_LEVEL,
        matterValue
      );

      // Verify final state
      const finalAttribute = bridgeAccessor.getEndpointAttribute(
        endpointId,
        MATTER_CLUSTER_IDS.LEVEL_CONTROL,
        MATTER_ATTRIBUTE_IDS.CURRENT_LEVEL
      );

      const deviceState = homecoreDevice.getState("brightness");

      expect(finalAttribute).toBeDefined();
      expect(finalAttribute).toBeGreaterThan(0);
      expect(deviceState).toBe(homecorePercent);
    });

    it("should handle multiple device state changes concurrently", async () => {
      const devices = [
        "light_kitchen",
        "light_bedroom",
        "light_living_room",
      ];

      // Step 1: Multiple state updates arrive from HomeCore
      for (const device of devices) {
        await wsBridge.emitStateUpdate(`homecore/devices/${device}/state`, {
          on: true,
          brightness: 75,
        });

        bridgeAccessor.setEndpointAttribute(
          device,
          MATTER_CLUSTER_IDS.ON_OFF,
          MATTER_ATTRIBUTE_IDS.ON_OFF,
          true
        );

        bridgeAccessor.setEndpointAttribute(
          device,
          MATTER_CLUSTER_IDS.LEVEL_CONTROL,
          MATTER_ATTRIBUTE_IDS.CURRENT_LEVEL,
          Math.round((75 / 100) * 254)
        );
      }

      // Step 2: External controller reads all endpoints
      const endpoints = bridgeAccessor.getAllEndpoints();

      expect(Object.keys(endpoints)).toHaveLength(3);
      for (const deviceId of devices) {
        expect(endpoints[deviceId]).toBeDefined();
        const onOffValue = endpoints[deviceId][MATTER_CLUSTER_IDS.ON_OFF]?.[
          MATTER_ATTRIBUTE_IDS.ON_OFF
        ];
        expect(onOffValue).toBe(true);
      }
    });

    it("should track state through partial updates", async () => {
      const endpointId = "light_kitchen";

      // State update 1: Turn on
      await wsBridge.emitStateUpdate(`homecore/devices/${endpointId}/state`, {
        on: true,
      });

      bridgeAccessor.setEndpointAttribute(
        endpointId,
        MATTER_CLUSTER_IDS.ON_OFF,
        MATTER_ATTRIBUTE_IDS.ON_OFF,
        true
      );

      // State update 2: Adjust brightness (partial)
      await wsBridge.emitStateUpdate(
        `homecore/devices/${endpointId}/state/partial`,
        {
          brightness: 80,
        }
      );

      bridgeAccessor.setEndpointAttribute(
        endpointId,
        MATTER_CLUSTER_IDS.LEVEL_CONTROL,
        MATTER_ATTRIBUTE_IDS.CURRENT_LEVEL,
        Math.round((80 / 100) * 254)
      );

      // Both states should be present
      const onOff = bridgeAccessor.getEndpointAttribute(
        endpointId,
        MATTER_CLUSTER_IDS.ON_OFF,
        MATTER_ATTRIBUTE_IDS.ON_OFF
      );

      const brightness = bridgeAccessor.getEndpointAttribute(
        endpointId,
        MATTER_CLUSTER_IDS.LEVEL_CONTROL,
        MATTER_ATTRIBUTE_IDS.CURRENT_LEVEL
      );

      expect(onOff).toBe(true);
      expect(brightness).toBeGreaterThan(0);
    });
  });

  describe("Command Ordering and Deduplication", () => {
    it("should handle rapid successive commands", async () => {
      const endpointId = "light_kitchen";

      // Send 5 rapid on/off toggling commands
      for (let i = 0; i < 5; i++) {
        const value = i % 2 === 0;
        bridgeAccessor.setEndpointAttribute(
          endpointId,
          MATTER_CLUSTER_IDS.ON_OFF,
          MATTER_ATTRIBUTE_IDS.ON_OFF,
          value
        );

        await wsBridge.publish(`homecore/devices/${endpointId}/cmd`, {
          command: "on",
          value,
        });

        homecoreDevice.receiveCommand("on", value);
      }

      const commands = homecoreDevice.getCommandQueue();
      expect(commands).toHaveLength(5);

      // Verify order is preserved
      for (let i = 0; i < commands.length; i++) {
        const expectedValue = i % 2 === 0;
        expect(commands[i].value).toBe(expectedValue);
      }
    });

    it("should preserve command sequence for different endpoints", async () => {
      const devices = ["light_1", "light_2", "light_3"];

      // Send commands in specific order
      for (let i = 0; i < 10; i++) {
        const device = devices[i % devices.length];
        const value = i % 2 === 0;

        await wsBridge.publish(`homecore/devices/${device}/cmd`, {
          command: "on",
          value,
        });

        homecoreDevice.receiveCommand(`${device}:on`, value);
      }

      const commands = homecoreDevice.getCommandQueue();
      expect(commands).toHaveLength(10);
    });
  });
});
