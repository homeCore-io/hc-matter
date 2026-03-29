/**
 * Device type mapping between HomeCore and Matter
 */

export interface DeviceMapping {
  homecoreType: string;
  matterType: string;
  clusters: string[];
  attributeMap: Record<string, string>;
}

export const DEVICE_MAPPINGS: Record<string, DeviceMapping> = {
  light: {
    homecoreType: "light",
    matterType: "ExtendedColorLight",
    clusters: ["OnOff", "LevelControl", "ColorControl"],
    attributeMap: {
      on: "OnOff/onOff",
      brightness_pct: "LevelControl/currentLevel",
      color_xy: "ColorControl/currentX,currentY",
    },
  },
  dimmer_light: {
    homecoreType: "dimmer_light",
    matterType: "DimmableLight",
    clusters: ["OnOff", "LevelControl"],
    attributeMap: {
      on: "OnOff/onOff",
      brightness_pct: "LevelControl/currentLevel",
    },
  },
  switch: {
    homecoreType: "switch",
    matterType: "OnOffSwitch",
    clusters: ["OnOff", "Scenes"],
    attributeMap: {
      on: "OnOff/onOff",
    },
  },
  contact_sensor: {
    homecoreType: "contact_sensor",
    matterType: "ContactSensor",
    clusters: ["BooleanState"],
    attributeMap: {
      open: "BooleanState/stateValue",
      contact: "BooleanState/stateValue",
    },
  },
  motion_sensor: {
    homecoreType: "motion_sensor",
    matterType: "OccupancySensor",
    clusters: ["Occupancy", "BooleanState"],
    attributeMap: {
      occupied: "Occupancy/occupancy",
      motion: "BooleanState/stateValue",
    },
  },
  temp_sensor: {
    homecoreType: "temp_sensor",
    matterType: "TemperatureSensor",
    clusters: ["TemperatureMeasurement"],
    attributeMap: {
      temperature_c: "TemperatureMeasurement/measuredValue",
    },
  },
  humidity_sensor: {
    homecoreType: "humidity_sensor",
    matterType: "HumiditySensor",
    clusters: ["RelativeHumidityMeasurement"],
    attributeMap: {
      humidity_pct: "RelativeHumidityMeasurement/relativeHumidity",
    },
  },
  lock: {
    homecoreType: "lock",
    matterType: "DoorLock",
    clusters: ["DoorLock"],
    attributeMap: {
      locked: "DoorLock/lockState",
    },
  },
  cover: {
    homecoreType: "cover",
    matterType: "WindowCovering",
    clusters: ["WindowCovering"],
    attributeMap: {
      position: "WindowCovering/currentPositionLiftPercent",
    },
  },
};

/**
 * Get Matter device mapping for HomeCore device type
 */
export function getDeviceMapping(homecoreType: string): DeviceMapping | undefined {
  return DEVICE_MAPPINGS[homecoreType];
}

/**
 * Convert HomeCore attribute value to Matter representation
 */
export function toMatterValue(homecoreKey: string, value: unknown): unknown {
  // Handle temperature: HomeCore uses Celsius, Matter uses centidegrees
  if (homecoreKey === "temperature_c" && typeof value === "number") {
    return Math.round(value * 100);
  }

  // Handle brightness: HomeCore uses percentage, Matter uses 0-254
  if (homecoreKey === "brightness_pct" && typeof value === "number") {
    return Math.round((value / 100) * 254);
  }

  // Handle humidity: HomeCore uses percentage, Matter uses 0-10000 (in centipercent)
  if (homecoreKey === "humidity_pct" && typeof value === "number") {
    return Math.round(value * 100);
  }

  return value;
}

/**
 * Convert Matter attribute value to HomeCore representation
 */
export function fromMatterValue(homecoreKey: string, value: unknown): unknown {
  // Handle temperature: Matter uses centidegrees, HomeCore uses Celsius
  if (homecoreKey === "temperature_c" && typeof value === "number") {
    return value / 100;
  }

  // Handle brightness: Matter uses 0-254, HomeCore uses percentage
  if (homecoreKey === "brightness_pct" && typeof value === "number") {
    return Math.round((value / 254) * 100);
  }

  // Handle humidity: Matter uses 0-10000, HomeCore uses percentage
  if (homecoreKey === "humidity_pct" && typeof value === "number") {
    return Math.round(value / 100);
  }

  return value;
}
