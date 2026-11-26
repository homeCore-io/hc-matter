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
      WindowCoveringDevice.with(B, part.positioned ? WindowCoveringServer.with("Lift", "PositionAwareLift") : WindowCoveringServer.with("Lift")),
      { id, ...bridged, windowCovering: part.positioned
        ? { type: 0, endProductType: 0, currentPositionLiftPercent100ths: 0, targetPositionLiftPercent100ths: 0 }
        : { type: 0, endProductType: 0 } } as any),
    contact_sensor: () => new Endpoint(ContactSensorDevice.with(B), { id, ...bridged, booleanState: { stateValue: true } } as any),
    occupancy_sensor: () => new Endpoint(OccupancySensorDevice.with(B, OccupancySensingServer.with("PassiveInfrared")),
      { id, ...bridged, occupancySensing: { occupancy: { occupied: false }, occupancySensorType: 0, occupancySensorTypeBitmap: { pir: true } } } as any),
    temperature_sensor: () => new Endpoint(TemperatureSensorDevice.with(B),
      { id, ...bridged, temperatureMeasurement: { measuredValue: null, minMeasuredValue: -5000, maxMeasuredValue: 10000 } } as any),
    humidity_sensor: () => new Endpoint(HumiditySensorDevice.with(B),
      { id, ...bridged, relativeHumidityMeasurement: { measuredValue: null, minMeasuredValue: 0, maxMeasuredValue: 10000 } } as any),
    water_leak: () => new Endpoint(WaterLeakDetectorDevice.with(B), { id, ...bridged, booleanState: { stateValue: false } } as any),
    light_sensor: () => new Endpoint(LightSensorDevice.with(B),
      { id, ...bridged, illuminanceMeasurement: { measuredValue: null, minMeasuredValue: 1, maxMeasuredValue: 0xfffe } } as any),
  };
  return kinds[part.kind]();
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
};

interface Shared {
  device: HomeDevice;
  parts: { part: BridgePart; endpoint: AnyEndpoint }[];
  pending: Record<string, unknown>;
  timer: NodeJS.Timeout | null;
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
    // the bridge and command everything shared, locks included. The page
    // shows the code to admins; the log must not.
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
        productName: "homeCore bridge",
        productId: 0x8001,
        nodeLabel: "homeCore",
        serialNumber: "homecore-bridge",
      },
    } as any);
    const aggregator = new Endpoint(AggregatorEndpoint, { id: "devices" });
    await node.add(aggregator);
    this.node = node;
    this.aggregator = aggregator;
    for (const s of this.shared.values()) await this.addParts(s);
    await node.start();
    this.log("info", `bridge: running on port ${BRIDGE_PORT}, ${this.shared.size} device(s) shared`);
  }

  async stop(): Promise<void> {
    const node = this.node;
    this.node = null;
    this.aggregator = null;
    this.starting = null;
    for (const s of this.shared.values()) {
      if (s.timer) clearTimeout(s.timer);
      s.parts = [];
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
    const same = before && JSON.stringify(before.parts.map((p) => p.part)) === JSON.stringify(parts) && homeName(before.device) === homeName(device);
    if (before && same) {
      before.device = device;
      await this.applyState(before);
      return;
    }
    if (before) await this.unshare(device.device_id);
    const s: Shared = { device, parts: parts.map((part) => ({ part, endpoint: null as unknown as AnyEndpoint })), pending: {}, timer: null, xy: {} };
    this.shared.set(device.device_id, s);
    if (this.aggregator) await this.addParts(s);
  }

  async unshare(deviceId: string): Promise<void> {
    const s = this.shared.get(deviceId);
    if (!s) return;
    this.shared.delete(deviceId);
    if (s.timer) clearTimeout(s.timer);
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
    try {
      for (const p of s.parts) {
        const suffix = p.part.key.endsWith("_rh") ? " humidity" : "";
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
    }
    if (Object.keys(s.pending).length === 0) return;
    if (s.timer) clearTimeout(s.timer);
    s.timer = setTimeout(() => {
      s.timer = null;
      const body = s.pending;
      s.pending = {};
      this.log("info", `bridge: another app set ${homeName(s.device)}: ${JSON.stringify(body)}`);
      this.send(s.device.device_id, body).catch((e) => this.log("warn", `bridge: ${homeName(s.device)} refused ${JSON.stringify(body)}: ${(e as Error).message}`));
    }, SETTLE_MS);
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
    for (const { part, endpoint } of s.parts) {
      if (!endpoint) continue;
      const state = clusterState(part, s.device.attributes);
      if (Object.keys(state).length) await this.safeSet(endpoint, state, s.device.device_id);
    }
  }

  private async safeSet(endpoint: AnyEndpoint, state: Record<string, unknown>, deviceId: string): Promise<void> {
    try {
      await endpoint.set(state as any);
    } catch (e) {
      this.log("debug", `bridge: could not show ${deviceId}'s state: ${(e as Error).message}`);
    }
  }
}
