// Matter endpoints as homeCore devices.
//
// One homeCore device per endpoint that has a device type of its own (bridged
// endpoints included), id `matter_<node>_<endpoint>`. What it reports and takes
// is decided cluster by cluster ("traits"), in homeCore's names and units
// (core's device_vocabulary). Everything here is pure: a node's attributes in,
// devices, state and Matter operations out, so it is tested against a node
// dump (tests/fixtures) and nothing else.
//
// The Matter bridge (homeCore devices into other ecosystems) is planned to use
// the same table in reverse, so a trait keeps "which attribute means what" in
// one place.

import { createHash } from "node:crypto";
import { Attr, Cluster, DeviceTypes, Feature, Global, deviceTypeName } from "./clusters.js";
import {
  coverFromMatter, coverToMatter, halfPercent, hundredths, illuminanceToLux, kelvinToMireds, levelToPct, milli,
  miredsToKelvin, mwhToKwh, num, pctToLevel, rgbToHueSat, rgbToXy, toHundredths, xyFromMatter, xyToMatter, xyToRgb,
  type Rgb, type Xy,
} from "./convert.js";

// ── Shapes ──────────────────────────────────────────────────────────────────

export type Attributes = Record<string, unknown>;

/** What matter-server says about one node (its `MatterNodeData`). */
export interface NodeData {
  node_id: number | bigint;
  available: boolean;
  is_bridge: boolean;
  attributes: Attributes;
  endpoint_parents?: Record<string, number>;
  date_commissioned?: string;
  last_interview?: string;
}

export interface StateLabel { label: string; verb?: string }
export interface AttrSchema {
  kind: "bool" | "integer" | "float" | "string" | "enum" | "color_xy" | "color_rgb" | "color_temp" | "json";
  writable: boolean;
  display_name?: string;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: { value: string; label?: string }[];
  category?: "diagnostic" | "config";
  states?: { when_true: StateLabel; when_false: StateLabel };
}
export interface ParamSpec { name: string; kind: string; label?: string; required?: boolean; default?: unknown; unit?: string; min?: number; max?: number }
export interface ActionSpec { id: string; label: string; description?: string; params?: ParamSpec[]; sentence?: string }
export interface Schema { attributes: Record<string, AttrSchema>; actions?: ActionSpec[] }

export type MatterOp =
  | { op: "command"; endpoint: number; cluster: number; command: string; payload?: Record<string, unknown>; timedMs?: number }
  | { op: "write"; endpoint: number; cluster: number; attribute: number; value: unknown };

export interface Device {
  id: string;
  nodeId: string;
  endpoint: number;
  name: string;
  /** The homeCore device_type. */
  kind: string;
  /** The Matter device type it was made from, by name. */
  matterType: string;
  schema: Schema;
}

export interface CommandPlan {
  ops: MatterOp[];
  /** Keys the command carried that this device has nothing to do with. */
  ignored: string[];
  /** Why nothing can be done, when nothing can. */
  error?: string;
}

// ── Reading a node ──────────────────────────────────────────────────────────

export function nodeIdOf(node: NodeData): string {
  return String(node.node_id);
}

/** A short, path-safe stand-in for a Matter unique id. */
function tag(uid: string, length: number): string {
  return createHash("sha256").update(uid).digest("hex").slice(0, length);
}

/**
 * A device's homeCore id, from what the device says it is rather than the
 * node number this controller happened to give it, so pairing it again
 * (a reset, a lost fabric) brings back the same device, with its name, room,
 * history and automations.
 *
 * - `matter_<node uid>_<endpoint>`: a device's own endpoints.
 * - `matter_<node uid>_<bridged uid>`: a device behind a bridge, which a
 *   bridge may move to another endpoint; `…_<endpoint>` added for a part of
 *   one (an endpoint under the bridged one).
 * - `matter_n<node>_<endpoint>`: a node that gives no unique id (before
 *   Matter 1.2 it was optional).
 */
export function deviceId(node: NodeData, endpoint: number, view?: EndpointView): string {
  const uid = node.attributes[`0/${Cluster.BasicInformation}/${Attr.BasicInformation.UniqueId}`];
  if (typeof uid !== "string" || !uid) return `matter_n${nodeIdOf(node)}_${endpoint}`;
  const base = `matter_${tag(uid, 12)}`;
  for (const ep of view?.searched ?? []) {
    const b = view!.at(ep, Cluster.BridgedDeviceBasicInformation, Attr.BridgedDeviceBasicInformation.UniqueId);
    if (typeof b === "string" && b) return ep === endpoint ? `${base}_${tag(b, 8)}` : `${base}_${tag(b, 8)}_${endpoint}`;
  }
  return `${base}_${endpoint}`;
}

/** The endpoints a node has attributes for, in order. */
function endpointsOf(node: NodeData): number[] {
  const eps = new Set<number>();
  for (const key of Object.keys(node.attributes)) {
    const ep = Number(key.slice(0, key.indexOf("/")));
    if (Number.isInteger(ep)) eps.add(ep);
  }
  return [...eps].sort((a, b) => a - b);
}

function deviceTypesAt(node: NodeData, ep: number): number[] {
  const list = node.attributes[`${ep}/${Cluster.Descriptor}/${Attr.Descriptor.DeviceTypeList}`];
  if (!Array.isArray(list)) return [];
  return list.map((t) => num((t as Record<string, unknown>)?.["0"])).filter((t): t is number => t !== null);
}

