// The Matter bridge: shared homeCore devices, as one Matter bridge that Apple
// Home, Google Home, Alexa or any Matter controller can pair.
//
// A matter.js server node in this process: the controller side is
// matter-server's, in its own process, so the two never share matter.js's
// process-wide state. Its own port, its own storage (data/bridge), its own
// pairing code.

import { Endpoint, Environment, Logger, ServerNode, VendorId } from "@matter/main";
import { AggregatorEndpoint } from "@matter/main/endpoints/aggregator";
import { BridgedDeviceBasicInformationServer } from "@matter/main/behaviors/bridged-device-basic-information";
import { ColorControlServer } from "@matter/main/behaviors/color-control";
import { DoorLockServer } from "@matter/main/behaviors/door-lock";
import { WindowCoveringServer } from "@matter/main/behaviors/window-covering";
import { OccupancySensingServer } from "@matter/main/behaviors/occupancy-sensing";
import { ThermostatServer } from "@matter/main/behaviors/thermostat";
import { FanControlServer } from "@matter/main/behaviors/fan-control";
import { ThermostatDevice } from "@matter/main/devices/thermostat";
import { FanDevice } from "@matter/main/devices/fan";
import { OnOffLightDevice } from "@matter/main/devices/on-off-light";
import { DimmableLightDevice } from "@matter/main/devices/dimmable-light";
import { ColorTemperatureLightDevice } from "@matter/main/devices/color-temperature-light";
import { ExtendedColorLightDevice } from "@matter/main/devices/extended-color-light";
import { OnOffPlugInUnitDevice } from "@matter/main/devices/on-off-plug-in-unit";
import { DoorLockDevice } from "@matter/main/devices/door-lock";
import { WindowCoveringDevice } from "@matter/main/devices/window-covering";
import { ContactSensorDevice } from "@matter/main/devices/contact-sensor";
import { OccupancySensorDevice } from "@matter/main/devices/occupancy-sensor";
import { TemperatureSensorDevice } from "@matter/main/devices/temperature-sensor";
import { HumiditySensorDevice } from "@matter/main/devices/humidity-sensor";
import { WaterLeakDetectorDevice } from "@matter/main/devices/water-leak-detector";
import { LightSensorDevice } from "@matter/main/devices/light-sensor";
import { createHash } from "node:crypto";
import type { Log } from "../server.js";
import { clusterState, colorCommand, commandFrom, homeName, type BridgeKind, type BridgePart, type HomeDevice } from "./model.js";

/** The controller (matter-server) has 5540. */
export const BRIDGE_PORT = 5541;
/** Changes another app makes within this long are one command (a dimmer's fade is many). */
const SETTLE_MS = 250;

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyEndpoint = Endpoint<any>;

const B = BridgedDeviceBasicInformationServer;

/** Open, close and stop from another app, by endpoint id, to the bridge that owns it. */
const coverActions = new Map<string, (action: "open" | "close" | "stop") => void>();

/**
 * A cover's server that tells homeCore about open, close and stop. matter.js
 * moves only a position-aware cover's target, so for one that only opens and
 * closes, nothing else would ever reach homeCore; and stop moves nothing at all.
 */
function coverServer(positioned: boolean): any {
  const Base: any = positioned ? WindowCoveringServer.with("Lift", "PositionAwareLift") : WindowCoveringServer.with("Lift");
  return class extends Base {
    async upOrOpen() {
      if (!positioned) return coverActions.get(this.endpoint.id)?.("open");
      return super.upOrOpen();
    }
    async downOrClose() {
      if (!positioned) return coverActions.get(this.endpoint.id)?.("close");
      return super.downOrClose();
    }
    async stopMotion() {
      coverActions.get(this.endpoint.id)?.("stop");
      if (positioned) return super.stopMotion();
    }
  };
}

