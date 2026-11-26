// homeCore devices as Matter devices: the bridge's half of the mapping, the
// reverse of devices.ts. Pure, and tested (tests/bridge-model.test.ts).
//
// A homeCore device is offered when its type has a Matter counterpart. Its
// state becomes cluster state (homeCore's units to Matter's scales, with the
// same conversions the controller uses the other way), and a change another
// app makes becomes a homeCore command in homeCore's names.

import { coverFromMatter, coverToMatter, kelvinToMireds, levelToPct, miredsToKelvin, num, pctToLevel, toHundredths, xyFromMatter, xyToMatter } from "../convert.js";

/** A device as homeCore's event stream and snapshot describe it. */
export interface HomeDevice {
  device_id: string;
  name: string;
  name_override?: string | null;
  device_type?: string | null;
  plugin_id?: string | null;
  available?: boolean;
  attributes: Record<string, unknown>;
  schema?: { attributes?: Record<string, { writable?: boolean }> } | null;
  ui_hint?: string | null;
  security?: boolean | null;
}

export type BridgeKind =
  | "on_off_light" | "dimmable_light" | "color_temperature_light" | "extended_color_light"
  | "plug" | "door_lock" | "window_covering" | "contact_sensor" | "occupancy_sensor"
  | "temperature_sensor" | "humidity_sensor" | "water_leak" | "light_sensor";

/** One Matter endpoint a homeCore device becomes (a climate sensor becomes two). */
export interface BridgePart {
  /** Stable id for matter.js, which keeps the endpoint's number by it. */
  key: string;
  kind: BridgeKind;
  /** Whether the lift can be set to a position, for a cover. */
  positioned?: boolean;
}

export const BRIDGE_KIND_NAMES: Record<BridgeKind, string> = {
  on_off_light: "light", dimmable_light: "dimmable light", color_temperature_light: "white light",
  extended_color_light: "colour light", plug: "switch", door_lock: "lock", window_covering: "blind or cover",
  contact_sensor: "contact sensor", occupancy_sensor: "occupancy sensor", temperature_sensor: "temperature sensor",
  humidity_sensor: "humidity sensor", water_leak: "leak sensor", light_sensor: "light sensor",
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