/** Direct parents, from the server's endpoint_parents or, failing that, the PartsLists. */
function parentsOf(node: NodeData): Map<number, number> {
  const parents = new Map<number, number>();
  if (node.endpoint_parents) {
    for (const [ep, parent] of Object.entries(node.endpoint_parents)) parents.set(Number(ep), Number(parent));
    return parents;
  }
  // PartsList holds every descendant; the direct parent is the nearest one,
  // which is the one with the shortest PartsList that still lists it.
  const parts = new Map<number, number[]>();
  for (const ep of endpointsOf(node)) {
    const list = node.attributes[`${ep}/${Cluster.Descriptor}/${Attr.Descriptor.PartsList}`];
    if (Array.isArray(list)) parts.set(ep, list.map(Number));
  }
  for (const ep of endpointsOf(node)) {
    if (ep === 0) continue;
    let best: number | null = null;
    for (const [candidate, list] of parts) {
      if (candidate !== ep && list.includes(ep) && (best === null || list.length < parts.get(best)!.length)) best = candidate;
    }
    parents.set(ep, best ?? 0);
  }
  return parents;
}

const isUtility = (t: number) => DeviceTypes[t]?.utility === true;
const AGGREGATOR = 0x000e;

/** One endpoint, and where to look for what it does not carry itself. */
export class EndpointView {
  /**
   * Endpoints searched for a cluster, nearest first: this one, its
   * utility-only children (an electrical sensor under a plug), then its
   * ancestors up to a bridge's aggregator (a bridged node's power source, or
   * a plain node's root on endpoint 0).
   */
  readonly searched: number[];

  constructor(readonly node: NodeData, readonly endpoint: number, parents: Map<number, number>) {
    const children = [...parents.entries()]
      .filter(([, p]) => p === endpoint)
      .map(([c]) => c)
      .filter((c) => {
        const types = deviceTypesAt(node, c);
        return types.length > 0 && types.every(isUtility);
      });
    const ancestors: number[] = [];
    let at = parents.get(endpoint);
    while (at !== undefined && !ancestors.includes(at)) {
      if (deviceTypesAt(node, at).includes(AGGREGATOR)) break;
      ancestors.push(at);
      if (at === 0) break;
      at = parents.get(at);
    }
    this.searched = [endpoint, ...children, ...ancestors];
  }

  /** This endpoint's own attribute. */
  get(cluster: number, attr: number): unknown {
    return this.node.attributes[`${this.endpoint}/${cluster}/${attr}`];
  }

  has(cluster: number): boolean {
    return this.hasAt(this.endpoint, cluster);
  }

  hasAt(ep: number, cluster: number): boolean {
    const servers = this.node.attributes[`${ep}/${Cluster.Descriptor}/${Attr.Descriptor.ServerList}`];
    if (Array.isArray(servers)) return servers.map(Number).includes(cluster);
    return Object.prototype.hasOwnProperty.call(this.node.attributes, `${ep}/${cluster}/${Global.FeatureMap}`);
  }

  features(cluster: number, ep = this.endpoint): number {
    return num(this.node.attributes[`${ep}/${cluster}/${Global.FeatureMap}`]) ?? 0;
  }

  /** The nearest searched endpoint serving a cluster. */
  find(cluster: number): number | null {
    return this.searched.find((ep) => this.hasAt(ep, cluster)) ?? null;
  }

  at(ep: number, cluster: number, attr: number): unknown {
    return this.node.attributes[`${ep}/${cluster}/${attr}`];
  }
}

// ── Traits: one cluster's (or one idea's) part of a device ──────────────────

interface Ctx { v: EndpointView; kind: string }

interface Trait {
  applies(c: Ctx): boolean;
  schema(c: Ctx): Schema;
  state(c: Ctx): Record<string, unknown>;
  /** Command keys and actions this trait answers. */
  keys?: string[];
  actions?: string[];
  command?(c: Ctx, payload: Record<string, unknown>, ops: MatterOp[]): string | void;
}

const reading = (kind: AttrSchema["kind"], extra: Partial<AttrSchema> = {}): AttrSchema => ({ kind, writable: false, ...extra });
const diag = (display_name: string): AttrSchema => ({ kind: "string", writable: false, display_name, category: "diagnostic" });
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Transition time in Matter's tenths of a second, or null for the device's default. */
function tenths(payload: Record<string, unknown>): number | null {
  const ms = payload.transition_ms;
  return isNum(ms) && ms >= 0 ? Math.min(65534, Math.round(ms / 100)) : null;
}

const ExecuteIfOff = { optionsMask: 1, optionsOverride: 1 };

