import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clusterState, colorCommand, commandFrom, needsSecurityConfirm, partKey, partsFor, type HomeDevice } from "../src/bridge/model.js";
import { candidates } from "../src/bridge/service.js";
import { BridgeStore, newPasscode } from "../src/bridge/store.js";

const dev = (device_type: string, attributes: Record<string, unknown>, extra: Partial<HomeDevice> = {}): HomeDevice => ({
  device_id: `${device_type}.1`, name: `My ${device_type}`, device_type, plugin_id: "plugin.hue", available: true, attributes, ...extra,
});

describe("what a homeCore device can be", () => {
  it("picks the light Matter has for what it can do", () => {
    expect(partsFor(dev("light", { on: true }), "plugin.matter")).toEqual([{ key: "hc_light_1", kind: "on_off_light" }]);
    expect(partsFor(dev("light", { on: true, brightness_pct: 40 }), "plugin.matter")).toMatchObject([{ kind: "dimmable_light" }]);
    expect(partsFor(dev("light", { on: true, brightness_pct: 40, color_temp: 2700 }), "plugin.matter")).toMatchObject([{ kind: "color_temperature_light" }]);
    expect(partsFor(dev("light", { on: true, color_xy: { x: 0.3, y: 0.3 } }), "plugin.matter")).toMatchObject([{ kind: "extended_color_light" }]);
  });

  it("makes a climate sensor two parts, and refuses what it can't show", () => {
    expect(partsFor(dev("temperature_sensor", { temperature: 21, humidity: 40 }), "x")).toEqual([
      { key: "hc_temperature_sensor_1", kind: "temperature_sensor" },
      { key: "hc_temperature_sensor_1_rh", kind: "humidity_sensor" },
    ]);
    expect(partsFor(dev("media_player", { state: "playing" }), "x")).toEqual({ reason: "Matter has no media player this bridge can show yet." });
  });

  it("never offers a device that came from Matter", () => {
    expect(partsFor(dev("light", { on: true }, { plugin_id: "plugin.matter" }), "plugin.matter")).toHaveProperty("reason");
  });

  it("keeps endpoint ids to what matter.js accepts", () => {
    expect(partKey("Hue.Light/Kitchen #2")).toBe("hc_hue_light_kitchen_2");
  });
});

describe("what needs the security warning", () => {
  it("locks, garage and gate covers, and what someone marked as security that can be commanded", () => {
    expect(needsSecurityConfirm(dev("lock", { locked: true }))).toBe(true);
    expect(needsSecurityConfirm(dev("cover", { position: 0 }, { ui_hint: "garage" }))).toBe(true);
    expect(needsSecurityConfirm(dev("cover", { position: 0 }))).toBe(false);
    expect(needsSecurityConfirm(dev("switch", { on: true }, { security: true }))).toBe(true);
    expect(needsSecurityConfirm(dev("lock", { locked: true }, { security: false }))).toBe(false);
  });
  it("not a sensor, which only reports", () => {
    expect(needsSecurityConfirm(dev("contact_sensor", { open: false }, { security: true }))).toBe(false);
  });
});

describe("homeCore state into Matter", () => {
  const p = (kind: string, extra = {}) => ({ key: "k", kind, ...extra }) as never;
  it("converts each kind at both ends of its scale", () => {
    expect(clusterState(p("dimmable_light"), { on: true, brightness_pct: 100 })).toEqual({ onOff: { onOff: true }, levelControl: { currentLevel: 254 } });
    expect(clusterState(p("dimmable_light"), { on: true, brightness_pct: 1 }).levelControl).toEqual({ currentLevel: 3 });
    expect(clusterState(p("door_lock"), { locked: false })).toEqual({ doorLock: { lockState: 2 } });
    expect(clusterState(p("window_covering", { positioned: true }), { position: 100 })).toEqual({
      windowCovering: { currentPositionLiftPercent100ths: 0, targetPositionLiftPercent100ths: 0 } });
    expect(clusterState(p("contact_sensor"), { open: true })).toEqual({ booleanState: { stateValue: false } });
    expect(clusterState(p("temperature_sensor"), { temperature: -12.5 })).toEqual({ temperatureMeasurement: { measuredValue: -1250 } });
    expect(clusterState(p("light_sensor"), { illuminance: 1000 })).toEqual({ illuminanceMeasurement: { measuredValue: 30001 } });
    expect(clusterState(p("occupancy_sensor"), { motion: true })).toEqual({ occupancySensing: { occupancy: { occupied: true } } });
  });
  it("leaves what the device doesn't report alone", () => {
    expect(clusterState(p("extended_color_light"), { on: false })).toEqual({ onOff: { onOff: false } });
  });
});

