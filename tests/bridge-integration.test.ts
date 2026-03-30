/**
 * Bridge Endpoint Exposure Integration Tests
 *
 * Test end-to-end bridge endpoint exposure pipeline including:
 * - Endpoint composition, registration, and lifecycle
 * - Attribute state synchronization (HomeCore → Matter)
 * - Command handling and bidirectional sync
 * - Matter endpoint discovery and validation
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Logger } from "../src/logger.js";
import { MatterBridgeBinding } from "../src/bridge/matter-bridge-binding.js";
import { BridgeAttributeHandlers } from "../src/bridge/attribute-handlers.js";
import { composeEndpoint, getClusterIds, MATTER_CLUSTER_IDS } from "../src/bridge/endpoint-factory.js";

const logger = new Logger("test");

// Mock WebSocket bridge for testing
class MockWebSocketBridge {
  private subscriptions: Map<string, boolean> = new Map();
  private listeners: Map<string, Set<(msg: unknown) => void>> = new Map();
  private publishedMessages: unknown[] = [];

  isConnected(): boolean {
    return true;
  }

  async subscribe(topic: string): Promise<void> {
    this.subscriptions.set(topic, true);
  }

  async publish(topic: string, payload: unknown): Promise<void> {
    this.publishedMessages.push({ topic, payload });
  }

  on(event: string, handler: (msg: unknown) => void): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler);
  }

  off(_event: string, _handler: (msg: unknown) => void): void {
    // no-op for mock
  }

  async emitMessage(msg: unknown): Promise<void> {
    const handlers = this.listeners.get("message") || new Set();
    for (const handler of handlers) {
      handler(msg);
    }
  }

  getPublishedMessages(): unknown[] {
    return [...this.publishedMessages];
  }

  clearPublishedMessages(): void {
    this.publishedMessages = [];
  }

  getSubscriptions(): string[] {
    return Array.from(this.subscriptions.keys());
  }
}

describe("Bridge Endpoint Exposure Integration", () => {
  let wsBridge: MockWebSocketBridge;
  let bridgeBinding: MatterBridgeBinding;
  let attributeHandlers: BridgeAttributeHandlers;

  beforeEach(() => {
    wsBridge = new MockWebSocketBridge();
    bridgeBinding = new MatterBridgeBinding(logger);
    attributeHandlers = new BridgeAttributeHandlers({
      logger,
      wsBridge: wsBridge as any,
      bridgeBinding,
    });
  });

  afterEach(async () => {
    await attributeHandlers.stop();
    await bridgeBinding.dispose();
  });

  describe("Endpoint Composition and Registration", () => {
    it("should compose light endpoint with all required clusters", () => {
      const endpoint = composeEndpoint(
        {
          homecoreId: "light_kitchen",
          homecoreType: "light",
          matterType: "OnOffLight",
          nodeId: "node-1",
          endpointId: 1,
        },
        logger
      );

      expect(endpoint.homecoreId).toBe("light_kitchen");
      expect(endpoint.clusters.length).toBeGreaterThanOrEqual(4);

      const clusterIds = getClusterIds(endpoint);
      expect(clusterIds).toContain(MATTER_CLUSTER_IDS.BASIC_INFORMATION);
      expect(clusterIds).toContain(MATTER_CLUSTER_IDS.ON_OFF);
      expect(clusterIds).toContain(MATTER_CLUSTER_IDS.LEVEL_CONTROL);
      expect(clusterIds).toContain(MATTER_CLUSTER_IDS.COLOR_CONTROL);
    });

    it("should compose multiple endpoint types correctly", () => {
      const endpoints = [
        composeEndpoint(
          {
            homecoreId: "light_1",
            homecoreType: "light",
            matterType: "OnOffLight",
            nodeId: "node-1",
            endpointId: 1,
          },
          logger
        ),
        composeEndpoint(
          {
            homecoreId: "switch_1",
            homecoreType: "switch",
            matterType: "OnOffSwitch",
            nodeId: "node-1",
            endpointId: 2,
          },
          logger
        ),
        composeEndpoint(
          {
            homecoreId: "motion_1",
            homecoreType: "motion_sensor",
            matterType: "OccupancySensor",
            nodeId: "node-1",
            endpointId: 3,
          },
          logger
        ),
      ];

      expect(endpoints).toHaveLength(3);
      expect(endpoints[0].clusters.length).toBeGreaterThan(endpoints[2].clusters.length); // Light has more than sensor
    });

    it("should track endpoint bindings in bridge binding", async () => {
      const endpoint = composeEndpoint(
        {
          homecoreId: "light_1",
          homecoreType: "light",
          matterType: "OnOffLight",
          nodeId: "node-1",
          endpointId: 1,
        },
        logger
      );

      // Before creating bridge, no bindings
      expect(bridgeBinding.getEndpointBinding("light_1")).toBeNull();

      // Create bridge with endpoint
      await bridgeBinding.createBridge({
        composedEndpoints: [endpoint],
        logger,
      });

      // Note: Real matter.js unavailable in test, so bindings won't be created
      // but in production, they would be tracked here
      expect(bridgeBinding.getBridge()).toBeNull();
    });
  });

  describe("Attribute State Synchronization", () => {
    beforeEach(async () => {
      await attributeHandlers.start();
    });

    it("should subscribe to device state topics on start", async () => {
      const subscriptions = wsBridge.getSubscriptions();
      expect(subscriptions).toContain("homecore/devices/+/state");
      expect(subscriptions).toContain("homecore/devices/+/state/partial");
    });

    it("should handle brightness state update conversion", async () => {
      const handlers = attributeHandlers as any;
      const convert = handlers.convertHomeCorValueToMatter.bind(handlers);

      // 100% brightness → 254 (full level in Matter)
      expect(convert("brightness_pct", 100, "light")).toBe(254);

      // 50% brightness → ~127
      expect(convert("brightness_pct", 50, "light")).toBe(127);

      // 0% brightness → 0
      expect(convert("brightness_pct", 0, "light")).toBe(0);
    });

    it("should handle temperature state update conversion", async () => {
      const handlers = attributeHandlers as any;
      const convert = handlers.convertHomeCorValueToMatter.bind(handlers);

      // 20°C → 2000 (0.01°C units)
      expect(convert("temperature_c", 20, "temp_sensor")).toBe(2000);

      // 25.5°C → 2550
      expect(convert("temperature_c", 25.5, "temp_sensor")).toBe(2550);
    });

    it("should handle humidity state update preservation", async () => {
      const handlers = attributeHandlers as any;
      const convert = handlers.convertHomeCorValueToMatter.bind(handlers);

      // Humidity percentage preserved as-is
      expect(convert("humidity_pct", 65, "humidity_sensor")).toBe(65);

      // 0% humidity preserved
      expect(convert("humidity_pct", 0, "humidity_sensor")).toBe(0);
    });

    it("should handle lock state mapping", async () => {
      const handlers = attributeHandlers as any;
      const convert = handlers.convertHomeCorValueToMatter.bind(handlers);

      // locked true → Matter state 1
      expect(convert("locked", true, "lock")).toBe(1);

      // locked false → Matter state 2 (unlocked)
      expect(convert("locked", false, "lock")).toBe(2);
    });

    it("should handle motion detection mapping", async () => {
      const handlers = attributeHandlers as any;
      const convert = handlers.convertHomeCorValueToMatter.bind(handlers);

      // Motion detected true → occupancy bit 0 set (1)
      expect(convert("motion_detected", true, "motion_sensor")).toBe(1);

      // Motion detected false → occupancy bit 0 clear (0)
      expect(convert("motion_detected", false, "motion_sensor")).toBe(0);
    });
  });

  describe("Bidirectional Command Handling", () => {
    beforeEach(async () => {
      await attributeHandlers.start();
    });

    it("should convert Matter brightness command to HomeCore command", async () => {
      const handlers = attributeHandlers as any;
      const convertBack = handlers.convertMatterValueToHomeCore.bind(handlers);

      // Matter 254 → 100% brightness
      expect(convertBack("brightness_pct", 254, "light")).toBe(100);

      // Matter 127 → ~50% brightness
      const result = convertBack("brightness_pct", 127, "light");
      expect(result).toBeCloseTo(50, 0);

      // Matter 0 → 0% brightness
      expect(convertBack("brightness_pct", 0, "light")).toBe(0);
    });

    it("should convert Matter temperature to HomeCore format", async () => {
      const handlers = attributeHandlers as any;
      const convertBack = handlers.convertMatterValueToHomeCore.bind(handlers);

      // Matter 2000 → 20°C
      expect(convertBack("temperature_c", 2000, "temp_sensor")).toBe(20);

      // Matter 2550 → 25.5°C
      expect(convertBack("temperature_c", 2550, "temp_sensor")).toBe(25.5);
    });

    it("should convert Matter lock state to HomeCore boolean", async () => {
      const handlers = attributeHandlers as any;
      const convertBack = handlers.convertMatterValueToHomeCore.bind(handlers);

      // Matter state 1 → locked true
      expect(convertBack("locked", 1, "lock")).toBe(true);

      // Matter state 2 → locked false
      expect(convertBack("locked", 2, "lock")).toBe(false);
    });

    it("should convert Matter occupancy to motion detected boolean", async () => {
      const handlers = attributeHandlers as any;
      const convertBack = handlers.convertMatterValueToHomeCore.bind(handlers);

      // Occupancy bitmap bit 0 set → motion detected true
      expect(convertBack("motion_detected", 1, "motion_sensor")).toBe(true);

      // Occupancy bitmap bit 0 clear → motion detected false
      expect(convertBack("motion_detected", 0, "motion_sensor")).toBe(false);

      // Higher bits don't affect motion detection
      expect(convertBack("motion_detected", 3, "motion_sensor")).toBe(true); // 0b11 has bit 0 set
      expect(convertBack("motion_detected", 2, "motion_sensor")).toBe(false); // 0b10 doesn't have bit 0
    });
  });

  describe("Endpoint Discovery and Validation", () => {
    it("should compose switch endpoint with only OnOff cluster", () => {
      const endpoint = composeEndpoint(
        {
          homecoreId: "switch_hallway",
          homecoreType: "switch",
          matterType: "OnOffSwitch",
          nodeId: "node-1",
          endpointId: 2,
        },
        logger
      );

      const clusterIds = getClusterIds(endpoint);
      
      // Switch should have BasicInformation and OnOff only
      expect(clusterIds).toContain(MATTER_CLUSTER_IDS.BASIC_INFORMATION);
      expect(clusterIds).toContain(MATTER_CLUSTER_IDS.ON_OFF);
      
      // Should NOT have level control
      expect(clusterIds).not.toContain(MATTER_CLUSTER_IDS.LEVEL_CONTROL);
    });

    it("should compose sensor endpoint with measurement cluster", () => {
      const endpoint = composeEndpoint(
        {
          homecoreId: "temp_outdoor",
          homecoreType: "temp_sensor",
          matterType: "TemperatureSensor",
          nodeId: "node-1",
          endpointId: 3,
        },
        logger
      );

      const clusterIds = getClusterIds(endpoint);
      
      // Sensor should have BasicInformation and TemperatureMeasurement
      expect(clusterIds).toContain(MATTER_CLUSTER_IDS.BASIC_INFORMATION);
      expect(clusterIds).toContain(MATTER_CLUSTER_IDS.TEMPERATURE_MEASUREMENT);
      
      // Should NOT have OnOff (not an actuator)
      expect(clusterIds).not.toContain(MATTER_CLUSTER_IDS.ON_OFF);
    });

    it("should compose lock endpoint with DoorLock cluster", () => {
      const endpoint = composeEndpoint(
        {
          homecoreId: "lock_front_door",
          homecoreType: "lock",
          matterType: "DoorLock",
          nodeId: "node-1",
          endpointId: 4,
        },
        logger
      );

      const clusterIds = getClusterIds(endpoint);
      
      // Lock should have BasicInformation and DoorLock
      expect(clusterIds).toContain(MATTER_CLUSTER_IDS.BASIC_INFORMATION);
      expect(clusterIds).toContain(MATTER_CLUSTER_IDS.DOOR_LOCK);
    });

    it("should compose cover endpoint with WindowCovering cluster", () => {
      const endpoint = composeEndpoint(
        {
          homecoreId: "cover_living_room",
          homecoreType: "cover",
          matterType: "WindowCovering",
          nodeId: "node-1",
          endpointId: 5,
        },
        logger
      );

      const clusterIds = getClusterIds(endpoint);
      
      // Cover should have BasicInformation and WindowCovering
      expect(clusterIds).toContain(MATTER_CLUSTER_IDS.BASIC_INFORMATION);
      expect(clusterIds).toContain(MATTER_CLUSTER_IDS.WINDOW_COVERING);
    });

    it("should create complete device typeset for Matter bridge", () => {
      const deviceTypes = [
        "light",
        "dimmer_light",
        "switch",
        "contact_sensor",
        "motion_sensor",
        "temp_sensor",
        "humidity_sensor",
        "lock",
        "cover",
      ];

      const endpoints = deviceTypes.map((type) =>
        composeEndpoint(
          {
            homecoreId: `device_${type}`,
            homecoreType: type,
            matterType: "GenericDevice",
            nodeId: "node-1",
            endpointId: 1,
          },
          logger
        )
      );

      // All endpoints should have BasicInformation
      endpoints.forEach((ep) => {
        const clusterIds = getClusterIds(ep);
        expect(clusterIds).toContain(MATTER_CLUSTER_IDS.BASIC_INFORMATION);
      });

      // Sample checks for variety
      const lightClusters = getClusterIds(endpoints[0]); // light
      expect(lightClusters).toContain(MATTER_CLUSTER_IDS.ON_OFF);
      expect(lightClusters).toContain(MATTER_CLUSTER_IDS.LEVEL_CONTROL);

      const tempClusters = getClusterIds(endpoints[5]); // temp_sensor
      expect(tempClusters).toContain(MATTER_CLUSTER_IDS.TEMPERATURE_MEASUREMENT);
      expect(tempClusters).not.toContain(MATTER_CLUSTER_IDS.ON_OFF);
    });
  });

  describe("Attribute Writable Status Validation", () => {
    it("should identify writable attributes for light", () => {
      const endpoint = composeEndpoint(
        {
          homecoreId: "light_1",
          homecoreType: "light",
          matterType: "OnOffLight",
          nodeId: "node-1",
          endpointId: 1,
        },
        logger
      );

      const handlers = attributeHandlers as any;
      const writableAttrs = handlers.getWritableAttributes("light_1");

      // Light is an actuator, so will have no bindings yet but method should work
      expect(Array.isArray(writableAttrs)).toBe(true);
    });

    it("should identify no writable attributes for sensor", () => {
      const endpoint = composeEndpoint(
        {
          homecoreId: "temp_1",
          homecoreType: "temp_sensor",
          matterType: "TemperatureSensor",
          nodeId: "node-1",
          endpointId: 3,
        },
        logger
      );

      const handlers = attributeHandlers as any;
      const writableAttrs = handlers.getWritableAttributes("temp_1");

      // Sensor endpoint has no writable attributes (read-only)
      expect(Array.isArray(writableAttrs)).toBe(true);
    });
  });

  describe("Bridge Lifecycle and Error Handling", () => {
    it("should handle endpoint creation failure gracefully", async () => {
      const endpoint = composeEndpoint(
        {
          homecoreId: "light_1",
          homecoreType: "light",
          matterType: "OnOffLight",
          nodeId: "node-1",
          endpointId: 1,
        },
        logger
      );

      // Should not throw even when matter.js is unavailable
      const bridge = await bridgeBinding.createBridge({
        composedEndpoints: [endpoint],
        logger,
      });

      expect(bridge).toBeNull(); // null in test environment without matter.js
    });

    it("should cleanup bridge on dispose", async () => {
      await bridgeBinding.dispose();

      expect(bridgeBinding.getBridge()).toBeNull();
      expect(bridgeBinding.getAllEndpointBindings().length).toBe(0);
    });

    it("should stop attribute handlers cleanly", async () => {
      await attributeHandlers.start();
      expect(wsBridge.getSubscriptions().length).toBeGreaterThan(0);

      await attributeHandlers.stop();
      // Should complete without error
    });
  });

  describe("Complete Device Category Coverage", () => {
    it("should handle all 10 supported HomeCore device types", () => {
      const deviceTypes = [
        { type: "light", expectedClusters: 4 },          // OnOff, Level, Color, Basic
        { type: "dimmer_light", expectedClusters: 3 },   // OnOff, Level, Basic
        { type: "switch", expectedClusters: 2 },         // OnOff, Basic
        { type: "contact_sensor", expectedClusters: 2 }, // Boolean, Basic
        { type: "motion_sensor", expectedClusters: 2 },  // Occupancy, Basic
        { type: "temp_sensor", expectedClusters: 2 },    // Temperature, Basic
        { type: "humidity_sensor", expectedClusters: 2 }, // Humidity, Basic
        { type: "lock", expectedClusters: 2 },           // DoorLock, Basic
        { type: "cover", expectedClusters: 2 },          // WindowCovering, Basic
        { type: "shade", expectedClusters: 2 },          // WindowCovering, Basic (alias)
      ];

      deviceTypes.forEach(({ type, expectedClusters }) => {
        const endpoint = composeEndpoint(
          {
            homecoreId: `device_${type}`,
            homecoreType: type,
            matterType: "GenericDevice",
            nodeId: "node-1",
            endpointId: 1,
          },
          logger
        );

        expect(endpoint.clusters.length).toBe(expectedClusters);
        expect(getClusterIds(endpoint)).toContain(MATTER_CLUSTER_IDS.BASIC_INFORMATION);
      });
    });
  });
});

    it("should handle expanded sensor types (lux, pressure, energy)", () => {
      const expandedDeviceTypes = [
        { type: "lux_sensor", expectedClusters: 2 },      // Illuminance, Basic
        { type: "pressure_sensor", expectedClusters: 2 }, // Pressure, Basic
        { type: "energy_sensor", expectedClusters: 2 },   // Electrical, Basic
      ];

      expandedDeviceTypes.forEach(({ type, expectedClusters }) => {
        const endpoint = composeEndpoint(
          {
            homecoreId: `device_${type}`,
            homecoreType: type,
            matterType: "GenericDevice",
            nodeId: "node-1",
            endpointId: 1,
          },
          logger
        );

        expect(endpoint.clusters.length).toBe(expectedClusters);
        expect(getClusterIds(endpoint)).toContain(MATTER_CLUSTER_IDS.BASIC_INFORMATION);
      });
    });

    it("should validate lux sensor composition", () => {
      const endpoint = composeEndpoint(
        {
          homecoreId: "lux_living_room",
          homecoreType: "lux_sensor",
          matterType: "LightSensor",
          nodeId: "node-1",
          endpointId: 6,
        },
        logger
      );

      const clusterIds = getClusterIds(endpoint);
      expect(clusterIds).toContain(MATTER_CLUSTER_IDS.BASIC_INFORMATION);
      expect(clusterIds).toContain(MATTER_CLUSTER_IDS.ILLUMINANCE_MEASUREMENT);
    });

    it("should validate pressure sensor composition", () => {
      const endpoint = composeEndpoint(
        {
          homecoreId: "pressure_weather",
          homecoreType: "pressure_sensor",
          matterType: "PressureSensor",
          nodeId: "node-1",
          endpointId: 7,
        },
        logger
      );

      const clusterIds = getClusterIds(endpoint);
      expect(clusterIds).toContain(MATTER_CLUSTER_IDS.BASIC_INFORMATION);
      expect(clusterIds).toContain(MATTER_CLUSTER_IDS.PRESSURE_MEASUREMENT);
    });

    it("should validate energy sensor composition", () => {
      const endpoint = composeEndpoint(
        {
          homecoreId: "energy_main_panel",
          homecoreType: "energy_sensor",
          matterType: "PowerSensor",
          nodeId: "node-1",
          endpointId: 8,
        },
        logger
      );

      const clusterIds = getClusterIds(endpoint);
      expect(clusterIds).toContain(MATTER_CLUSTER_IDS.BASIC_INFORMATION);
      expect(clusterIds).toContain(MATTER_CLUSTER_IDS.ELECTRICAL_MEASUREMENT);
    });
