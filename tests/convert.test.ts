import { describe, expect, it } from "vitest";
import {
  coverFromMatter, coverToMatter, halfPercent, hundredths, illuminanceToLux, kelvinToMireds, levelToPct, milli,
  miredsToKelvin, mwhToKwh, num, pctToLevel, rgbToHueSat, rgbToXy, xyFromMatter, xyToMatter, xyToRgb,
} from "../src/convert.js";

describe("light level", () => {
  it("never reads the lowest step as off, and reads the top as 100", () => {
    expect(levelToPct(1, true)).toBe(1);
    expect(levelToPct(254, true)).toBe(100);
    expect(levelToPct(127, true)).toBe(50);
  });
  it("reads 0 when off, whatever the level", () => {
    expect(levelToPct(200, false)).toBe(0);
  });
  it("keeps an unknown level unknown", () => {
    expect(levelToPct(null, true)).toBeNull();
  });
  it("reaches the device's maximum at 100 and its minimum just above 0", () => {
    expect(pctToLevel(100)).toBe(254);
    expect(pctToLevel(0.1)).toBe(1);
    expect(pctToLevel(0)).toBe(0);
    expect(pctToLevel(150)).toBe(254);
  });
  it("round-trips whole percentages", () => {
    for (const p of [1, 10, 33, 50, 99, 100]) expect(levelToPct(pctToLevel(p), true)).toBe(p);
  });
});

describe("colour", () => {
  it("converts mireds and kelvin, inside what the light can do", () => {
    expect(miredsToKelvin(370)).toBe(2703);
    expect(miredsToKelvin(0)).toBeNull();
    expect(kelvinToMireds(2700)).toBe(370);
    expect(kelvinToMireds(10000, 153, 500)).toBe(153);
    expect(kelvinToMireds(1500, 153, 500)).toBe(500);
  });
  it("scales xy to Matter's 0–65279 and back", () => {
    expect(xyFromMatter(24939)).toBeCloseTo(0.3805, 4);
    expect(xyToMatter(1)).toBe(65279);
    expect(xyToMatter(0)).toBe(0);
    expect(xyFromMatter(xyToMatter(0.3127))).toBeCloseTo(0.3127, 3);
  });
  it("puts sRGB white at D65 and keeps primaries in their corners", () => {
    expect(rgbToXy({ r: 255, g: 255, b: 255 })).toEqual({ x: 0.3127, y: 0.329 });
    const red = rgbToXy({ r: 255, g: 0, b: 0 })!;
    expect(red.x).toBeCloseTo(0.64, 2);
    expect(rgbToXy({ r: 0, g: 0, b: 0 })).toBeNull();
  });
  it("goes back from xy to a full-brightness colour", () => {
    const rgb = xyToRgb({ x: 0.64, y: 0.33 });
    expect(rgb.r).toBe(255);
    expect(rgb.g).toBeLessThan(20);
  });
  it("gives hue and saturation on Matter's 0–254", () => {
    expect(rgbToHueSat({ r: 255, g: 0, b: 0 })).toEqual({ hue: 0, saturation: 254 });
    expect(rgbToHueSat({ r: 0, g: 0, b: 255 }).hue).toBe(169);
    expect(rgbToHueSat({ r: 255, g: 255, b: 255 }).saturation).toBe(0);
  });
});

describe("measurements", () => {
  it("reads hundredths", () => {
    expect(hundredths(2150)).toBe(21.5);
    expect(hundredths(-4000)).toBe(-40);
    expect(hundredths(null)).toBeNull();
  });
  it("reads illuminance from its log scale, at both ends", () => {
    expect(illuminanceToLux(1)).toBe(1);
    expect(illuminanceToLux(30001)).toBe(1000);
    expect(illuminanceToLux(0)).toBe(0);
    expect(illuminanceToLux(0xfffe)).toBeGreaterThan(3_000_000);
  });
  it("reads thousandths, energy and int64 values", () => {
    expect(milli(1500n)).toBe(1.5);
    expect(milli(230_000)).toBe(230);
    expect(mwhToKwh(12_345_678n)).toBe(12.3457);
    expect(num(5n)).toBe(5);
    expect(num("5")).toBeNull();
  });
  it("reads a battery's half-percent, at both ends", () => {
    expect(halfPercent(200)).toBe(100);
    expect(halfPercent(0)).toBe(0);
    expect(halfPercent(1)).toBe(0.5);
  });
});

describe("covers", () => {
  it("turns Matter's 0 = open into homeCore's 100 = open, both ways", () => {
    expect(coverFromMatter(0)).toBe(100);
    expect(coverFromMatter(10000)).toBe(0);
    expect(coverFromMatter(2500)).toBe(75);
    expect(coverToMatter(100)).toBe(0);
    expect(coverToMatter(0)).toBe(10000);
    expect(coverToMatter(120)).toBe(0);
  });
});
