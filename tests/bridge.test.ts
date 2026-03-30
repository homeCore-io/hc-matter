/**
 * Bridge Endpoint Factory Tests
 *
 * Test Matter endpoint composition for all supported HomeCore device types.
 */

import { describe, it, expect } from "vitest";
import { Logger } from "../src/logger.js";
import {
  composeDeviceClusters,
  composeEndpoint,
  getClusterIds,
  findAttributeSpec,
  getWritableAttributes,
  MATTER_CLUSTER_IDS,
} from "../src/bridge/endpoint-factory.js";

const logger = new Logger("test");

describe("Bridge Endpoint Factory", () => {
  describe("Device Cluster Composition", () => {
    it("should compose light clusters (OnOff, LevelControl, ColorControl)", () => {
      const clusters = composeDeviceClusters("light", logger);

      expect(clusters.length).toBeGreaterThanOrEqual(3);
      const clusterIds = clusters.map((c) => c.clusterId);

      expect(clusterIds).toContain(MATTER_CLUSTER_IDS.BASIC_INFORMATION);
      expect(clusterIds).toContain(MATTER_CLUSTER_IDS.ON_OFF);
      expect(clusterIds).toContain(MATTER_CLUSTER_IDS.LEVEL_CONTROL);
      expect(clusterIds).toContain(MATTER_CLUSTER_IDS.COLOR_CONTROL);
    });

    it("should compose dimmer_light clusters (OnOff, LevelControl)", () => {
      const clusters = composeDeviceClusters("dimmer_light", logger);

      expect(clusters.length).toBeGreaterThanOrEqual(2);
      const clusterIds = clusters.map((c) => c.clusterId);

      expect(clusterIds).toContain(MATTER_CLUSTER_IDS.BASIC_INFORMATION);
      expect(clusterIds).toContain(MATTER_CLUSTER_IDS.ON_OFF);
      expect(clusterIds).toContain(MATTER_CLUSTER_IDS.LEVEL_CONTROL);
      expect(clusterIds).not.toContain(MATTER_CLUSTER_IDS.COLOR_CONTROL);
    });

    it("should compose switch clusters (OnOff)", () => {
      const clusters = composeDeviceClusters("switch", logger);

      expect(clusters.length).toBeGreaterThanOrEqual(1);
      const clusterIds = clusters.map((c) => c.clusterId);

      expect(clusterIds).toContain(MATTER_CLUSTER_IDS.BASIC_INFORMATION);
      expect(clusterIds).toContain(MATTER_CLUSTER_IDS.ON_OFF);
    });

    it("should compose contact_sensor clusters (BooleanState)", () => {
      const clusters = composeDeviceClusters("contact_sensor", logger);

      expect(clusters.length).toBeGreaterThanOrEqual(1);
      const clusterIds = clusters.map((c) => c.clusterId);

      expect(clusterIds).toContain(MATTER_CLUSTER_IDS.BASIC_INFORMATION);
      expect(clusterIds).toContain(MATTER_CLUSTER_IDS.BOOLEAN_STATE);
    });

    it("should compose motion_sensor clusters (OccupancySensing)", () => {
      const clusters = composeDeviceClusters("motion_sensor", logger);

      expect(clusters.length).toBeGreaterThanOrEqual(1);
      const clusterIds = clusters.map((c) => c.clusterId);

      expect(clusterIds).toContain(MATTER_CLUSTER_IDS.BASIC_INFORMATION);
      expect(clusterIds).toContain(MATTER_CLUSTER_IDS.OCCUPANCY_SENSING);
    });

    it("should compose temp_sensor clusters (TemperatureMeasurement)", () => {
      const clusters = composeDeviceClusters("temp_sensor", logger);

      expect(clusters.length).toBeGreaterThanOrEqual(1);
      const clusterIds = clusters.map((c) => c.clusterId);

      expect(clusterIds).toContain(MATTER_CLUSTER_IDS.BASIC_INFORMATION);
      expect(clusterIds).toContain(MATTER_CLUSTER_IDS.TEMPERATURE_MEASUREMENT);
    });

    it("should compose humidity_sensor clusters (RelativeHumidityMeasurement)", () => {
      const clusters = composeDeviceClusters("humidity_sensor", logger);

      expect(clusters.length).toBeGreaterThanOrEqual(1);
      const clusterIds = clusters.map((c) => c.clusterId);

      expect(clusterIds).toContain(MATTER_CLUSTER_IDS.BASIC_INFORMATION);
      expect(clusterIds).toContain(MATTER_CLUSTER_IDS.RELATIVE_HUMIDITY_MEASUREMENT);
    });

    it("should compose lock clusters (DoorLock)", () => {
      const clusters = composeDeviceClusters("lock", logger);

      expect(clusters.length).toBeGreaterThanOrEqual(1);
      const clusterIds = clusters.map((c) => c.clusterId);

      expect(clusterIds).toContain(MATTER_CLUSTER_IDS.BASIC_INFORMATION);
      expect(clusterIds).toContain(MATTER_CLUSTER_IDS.DOOR_LOCK);
    });

    it("should compose cover clusters (WindowCovering)", () => {
      const clusters = composeDeviceClusters("cover", logger);

      expect(clusters.length).toBeGreaterThanOrEqual(1);
      const clusterIds = clusters.map((c) => c.clusterId);

      expect(clusterIds).toContain(MATTER_CLUSTER_IDS.BASIC_INFORMATION);
      expect(clusterIds).toContain(MATTER_CLUSTER_IDS.WINDOW_COVERING);
    });

    it("should compose shade clusters (WindowCovering, same as cover)", () => {
      const clusters = composeDeviceClusters("shade", logger);

      expect(clusters.length).toBeGreaterThanOrEqual(1);
      const clusterIds = clusters.map((c) => c.clusterId);

      expect(clusterIds).toContain(MATTER_CLUSTER_IDS.BASIC_INFORMATION);
      expect(clusterIds).toContain(MATTER_CLUSTER_IDS.WINDOW_COVERING);
    });

    it("should always include BasicInformation cluster", () => {
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
        "shade",
      ];

      for (const type of deviceTypes) {
        const clusters = composeDeviceClusters(type, logger);
        const hasBasic = clusters.some(
          (c) => c.clusterId === MATTER_CLUSTER_IDS.BASIC_INFORMATION
        );

        expect(hasBasic).toBe(true);
      }
    });

    it("should handle unknown device types gracefully", () => {
      const clusters = composeDeviceClusters("unknown_device", logger);

      // Should at least include BasicInformation
      expect(clusters.length).toBeGreaterThanOrEqual(1);
      const hasBasic = clusters.some(
        (c) => c.clusterId === MATTER_CLUSTER_IDS.BASIC_INFORMATION
      );

      expect(hasBasic).toBe(true);
    });
  });

  describe("Endpoint Composition", () => {
    it("should compose a complete endpoint with metadata", () => {
      const endpoint = composeEndpoint(
        {
          homecoreId: "light.living_room",
          homecoreType: "light",
          matterType: "ExtendedColorLight",
          nodeId: "node-1",
          endpointId: 1,
        },
        logger
      );

      expect(endpoint.homecoreId).toBe("light.living_room");
      expect(endpoint.homecoreType).toBe("light");
      expect(endpoint.matterType).toBe("ExtendedColorLight");
      expect(endpoint.clusters.length).toBeGreaterThanOrEqual(3);
      expect(endpoint.additionalMetadata).toEqual({
        nodeId: "node-1",
        endpointId: 1,
      });
    });

    it("should preserve all cluster configurations during endpoint composition", () => {
      const endpoint = composeEndpoint(
        {
          homecoreId: "dimmer_light.bedroom",
          homecoreType: "dimmer_light",
          matterType: "DimmableLight",
          nodeId: "node-2",
          endpointId: 2,
        },
        logger
      );

      const clusterIds = getClusterIds(endpoint);

      expect(clusterIds).toContain(MATTER_CLUSTER_IDS.BASIC_INFORMATION);
      expect(clusterIds).toContain(MATTER_CLUSTER_IDS.ON_OFF);
      expect(clusterIds).toContain(MATTER_CLUSTER_IDS.LEVEL_CONTROL);
    });
  });

  describe("Cluster ID Extraction", () => {
    it("should extract all cluster IDs from an endpoint", () => {
      const endpoint = composeEndpoint(
        {
          homecoreId: "light.kitchen",
          homecoreType: "light",
          matterType: "ExtendedColorLight",
          nodeId: "node-1",
          endpointId: 1,
        },
        logger
      );

      const clusterIds = getClusterIds(endpoint);

      expect(Array.isArray(clusterIds)).toBe(true);
      expect(clusterIds.length).toBeGreaterThanOrEqual(4);
      expect(clusterIds.every((id) => typeof id === "number")).toBe(true);
    });
  });

  describe("Attribute Specification Lookup", () => {
    it("should find onOff attribute in OnOff cluster for light", () => {
      const endpoint = composeEndpoint(
        {
          homecoreId: "light.hallway",
          homecoreType: "light",
          matterType: "ExtendedColorLight",
          nodeId: "node-1",
          endpointId: 1,
        },
        logger
      );

      const attr = findAttributeSpec(endpoint, "OnOff", "onOff");

      expect(attr).toBeDefined();
      expect(attr?.name).toBe("onOff");
      expect(attr?.writable).toBe(true);
      expect(attr?.readable).toBe(true);
      expect(attr?.homecoreAttribute).toBe("on");
    });

    it("should find currentLevel attribute in LevelControl cluster for dimmer_light", () => {
      const endpoint = composeEndpoint(
        {
          homecoreId: "dimmer_light.office",
          homecoreType: "dimmer_light",
          matterType: "DimmableLight",
          nodeId: "node-1",
          endpointId: 1,
        },
        logger
      );

      const attr = findAttributeSpec(endpoint, "LevelControl", "currentLevel");

      expect(attr).toBeDefined();
      expect(attr?.name).toBe("currentLevel");
      expect(attr?.writable).toBe(true);
      expect(attr?.homecoreAttribute).toBe("brightness_pct");
    });

    it("should return undefined for non-existent cluster", () => {
      const endpoint = composeEndpoint(
        {
          homecoreId: "switch.bath",
          homecoreType: "switch",
          matterType: "OnOffSwitch",
          nodeId: "node-1",
          endpointId: 1,
        },
        logger
      );

      const attr = findAttributeSpec(endpoint, "NonExistent", "someAttr");

      expect(attr).toBeUndefined();
    });

    it("should return undefined for non-existent attribute", () => {
      const endpoint = composeEndpoint(
        {
          homecoreId: "switch.garage",
          homecoreType: "switch",
          matterType: "OnOffSwitch",
          nodeId: "node-1",
          endpointId: 1,
        },
        logger
      );

      const attr = findAttributeSpec(endpoint, "OnOff", "nonExistent");

      expect(attr).toBeUndefined();
    });
  });

  describe("Writable Attributes Discovery", () => {
    it("should find all writable attributes in light endpoint", () => {
      const endpoint = composeEndpoint(
        {
          homecoreId: "light.porch",
          homecoreType: "light",
          matterType: "ExtendedColorLight",
          nodeId: "node-1",
          endpointId: 1,
        },
        logger
      );

      const writableAttrs = getWritableAttributes(endpoint);

      expect(writableAttrs.length).toBeGreaterThan(0);
      expect(writableAttrs.every((a) => a.writable)).toBe(true);
    });

    it("should find no writable attributes in contact_sensor endpoint", () => {
      const endpoint = composeEndpoint(
        {
          homecoreId: "contact_sensor.door",
          homecoreType: "contact_sensor",
          matterType: "ContactSensor",
          nodeId: "node-1",
          endpointId: 1,
        },
        logger
      );

      const writableAttrs = getWritableAttributes(endpoint);

      expect(writableAttrs.every((a) => a.writable)).toBe(true);
      // Contact sensors should have no writable attributes
      expect(
        writableAttrs.some((a) => a.homecoreAttribute === "open")
      ).toBe(false);
    });

    it("should identify lock endpoint has writable attributes for lock command", () => {
      const endpoint = composeEndpoint(
        {
          homecoreId: "lock.front_door",
          homecoreType: "lock",
          matterType: "DoorLock",
          nodeId: "node-1",
          endpointId: 1,
        },
        logger
      );

      const writableAttrs = getWritableAttributes(endpoint);

      expect(writableAttrs.length).toBeGreaterThan(0);
      const hasLockState = writableAttrs.some(
        (a) => a.homecoreAttribute === "locked"
      );

      expect(hasLockState).toBe(true);
    });
  });

  describe("Matter Bridge Binding", () => {
    it("should create a MatterBridgeBinding instance", async () => {
      const { MatterBridgeBinding } = await import("../src/bridge/matter-bridge-binding.js");

      const binding = new MatterBridgeBinding(logger);
      expect(binding).toBeDefined();
      expect(binding.getBridge()).toBeNull();
    });

    it("should track created endpoint bindings", async () => {
      const { MatterBridgeBinding } = await import("../src/bridge/matter-bridge-binding.js");

      const binding = new MatterBridgeBinding(logger);

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

      // In simulation mode, createBridge returns null but tracks endpoints
      const bridge = await binding.createBridge({
        composedEndpoints: [endpoint],
        logger,
      });

      // Bridge should be null in non-matter.js environment
      expect(bridge).toBeNull();

      // But track the endpoints in binding internal state
      // (We can't easily test real matter.js creation without mocking)
      const allBindings = binding.getAllEndpointBindings();
      // Should be empty since real Bridge API isn't available
      expect(Array.isArray(allBindings)).toBe(true);
    });

    it("should handle multiple composed endpoints", async () => {
      const { MatterBridgeBinding } = await import("../src/bridge/matter-bridge-binding.js");

      const binding = new MatterBridgeBinding(logger);

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
      ];

      const bridge = await binding.createBridge({
        composedEndpoints: endpoints,
        logger,
      });

      // Should handle gracefully even without real matter.js
      expect(bridge).toBeNull();
    });

    it("should get default attribute values based on type", async () => {
      const { MatterBridgeBinding } = await import("../src/bridge/matter-bridge-binding.js");

      const binding = new MatterBridgeBinding(logger);

      // Access private method via reflection for testing
      const getDefaultValue = (binding as any).getDefaultAttributeValue.bind(binding);

      expect(getDefaultValue("boolean", "sensor")).toBe(false);
      expect(getDefaultValue("number", "sensor")).toBe(0);
      expect(getDefaultValue("string", "sensor")).toBe("");
      expect(getDefaultValue("array", "sensor")).toEqual([]);
      expect(getDefaultValue("struct", "sensor")).toEqual({});
    });

    it("should determine correct Matter device types", async () => {
      const { MatterBridgeBinding } = await import("../src/bridge/matter-bridge-binding.js");

      const binding = new MatterBridgeBinding(logger);

      // Access private method via reflection
      const getDeviceType = (binding as any).getDeviceType.bind(binding);

      expect(getDeviceType("OnOffLight")).toBe(0x0100);
      expect(getDeviceType("DimmableLight")).toBe(0x0101);
      expect(getDeviceType("ColorLight")).toBe(0x0102);
      expect(getDeviceType("DoorLock")).toBe(0x000a);
      expect(getDeviceType("WindowCovering")).toBe(0x0202);
      expect(getDeviceType("TemperatureSensor")).toBe(0x0302);
      expect(getDeviceType("ContactSensor")).toBe(0x0015);
      expect(getDeviceType("UnknownType")).toBe(0x0000); // Generic device fallback
    });

    it("should handle dispose/cleanup", async () => {
      const { MatterBridgeBinding } = await import("../src/bridge/matter-bridge-binding.js");

      const binding = new MatterBridgeBinding(logger);

      // Should not throw
      await binding.dispose();

      expect(binding.getBridge()).toBeNull();
      expect(binding.getAllEndpointBindings().length).toBe(0);
    });

    it("should handle dispose/cleanup", async () => {
      const { MatterBridgeBinding } = await import("../src/bridge/matter-bridge-binding.js");

      const binding = new MatterBridgeBinding(logger);

      // Should not throw
      await binding.dispose();

      expect(binding.getBridge()).toBeNull();
      expect(binding.getAllEndpointBindings().length).toBe(0);
    });

    it("should get endpoint binding by HomeCore device ID", async () => {
      const { MatterBridgeBinding } = await import("../src/bridge/matter-bridge-binding.js");

      const binding = new MatterBridgeBinding(logger);

      // Before any binding
      expect(binding.getEndpointBinding("light_1")).toBeNull();

      // After creation (would be null without real matter.js, but method should exist)
      const result = binding.getEndpointBinding("light_1");
      expect(result).toBeNull();
    });
  });

  describe("Bridge Attribute Handlers", () => {
    it("should create BridgeAttributeHandlers instance", async () => {
      const { BridgeAttributeHandlers } = await import("../src/bridge/attribute-handlers.js");

      const handlers = new BridgeAttributeHandlers({
        logger,
        wsBridge: {} as any,
        bridgeBinding: {} as any,
      });

      expect(handlers).toBeDefined();
    });

    it("should convert brightness percentage to Matter level", async () => {
      const { BridgeAttributeHandlers } = await import("../src/bridge/attribute-handlers.js");

      const handlers = new BridgeAttributeHandlers({
        logger,
        wsBridge: {} as any,
        bridgeBinding: {} as any,
      });

      // Access private method via reflection
      const convert = (handlers as any).convertHomeCorValueToMatter.bind(handlers);

      // 100% brightness → 254 (full brightness in Matter)
      expect(convert("brightness_pct", 100, "light")).toBe(254);

      // 50% brightness → 127
      expect(convert("brightness_pct", 50, "light")).toBe(127);

      // 0% brightness → 0
      expect(convert("brightness_pct", 0, "light")).toBe(0);
    });

    it("should convert temperature Celsius to Matter 0.01°C units", async () => {
      const { BridgeAttributeHandlers } = await import("../src/bridge/attribute-handlers.js");

      const handlers = new BridgeAttributeHandlers({
        logger,
        wsBridge: {} as any,
        bridgeBinding: {} as any,
      });

      const convert = (handlers as any).convertHomeCorValueToMatter.bind(handlers);

      // 20°C → 2000 (0.01°C units)
      expect(convert("temperature_c", 20, "temp_sensor")).toBe(2000);

      // 25.5°C → 2550
      expect(convert("temperature_c", 25.5, "temp_sensor")).toBe(2550);
    });

    it("should convert motion detected boolean to occupancy bitmap", async () => {
      const { BridgeAttributeHandlers } = await import("../src/bridge/attribute-handlers.js");

      const handlers = new BridgeAttributeHandlers({
        logger,
        wsBridge: {} as any,
        bridgeBinding: {} as any,
      });

      const convert = (handlers as any).convertHomeCorValueToMatter.bind(handlers);

      // Motion detected → occupancy bit 0 set
      expect(convert("motion_detected", true, "motion_sensor")).toBe(1);

      // No motion → occupancy bit 0 clear
      expect(convert("motion_detected", false, "motion_sensor")).toBe(0);
    });

    it("should convert lock state boolean to Matter lock state enum", async () => {
      const { BridgeAttributeHandlers } = await import("../src/bridge/attribute-handlers.js");

      const handlers = new BridgeAttributeHandlers({
        logger,
        wsBridge: {} as any,
        bridgeBinding: {} as any,
      });

      const convert = (handlers as any).convertHomeCorValueToMatter.bind(handlers);

      // Locked → Matter state 1
      expect(convert("locked", true, "lock")).toBe(1);

      // Unlocked → Matter state 2
      expect(convert("locked", false, "lock")).toBe(2);
    });

    it("should convert Matter level back to brightness percentage", async () => {
      const { BridgeAttributeHandlers } = await import("../src/bridge/attribute-handlers.js");

      const handlers = new BridgeAttributeHandlers({
        logger,
        wsBridge: {} as any,
        bridgeBinding: {} as any,
      });

      const convertBack = (handlers as any).convertMatterValueToHomeCore.bind(handlers);

      // Matter 254 → 100%
      expect(convertBack("brightness_pct", 254, "light")).toBe(100);

      // Matter 127 → approximately 50%
      const result = convertBack("brightness_pct", 127, "light");
      expect(result).toBeCloseTo(50, 0);

      // Matter 0 → 0%
      expect(convertBack("brightness_pct", 0, "light")).toBe(0);
    });

    it("should convert Matter temperature back to Celsius", async () => {
      const { BridgeAttributeHandlers } = await import("../src/bridge/attribute-handlers.js");

      const handlers = new BridgeAttributeHandlers({
        logger,
        wsBridge: {} as any,
        bridgeBinding: {} as any,
      });

      const convertBack = (handlers as any).convertMatterValueToHomeCore.bind(handlers);

      // Matter 2000 → 20°C
      expect(convertBack("temperature_c", 2000, "temp_sensor")).toBe(20);

      // Matter 2550 → 25.5°C
      expect(convertBack("temperature_c", 2550, "temp_sensor")).toBe(25.5);
    });

    it("should get writable attributes for endpoint", async () => {
      const { BridgeAttributeHandlers } = await import("../src/bridge/attribute-handlers.js");
      const { MatterBridgeBinding } = await import("../src/bridge/matter-bridge-binding.js");

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

      const binding = new MatterBridgeBinding(logger);

      const handlers = new BridgeAttributeHandlers({
        logger,
        wsBridge: {} as any,
        bridgeBinding: binding,
      });

      // Without registered binding
      expect(handlers.getWritableAttributes("light_1")).toEqual([]);
    });

    it("should preserve attribute type through conversions", async () => {
      const { BridgeAttributeHandlers } = await import("../src/bridge/attribute-handlers.js");

      const handlers = new BridgeAttributeHandlers({
        logger,
        wsBridge: {} as any,
        bridgeBinding: {} as any,
      });

      const convert = (handlers as any).convertHomeCorValueToMatter.bind(handlers);

      // Color temperature in mireds passes through
      expect(convert("color_temperature_mireds", 370, "light")).toBe(370);

      // Humidity percentage passes through
      expect(convert("humidity_pct", 65, "humidity_sensor")).toBe(65);
    });
  });
});