/** Each kind's matter.js device, and the state it must start with. */
function makeEndpoint(part: BridgePart, name: string, uniqueId: string, reachable: boolean): AnyEndpoint {
  const bridged = { bridgedDeviceBasicInformation: { nodeLabel: name.slice(0, 32), productName: name.slice(0, 32), reachable, uniqueId } };
  const color = { colorTempPhysicalMinMireds: 153, colorTempPhysicalMaxMireds: 500, coupleColorTempToLevelMinMireds: 153,
    colorTemperatureMireds: 370, startUpColorTemperatureMireds: 370, colorMode: 2, enhancedColorMode: 2 };
  const id = part.key;
  const kinds: Record<BridgeKind, () => AnyEndpoint> = {
    on_off_light: () => new Endpoint(OnOffLightDevice.with(B), { id, ...bridged }),
    dimmable_light: () => new Endpoint(DimmableLightDevice.with(B), { id, ...bridged }),
    color_temperature_light: () => new Endpoint(ColorTemperatureLightDevice.with(B, ColorControlServer.with("ColorTemperature")),
      { id, ...bridged, colorControl: color } as any),
    extended_color_light: () => new Endpoint(ExtendedColorLightDevice.with(B, ColorControlServer.with("Xy", "ColorTemperature")),
      { id, ...bridged, colorControl: { ...color, currentX: 0x5000, currentY: 0x5400 } } as any),
    plug: () => new Endpoint(OnOffPlugInUnitDevice.with(B), { id, ...bridged }),
    door_lock: () => new Endpoint(DoorLockDevice.with(B, DoorLockServer),
      { id, ...bridged, doorLock: { lockState: 1, lockType: 0, actuatorEnabled: true, operatingMode: 0 } } as any),
    window_covering: () => new Endpoint(
      WindowCoveringDevice.with(B, coverServer(!!part.positioned)),
      { id, ...bridged, windowCovering: part.positioned
        ? { type: 0, endProductType: 0, currentPositionLiftPercent100ths: 0, targetPositionLiftPercent100ths: 0 }
        : { type: 0, endProductType: 0 } } as any),
    contact_sensor: () => new Endpoint(ContactSensorDevice.with(B), { id, ...bridged, booleanState: { stateValue: true } } as any),
    occupancy_sensor: () => new Endpoint(OccupancySensorDevice.with(B, OccupancySensingServer.with("PassiveInfrared")),
      { id, ...bridged, occupancySensing: { occupancy: { occupied: false }, occupancySensorType: 0, occupancySensorTypeBitmap: { pir: true } } } as any),
    temperature_sensor: () => new Endpoint(TemperatureSensorDevice.with(B),
      { id, ...bridged, temperatureMeasurement: { measuredValue: null, minMeasuredValue: null, maxMeasuredValue: null } } as any),
    humidity_sensor: () => new Endpoint(HumiditySensorDevice.with(B),
      { id, ...bridged, relativeHumidityMeasurement: { measuredValue: null, minMeasuredValue: 0, maxMeasuredValue: 10000 } } as any),
    water_leak: () => new Endpoint(WaterLeakDetectorDevice.with(B), { id, ...bridged, booleanState: { stateValue: false } } as any),
    light_sensor: () => new Endpoint(LightSensorDevice.with(B),
      { id, ...bridged, illuminanceMeasurement: { measuredValue: null, minMeasuredValue: null, maxMeasuredValue: null } } as any),
    thermostat: () => thermostatEndpoint(part, id, bridged),
    fan: () => new Endpoint(FanDevice.with(B, FanControlServer),
      { id, ...bridged, fanControl: { fanMode: 0, fanModeSequence: 0, percentSetting: 0, percentCurrent: 0 } } as any),
  };
  return kinds[part.kind]();
}

/** A thermostat with the features the homeCore one has: heating, cooling, and auto when it has both. */
function thermostatEndpoint(part: BridgePart, id: string, bridged: object): AnyEndpoint {
  const features: ("Heating" | "Cooling" | "AutoMode")[] = [];
  if (part.heat) features.push("Heating");
  if (part.cool) features.push("Cooling");
  const auto = !!part.heat && !!part.cool && (part.modes ?? []).includes("auto");
  if (auto) features.push("AutoMode");
  const [hLo, hHi] = part.heatLimits ?? [7, 30];
  const [cLo, cHi] = part.coolLimits ?? [16, 32];
  const c = (v: number) => Math.round(v * 100);
  const t: Record<string, unknown> = {
    localTemperature: null,
    // Heating only, cooling only, or both (ControlSequenceOfOperation).
    controlSequenceOfOperation: part.heat && part.cool ? 4 : part.heat ? 2 : 0,
    systemMode: part.heat ? 4 : 3,
    thermostatRunningState: { heat: false, cool: false, fan: false },
  };
  if (part.heat) Object.assign(t, { occupiedHeatingSetpoint: c(Math.min(hHi, Math.max(hLo, 20))), absMinHeatSetpointLimit: c(hLo), absMaxHeatSetpointLimit: c(hHi), minHeatSetpointLimit: c(hLo), maxHeatSetpointLimit: c(hHi) });
  if (part.cool) Object.assign(t, { occupiedCoolingSetpoint: c(Math.min(cHi, Math.max(cLo, 26))), absMinCoolSetpointLimit: c(cLo), absMaxCoolSetpointLimit: c(cHi), minCoolSetpointLimit: c(cLo), maxCoolSetpointLimit: c(cHi) });
  if (auto) t.minSetpointDeadBand = 2;
  return new Endpoint(ThermostatDevice.with(B, ThermostatServer.with(...features)), { id, ...bridged, thermostat: t } as any);
}