/** On/off, level and colour, together: a light's command is one change. */
const power: Trait = {
  applies: ({ v, kind }) => v.has(Cluster.OnOff) && kind !== "fan",
  keys: ["on", "brightness_pct", "color_temp", "color_xy", "color_rgb", "transition_ms"],
  actions: ["toggle"],
  schema({ v, kind }) {
    const attributes: Record<string, AttrSchema> = { on: { kind: "bool", writable: true } };
    if (kind === "light" && v.has(Cluster.LevelControl)) {
      attributes.brightness_pct = { kind: "float", writable: true, unit: "%", min: 0, max: 100, display_name: "Brightness" };
    }
    if (kind === "light" && v.has(Cluster.ColorControl)) {
      const f = v.features(Cluster.ColorControl);
      if (f & Feature.ColorControl.ColorTemperature) {
        const minM = num(v.get(Cluster.ColorControl, Attr.ColorControl.ColorTempPhysicalMinMireds));
        const maxM = num(v.get(Cluster.ColorControl, Attr.ColorControl.ColorTempPhysicalMaxMireds));
        attributes.color_temp = {
          kind: "color_temp", writable: true, unit: "K", display_name: "Colour temperature",
          ...(maxM ? { min: Math.round(1_000_000 / maxM) } : {}),
          ...(minM ? { max: Math.round(1_000_000 / minM) } : {}),
        };
      }
      if (f & (Feature.ColorControl.Xy | Feature.ColorControl.HueSaturation)) {
        attributes.color_xy = { kind: "color_xy", writable: true, display_name: "Colour" };
      }
    }
    return { attributes, actions: [{ id: "toggle", label: "Toggle", sentence: "toggle {device}" }] };
  },
  state({ v, kind }) {
    const on = bool(v.get(Cluster.OnOff, Attr.OnOff.OnOff));
    const s: Record<string, unknown> = { on };
    if (kind === "light" && v.has(Cluster.LevelControl)) {
      s.brightness_pct = levelToPct(v.get(Cluster.LevelControl, Attr.LevelControl.CurrentLevel), on);
    }
    if (kind === "light" && v.has(Cluster.ColorControl)) {
      const f = v.features(Cluster.ColorControl);
      const mode = num(v.get(Cluster.ColorControl, Attr.ColorControl.ColorMode));
      if (f & Feature.ColorControl.ColorTemperature) {
        s.color_temp = mode === null || mode === 2 ? miredsToKelvin(v.get(Cluster.ColorControl, Attr.ColorControl.ColorTemperatureMireds)) : null;
      }
      if (f & Feature.ColorControl.Xy) {
        const x = xyFromMatter(v.get(Cluster.ColorControl, Attr.ColorControl.CurrentX));
        const y = xyFromMatter(v.get(Cluster.ColorControl, Attr.ColorControl.CurrentY));
        s.color_xy = mode !== 2 && x !== null && y !== null ? { x, y } : null;
      } else if (f & Feature.ColorControl.HueSaturation) {
        s.color_xy = null;
      }
    }
    return s;
  },
  command({ v, kind }, p, ops) {
    const ep = v.endpoint;
    const tt = tenths(p);
    if (p.action === "toggle") {
      ops.push({ op: "command", endpoint: ep, cluster: Cluster.OnOff, command: "toggle" });
      return;
    }
    const isLight = kind === "light";
    // Colour first, with ExecuteIfOff, so a light turned on in the same
    // command comes on in the new colour rather than fading from the old.
    if (isLight && v.has(Cluster.ColorControl)) {
      const f = v.features(Cluster.ColorControl);
      if (isNum(p.color_temp) && f & Feature.ColorControl.ColorTemperature) {
        const mireds = kelvinToMireds(
          p.color_temp,
          num(v.get(Cluster.ColorControl, Attr.ColorControl.ColorTempPhysicalMinMireds)),
          num(v.get(Cluster.ColorControl, Attr.ColorControl.ColorTempPhysicalMaxMireds)),
        );
        ops.push({ op: "command", endpoint: ep, cluster: Cluster.ColorControl, command: "moveToColorTemperature",
          payload: { colorTemperatureMireds: mireds, transitionTime: tt ?? 0, ...ExecuteIfOff } });
      }
      let xy: Xy | null = null;
      if (isXy(p.color_xy)) xy = p.color_xy;
      else if (isRgb(p.color_rgb)) xy = rgbToXy(p.color_rgb);
      if (xy && f & Feature.ColorControl.Xy) {
        ops.push({ op: "command", endpoint: ep, cluster: Cluster.ColorControl, command: "moveToColor",
          payload: { colorX: xyToMatter(xy.x), colorY: xyToMatter(xy.y), transitionTime: tt ?? 0, ...ExecuteIfOff } });
      } else if ((xy || isRgb(p.color_rgb)) && f & Feature.ColorControl.HueSaturation) {
        const rgb = isRgb(p.color_rgb) ? p.color_rgb : xyToRgb(xy!);
        const { hue, saturation } = rgbToHueSat(rgb);
        ops.push({ op: "command", endpoint: ep, cluster: Cluster.ColorControl, command: "moveToHueAndSaturation",
          payload: { hue, saturation, transitionTime: tt ?? 0, ...ExecuteIfOff } });
      }
    }
    const level = isNum(p.brightness_pct) && isLight && v.has(Cluster.LevelControl) ? pctToLevel(p.brightness_pct) : null;
    if (p.on === false || level === 0) {
      ops.push({ op: "command", endpoint: ep, cluster: Cluster.OnOff, command: "off" });
    } else if (level !== null) {
      ops.push({ op: "command", endpoint: ep, cluster: Cluster.LevelControl, command: "moveToLevelWithOnOff",
        payload: { level, transitionTime: tt, optionsMask: 0, optionsOverride: 0 } });
    } else if (p.on === true) {
      // On restores the last level: Matter's On does exactly that.
      ops.push({ op: "command", endpoint: ep, cluster: Cluster.OnOff, command: "on" });
    }
  },
};

function isXy(v: unknown): v is Xy {
  return !!v && typeof v === "object" && isNum((v as Xy).x) && isNum((v as Xy).y);
}
function isRgb(v: unknown): v is Rgb {
  return !!v && typeof v === "object" && isNum((v as Rgb).r) && isNum((v as Rgb).g) && isNum((v as Rgb).b);
}

const LOCK_TIMED_MS = 10_000;

