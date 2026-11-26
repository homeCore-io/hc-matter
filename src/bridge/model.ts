// homeCore devices as Matter devices: the bridge's half of the mapping, the
// reverse of devices.ts. Pure, and tested (tests/bridge-model.test.ts).
//
// A homeCore device is offered when its type has a Matter counterpart. Its
// state becomes cluster state (homeCore's units to Matter's scales, with the
// same conversions the controller uses the other way), and a change another
// app makes becomes a homeCore command in homeCore's names.

import { coverFromMatter, coverToMatter, hundredths, kelvinToMireds, levelToPct, miredsToKelvin, num, pctToLevel, toHundredths, xyFromMatter, xyToMatter } from "../convert.js";

/** A device as homeCore's event stream and snapshot describe it. */
export interface HomeDevice {
  device_id: string;
  name: string;
  name_override?: string | null;
  device_type?: string | null;
  plugin_id?: string | null;
  available?: boolean;
  attributes: Record<string, unknown>;
  schema?: { attributes?: Record<string, SchemaAttr> } | null;
  ui_hint?: string | null;
  security?: boolean | null;
}

export interface SchemaAttr {
  writable?: boolean;
  min?: number | null;
  max?: number | null;
  /** Plain strings, or {value, label}, as plugins declare them. */
  options?: (string | { value: string })[] | null;
}

export type BridgeKind =
  | "on_off_light" | "dimmable_light" | "color_temperature_light" | "extended_color_light"
  | "plug" | "door_lock" | "window_covering" | "contact_sensor" | "occupancy_sensor"
  | "temperature_sensor" | "humidity_sensor" | "water_leak" | "light_sensor" | "thermostat" | "fan";

/** One Matter endpoint a homeCore device becomes (a climate sensor becomes two). */
export interface BridgePart {
  /** Stable id for matter.js, which keeps the endpoint's number by it. */
  key: string;
  kind: BridgeKind;
  /** Whether the lift can be set to a position, for a cover. */
  positioned?: boolean;
  /** A thermostat: the homeCore attribute holding each setpoint, its limits, and the modes it takes. */
  heat?: "heat_setpoint" | "setpoint" | null;
  cool?: "cool_setpoint" | null;
  heatLimits?: [number, number];
  coolLimits?: [number, number];
  modes?: string[];
  modeWritable?: boolean;
}

export const BRIDGE_KIND_NAMES: Record<BridgeKind, string> = {
  on_off_light: "light", dimmable_light: "dimmable light", color_temperature_light: "white light",
  extended_color_light: "colour light", plug: "switch", door_lock: "lock", window_covering: "blind or cover",
  contact_sensor: "contact sensor", occupancy_sensor: "occupancy sensor", temperature_sensor: "temperature sensor",
  humidity_sensor: "humidity sensor", water_leak: "leak sensor", light_sensor: "light sensor",
  thermostat: "thermostat", fan: "fan",
};

const has = (d: HomeDevice, attr: string) =>
  Object.prototype.hasOwnProperty.call(d.attributes ?? {}, attr) || !!d.schema?.attributes?.[attr];
const writable = (d: HomeDevice, attr: string) => d.schema?.attributes?.[attr]?.writable ?? has(d, attr);

/** A key matter.js accepts as an endpoint id: lowercase letters, digits and underscores. */
export function partKey(deviceId: string, suffix = ""): string {
  return `hc_${deviceId.toLowerCase().replace(/[^a-z0-9]+/g, "_")}${suffix}`.slice(0, 60);
}

/** The name the house uses for it. */
export function homeName(d: HomeDevice): string {
  return (d.name_override?.trim() || d.name || d.device_id).trim();
}

/**
 * What a homeCore device can be on the bridge, or why not. Devices that came
 * from Matter in the first place are never offered: the other app pairs them
 * itself, and a loop would show each twice.
 */
