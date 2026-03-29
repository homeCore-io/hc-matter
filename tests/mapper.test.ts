import { describe, it, expect } from "vitest";
import {
  getDeviceMapping,
  toMatterValue,
  fromMatterValue,
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
});