describe("another app's change into a homeCore command", () => {
  const light = { key: "k", kind: "extended_color_light" } as const;
  it("sends what changed, in homeCore's names", () => {
    expect(commandFrom(light, { cluster: "onOff", attribute: "onOff", value: true }, { on: false })).toEqual({ on: true });
    expect(commandFrom(light, { cluster: "levelControl", attribute: "currentLevel", value: 127 }, { on: true, brightness_pct: 10 })).toEqual({ brightness_pct: 50 });
    expect(commandFrom(light, { cluster: "colorControl", attribute: "colorTemperatureMireds", value: 250 }, { color_temp: 2700 })).toEqual({ color_temp: 4000 });
    expect(colorCommand(41950, 21627, { color_xy: { x: 0.3, y: 0.3 } })).toEqual({ color_xy: { x: 0.6401, y: 0.33 } });
  });
  it("sends nothing for homeCore's own change reflected back", () => {
    expect(commandFrom(light, { cluster: "onOff", attribute: "onOff", value: true }, { on: true })).toBeNull();
    expect(commandFrom(light, { cluster: "levelControl", attribute: "currentLevel", value: 127 }, { on: true, brightness_pct: 50 })).toBeNull();
    expect(colorCommand(41950, 21627, { color_xy: { x: 0.6401, y: 0.33 } })).toBeNull();
  });
  it("locks and moves covers in homeCore's direction", () => {
    expect(commandFrom({ key: "k", kind: "door_lock" }, { cluster: "doorLock", attribute: "lockState", value: 2 }, { locked: true })).toEqual({ locked: false });
    expect(commandFrom({ key: "k", kind: "window_covering", positioned: true },
      { cluster: "windowCovering", attribute: "targetPositionLiftPercent100ths", value: 2500 }, { position: 0 })).toEqual({ position: 75 });
    expect(commandFrom({ key: "k", kind: "window_covering", positioned: false },
      { cluster: "windowCovering", attribute: "targetPositionLiftPercent100ths", value: 10000 }, {})).toEqual({ action: "close" });
  });
});

describe("the page's list", () => {
  it("says what each can be, why not, and which need the warning", () => {
    const list = candidates([
      dev("lock", { locked: true }, { device_id: "b", name: "Back door" }),
      dev("media_player", {}, { device_id: "a", name: "Amp" }),
    ], new Set(["b"]), "plugin.matter");
    expect(list.map((c) => [c.name, c.can_share, c.shared, c.needs_confirm, c.shows_as])).toEqual([
      ["Amp", false, false, false, null],
      ["Back door", true, true, true, "lock"],
    ]);
  });
});

describe("the bridge's own choices", () => {
  it("keeps a valid code across starts, only to itself, and a new one after a reset", () => {
    const dir = mkdtempSync(join(tmpdir(), "hcm-"));
    const path = join(dir, "data", "bridge.json");
    const a = new BridgeStore(path);
    const code = a.get().passcode;
    expect(code).toBeGreaterThan(0);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    a.share("x", false);
    const b = new BridgeStore(path);
    expect(b.get().passcode).toBe(code);
    expect(Object.keys(b.get().devices)).toEqual(["x"]);
    b.reset();
    expect(b.get().passcode).not.toBe(code);
    expect(JSON.parse(readFileSync(path, "utf8")).devices).toEqual({ x: {} });
  });
  it("never picks a passcode Matter forbids", () => {
    const seq = [12345678, 11111111, 4242];
    expect(newPasscode(() => seq.shift()!)).toBe(4242);
  });
});

describe("what matter.js needs", () => {
  it("keeps each part's UniqueID within Matter's 32 characters, and different", async () => {
    const { uniqueIdFor } = await import("../src/bridge/bridge.js");
    const a = uniqueIdFor("hc_ecowitt_indoor");
    const b = uniqueIdFor("hc_ecowitt_indoor_rh");
    expect(a).toHaveLength(32);
    expect(b).toHaveLength(32);
    expect(a).not.toBe(b);
  });

  it("says why matter.js refused, not only that it did", async () => {
    const { describe: say } = await import("../src/bridge/service.js");
    const inner = new Error("Matter requires you to set this attribute");
    const outer = Object.assign(new AggregateError([new Error("initializing colorControl", { cause: inner })], "Behaviors have errors"));
    expect(say(outer)).toBe("Behaviors have errors (initializing colorControl (Matter requires you to set this attribute))");
  });
});