export function partsFor(d: HomeDevice, ownPluginId: string): BridgePart[] | { reason: string } {
  if (d.plugin_id === ownPluginId) return { reason: "It is a Matter device already: share it from this plugin's paired devices instead." };
  const t = d.device_type ?? "";
  const key = partKey(d.device_id);
  switch (t) {
    case "light": {
      const color = has(d, "color_xy") && writable(d, "color_xy");
      const ct = has(d, "color_temp") && writable(d, "color_temp");
      const level = has(d, "brightness_pct") && writable(d, "brightness_pct");
      const kind: BridgeKind = color ? "extended_color_light" : ct ? "color_temperature_light" : level ? "dimmable_light" : "on_off_light";
      return [{ key, kind }];
    }
    case "switch":
    case "virtual_switch":
      return has(d, "on") ? [{ key, kind: "plug" }] : { reason: "It has no on/off." };
    case "lock":
      return has(d, "locked") ? [{ key, kind: "door_lock" }] : { reason: "It does not report locked." };
    case "cover":
      return [{ key, kind: "window_covering", positioned: has(d, "position") && writable(d, "position") }];
    case "contact_sensor":
      return has(d, "open") ? [{ key, kind: "contact_sensor" }] : { reason: "It does not report open." };
    case "motion_sensor":
    case "occupancy_sensor":
      return has(d, "motion") || has(d, "occupied") ? [{ key, kind: "occupancy_sensor" }] : { reason: "It reports no motion." };
    case "thermostat":
      return thermostatPart(d, key);
    case "fan":
      return has(d, "on") || has(d, "speed_pct") ? [{ key, kind: "fan" }] : { reason: "It has no on/off or speed." };
    case "water_sensor":
      return has(d, "water_detected") ? [{ key, kind: "water_leak" }] : { reason: "It does not report water." };
    case "light_sensor":
      return has(d, "illuminance") ? [{ key, kind: "light_sensor" }] : { reason: "It does not report light." };
    case "humidity_sensor":
      return has(d, "humidity") ? [{ key, kind: "humidity_sensor" }] : { reason: "It does not report humidity." };
    case "temperature_sensor":
    case "sensor": {
      const parts: BridgePart[] = [];
      if (has(d, "temperature")) parts.push({ key, kind: "temperature_sensor" });
      if (has(d, "humidity")) parts.push({ key: partKey(d.device_id, "_rh"), kind: "humidity_sensor" });
      return parts.length ? parts : { reason: "It reports no temperature or humidity." };
    }
    default:
      return { reason: t ? `Matter has no ${t.replace(/_/g, " ")} this bridge can show yet.` : "It has no device type." };
  }
}

/** The values an attribute's options allow, whichever way the plugin wrote them. */
function optionValues(a?: SchemaAttr): string[] {
  return (a?.options ?? []).map((o) => (typeof o === "string" ? o : o.value)).filter((v): v is string => typeof v === "string");
}

const limits = (a: SchemaAttr | undefined, lo: number, hi: number): [number, number] =>
  [typeof a?.min === "number" ? a.min : lo, typeof a?.max === "number" ? a.max : hi];

/** A thermostat as what it has: heating, cooling or both, and its own modes and limits. */
function thermostatPart(d: HomeDevice, key: string): BridgePart[] | { reason: string } {
  const sch = d.schema?.attributes ?? {};
  const heat = has(d, "heat_setpoint") ? "heat_setpoint" : has(d, "setpoint") ? "setpoint" : null;
  const cool = has(d, "cool_setpoint") ? "cool_setpoint" : null;
  if (!heat && !cool) return { reason: "It has no setpoint." };
  const declared = optionValues(sch.hvac_mode);
  const known = declared.length ? declared : typeof d.attributes.hvac_mode === "string" ? [d.attributes.hvac_mode] : [];
  const modes = known.filter((m) => m in SYSTEM_MODE_FOR && (m !== "heat" || heat) && (m !== "cool" || cool) && (m !== "auto" || (heat && cool)));
  return [{
    key, kind: "thermostat", heat, cool,
    heatLimits: limits(sch[heat ?? ""], 7, 30),
    coolLimits: limits(sch[cool ?? ""], 16, 32),
    modes,
    modeWritable: writable(d, "hvac_mode"),
  }];
}

export const SYSTEM_MODE_FOR: Record<string, number> = { off: 0, auto: 1, cool: 3, heat: 4, fan_only: 7, dry: 8 };
const MODE_OF: Record<number, string> = { 0: "off", 1: "auto", 3: "cool", 4: "heat", 7: "fan_only", 8: "dry" };

/** Matter's FanMode for a speed: Off, Low, Medium, High. */
export function fanModeFor(pct: number): number {
  return pct <= 0 ? 0 : pct <= 33 ? 1 : pct <= 66 ? 2 : 3;
}

/**
 * Whether sharing it lets the other app's users, and its voice assistant,
 * open or unlock something: what homeCore counts as security, and can be
 * commanded. Read-only sensors are not.
 */
export function needsSecurityConfirm(d: HomeDevice): boolean {
  if (d.security === false) return false;
  const t = d.device_type ?? "";
  if (t === "lock") return true;
  const hint = (d.ui_hint ?? "").toLowerCase();
  if (t === "cover" && ["garage", "gate", "door"].includes(hint)) return true;
  return d.security === true && ["cover", "switch", "virtual_switch", "lock"].includes(t);
}