/** A part's UniqueID: stable, and within Matter's 32 characters. */
export function uniqueIdFor(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 32);
}

/** The attributes the bridge listens to, per cluster, for changes another app makes. */
const WATCHED: Record<string, string[]> = {
  onOff: ["onOff"],
  levelControl: ["currentLevel"],
  colorControl: ["colorTemperatureMireds", "currentX", "currentY"],
  doorLock: ["lockState"],
  windowCovering: ["targetPositionLiftPercent100ths"],
  thermostat: ["systemMode", "occupiedHeatingSetpoint", "occupiedCoolingSetpoint"],
  fanControl: ["percentSetting", "fanMode"],
};

interface Shared {
  device: HomeDevice;
  parts: { part: BridgePart; endpoint: AnyEndpoint }[];
  pending: Record<string, unknown>;
  timer: NodeJS.Timeout | null;
  /** Puts homeCore's state back after a change it can't take. */
  resync: NodeJS.Timeout | null;
  /** On the bridge already (a share during start must not add it twice). */
  added: boolean;
  /** Setting homeCore's state into it now: the changes that causes are not another app's. */
  applying: number;
  /** Colour arrives as two attributes; kept until both are known. */
  xy: { x?: unknown; y?: unknown };
}

export interface BridgeInfo {
  running: boolean;
  commissioned: boolean;
  qr_code: string | null;
  manual_code: string | null;
  fabrics: { fabric_index: number; label: string; vendor_id: number }[];
}

export class MatterBridge {
  private node: ServerNode | null = null;
  private aggregator: AnyEndpoint | null = null;
  private readonly shared = new Map<string, Shared>();
  private starting: Promise<void> | null = null;

  constructor(
    private readonly storageDir: string,
    private readonly code: { passcode: number; discriminator: number },
    private readonly log: Log,
    private readonly send: (deviceId: string, body: Record<string, unknown>) => Promise<void>,
  ) {}

  get running(): boolean {
    return this.node !== null;
  }

  start(): Promise<void> {
    if (!this.starting) this.starting = this.doStart().catch((e) => {
      this.starting = null;
      throw e;
    });
    return this.starting;
  }

  private async doStart(): Promise<void> {
    // Everything matter.js keeps for the bridge (its fabrics, endpoint numbers).
    Environment.default.vars.set("path.root", this.storageDir);
    // Warnings and worse only. matter.js prints the pairing passcode at
    // notice when the bridge starts unpaired, and whoever has that can pair
    // the bridge and command everything shared, locks included. Only
    // bridge_status, an admin's action, hands it out; the log must not.
    Logger.level = "warn";
    const node = await ServerNode.create({
      id: "homecore-bridge",
      network: { port: BRIDGE_PORT },
      commissioning: { passcode: this.code.passcode, discriminator: this.code.discriminator },
      productDescription: { name: "homeCore", deviceType: AggregatorEndpoint.deviceType },
      basicInformation: {
        vendorName: "homeCore",
        // Matter's test vendor: the bridge is not certified.
        vendorId: VendorId(0xfff1),
        productName: "Matter bridge",
        productId: 0x8001,
        nodeLabel: "homeCore",
        serialNumber: "homecore-bridge",
      },
    } as any);
    try {
      const aggregator = new Endpoint(AggregatorEndpoint, { id: "devices" });
      await node.add(aggregator);
      this.aggregator = aggregator;
      for (const s of [...this.shared.values()]) {
        try {
          await this.addParts(s);
        } catch (e) {
          // One device matter.js refuses must not keep the rest off the bridge.
          this.log("warn", `bridge: left ${homeName(s.device)} off: ${(e as Error).message}`);
        }
      }
      await node.start();
      // Only now is it running: a failed start leaves nothing half-made.
      this.node = node;
      this.log("info", `bridge: running on port ${BRIDGE_PORT}, ${this.shared.size} device(s) shared`);
    } catch (e) {
      this.aggregator = null;
      for (const s of this.shared.values()) {
        s.added = false;
        for (const p of s.parts) p.endpoint = null as unknown as AnyEndpoint;
      }
      try {
        await node.close();
      } catch {
        // already closed
      }
      throw e;
    }
  }