const lock: Trait = {
  applies: ({ v }) => v.has(Cluster.DoorLock),
  keys: ["locked"],
  schema({ v }) {
    const attributes: Record<string, AttrSchema> = {
      locked: { kind: "bool", writable: true, states: { when_true: { label: "Locked", verb: "lock" }, when_false: { label: "Unlocked", verb: "unlock" } } },
      jammed: reading("bool", { display_name: "Jammed" }),
    };
    if (v.features(Cluster.DoorLock) & Feature.DoorLock.DoorPositionSensor) {
      attributes.open = reading("bool", { display_name: "Door", states: { when_true: { label: "Open" }, when_false: { label: "Closed" } } });
    }
    return { attributes };
  },
  state({ v }) {
    const ls = num(v.get(Cluster.DoorLock, Attr.DoorLock.LockState));
    const ds = num(v.get(Cluster.DoorLock, Attr.DoorLock.DoorState));
    const s: Record<string, unknown> = {
      locked: ls === null ? null : ls === 1,
      // NotFullyLocked: the bolt was thrown and did not go home.
      jammed: ls === 0 || ds === 2,
    };
    if (v.features(Cluster.DoorLock) & Feature.DoorLock.DoorPositionSensor) {
      s.open = ds === null ? null : ds === 0 || ds === 5 ? true : ds === 1 ? false : null;
    }
    return s;
  },
  command({ v }, p, ops) {
    if (typeof p.locked !== "boolean") return;
    ops.push({ op: "command", endpoint: v.endpoint, cluster: Cluster.DoorLock,
      command: p.locked ? "lockDoor" : "unlockDoor", payload: {}, timedMs: LOCK_TIMED_MS });
  },
};

const cover: Trait = {
  applies: ({ v }) => v.has(Cluster.WindowCovering),
  keys: ["position", "tilt_pct"],
  actions: ["open", "close", "stop"],
  schema({ v }) {
    const f = v.features(Cluster.WindowCovering);
    const attributes: Record<string, AttrSchema> = {};
    if (f & Feature.WindowCovering.PositionAwareLift) {
      attributes.position = { kind: "float", writable: true, unit: "%", min: 0, max: 100, display_name: "Position" };
    }
    if (f & Feature.WindowCovering.PositionAwareTilt) {
      attributes.tilt_pct = { kind: "float", writable: true, unit: "%", min: 0, max: 100, display_name: "Tilt" };
    }
    return {
      attributes,
      actions: [
        { id: "open", label: "Open", sentence: "open {device}" },
        { id: "close", label: "Close", sentence: "close {device}" },
        { id: "stop", label: "Stop", sentence: "stop {device}" },
      ],
    };
  },
  state({ v }) {
    const f = v.features(Cluster.WindowCovering);
    const s: Record<string, unknown> = {};
    if (f & Feature.WindowCovering.PositionAwareLift) {
      s.position = coverFromMatter(v.get(Cluster.WindowCovering, Attr.WindowCovering.CurrentPositionLiftPercent100ths));
    }
    if (f & Feature.WindowCovering.PositionAwareTilt) {
      s.tilt_pct = coverFromMatter(v.get(Cluster.WindowCovering, Attr.WindowCovering.CurrentPositionTiltPercent100ths));
    }
    return s;
  },
  command({ v }, p, ops) {
    const ep = v.endpoint;
    const cmd = (command: string, payload?: Record<string, unknown>) =>
      ops.push({ op: "command", endpoint: ep, cluster: Cluster.WindowCovering, command, ...(payload ? { payload } : {}) });
    if (p.action === "open") return void cmd("upOrOpen");
    if (p.action === "close") return void cmd("downOrClose");
    if (p.action === "stop") return void cmd("stopMotion");
    const f = v.features(Cluster.WindowCovering);
    if (isNum(p.position)) {
      if (f & Feature.WindowCovering.PositionAwareLift) cmd("goToLiftPercentage", { liftPercent100thsValue: coverToMatter(p.position) });
      else if (p.position >= 100) cmd("upOrOpen");
      else if (p.position <= 0) cmd("downOrClose");
      else return "this cover can only open or close, not stop part way";
    }
    if (isNum(p.tilt_pct) && f & Feature.WindowCovering.PositionAwareTilt) {
      cmd("goToTiltPercentage", { tiltPercent100thsValue: coverToMatter(p.tilt_pct) });
    }
  },
};

const SYSTEM_MODE: Record<number, string> = { 0: "off", 1: "auto", 3: "cool", 4: "heat", 5: "heat", 6: "cool", 7: "fan_only", 8: "dry" };
const SYSTEM_MODE_FOR: Record<string, number> = { off: 0, auto: 1, cool: 3, heat: 4, fan_only: 7, dry: 8 };
const FAN_MODES = ["off", "low", "medium", "high", "on", "auto", "smart"];