const bool = (v: unknown) => (typeof v === "boolean" ? v : null);

/** Matter's illuminance, 10000·log10(lux)+1. */
function luxToMatter(lux: number): number {
  if (!(lux > 0)) return 0;
  return Math.min(0xfffe, Math.max(1, Math.round(10000 * Math.log10(lux) + 1)));
}

/**
 * Cluster state for a part, from the device's homeCore state, in matter.js's
 * names. Only what the device reports: an attribute it doesn't have is left as
 * it is.
 */
export function clusterState(part: BridgePart, a: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  const on = bool(a.on);
  switch (part.kind) {
    case "extended_color_light":
    case "color_temperature_light":
    case "dimmable_light":
    case "on_off_light":
    case "plug":
      if (on !== null) out.onOff = { onOff: on };
      if (part.kind !== "on_off_light" && part.kind !== "plug" && typeof a.brightness_pct === "number" && a.brightness_pct > 0) {
        out.levelControl = { currentLevel: pctToLevel(a.brightness_pct) };
      }
      if (part.kind === "extended_color_light" || part.kind === "color_temperature_light") {
        const cc: Record<string, unknown> = {};
        if (typeof a.color_temp === "number" && a.color_temp > 0) {
          cc.colorTemperatureMireds = kelvinToMireds(a.color_temp, 153, 500);
          cc.colorMode = 2;
          cc.enhancedColorMode = 2;
        }
        const xy = a.color_xy as { x?: unknown; y?: unknown } | null | undefined;
        if (part.kind === "extended_color_light" && xy && typeof xy.x === "number" && typeof xy.y === "number") {
          cc.currentX = xyToMatter(xy.x);
          cc.currentY = xyToMatter(xy.y);
          if (cc.colorMode === undefined) {
            cc.colorMode = 1;
            cc.enhancedColorMode = 1;
          }
        }
        if (Object.keys(cc).length) out.colorControl = cc;
      }
      break;
    case "door_lock": {
      const locked = bool(a.locked);
      if (locked !== null) out.doorLock = { lockState: locked ? 1 : 2 };
      break;
    }
    case "window_covering": {
      if (typeof a.position === "number") {
        const p = coverToMatter(a.position);
        out.windowCovering = { currentPositionLiftPercent100ths: p, targetPositionLiftPercent100ths: p };
      }
      break;
    }
    case "contact_sensor": {
      const open = bool(a.open);
      // StateValue is true while the contact is made: closed.
      if (open !== null) out.booleanState = { stateValue: !open };
      break;
    }
    case "occupancy_sensor": {
      const o = bool(a.occupied) ?? bool(a.motion);
      if (o !== null) out.occupancySensing = { occupancy: { occupied: o } };
      break;
    }
    case "water_leak": {
      const w = bool(a.water_detected);
      if (w !== null) out.booleanState = { stateValue: w };
      break;
    }
    case "temperature_sensor":
      if (typeof a.temperature === "number") out.temperatureMeasurement = { measuredValue: toHundredths(a.temperature) };
      break;
    case "humidity_sensor":
      if (typeof a.humidity === "number") out.relativeHumidityMeasurement = { measuredValue: toHundredths(Math.max(0, Math.min(100, a.humidity))) };
      break;
    case "light_sensor":
      if (typeof a.illuminance === "number") out.illuminanceMeasurement = { measuredValue: luxToMatter(a.illuminance) };
      break;
    case "thermostat": {
      const t: Record<string, unknown> = {};
      if (typeof a.temperature === "number") t.localTemperature = toHundredths(a.temperature);
      const clamp = (v: number, [lo, hi]: [number, number]) => Math.min(hi, Math.max(lo, v));
      if (part.heat && typeof a[part.heat] === "number") t.occupiedHeatingSetpoint = toHundredths(clamp(a[part.heat] as number, part.heatLimits ?? [7, 30]));
      if (part.cool && typeof a[part.cool] === "number") t.occupiedCoolingSetpoint = toHundredths(clamp(a[part.cool] as number, part.coolLimits ?? [16, 32]));
      if (typeof a.hvac_mode === "string" && a.hvac_mode in SYSTEM_MODE_FOR) t.systemMode = SYSTEM_MODE_FOR[a.hvac_mode];
      if (typeof a.hvac_action === "string" || a.hvac_action === null) {
        t.thermostatRunningState = { heat: a.hvac_action === "heating", cool: a.hvac_action === "cooling", fan: a.hvac_action === "fan" };
      }
      if (Object.keys(t).length) out.thermostat = t;
      break;
    }
    case "fan": {
      const speed = typeof a.speed_pct === "number" ? Math.round(Math.max(0, Math.min(100, a.speed_pct))) : null;
      const off = on === false || speed === 0;
      const pct = off ? 0 : speed ?? 100;
      if (on !== null || speed !== null) out.fanControl = { fanMode: off ? 0 : fanModeFor(pct), percentSetting: pct, percentCurrent: pct };
      break;
    }
  }
  return out;
}

