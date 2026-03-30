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
});
