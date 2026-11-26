#!/usr/bin/env node
// A Matter stand-in: virtual devices to pair hc-matter with, so nothing is ever
// tested against real hardware. Development only; not part of the artifact.
//
//   node standin/standin.mjs [--storage DIR] [--port 5540]
//                            [--passcode 20202021] [--discriminator 3840]
//
// One node, a bridge, with one bridged endpoint per device kind hc-matter
// maps. It prints its pairing code and stays up. Run it where its mDNS cannot
// reach a real network (the hc-matter-lab Docker network, see README).
//
// Every device behaves like a real one would at the protocol level: matter.js
// implements the commands, so a light's level moves, a lock locks, a cover's
// position changes. Readings (temperature, contact, ...) can be changed while
// it runs by writing a JSON line to its stdin:
//
//   {"device": "contact", "open": true}
//   {"device": "climate", "temperature": 21.5, "humidity": 40}

import { Endpoint, ServerNode, VendorId } from "@matter/main";
import { AggregatorEndpoint } from "@matter/main/endpoints/aggregator";
import { BridgedDeviceBasicInformationServer } from "@matter/main/behaviors/bridged-device-basic-information";
import { ColorControlServer } from "@matter/main/behaviors/color-control";
import { DoorLockServer } from "@matter/main/behaviors/door-lock";
import { WindowCoveringServer } from "@matter/main/behaviors/window-covering";
import { ThermostatServer } from "@matter/main/behaviors/thermostat";
import { FanControlServer } from "@matter/main/behaviors/fan-control";
import { PowerSourceServer } from "@matter/main/behaviors/power-source";
import { OccupancySensingServer } from "@matter/main/behaviors/occupancy-sensing";
import { ExtendedColorLightDevice } from "@matter/main/devices/extended-color-light";
import { ContactSensorDevice } from "@matter/main/devices/contact-sensor";
import { TemperatureSensorDevice } from "@matter/main/devices/temperature-sensor";
import { HumiditySensorDevice } from "@matter/main/devices/humidity-sensor";
import { DoorLockDevice } from "@matter/main/devices/door-lock";
import { WindowCoveringDevice } from "@matter/main/devices/window-covering";
import { ThermostatDevice } from "@matter/main/devices/thermostat";
import { FanDevice } from "@matter/main/devices/fan";
import { OnOffPlugInUnitDevice } from "@matter/main/devices/on-off-plug-in-unit";
import { WaterLeakDetectorDevice } from "@matter/main/devices/water-leak-detector";
import { OccupancySensorDevice } from "@matter/main/devices/occupancy-sensor";
import { LightSensorDevice } from "@matter/main/devices/light-sensor";
import { createInterface } from "node:readline";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const passcode = Number(args.passcode ?? 20202021);
const discriminator = Number(args.discriminator ?? 3840);
const port = Number(args.port ?? 5540);
if (args.storage) process.env.MATTER_STORAGE_PATH = args.storage;

const bridged = (id, name) =>
  ({ id, bridgedDeviceBasicInformation: { nodeLabel: name, productName: name, reachable: true, uniqueId: id } });

const node = await ServerNode.create({
  id: "standin",
  network: { port },
  commissioning: { passcode, discriminator },
  productDescription: { name: "hc-matter stand-in", deviceType: AggregatorEndpoint.deviceType },
  basicInformation: {
    vendorName: "homeCore stand-in",
    vendorId: VendorId(0xfff1),
    productName: "Stand-in bridge",
    productId: 0x8000,
    nodeLabel: "Stand-in bridge",
    serialNumber: "standin-0001",
  },
});

// matter.js's fan server takes a speed and leaves it there; a real fan then
// runs at it. This one does: its current speed and mode follow the setting.
const modeFor = (p) => (p === 0 ? 0 : p <= 33 ? 1 : p <= 66 ? 2 : 3);

class StandinFanServer extends FanControlServer {
  initialize() {
    super.initialize?.();
    // offline: as the device itself, not as the controller that wrote, which
    // may not set read-only attributes.
    this.reactTo(this.events.percentSetting$Changed, this.followSetting, { offline: true });
    this.reactTo(this.events.fanMode$Changed, this.followMode, { offline: true });
  }
  followSetting(pct) {
    const p = pct ?? 0;
    this.state.percentCurrent = p;
    this.state.fanMode = modeFor(p);
  }
  followMode(mode) {
    // A mode set by followSetting already matches the speed: keep the speed.
    if (mode === modeFor(this.state.percentCurrent ?? 0)) return;
    // Off, Low, Medium, High, On (full).
    const pct = { 0: 0, 1: 33, 2: 66, 3: 100, 4: 100 }[mode];
    if (pct !== undefined) {
      this.state.percentSetting = pct;
      this.state.percentCurrent = pct;
    }
  }
}

const aggregator = new Endpoint(AggregatorEndpoint, { id: "aggregator" });
await node.add(aggregator);