/** A change another app made, as matter.js reports it: cluster, attribute, new value. */
export interface MatterChange {
  cluster: string;
  attribute: string;
  value: unknown;
}

/**
 * The homeCore command a change means, or null when homeCore already has it
 * (a change that came from homeCore itself, reflected back) or it is not one
 * the device takes.
 */
export function commandFrom(part: BridgePart, c: MatterChange, current: Record<string, unknown>): Record<string, unknown> | null {
  const same = (k: string, v: unknown, tol = 0) =>
    typeof v === "number" && typeof current[k] === "number" ? Math.abs((current[k] as number) - v) <= tol : current[k] === v;
  const key = `${c.cluster}.${c.attribute}`;
  switch (key) {
    case "onOff.onOff": {
      const on = c.value === true;
      return same("on", on) ? null : { on };
    }
    case "levelControl.currentLevel": {
      const pct = levelToPct(num(c.value), true);
      if (pct === null || current.on === false) return null;
      return same("brightness_pct", pct, 1) ? null : { brightness_pct: pct };
    }
    case "colorControl.colorTemperatureMireds": {
      const k = miredsToKelvin(c.value);
      return k === null || same("color_temp", k, 30) ? null : { color_temp: k };
    }
    case "colorControl.currentX":
    case "colorControl.currentY": {
      // Sent as the pair; the caller merges the two halves of one change.
      return null;
    }
    case "doorLock.lockState": {
      const s = num(c.value);
      if (s !== 1 && s !== 2) return null;
      return same("locked", s === 1) ? null : { locked: s === 1 };
    }
    case "windowCovering.targetPositionLiftPercent100ths": {
      const p = coverFromMatter(c.value);
      if (p === null) return null;
      if (part.positioned) return same("position", p, 1) ? null : { position: p };
      // A cover that only opens and closes.
      return p >= 50 ? { action: "open" } : { action: "close" };
    }
    case "thermostat.systemMode": {
      const m = MODE_OF[num(c.value) ?? -1];
      if (!m || !part.modeWritable || !(part.modes ?? []).includes(m)) return null;
      return current.hvac_mode === m ? null : { hvac_mode: m };
    }
    case "thermostat.occupiedHeatingSetpoint": {
      const v = hundredths(c.value);
      if (v === null || !part.heat) return null;
      return same(part.heat, v, 0.05) ? null : { [part.heat]: v };
    }
    case "thermostat.occupiedCoolingSetpoint": {
      const v = hundredths(c.value);
      if (v === null || !part.cool) return null;
      return same(part.cool, v, 0.05) ? null : { [part.cool]: v };
    }
    case "fanControl.percentSetting": {
      const p = num(c.value);
      if (p === null) return null;
      const now = current.on === false ? 0 : typeof current.speed_pct === "number" ? current.speed_pct : current.on ? 100 : 0;
      if (Math.abs(now - p) <= 1) return null;
      return p <= 0 ? { on: false } : { speed_pct: p };
    }
    case "fanControl.fanMode": {
      const m = num(c.value);
      if (m === null) return null;
      const now = current.on === false ? 0 : typeof current.speed_pct === "number" ? current.speed_pct : current.on ? 100 : 0;
      // A mode that already matches the speed is homeCore's own, reflected back.
      if (m <= 3 && fanModeFor(now) === m) return null;
      if (m === 0) return { on: false };
      if (m >= 4) return current.on === true ? null : { on: true };
      return { speed_pct: [0, 33, 66, 100][m] };
    }
    default:
      return null;
  }
}

/** The colour another app set, from both halves. */
export function colorCommand(x: unknown, y: unknown, current: Record<string, unknown>): Record<string, unknown> | null {
  const cx = xyFromMatter(x);
  const cy = xyFromMatter(y);
  if (cx === null || cy === null) return null;
  const cur = current.color_xy as { x?: number; y?: number } | null | undefined;
  if (cur && typeof cur.x === "number" && typeof cur.y === "number" && Math.abs(cur.x - cx) < 0.002 && Math.abs(cur.y - cy) < 0.002) return null;
  return { color_xy: { x: cx, y: cy } };
}