const thermostat: Trait = {
  applies: ({ v }) => v.has(Cluster.Thermostat),
  keys: ["heat_setpoint", "cool_setpoint", "hvac_mode"],
  schema({ v }) {
    const f = v.features(Cluster.Thermostat);
    const limit = (a: number) => hundredths(v.get(Cluster.Thermostat, a)) ?? undefined;
    const attributes: Record<string, AttrSchema> = { temperature: reading("float", { unit: "°C" }) };
    const modes = ["off"];
    if (f & Feature.Thermostat.Heating) {
      modes.push("heat");
      attributes.heat_setpoint = { kind: "float", writable: true, unit: "°C", step: 0.5, display_name: "Heat to",
        min: limit(Attr.Thermostat.MinHeatSetpointLimit), max: limit(Attr.Thermostat.MaxHeatSetpointLimit) };
    }
    if (f & Feature.Thermostat.Cooling) {
      modes.push("cool");
      attributes.cool_setpoint = { kind: "float", writable: true, unit: "°C", step: 0.5, display_name: "Cool to",
        min: limit(Attr.Thermostat.MinCoolSetpointLimit), max: limit(Attr.Thermostat.MaxCoolSetpointLimit) };
    }
    if (f & Feature.Thermostat.AutoMode) modes.push("auto");
    attributes.hvac_mode = { kind: "enum", writable: true, display_name: "Mode", options: modes.map((value) => ({ value })) };
    attributes.hvac_action = reading("enum", { display_name: "Doing",
      options: ["idle", "heating", "cooling", "fan", "drying", "off"].map((value) => ({ value })) });
    for (const k of Object.keys(attributes)) if (attributes[k].min === undefined) delete attributes[k].min;
    for (const k of Object.keys(attributes)) if (attributes[k].max === undefined) delete attributes[k].max;
    return { attributes };
  },
  state({ v }) {
    const f = v.features(Cluster.Thermostat);
    const mode = num(v.get(Cluster.Thermostat, Attr.Thermostat.SystemMode));
    const s: Record<string, unknown> = {
      temperature: hundredths(v.get(Cluster.Thermostat, Attr.Thermostat.LocalTemperature)),
      hvac_mode: mode === null ? null : (SYSTEM_MODE[mode] ?? null),
    };
    if (f & Feature.Thermostat.Heating) s.heat_setpoint = hundredths(v.get(Cluster.Thermostat, Attr.Thermostat.OccupiedHeatingSetpoint));
    if (f & Feature.Thermostat.Cooling) s.cool_setpoint = hundredths(v.get(Cluster.Thermostat, Attr.Thermostat.OccupiedCoolingSetpoint));
    s.hvac_action = hvacAction(v, mode);
    return s;
  },
  command({ v }, p, ops) {
    const write = (attribute: number, value: unknown) =>
      ops.push({ op: "write", endpoint: v.endpoint, cluster: Cluster.Thermostat, attribute, value });
    if (typeof p.hvac_mode === "string") {
      const m = SYSTEM_MODE_FOR[p.hvac_mode];
      if (m === undefined) return `unknown hvac_mode ${p.hvac_mode}`;
      write(Attr.Thermostat.SystemMode, m);
    }
    if (isNum(p.heat_setpoint)) write(Attr.Thermostat.OccupiedHeatingSetpoint, toHundredths(p.heat_setpoint));
    if (isNum(p.cool_setpoint)) write(Attr.Thermostat.OccupiedCoolingSetpoint, toHundredths(p.cool_setpoint));
  },
};

function hvacAction(v: EndpointView, mode: number | null): string | null {
  if (mode === 0) return "off";
  const running = num(v.get(Cluster.Thermostat, Attr.Thermostat.ThermostatRunningState));
  if (running !== null) {
    if (running & 0b1001) return "heating";
    if (running & 0b10010) return "cooling";
    if (running & 0b1100100) return "fan";
    return "idle";
  }
  const runningMode = num(v.get(Cluster.Thermostat, Attr.Thermostat.ThermostatRunningMode));
  if (runningMode === 3) return "cooling";
  if (runningMode === 4) return "heating";
  if (runningMode === 0) return "idle";
  return null;
}

/** A fan: on and speed. On a thermostat, the fan's setting. */
const fan: Trait = {
  applies: ({ v }) => v.has(Cluster.FanControl),
  keys: ["on", "speed_pct", "fan_mode"],
  schema({ kind }): Schema {
    if (kind === "thermostat") {
      return { attributes: { fan_mode: { kind: "enum", writable: true, display_name: "Fan", options: FAN_MODES.map((value) => ({ value })) } } };
    }
    return { attributes: {
      on: { kind: "bool", writable: true },
      speed_pct: { kind: "float", writable: true, unit: "%", min: 0, max: 100, step: 1, display_name: "Speed" },
    } };
  },
  state({ v, kind }) {
    const mode = num(v.get(Cluster.FanControl, Attr.FanControl.FanMode));
    if (kind === "thermostat") return { fan_mode: mode === null ? null : (FAN_MODES[mode] ?? null) };
    const pct = num(v.get(Cluster.FanControl, Attr.FanControl.PercentCurrent)) ?? num(v.get(Cluster.FanControl, Attr.FanControl.PercentSetting));
    return { on: mode === null ? null : mode !== 0, speed_pct: pct };
  },
  command({ v, kind }, p, ops) {
    const write = (attribute: number, value: unknown) =>
      ops.push({ op: "write", endpoint: v.endpoint, cluster: Cluster.FanControl, attribute, value });
    if (kind === "thermostat") {
      if (typeof p.fan_mode !== "string") return;
      const m = FAN_MODES.indexOf(p.fan_mode);
      if (m < 0) return `unknown fan_mode ${p.fan_mode}`;
      return void write(Attr.FanControl.FanMode, m);
    }
    if (p.on === false || (isNum(p.speed_pct) && p.speed_pct <= 0)) return void write(Attr.FanControl.FanMode, 0);
    if (isNum(p.speed_pct)) return void write(Attr.FanControl.PercentSetting, Math.min(100, Math.round(p.speed_pct)));
    // Matter fans keep no last speed to go back to; On is the device's own idea of on.
    if (p.on === true) write(Attr.FanControl.FanMode, 4);
  },
};