  async stop(): Promise<void> {
    const node = this.node;
    this.node = null;
    this.aggregator = null;
    this.starting = null;
    for (const s of this.shared.values()) {
      if (s.timer) clearTimeout(s.timer);
      if (s.resync) clearTimeout(s.resync);
      s.added = false;
      for (const p of s.parts) p.endpoint = null as unknown as AnyEndpoint;
    }
    if (node) {
      try {
        await node.close();
      } catch (e) {
        this.log("debug", `bridge: closing: ${(e as Error).message}`);
      }
    }
  }

  /** Forget every app it is paired with, and start again with `code`. */
  async reset(code: { passcode: number; discriminator: number }): Promise<void> {
    const node = this.node;
    if (node) await node.erase();
    await this.stop();
    this.code.passcode = code.passcode;
    this.code.discriminator = code.discriminator;
  }

  info(): BridgeInfo {
    const n = this.node as any;
    if (!n) return { running: false, commissioned: false, qr_code: null, manual_code: null, fabrics: [] };
    const c = n.state.commissioning;
    const fabrics = Object.values(c.fabrics ?? {}).map((f: any) => ({
      fabric_index: Number(f.fabricIndex), label: String(f.label ?? ""), vendor_id: Number(f.rootVendorId),
    }));
    return {
      running: true,
      commissioned: !!c.commissioned,
      qr_code: c.pairingCodes?.qrPairingCode ?? null,
      manual_code: c.pairingCodes?.manualPairingCode ?? null,
      fabrics,
    };
  }

  // ── Devices ─────────────────────────────────────────────────────────────

  /** Share a device (or update what it is), with these parts. */
  async share(device: HomeDevice, parts: BridgePart[]): Promise<void> {
    const before = this.shared.get(device.device_id);
    const sameParts = before && JSON.stringify(before.parts.map((p) => p.part)) === JSON.stringify(parts);
    if (before && sameParts) {
      const renamed = homeName(before.device) !== homeName(device);
      before.device = device;
      // A rename is a new label on the same endpoint: re-creating it would
      // make the other app forget its room, scenes and automations for it.
      if (renamed) {
        for (const { part, endpoint } of before.parts) {
          if (!endpoint) continue;
          const label = `${homeName(device)}${part.key.endsWith("_rh") ? " humidity" : ""}`.slice(0, 32);
          await this.safeSet(endpoint, { bridgedDeviceBasicInformation: { nodeLabel: label } }, device.device_id);
        }
      }
      await this.applyState(before);
      return;
    }
    if (before) await this.unshare(device.device_id);
    const s: Shared = { device, parts: parts.map((part) => ({ part, endpoint: null as unknown as AnyEndpoint })), pending: {}, timer: null, resync: null, added: false, applying: 0, xy: {} };
    this.shared.set(device.device_id, s);
    if (this.aggregator) await this.addParts(s);
  }

  async unshare(deviceId: string): Promise<void> {
    const s = this.shared.get(deviceId);
    if (!s) return;
    this.shared.delete(deviceId);
    if (s.timer) clearTimeout(s.timer);
    if (s.resync) clearTimeout(s.resync);
    for (const { part } of s.parts) coverActions.delete(part.key);
    for (const { endpoint } of s.parts) {
      try {
        if (endpoint) await endpoint.delete();
      } catch (e) {
        this.log("warn", `bridge: could not remove ${deviceId}: ${(e as Error).message}`);
      }
    }
  }

  isShared(deviceId: string): boolean {
    return this.shared.has(deviceId);
  }

  private async addParts(s: Shared): Promise<void> {
    if (s.added) return;
    s.added = true;
    try {
      for (const p of s.parts) {
        const suffix = p.part.key.endsWith("_rh") ? " humidity" : "";
        if (p.part.kind === "window_covering") coverActions.set(p.part.key, (action) => this.queue(s, { action }));
        p.endpoint = makeEndpoint(p.part, `${homeName(s.device)}${suffix}`, uniqueIdFor(p.part.key), s.device.available !== false);
        await this.aggregator!.add(p.endpoint);
        this.watch(s, p.part, p.endpoint);
      }
    } catch (e) {
      // All or nothing: a device half on the bridge would confuse every app.
      await this.unshare(s.device.device_id);
      throw e;
    }
    await this.applyState(s);
  }

