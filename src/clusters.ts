// The Matter ids hc-matter reads and writes. matter-server keys every
// attribute "endpoint/cluster/attribute" in decimal, and a struct's fields by
// their field id ("0", "1", ...), so these are the numbers, named.

export const Cluster = {
  Identify: 3,
  OnOff: 6,
  LevelControl: 8,
  Descriptor: 29,
  BasicInformation: 40,
  PowerSource: 47,
  BridgedDeviceBasicInformation: 57,
  BooleanState: 69,
  Switch: 59,
  ElectricalPowerMeasurement: 144,
  ElectricalEnergyMeasurement: 145,
  DoorLock: 257,
  WindowCovering: 258,
  Thermostat: 513,
  FanControl: 514,
  ColorControl: 768,
  IlluminanceMeasurement: 1024,
  TemperatureMeasurement: 1026,
  PressureMeasurement: 1027,
  RelativeHumidityMeasurement: 1029,
  OccupancySensing: 1030,
  CarbonDioxideConcentrationMeasurement: 1037,
} as const;

/** Global attributes every cluster has. */
export const Global = {
  FeatureMap: 65532,
  AttributeList: 65531,
} as const;

export const Attr = {
  Descriptor: { DeviceTypeList: 0, ServerList: 1, PartsList: 3 },
  BasicInformation: { VendorName: 1, VendorId: 2, ProductName: 3, ProductId: 4, NodeLabel: 5, SoftwareVersionString: 10, SerialNumber: 15, UniqueId: 18 },
  BridgedDeviceBasicInformation: { VendorName: 1, ProductName: 3, NodeLabel: 5, SoftwareVersionString: 10, SerialNumber: 15, Reachable: 17, UniqueId: 18 },
  OnOff: { OnOff: 0 },
  LevelControl: { CurrentLevel: 0, MinLevel: 2, MaxLevel: 3 },
  ColorControl: {
    CurrentHue: 0, CurrentSaturation: 1, CurrentX: 3, CurrentY: 4, ColorTemperatureMireds: 7, ColorMode: 8,
    ColorTempPhysicalMinMireds: 16395, ColorTempPhysicalMaxMireds: 16396,
  },
  DoorLock: { LockState: 0, DoorState: 3 },
  WindowCovering: { CurrentPositionLiftPercent100ths: 14, CurrentPositionTiltPercent100ths: 15 },
  Thermostat: {
    LocalTemperature: 0, OccupiedCoolingSetpoint: 17, OccupiedHeatingSetpoint: 18,
    MinHeatSetpointLimit: 21, MaxHeatSetpointLimit: 22, MinCoolSetpointLimit: 23, MaxCoolSetpointLimit: 24,
    ControlSequenceOfOperation: 27, SystemMode: 28, ThermostatRunningMode: 30, ThermostatRunningState: 41,
  },
  FanControl: { FanMode: 0, PercentSetting: 2, PercentCurrent: 3 },
  BooleanState: { StateValue: 0 },
  PowerSource: { BatPercentRemaining: 12, BatChargeLevel: 14 },
  ElectricalPowerMeasurement: { Voltage: 4, ActiveCurrent: 5, ActivePower: 8 },
  ElectricalEnergyMeasurement: { CumulativeEnergyImported: 1 },
  Measurement: { MeasuredValue: 0 },
  OccupancySensing: { Occupancy: 0 },
} as const;

/** Feature bits, from each cluster's FeatureMap. */
export const Feature = {
  ColorControl: { HueSaturation: 1 << 0, Xy: 1 << 3, ColorTemperature: 1 << 4 },
  WindowCovering: { Lift: 1 << 0, Tilt: 1 << 1, PositionAwareLift: 1 << 2, PositionAwareTilt: 1 << 4 },
  Thermostat: { Heating: 1 << 0, Cooling: 1 << 1, AutoMode: 1 << 5 },
  DoorLock: { DoorPositionSensor: 1 << 5 },
  PowerSource: { Battery: 1 << 1 },
} as const;

/**
 * Matter device types, by id. `kind` is the homeCore `device_type` an endpoint
 * of that type registers as; `utility` types say how an endpoint is built
 * (root, bridge, bridged node, power source) rather than what it is.
 */
export interface DeviceTypeInfo {
  name: string;
  kind?: string;
  utility?: true;
}

export const DeviceTypes: Record<number, DeviceTypeInfo> = {
  0x000e: { name: "Aggregator", utility: true },
  0x0011: { name: "Power Source", utility: true },
  0x0012: { name: "OTA Requestor", utility: true },
  0x0013: { name: "Bridged Node", utility: true },
  0x0014: { name: "OTA Provider", utility: true },
  0x0016: { name: "Root Node", utility: true },
  0x050d: { name: "Device Energy Management", utility: true },
  0x0510: { name: "Electrical Sensor", utility: true },

  0x0100: { name: "On/Off Light", kind: "light" },
  0x0101: { name: "Dimmable Light", kind: "light" },
  0x010c: { name: "Color Temperature Light", kind: "light" },
  0x010d: { name: "Extended Color Light", kind: "light" },
  0x010a: { name: "On/Off Plug-in Unit", kind: "switch" },
  0x010b: { name: "Dimmable Plug-in Unit", kind: "light" },
  0x0110: { name: "Mounted On/Off Control", kind: "switch" },
  0x0111: { name: "Mounted Dimmable Load Control", kind: "light" },
  0x000a: { name: "Door Lock", kind: "lock" },
  0x0202: { name: "Window Covering", kind: "cover" },
  0x0301: { name: "Thermostat", kind: "thermostat" },
  0x002b: { name: "Fan", kind: "fan" },
  0x0015: { name: "Contact Sensor", kind: "contact_sensor" },
  0x0107: { name: "Occupancy Sensor", kind: "occupancy_sensor" },
  0x0302: { name: "Temperature Sensor", kind: "temperature_sensor" },
  0x0307: { name: "Humidity Sensor", kind: "humidity_sensor" },
  0x0106: { name: "Light Sensor", kind: "light_sensor" },
  0x0305: { name: "Pressure Sensor", kind: "pressure_sensor" },
  0x0043: { name: "Water Leak Detector", kind: "water_sensor" },
  0x0044: { name: "Rain Sensor", kind: "rain_sensor" },
  0x002c: { name: "Air Quality Sensor", kind: "air_quality_sensor" },
  0x000f: { name: "Generic Switch", kind: "remote" },
};

export function deviceTypeName(id: number): string {
  return DeviceTypes[id]?.name ?? `Matter device type 0x${id.toString(16).padStart(4, "0")}`;
}