const measurement = (cluster: number, name: string, unit: string, convert: (v: unknown) => number | null, extra: Partial<AttrSchema> = {}): Trait => ({
  applies: ({ v, kind }) => v.has(cluster) && !(kind === "thermostat" && name === "temperature"),
  schema: () => ({ attributes: { [name]: reading("float", { unit, ...extra }) } }),
  state: ({ v }) => ({ [name]: convert(v.get(cluster, Attr.Measurement.MeasuredValue)) }),
});

/** CO₂ in ppm, from whichever unit the sensor measures in (MeasurementUnit). */
export function co2Ppm(value: unknown, unit: unknown): number | null {
  const v = num(value);
  if (v === null) return null;
  // 0 ppm, 1 ppb, 2 ppt; the mass units can't become ppm without more than we know.
  const per: Record<number, number> = { 0: 1, 1: 1e-3, 2: 1e-6 };
  const u = num(unit) ?? 0;
  return per[u] === undefined ? null : Math.round(v * per[u] * 10) / 10;
}

const co2: Trait = {
  applies: ({ v }) => v.has(Cluster.CarbonDioxideConcentrationMeasurement),
  schema: () => ({ attributes: { co2: reading("float", { unit: "ppm" }) } }),
  state: ({ v }) => ({ co2: co2Ppm(v.get(Cluster.CarbonDioxideConcentrationMeasurement, 0), v.get(Cluster.CarbonDioxideConcentrationMeasurement, 8)) }),
};

const occupancy: Trait = {
  applies: ({ v }) => v.has(Cluster.OccupancySensing),
  schema: () => ({ attributes: { occupied: reading("bool", { states: { when_true: { label: "Occupied" }, when_false: { label: "Clear" } } }) } }),
  state: ({ v }) => {
    const o = num(v.get(Cluster.OccupancySensing, Attr.OccupancySensing.Occupancy));
    return { occupied: o === null ? null : (o & 1) === 1 };
  },
};

/** BooleanState means what the device type says it means. */
const booleanState: Trait = {
  applies: ({ v }) => v.has(Cluster.BooleanState),
  schema({ kind }): Schema {
    if (kind === "contact_sensor") return { attributes: { open: reading("bool", { states: { when_true: { label: "Open" }, when_false: { label: "Closed" } } }) } };
    if (kind === "water_sensor") return { attributes: { water_detected: reading("bool", { states: { when_true: { label: "Wet" }, when_false: { label: "Dry" } } }) } };
    if (kind === "rain_sensor") return { attributes: { rain_detected: reading("bool", { display_name: "Rain" }) } };
    return { attributes: { boolean_state: reading("bool", { display_name: "State" }) } };
  },
  state({ v, kind }) {
    const b = bool(v.get(Cluster.BooleanState, Attr.BooleanState.StateValue));
    // A contact sensor's StateValue is true while the contact is made: closed.
    if (kind === "contact_sensor") return { open: b === null ? null : !b };
    if (kind === "water_sensor") return { water_detected: b };
    if (kind === "rain_sensor") return { rain_detected: b };
    return { boolean_state: b };
  },
};

const battery: Trait = {
  applies: ({ v }) => {
    const ep = v.find(Cluster.PowerSource);
    return ep !== null && (v.features(Cluster.PowerSource, ep) & Feature.PowerSource.Battery) !== 0;
  },
  schema: () => ({ attributes: {
    battery_pct: reading("float", { unit: "%", min: 0, max: 100, display_name: "Battery" }),
    battery_low: reading("bool", { display_name: "Battery low", category: "diagnostic" }),
  } }),
  state({ v }) {
    const ep = v.find(Cluster.PowerSource)!;
    const level = num(v.at(ep, Cluster.PowerSource, Attr.PowerSource.BatChargeLevel));
    return {
      battery_pct: halfPercent(v.at(ep, Cluster.PowerSource, Attr.PowerSource.BatPercentRemaining)),
      battery_low: level === null ? null : level >= 1,
    };
  },
};

const electrical: Trait = {
  applies: ({ v }) => v.find(Cluster.ElectricalPowerMeasurement) !== null || v.find(Cluster.ElectricalEnergyMeasurement) !== null,
  schema({ v }) {
    const attributes: Record<string, AttrSchema> = {};
    if (v.find(Cluster.ElectricalPowerMeasurement) !== null) {
      attributes.power_w = reading("float", { unit: "W", display_name: "Power" });
      attributes.voltage = reading("float", { unit: "V", category: "diagnostic" });
      attributes.current_a = reading("float", { unit: "A", display_name: "Current", category: "diagnostic" });
    }
    if (v.find(Cluster.ElectricalEnergyMeasurement) !== null) attributes.energy_kwh = reading("float", { unit: "kWh", display_name: "Energy" });
    return { attributes };
  },
  state({ v }) {
    const s: Record<string, unknown> = {};
    const p = v.find(Cluster.ElectricalPowerMeasurement);
    if (p !== null) {
      s.power_w = milli(v.at(p, Cluster.ElectricalPowerMeasurement, Attr.ElectricalPowerMeasurement.ActivePower));
      s.voltage = milli(v.at(p, Cluster.ElectricalPowerMeasurement, Attr.ElectricalPowerMeasurement.Voltage));
      s.current_a = milli(v.at(p, Cluster.ElectricalPowerMeasurement, Attr.ElectricalPowerMeasurement.ActiveCurrent));
    }
    const e = v.find(Cluster.ElectricalEnergyMeasurement);
    if (e !== null) {
      const m = v.at(e, Cluster.ElectricalEnergyMeasurement, Attr.ElectricalEnergyMeasurement.CumulativeEnergyImported) as Record<string, unknown> | null;
      s.energy_kwh = m && typeof m === "object" ? mwhToKwh(m["0"]) : null;
    }
    return s;
  },
};

