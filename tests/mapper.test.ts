import { describe, it, expect } from "vitest";
import {
  getDeviceMapping,
  toMatterValue,
  fromMatterValue,
  isActuatorType,
  isSensorType,
  getSupportedDeviceTypes,
  getActuatorTypes,
  getSensorTypes,
  DEVICE_MAPPINGS,
} from "../src/mapper/index.js";

describe("Mapper - Phase 1 Device Normalization", () => {
  it("should provide mappings for initial Phase 1 device set", () => {
    const requiredTypes = [
      "light",
      "dimmer_light",
      "switch",
      "contact_sensor",
      "motion_sensor",
      "temp_sensor",
    ];

    for (const type of requiredTypes) {
      const mapping = getDeviceMapping(type);
      expect(mapping).toBeDefined();
      expect(mapping?.homecoreType).toBe(type);
      expect(mapping?.matterType).toBeTruthy();
      expect(Array.isArray(mapping?.clusters)).toBe(true);
      expect(Object.keys(mapping?.attributeMap ?? {}).length).toBeGreaterThan(0);
    }
  });

  it("should convert temperature between HomeCore and Matter units", () => {
    expect(toMatterValue("temperature_c", 21.5)).toBe(2150);
    expect(fromMatterValue("temperature_c", 2150)).toBe(21.5);
  });

  it("should convert brightness between percentage and Matter level", () => {
    expect(toMatterValue("brightness_pct", 0)).toBe(0);
    expect(toMatterValue("brightness_pct", 100)).toBe(254);
    expect(fromMatterValue("brightness_pct", 127)).toBe(50);
  });

  it("should convert humidity between percentage and centipercent", () => {
    expect(toMatterValue("humidity_pct", 43)).toBe(4300);
    expect(fromMatterValue("humidity_pct", 4300)).toBe(43);
  });

  it("should preserve passthrough values for unknown attributes", () => {
    expect(toMatterValue("custom", "value")).toBe("value");
    expect(fromMatterValue("custom", "value")).toBe("value");
  });

  it("should include extended mapping entries beyond minimum set", () => {
    expect(DEVICE_MAPPINGS.humidity_sensor).toBeDefined();
    expect(DEVICE_MAPPINGS.lock).toBeDefined();
    expect(DEVICE_MAPPINGS.cover).toBeDefined();
  });

  it("should classify actuator device types correctly", () => {
    expect(isActuatorType("light")).toBe(true);
    expect(isActuatorType("dimmer_light")).toBe(true);
    expect(isActuatorType("switch")).toBe(true);
    expect(isActuatorType("lock")).toBe(true);
    expect(isActuatorType("cover")).toBe(true);
    expect(isActuatorType("temp_sensor")).toBe(false);
    expect(isActuatorType("motion_sensor")).toBe(false);
    expect(isActuatorType("unknown_type")).toBe(false);
  });

  it("should classify sensor device types correctly", () => {
    expect(isSensorType("temp_sensor")).toBe(true);
    expect(isSensorType("humidity_sensor")).toBe(true);
    expect(isSensorType("contact_sensor")).toBe(true);
    expect(isSensorType("motion_sensor")).toBe(true);
    expect(isSensorType("light")).toBe(false);
    expect(isSensorType("switch")).toBe(false);
    expect(isSensorType("unknown_type")).toBe(false);
  });

  it("should list all supported device types", () => {
    const allTypes = getSupportedDeviceTypes();
    expect(allTypes).toContain("light");
    expect(allTypes).toContain("temp_sensor");
    expect(allTypes).toContain("lock");
    expect(allTypes.length).toBe(9);
  });

  it("should list all actuator types separately", () => {
    const actuators = getActuatorTypes();
    expect(actuators).toEqual(["light", "dimmer_light", "switch", "lock", "cover"]);
  });

  it("should list all sensor types separately", () => {
    const sensors = getSensorTypes();
    expect(sensors).toEqual([
      "contact_sensor",
      "motion_sensor",
      "temp_sensor",
      "humidity_sensor",
    ]);
  });

  it("should handle brightness bounds in conversion", () => {
    expect(toMatterValue("brightness_pct", -10)).toBe(0);
    expect(toMatterValue("brightness_pct", 150)).toBe(254);
    expect(toMatterValue("brightness_pct", 50)).toBe(127);
  });

  it("should handle humidity bounds in conversion", () => {
    expect(toMatterValue("humidity_pct", -5)).toBe(0);
    expect(toMatterValue("humidity_pct", 120)).toBe(10000);
    expect(toMatterValue("humidity_pct", 0)).toBe(0);
  });

  it("should handle position bounds in conversion", () => {
    expect(toMatterValue("position", -1)).toBe(0);
    expect(toMatterValue("position", 101)).toBe(100);
    expect(toMatterValue("position", 75)).toBe(75);
    expect(fromMatterValue("position", 75)).toBe(75);
  });
});

