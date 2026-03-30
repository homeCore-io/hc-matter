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
 * Determine if a device type is an actuator (can receive commands)
 */
export function isActuatorType(homecoreType: string): boolean {
  const actuatorTypes = ["light", "dimmer_light", "switch", "lock", "cover"];
  return actuatorTypes.includes(homecoreType);
}

/**
 * Determine if a device type is a sensor (read-only)
 */
export function isSensorType(homecoreType: string): boolean {
  const sensorTypes = ["contact_sensor", "motion_sensor", "temp_sensor", "humidity_sensor"];
  return sensorTypes.includes(homecoreType);
}

/**
 * Get all supported HomeCore device types
 */
export function getSupportedDeviceTypes(): string[] {
  return Object.keys(DEVICE_MAPPINGS);
}

/**
 * Get all supported actuator types
 */
export function getActuatorTypes(): string[] {
  return getSupportedDeviceTypes().filter(isActuatorType);
}

/**
 * Get all supported sensor types
 */
export function getSensorTypes(): string[] {
  return getSupportedDeviceTypes().filter(isSensorType);
}

/**
 * Convert HomeCore attribute value to Matter representation
 * Handles unit conversions and bounds checking specific to each attribute
 */
export function toMatterValue(homecoreKey: string, value: unknown): unknown {
  if (typeof value !== "number") {
    return value;
  }

  // Handle temperature: HomeCore uses Celsius, Matter uses centidegrees (1/100 °C)
  if (homecoreKey === "temperature_c") {
    return Math.round(value * 100);
  }

  // Handle brightness: HomeCore uses percentage (0-100), Matter uses 0-254
  if (homecoreKey === "brightness_pct") {
    const clamped = Math.max(0, Math.min(100, value));
    return Math.round((clamped / 100) * 254);
  }

  // Handle humidity: HomeCore uses percentage (0-100), Matter uses 0-10000 (in centipercent)
  if (homecoreKey === "humidity_pct") {
    const clamped = Math.max(0, Math.min(100, value));
    return Math.round(clamped * 100);
  }

  // Handle position (cover/shade): HomeCore uses percentage (0-100), Matter uses 0-100
  if (homecoreKey === "position") {
    return Math.max(0, Math.min(100, value));
  }

  return value;
}

/**
 * Convert Matter attribute value to HomeCore representation
 * Handles unit conversions and normalization for each attribute
 */
export function fromMatterValue(homecoreKey: string, value: unknown): unknown {
  if (typeof value !== "number") {
    return value;
  }

  // Handle temperature: Matter uses centidegrees, HomeCore uses Celsius
  if (homecoreKey === "temperature_c") {
    return Math.round((value / 100) * 10) / 10; // Round to 1 decimal place
  }

  // Handle brightness: Matter uses 0-254, HomeCore uses percentage (0-100)
  if (homecoreKey === "brightness_pct") {
    return Math.round((value / 254) * 100);
  }

  // Handle humidity: Matter uses 0-10000, HomeCore uses percentage (0-100)
  if (homecoreKey === "humidity_pct") {
    return Math.round(value / 100);
  }

  // Handle position (cover/shade): both use percentage 0-100
  if (homecoreKey === "position") {
    return Math.max(0, Math.min(100, value));
  }

  return value;
}