const identify: Trait = {
  applies: ({ v }) => v.has(Cluster.Identify),
  schema: () => ({ attributes: {}, actions: [{
    id: "identify", label: "Identify",
    description: "Make the device show itself (blink, beep) so you can tell which one it is.",
    params: [{ name: "duration_secs", kind: "int", label: "For", unit: "s", default: 10, min: 1, max: 300 }],
    sentence: "identify {device}",
  }] }),
  state: () => ({}),
  actions: ["identify"],
  command({ v }, p, ops) {
    if (p.action !== "identify") return;
    const secs = isNum(p.duration_secs) ? Math.max(1, Math.min(300, Math.round(p.duration_secs))) : 10;
    ops.push({ op: "command", endpoint: v.endpoint, cluster: Cluster.Identify, command: "identify", payload: { identifyTime: secs } });
  },
};

const TRAITS: Trait[] = [
  power, lock, cover, thermostat, fan,
  measurement(Cluster.TemperatureMeasurement, "temperature", "°C", hundredths),
  measurement(Cluster.RelativeHumidityMeasurement, "humidity", "%", hundredths, { min: 0, max: 100 }),
  measurement(Cluster.IlluminanceMeasurement, "illuminance", "lux", illuminanceToLux),
  measurement(Cluster.PressureMeasurement, "pressure", "hPa", num),
  co2,
  occupancy, booleanState, battery, electrical, identify,
];

/** Clusters some trait reads, so the rest can be listed as not mapped. */
const MAPPED = new Set<number>([
  Cluster.Identify, Cluster.OnOff, Cluster.LevelControl, Cluster.Descriptor, Cluster.PowerSource,
  Cluster.BridgedDeviceBasicInformation, Cluster.BooleanState, Cluster.ElectricalPowerMeasurement,
  Cluster.ElectricalEnergyMeasurement, Cluster.DoorLock, Cluster.WindowCovering, Cluster.Thermostat,
  Cluster.FanControl, Cluster.ColorControl, Cluster.IlluminanceMeasurement, Cluster.TemperatureMeasurement,
  Cluster.PressureMeasurement, Cluster.RelativeHumidityMeasurement, Cluster.OccupancySensing,
  Cluster.CarbonDioxideConcentrationMeasurement,
  // Plumbing every device has, which says nothing about what it does.
  4 /* Groups */, 5 /* Scenes */, 30 /* Binding */, 98 /* ScenesManagement */,
]);

// ── Devices of a node ───────────────────────────────────────────────────────

interface Found { endpoint: number; types: number[]; kind: string; view: EndpointView }

function found(node: NodeData): Found[] {
  const parents = parentsOf(node);
  const out: Found[] = [];
  for (const ep of endpointsOf(node)) {
    if (ep === 0) continue;
    const types = deviceTypesAt(node, ep).filter((t) => !isUtility(t));
    if (types.length === 0) continue;
    const known = types.find((t) => DeviceTypes[t]?.kind);
    out.push({ endpoint: ep, types, kind: known !== undefined ? DeviceTypes[known].kind! : "matter", view: new EndpointView(node, ep, parents) });
  }
  return out;
}

