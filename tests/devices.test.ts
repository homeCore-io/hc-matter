// The mapping, against what matter-server reported for the stand-in bridge
// (standin/standin.mjs, paired in the hc-matter-lab network): a real node
// dump, not a hand-written one.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { availableOf, commandFor, devicesOf, devicesTouchedBy, stateOf, type Device, type NodeData } from "../src/devices.js";

const fixture = (): NodeData => JSON.parse(readFileSync(new URL("./fixtures/standin-node.json", import.meta.url), "utf8"));

const byName = (devices: Device[], name: string) => {
  const d = devices.find((x) => x.name === name);
  if (!d) throw new Error(`no device ${name} in ${devices.map((x) => x.name).join(", ")}`);
  return d;
};

describe("devices of a bridge", () => {
  const node = fixture();
  const devices = devicesOf(node);

  it("makes one device per bridged endpoint, and none for the root or the aggregator", () => {
    expect(devices.map((d) => d.endpoint)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    expect(devices.map((d) => d.id)).toContain("matter_1_2");
  });

  it("names devices by their bridged name, and says which is which when two share one", () => {
    expect(devices.map((d) => d.name)).toEqual([
      "Desk Lamp", "Kettle Plug", "Front Door", "Hall Climate temperature", "Hall Climate humidity",
      "Sink Leak", "Office Presence", "Porch Light Level", "Back Door Lock", "Bedroom Blind",
      "Living Room Thermostat", "Ceiling Fan",
    ]);
  });

  it("gives each the homeCore type its Matter type means", () => {
    expect(Object.fromEntries(devices.map((d) => [d.name, d.kind]))).toMatchObject({
      "Desk Lamp": "light", "Kettle Plug": "switch", "Front Door": "contact_sensor",
      "Hall Climate temperature": "temperature_sensor", "Sink Leak": "water_sensor",
      "Back Door Lock": "lock", "Bedroom Blind": "cover", "Living Room Thermostat": "thermostat", "Ceiling Fan": "fan",
    });
  });

  it("declares a colour light's attributes in homeCore's names, with its real range", () => {
    const lamp = byName(devices, "Desk Lamp");
    expect(Object.keys(lamp.schema.attributes)).toEqual(expect.arrayContaining(["on", "brightness_pct", "color_temp", "color_xy"]));
    expect(lamp.schema.attributes.color_temp).toMatchObject({ unit: "K", min: 2000, max: 6536, writable: true });
    expect(lamp.schema.actions?.map((a) => a.id)).toEqual(["toggle", "identify"]);
  });

  it("reports state in homeCore's units", () => {
    const s = (name: string) => stateOf(node, byName(devices, name));
    expect(s("Desk Lamp")).toMatchObject({ on: false, brightness_pct: 0, color_temp: 2703 });
    expect(s("Front Door")).toMatchObject({ open: false, battery_pct: 80, battery_low: false });
    expect(s("Hall Climate temperature")).toMatchObject({ temperature: 21.5 });
    expect(s("Hall Climate humidity")).toMatchObject({ humidity: 42 });
    expect(s("Sink Leak")).toMatchObject({ water_detected: false });
    expect(s("Office Presence")).toMatchObject({ occupied: false });
    expect(s("Porch Light Level")).toMatchObject({ illuminance: 1000 });
    expect(s("Back Door Lock")).toMatchObject({ locked: true, jammed: false });
    expect(s("Bedroom Blind")).toMatchObject({ position: 50 });
    expect(s("Living Room Thermostat")).toMatchObject({ temperature: 20, heat_setpoint: 20, cool_setpoint: 26, hvac_mode: "heat" });
    expect(s("Ceiling Fan")).toMatchObject({ on: false, speed_pct: 0 });
  });

  it("says where a device comes from, out of the way", () => {
    const s = stateOf(node, byName(devices, "Desk Lamp"));
    expect(s).toMatchObject({ vendor: "homeCore stand-in", product: "Desk Lamp", matter_device_type: "Extended Color Light" });
    expect(byName(devices, "Desk Lamp").schema.attributes.vendor.category).toBe("diagnostic");
  });

  it("lists clusters it does not map, instead of dropping them silently", () => {
    // The stand-in's plug has nothing unmapped; give it one.
    const n = fixture();
    (n.attributes["3/29/1"] as number[]).push(0x0408);
    const plug = byName(devicesOf(n), "Kettle Plug");
    expect(stateOf(n, plug).matter_unmapped_clusters).toBe("0x0408");
  });

  it("is offline when the node is, or when the bridge says the device is unreachable", () => {
    const lamp = byName(devices, "Desk Lamp");
    expect(availableOf(node, lamp)).toBe(true);
    expect(availableOf({ ...node, available: false }, lamp)).toBe(false);
    const n = fixture();
    n.attributes["2/57/17"] = false;
    expect(availableOf(n, lamp)).toBe(false);
  });

  it("finds the devices an attribute change touches", () => {
    expect(devicesTouchedBy(node, devices, "2/6/0").map((d) => d.name)).toEqual(["Desk Lamp"]);
    expect(devicesTouchedBy(node, devices, "4/47/12").map((d) => d.name)).toEqual(["Front Door"]);
  });
});

describe("commands", () => {
  const node = fixture();
  const devices = devicesOf(node);
  const plan = (name: string, payload: Record<string, unknown>) => commandFor(node, byName(devices, name), payload);

  it("turns a light on with Matter's On, which restores its level", () => {
    expect(plan("Desk Lamp", { on: true }).ops).toEqual([{ op: "command", endpoint: 2, cluster: 6, command: "on" }]);
  });

  it("sets brightness with MoveToLevelWithOnOff, and 0 % as off", () => {
    expect(plan("Desk Lamp", { brightness_pct: 100, transition_ms: 500 }).ops).toEqual([
      { op: "command", endpoint: 2, cluster: 8, command: "moveToLevelWithOnOff", payload: { level: 254, transitionTime: 5, optionsMask: 0, optionsOverride: 0 } },
    ]);
    expect(plan("Desk Lamp", { brightness_pct: 0 }).ops).toEqual([{ op: "command", endpoint: 2, cluster: 6, command: "off" }]);
  });

  it("changes colour first, even while off, then the level", () => {
    const ops = plan("Desk Lamp", { on: true, color_temp: 4000 }).ops;
    expect(ops.map((o) => (o.op === "command" ? o.command : o.op))).toEqual(["moveToColorTemperature", "on"]);
    expect(ops[0]).toMatchObject({ payload: { colorTemperatureMireds: 250, optionsMask: 1, optionsOverride: 1 } });
  });

  it("takes an sRGB colour as xy", () => {
    const ops = plan("Desk Lamp", { color_rgb: { r: 255, g: 0, b: 0 } }).ops;
    expect(ops[0]).toMatchObject({ command: "moveToColor", payload: { colorX: 41950 } }); // x 0.6401, sRGB red
  });

  it("locks with a timed request", () => {
    expect(plan("Back Door Lock", { locked: false }).ops).toEqual([
      { op: "command", endpoint: 10, cluster: 257, command: "unlockDoor", payload: {}, timedMs: 10000 },
    ]);
  });

  it("moves a cover in homeCore's direction", () => {
    expect(plan("Bedroom Blind", { position: 100 }).ops).toEqual([
      { op: "command", endpoint: 11, cluster: 258, command: "goToLiftPercentage", payload: { liftPercent100thsValue: 0 } },
    ]);
    expect(plan("Bedroom Blind", { action: "stop" }).ops[0]).toMatchObject({ command: "stopMotion" });
  });

  it("writes a thermostat's setpoints and mode", () => {
    expect(plan("Living Room Thermostat", { heat_setpoint: 21.5, hvac_mode: "auto" }).ops).toEqual([
      { op: "write", endpoint: 12, cluster: 513, attribute: 28, value: 1 },
      { op: "write", endpoint: 12, cluster: 513, attribute: 18, value: 2150 },
    ]);
    expect(plan("Living Room Thermostat", { hvac_mode: "sauna" }).error).toMatch(/unknown hvac_mode/);
  });

  it("sets a fan's speed, and off", () => {
    expect(plan("Ceiling Fan", { speed_pct: 40 }).ops).toEqual([{ op: "write", endpoint: 13, cluster: 514, attribute: 2, value: 40 }]);
    expect(plan("Ceiling Fan", { on: false }).ops).toEqual([{ op: "write", endpoint: 13, cluster: 514, attribute: 0, value: 0 }]);
  });

  it("identifies, and refuses what a device cannot do", () => {
    expect(plan("Sink Leak", { action: "identify", duration_secs: 5 }).ops).toEqual([
      { op: "command", endpoint: 7, cluster: 3, command: "identify", payload: { identifyTime: 5 } },
    ]);
    expect(plan("Sink Leak", { water_detected: true }).error).toMatch(/cannot be set: water_detected/);
    expect(plan("Sink Leak", { action: "explode" }).error).toMatch(/no action explode/);
  });

  it("ignores the command's metadata", () => {
    expect(plan("Kettle Plug", { on: false, _hc: { command: { source: "x" } } })).toEqual({
      ops: [{ op: "command", endpoint: 3, cluster: 6, command: "off" }], ignored: [],
    });
  });
});

describe("a plain node", () => {
  it("is one device, named by the node, with a battery on its root", () => {
    const node: NodeData = {
      node_id: 9007199254740993n,
      available: true,
      is_bridge: false,
      attributes: {
        "0/29/0": [{ "0": 22, "1": 1 }],
        "0/29/1": [29, 40, 47],
        "0/29/3": [1],
        "0/40/1": "Acme",
        "0/40/3": "Acme Door Sensor",
        "0/47/65532": 2,
        "0/47/12": 200,
        "0/47/14": 1,
        "1/29/0": [{ "0": 21, "1": 1 }],
        "1/29/1": [29, 69],
        "1/69/0": false,
      },
    };
    const [d, ...rest] = devicesOf(node);
    expect(rest).toEqual([]);
    expect(d).toMatchObject({ id: "matter_9007199254740993_1", name: "Acme Door Sensor", kind: "contact_sensor" });
    expect(stateOf(node, d)).toMatchObject({ open: true, battery_pct: 100, battery_low: true, vendor: "Acme" });
    expect(devicesTouchedBy(node, [d], "0/47/12")).toEqual([d]);
  });

  it("keeps an endpoint of a type it does not know, as a generic device", () => {
    const node: NodeData = {
      node_id: 7, available: true, is_bridge: false,
      attributes: {
        "0/40/3": "Speaker",
        "1/29/0": [{ "0": 0x0022, "1": 1 }],
        "1/29/1": [29, 6, 8],
        "1/6/0": true,
      },
    };
    const [d] = devicesOf(node);
    expect(d).toMatchObject({ kind: "matter", matterType: "Matter device type 0x0022" });
    expect(stateOf(node, d)).toMatchObject({ on: true });
    expect(d.schema.attributes.brightness_pct).toBeUndefined();
  });
});