  /** Another app changed something: tell homeCore, once it settles. */
  private watch(s: Shared, part: BridgePart, endpoint: AnyEndpoint): void {
    const events = endpoint.events as any;
    for (const [cluster, attrs] of Object.entries(WATCHED)) {
      if (!events[cluster]) continue;
      for (const attribute of attrs) {
        const ev = events[cluster][`${attribute}$Changed`];
        if (!ev) continue;
        ev.on((value: unknown) => this.changed(s, part, cluster, attribute, value));
      }
    }
  }

  private changed(s: Shared, part: BridgePart, cluster: string, attribute: string, value: unknown): void {
    // The bridge setting homeCore's own state: not a change another app made.
    if (s.applying > 0) return;
    // homeCore's state as it will be once what is waiting is sent: "on, then
    // 50 %" from one app is one change, and the level must not be dropped
    // because homeCore hasn't heard the "on" yet.
    const view = { ...s.device.attributes, ...s.pending };
    if (cluster === "colorControl" && (attribute === "currentX" || attribute === "currentY")) {
      s.xy[attribute === "currentX" ? "x" : "y"] = value;
      const cmd = colorCommand(s.xy.x, s.xy.y, view);
      if (cmd) Object.assign(s.pending, cmd);
    } else {
      const cmd = commandFrom(part, { cluster, attribute, value }, view);
      if (cmd) Object.assign(s.pending, cmd);
      // Nothing to send: homeCore's own state reflected back, or a change the
      // device can't take (a mode it has no way to set). Show homeCore's state
      // again shortly, so the other app is never left showing something false;
      // for a reflection that changes nothing.
      else this.resyncSoon(s);
    }
    this.flushSoon(s);
  }

  /** A command from another app, as the device's own words (a cover's open, close or stop). */
  private queue(s: Shared, cmd: Record<string, unknown>): void {
    if (this.shared.get(s.device.device_id) !== s) return;
    Object.assign(s.pending, cmd);
    this.flushSoon(s);
  }

  private flushSoon(s: Shared): void {
    if (Object.keys(s.pending).length === 0) return;
    if (s.timer) clearTimeout(s.timer);
    s.timer = setTimeout(() => {
      s.timer = null;
      const body = s.pending;
      s.pending = {};
      this.log("info", `bridge: another app set ${homeName(s.device)}: ${JSON.stringify(body)}`);
      this.send(s.device.device_id, body)
        .catch((e) => this.log("warn", `bridge: ${homeName(s.device)} refused ${JSON.stringify(body)}: ${(e as Error).message}`))
        // Whatever homeCore made of it, show that.
        .finally(() => this.resyncSoon(s));
    }, SETTLE_MS);
  }

  private resyncSoon(s: Shared): void {
    if (s.resync) clearTimeout(s.resync);
    s.resync = setTimeout(() => {
      s.resync = null;
      if (this.shared.get(s.device.device_id) === s) void this.applyState(s);
    }, SETTLE_MS * 2);
  }

  /** homeCore's state, into the bridge. */
  async setState(deviceId: string, current: Record<string, unknown>): Promise<void> {
    const s = this.shared.get(deviceId);
    if (!s) return;
    s.device = { ...s.device, attributes: current };
    await this.applyState(s);
  }

  async setAvailable(deviceId: string, available: boolean): Promise<void> {
    const s = this.shared.get(deviceId);
    if (!s) return;
    s.device = { ...s.device, available };
    for (const { endpoint } of s.parts) {
      if (endpoint) await this.safeSet(endpoint, { bridgedDeviceBasicInformation: { reachable: available } }, deviceId);
    }
  }

  private async applyState(s: Shared): Promise<void> {
    // Another app's change is waiting to be sent: homeCore's state from before
    // it would undo what that app shows. It is shown once the change is sent.
    if (s.timer) return;
    s.applying += 1;
    try {
      for (const { part, endpoint } of s.parts) {
        if (!endpoint) continue;
        const state = clusterState(part, s.device.attributes);
        if (Object.keys(state).length) await this.safeSet(endpoint, state, s.device.device_id);
      }
    } finally {
      s.applying -= 1;
    }
  }

  /** One cluster at a time: a value matter.js refuses spoils only its own cluster, and says so. */
  private async safeSet(endpoint: AnyEndpoint, state: Record<string, unknown>, deviceId: string): Promise<void> {
    for (const [cluster, values] of Object.entries(state)) {
      try {
        await endpoint.set({ [cluster]: values } as any);
      } catch (e) {
        this.log("warn", `bridge: could not show ${deviceId}'s ${cluster} ${JSON.stringify(values)}: ${(e as Error).message}`);
      }
    }
  }
}