describe("thermostats", () => {
  const mysa = dev("thermostat", { heat_setpoint: 26.1, hvac_mode: "heat", temperature: 22.44 }, {
    schema: { attributes: { heat_setpoint: { writable: true, min: 5, max: 30 }, hvac_mode: { writable: true, options: [{ value: "off" }, { value: "heat" }] } } },
  });
  const nuheat = dev("thermostat", { setpoint: 12.67, hvac_mode: "heat", hvac_action: "idle", temperature: 23.17 }, {
    schema: { attributes: { setpoint: { writable: true, min: 5, max: 30 }, hvac_mode: { writable: false, options: ["heat"] } } },
  });
  const dual = dev("thermostat", { heat_setpoint: 20, cool_setpoint: 26, hvac_mode: "auto", temperature: 21 }, {
    schema: { attributes: { heat_setpoint: { writable: true }, cool_setpoint: { writable: true }, hvac_mode: { writable: true, options: ["off", "heat", "cool", "auto", "eco"] } } },
  });
  const part = (d: HomeDevice) => (partsFor(d, "plugin.matter") as never[])[0] as never;

  it("has what the device has: heating, cooling, its limits, and the modes it takes", () => {
    expect(part(mysa)).toMatchObject({ heat: "heat_setpoint", cool: null, heatLimits: [5, 30], modes: ["off", "heat"], modeWritable: true });
    expect(part(nuheat)).toMatchObject({ heat: "setpoint", modes: ["heat"], modeWritable: false });
    expect(part(dual)).toMatchObject({ heat: "heat_setpoint", cool: "cool_setpoint", modes: ["off", "heat", "cool", "auto"] });
    expect(partsFor(dev("thermostat", { temperature: 20 }), "x")).toEqual({ reason: "It has no setpoint." });
  });

  it("shows temperatures and setpoints in hundredths, within the device's limits", () => {
    expect(clusterState(part(mysa), mysa.attributes)).toEqual({ thermostat: { localTemperature: 2244, occupiedHeatingSetpoint: 2610, systemMode: 4 } });
    expect(clusterState(part(nuheat), { ...nuheat.attributes, setpoint: 40 }).thermostat).toMatchObject({ occupiedHeatingSetpoint: 3000 });
    expect(clusterState(part(dual), { hvac_action: "cooling" }).thermostat).toEqual({ thermostatRunningState: { heat: false, cool: true, fan: false } });
  });

  it("sends setpoints and modes back under the device's own names", () => {
    expect(commandFrom(part(nuheat), { cluster: "thermostat", attribute: "occupiedHeatingSetpoint", value: 2050 }, nuheat.attributes)).toEqual({ setpoint: 20.5 });
    expect(commandFrom(part(dual), { cluster: "thermostat", attribute: "occupiedCoolingSetpoint", value: 2400 }, dual.attributes)).toEqual({ cool_setpoint: 24 });
    expect(commandFrom(part(mysa), { cluster: "thermostat", attribute: "systemMode", value: 0 }, mysa.attributes)).toEqual({ hvac_mode: "off" });
  });

  it("sends nothing it can't do, or homeCore already has", () => {
    // NuHeat's mode can't be set; Mysa has no cooling; the setpoint is homeCore's own, reflected.
    expect(commandFrom(part(nuheat), { cluster: "thermostat", attribute: "systemMode", value: 0 }, nuheat.attributes)).toBeNull();
    expect(commandFrom(part(mysa), { cluster: "thermostat", attribute: "systemMode", value: 3 }, mysa.attributes)).toBeNull();
    expect(commandFrom(part(mysa), { cluster: "thermostat", attribute: "occupiedHeatingSetpoint", value: 2610 }, mysa.attributes)).toBeNull();
  });
});

describe("fans", () => {
  const fan = { key: "k", kind: "fan" } as const;
  it("shows on and speed as Matter's mode and percent", () => {
    expect(clusterState(fan, { on: true, speed_pct: 25.5 })).toEqual({ fanControl: { fanMode: 1, percentSetting: 26, percentCurrent: 26 } });
    expect(clusterState(fan, { on: false, speed_pct: 60 })).toEqual({ fanControl: { fanMode: 0, percentSetting: 0, percentCurrent: 0 } });
    expect(clusterState(fan, { on: true })).toEqual({ fanControl: { fanMode: 3, percentSetting: 100, percentCurrent: 100 } });
  });
  it("turns another app's speed or mode into homeCore's, and ignores its own reflected", () => {
    expect(commandFrom(fan, { cluster: "fanControl", attribute: "percentSetting", value: 50 }, { on: true, speed_pct: 25 })).toEqual({ speed_pct: 50 });
    expect(commandFrom(fan, { cluster: "fanControl", attribute: "percentSetting", value: 0 }, { on: true, speed_pct: 25 })).toEqual({ on: false });
    expect(commandFrom(fan, { cluster: "fanControl", attribute: "fanMode", value: 3 }, { on: false, speed_pct: 0 })).toEqual({ speed_pct: 100 });
    expect(commandFrom(fan, { cluster: "fanControl", attribute: "fanMode", value: 0 }, { on: true, speed_pct: 40 })).toEqual({ on: false });
    // 25.5 % shows as Low and 26 %: neither is a change.
    expect(commandFrom(fan, { cluster: "fanControl", attribute: "fanMode", value: 1 }, { on: true, speed_pct: 25.5 })).toBeNull();
    expect(commandFrom(fan, { cluster: "fanControl", attribute: "percentSetting", value: 26 }, { on: true, speed_pct: 25.5 })).toBeNull();
  });
});

describe("a damaged bridge.json", () => {
  it("is set aside, and the plugin starts with the bridge off", async () => {
    const { writeFileSync, readdirSync, mkdirSync } = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "hcm-"));
    mkdirSync(join(dir, "data"));
    const path = join(dir, "data", "bridge.json");
    writeFileSync(path, "{ not json");
    const said: string[] = [];
    const store = new BridgeStore(path, (m) => said.push(m));
    expect(store.get()).toMatchObject({ enabled: false, devices: {} });
    expect(said[0]).toMatch(/could not be read/);
    expect(readdirSync(join(dir, "data")).some((f) => f.startsWith("bridge.json.corrupt-"))).toBe(true);
  });
});