const devices = {
  light: new Endpoint(
    ExtendedColorLightDevice.with(
      BridgedDeviceBasicInformationServer,
      ColorControlServer.with("Xy", "ColorTemperature"),
    ),
    {
      ...bridged("light", "Desk Lamp"),
      colorControl: {
        colorTempPhysicalMinMireds: 153,
        colorTempPhysicalMaxMireds: 500,
        coupleColorTempToLevelMinMireds: 153,
        startUpColorTemperatureMireds: 370,
        colorTemperatureMireds: 370,
        colorMode: 2,
        enhancedColorMode: 2,
        currentX: 0x616b,
        currentY: 0x607d,
      },
    },
  ),
  plug: new Endpoint(OnOffPlugInUnitDevice.with(BridgedDeviceBasicInformationServer), bridged("plug", "Kettle Plug")),
  contact: new Endpoint(
    ContactSensorDevice.with(BridgedDeviceBasicInformationServer, PowerSourceServer.with("Battery")),
    {
      ...bridged("contact", "Front Door"),
      booleanState: { stateValue: true },
      powerSource: { status: 1, order: 0, description: "Battery", batPercentRemaining: 160, batChargeLevel: 0, batReplaceability: 1 },
    },
  ),
  temperature: new Endpoint(
    TemperatureSensorDevice.with(BridgedDeviceBasicInformationServer),
    { ...bridged("temperature", "Hall Climate"), temperatureMeasurement: { measuredValue: 2150, minMeasuredValue: -4000, maxMeasuredValue: 8500 } },
  ),
  humidity: new Endpoint(
    HumiditySensorDevice.with(BridgedDeviceBasicInformationServer),
    { ...bridged("humidity", "Hall Climate"), relativeHumidityMeasurement: { measuredValue: 4200, minMeasuredValue: 0, maxMeasuredValue: 10000 } },
  ),
  leak: new Endpoint(
    WaterLeakDetectorDevice.with(BridgedDeviceBasicInformationServer),
    { ...bridged("leak", "Sink Leak"), booleanState: { stateValue: false } },
  ),
  occupancy: new Endpoint(
    OccupancySensorDevice.with(BridgedDeviceBasicInformationServer, OccupancySensingServer.with("PassiveInfrared")),
    { ...bridged("occupancy", "Office Presence"), occupancySensing: { occupancy: { occupied: false }, occupancySensorType: 0, occupancySensorTypeBitmap: { pir: true } } },
  ),
  lux: new Endpoint(
    LightSensorDevice.with(BridgedDeviceBasicInformationServer),
    { ...bridged("lux", "Porch Light Level"), illuminanceMeasurement: { measuredValue: 30001, minMeasuredValue: 1, maxMeasuredValue: 0xfffe } },
  ),
  lock: new Endpoint(
    DoorLockDevice.with(BridgedDeviceBasicInformationServer, DoorLockServer),
    { ...bridged("lock", "Back Door Lock"), doorLock: { lockState: 1, lockType: 0, actuatorEnabled: true, operatingMode: 0 } },
  ),
  cover: new Endpoint(
    WindowCoveringDevice.with(
      BridgedDeviceBasicInformationServer,
      WindowCoveringServer.with("Lift", "PositionAwareLift"),
    ),
    {
      ...bridged("cover", "Bedroom Blind"),
      windowCovering: { type: 0, endProductType: 0, currentPositionLiftPercent100ths: 5000, targetPositionLiftPercent100ths: 5000 },
    },
  ),
  thermostat: new Endpoint(
    ThermostatDevice.with(
      BridgedDeviceBasicInformationServer,
      ThermostatServer.with("Heating", "Cooling", "AutoMode"),
    ),
    {
      ...bridged("thermostat", "Living Room Thermostat"),
      thermostat: {
        localTemperature: 2000,
        occupiedHeatingSetpoint: 2000,
        occupiedCoolingSetpoint: 2600,
        minSetpointDeadBand: 2,
        controlSequenceOfOperation: 4,
        systemMode: 4,
      },
    },
  ),
  fan: new Endpoint(
    FanDevice.with(BridgedDeviceBasicInformationServer, StandinFanServer),
    { ...bridged("fan", "Ceiling Fan"), fanControl: { fanMode: 0, fanModeSequence: 0, percentSetting: 0, percentCurrent: 0 } },
  ),
};
for (const d of Object.values(devices)) await aggregator.add(d);

// Readings a test can change while the stand-in runs.
const setters = {
  contact: (v) => devices.contact.set({ booleanState: { stateValue: !v.open } }),
  leak: (v) => devices.leak.set({ booleanState: { stateValue: !!v.wet } }),
  occupancy: (v) => devices.occupancy.set({ occupancySensing: { occupancy: { occupied: !!v.occupied } } }),
  temperature: (v) => devices.temperature.set({ temperatureMeasurement: { measuredValue: Math.round(v.temperature * 100) } }),
  humidity: (v) => devices.humidity.set({ relativeHumidityMeasurement: { measuredValue: Math.round(v.humidity * 100) } }),
  battery: (v) => devices.contact.set({ powerSource: { batPercentRemaining: Math.round(v.pct * 2) } }),
  reachable: (v) => devices[v.which].set({ bridgedDeviceBasicInformation: { reachable: !!v.reachable } }),
};
createInterface({ input: process.stdin }).on("line", async (line) => {
  try {
    const msg = JSON.parse(line);
    await setters[msg.device](msg);
    console.log(`standin: set ${line}`);
  } catch (e) {
    console.error(`standin: could not apply ${line}: ${e.message}`);
  }
});

await node.start();
const { qrPairingCode, manualPairingCode } = node.state.commissioning.pairingCodes;
console.log(`standin: ready on port ${port}`);
console.log(`standin: manual code ${manualPairingCode}`);
console.log(`standin: qr ${qrPairingCode}`);