function text(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** What the device calls itself: its bridged name, else the node's. */
function baseName(f: Found): string {
  const v = f.view;
  for (const ep of v.searched) {
    const label = text(v.at(ep, Cluster.BridgedDeviceBasicInformation, Attr.BridgedDeviceBasicInformation.NodeLabel))
      ?? text(v.at(ep, Cluster.BridgedDeviceBasicInformation, Attr.BridgedDeviceBasicInformation.ProductName));
    if (label) return label;
  }
  const b = (a: number) => text(v.node.attributes[`0/${Cluster.BasicInformation}/${a}`]);
  return b(Attr.BasicInformation.NodeLabel) ?? b(Attr.BasicInformation.ProductName)
    ?? (b(Attr.BasicInformation.VendorName) ? `${b(Attr.BasicInformation.VendorName)} device` : `Matter device ${nodeIdOf(v.node)}`);
}

/** Vendor, product, firmware and serial: the bridged device's own, else the node's. */
function about(f: Found): Record<string, string | null> {
  const v = f.view;
  const bridged = v.searched.find((ep) => v.hasAt(ep, Cluster.BridgedDeviceBasicInformation));
  const pick = (bridgedAttr: number, basicAttr: number) =>
    (bridged !== undefined ? text(v.at(bridged, Cluster.BridgedDeviceBasicInformation, bridgedAttr)) : null)
    ?? text(v.node.attributes[`0/${Cluster.BasicInformation}/${basicAttr}`]);
  const B = Attr.BridgedDeviceBasicInformation;
  const N = Attr.BasicInformation;
  return {
    vendor: pick(B.VendorName, N.VendorName),
    product: pick(B.ProductName, N.ProductName),
    firmware_version: pick(B.SoftwareVersionString, N.SoftwareVersionString),
    serial_number: pick(B.SerialNumber, N.SerialNumber),
  };
}

function unmappedClusters(v: EndpointView): string | null {
  const servers = v.get(Cluster.Descriptor, Attr.Descriptor.ServerList);
  if (!Array.isArray(servers)) return null;
  const rest = servers.map(Number).filter((c) => !MAPPED.has(c));
  return rest.length ? rest.map((c) => `0x${c.toString(16).padStart(4, "0")}`).join(", ") : null;
}

const KIND_WORD: Record<string, string> = {
  light: "light", switch: "switch", lock: "lock", cover: "cover", thermostat: "thermostat", fan: "fan",
  contact_sensor: "contact", occupancy_sensor: "occupancy", temperature_sensor: "temperature",
  humidity_sensor: "humidity", light_sensor: "light level", pressure_sensor: "pressure",
  water_sensor: "leak", rain_sensor: "rain", air_quality_sensor: "air quality",
};

/** Every device a node has, with its schema. */
export function devicesOf(node: NodeData): Device[] {
  const nodeId = nodeIdOf(node);
  const all = found(node);
  const names = all.map(baseName);
  return all.map((f, i) => {
    // Two endpoints sharing a name (a sensor's temperature and humidity) get
    // what each is added, so neither is "Hall Climate (2)".
    const shared = names.filter((n) => n === names[i]).length > 1;
    const word = KIND_WORD[f.kind] ?? deviceTypeName(f.types[0]).toLowerCase();
    const name = shared ? `${names[i]} ${word}` : names[i];
    const c: Ctx = { v: f.view, kind: f.kind };
    const schema: Schema = { attributes: {}, actions: [] };
    for (const t of TRAITS) {
      if (!t.applies(c)) continue;
      const s = t.schema(c);
      Object.assign(schema.attributes, s.attributes);
      schema.actions!.push(...(s.actions ?? []));
    }
    schema.attributes.matter_device_type = diag("Matter device type");
    for (const [k, label] of [["vendor", "Vendor"], ["product", "Product"], ["firmware_version", "Firmware"], ["serial_number", "Serial number"]]) {
      schema.attributes[k] = diag(label);
    }
    if (unmappedClusters(f.view)) schema.attributes.matter_unmapped_clusters = diag("Matter clusters not shown");
    if (schema.actions!.length === 0) delete schema.actions;
    return {
      id: deviceId(node, f.endpoint, f.view), nodeId, endpoint: f.endpoint, name, kind: f.kind,
      matterType: f.types.map(deviceTypeName).join(", "), schema,
    };
  });
}

function findDevice(node: NodeData, device: Device): Found | undefined {
  return found(node).find((f) => f.endpoint === device.endpoint);
}

/** The device's whole state, in homeCore's names and units. */
export function stateOf(node: NodeData, device: Device): Record<string, unknown> {
  const f = findDevice(node, device);
  if (!f) return {};
  const c: Ctx = { v: f.view, kind: f.kind };
  const s: Record<string, unknown> = {};
  for (const t of TRAITS) if (t.applies(c)) Object.assign(s, t.state(c));
  s.matter_device_type = device.matterType;
  Object.assign(s, about(f));
  const unmapped = unmappedClusters(f.view);
  if (unmapped) s.matter_unmapped_clusters = unmapped;
  return s;
}

/** Online: the node answers, and a bridge says the device behind it is reachable. */
export function availableOf(node: NodeData, device: Device): boolean {
  if (!node.available) return false;
  const f = findDevice(node, device);
  if (!f) return false;
  for (const ep of f.view.searched) {
    const r = f.view.at(ep, Cluster.BridgedDeviceBasicInformation, Attr.BridgedDeviceBasicInformation.Reachable);
    if (typeof r === "boolean") return r;
  }
  return true;
}

/** The Matter operations a homeCore command means for this device. */
export function commandFor(node: NodeData, device: Device, payload: Record<string, unknown>): CommandPlan {
  const f = findDevice(node, device);
  if (!f) return { ops: [], ignored: [], error: "the device is no longer on its node" };
  const c: Ctx = { v: f.view, kind: f.kind };
  const p = Object.fromEntries(Object.entries(payload).filter(([k]) => k !== "_hc"));
  const ops: MatterOp[] = [];
  const handled = new Set<string>();
  const traits = TRAITS.filter((t) => t.applies(c) && t.command);
  for (const t of traits) {
    const mine = typeof p.action === "string" ? (t.actions ?? []).includes(p.action) : (t.keys ?? []).some((k) => k in p);
    if (!mine) continue;
    const err = t.command!(c, p, ops);
    if (err) return { ops: [], ignored: [], error: err };
    for (const k of t.keys ?? []) if (k in p) handled.add(k);
    if (typeof p.action === "string") handled.add("action");
  }
  const ignored = Object.keys(p).filter((k) => !handled.has(k) && !(p.action && k !== "action"));
  if (typeof p.action === "string" && !handled.has("action")) {
    return { ops: [], ignored, error: `${device.name} has no action ${p.action}` };
  }
  if (ops.length === 0 && ignored.length > 0) {
    return { ops, ignored, error: `${device.name} cannot be set: ${ignored.join(", ")}` };
  }
  // Keys a trait claims but can't act on here: brightness on a switch, a fan's
  // "on" on a thermostat. Nothing to send is a refusal, not a silent success.
  if (ops.length === 0 && typeof p.action !== "string") {
    const asked = Object.keys(p).filter((k) => k !== "transition_ms");
    if (asked.length) return { ops, ignored, error: `${device.name} cannot be set: ${asked.join(", ")}` };
  }
  return { ops, ignored };
}

/** Which devices an attribute change touches: the endpoints that search it. */
export function devicesTouchedBy(node: NodeData, devices: Device[], attributeKey: string): Device[] {
  const ep = Number(attributeKey.slice(0, attributeKey.indexOf("/")));
  const parents = parentsOf(node);
  return devices.filter((d) => d.endpoint === ep || new EndpointView(node, d.endpoint, parents).searched.includes(ep)
    || (ep === 0 && !node.is_bridge));
}
