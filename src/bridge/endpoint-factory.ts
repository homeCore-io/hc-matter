/**
 * Bridge Endpoint Factory
 *
 * Creates Matter endpoint structures (clusters and attributes) from HomeCore device types.
 * Acts as a bridge between logical HomeCore device semantics and Matter protocol structures.
 */

import { Logger } from "../logger.js";

/**
 * Represents a Matter cluster specification with supported attributes.
 */
export interface ClusterSpec {
  clusterId: number;
  name: string;
  attributes: AttributeSpec[];
}

/**
 * Represents a Matter attribute within a cluster.
 */
export interface AttributeSpec {
  attributeId: number;
  name: string;
  type: "boolean" | "number" | "string" | "enum" | "bitmap" | "array" | "struct";
  writable: boolean;
  readable: boolean;
  // HomeCore attribute that this Matter attribute maps to
  homecoreAttribute?: string;
}

/**
 * Configuration for creating a Matter bridge endpoint from a HomeCore device.
 */
export interface EndpointCompositionConfig {
  homecoreId: string;
  homecoreType: string;
  matterType: string;
  nodeId: string;
  endpointId: number;
}

/**
 * Result of composing a Matter endpoint for a HomeCore device.
 */
export interface ComposedEndpoint {
  homecoreId: string;
  homecoreType: string;
  matterType: string;
  clusters: ClusterSpec[];
  additionalMetadata?: Record<string, unknown>;
}

/**
 * Standard Matter cluster IDs (16-bit identifiers in Matter protocol)
 */
export const MATTER_CLUSTER_IDS = {
  BASIC_INFORMATION: 0x0028,
  ON_OFF: 0x0006,
  LEVEL_CONTROL: 0x0008,
  COLOR_CONTROL: 0x0300,
  TEMPERATURE_MEASUREMENT: 0x0402,
  RELATIVE_HUMIDITY_MEASUREMENT: 0x0405,
  OCCUPANCY_SENSING: 0x0406,
  BOOLEAN_STATE: 0x0045,
  DOOR_LOCK: 0x0101,
  WINDOW_COVERING: 0x0102,
} as const;

/**
 * Standard Matter cluster attribute IDs
 */
export const MATTER_ATTRIBUTE_IDS = {
  // OnOff cluster
  ON_OFF: 0x0000,
  // LevelControl cluster
  CURRENT_LEVEL: 0x0000,
  // ColorControl cluster
  COLOR_TEMPERATURE_MIREDS: 0x0007,
  // TemperatureMeasurement cluster
  MEASURED_VALUE: 0x0000,
  TOLERANCE: 0x0002,
  // RelativeHumidityMeasurement cluster
  RELATIVE_HUMIDITY: 0x0000,
  // OccupancySensing cluster
  OCCUPANCY: 0x0000,
  // BooleanState cluster
  STATE_VALUE: 0x0000,
  // DoorLock cluster
  LOCK_STATE: 0x0000,
  // WindowCovering cluster
  CURRENT_POSITION_LIFT_PERCENTAGE: 0x0008,
  TARGET_POSITION_LIFT_PERCENTAGE: 0x000b,
} as const;

/**
 * Compose Matter cluster specifications for a HomeCore device type.
 * Returns the set of clusters needed to represent the device in Matter.
 */
export function composeDeviceClusters(
  homecoreType: string,
  logger: Logger
): ClusterSpec[] {
  const clusters: ClusterSpec[] = [];

  // All endpoints include basic information cluster
  clusters.push({
    clusterId: MATTER_CLUSTER_IDS.BASIC_INFORMATION,
    name: "BasicInformation",
    attributes: [
      {
        attributeId: 0x0000,
        name: "dataModelRevision",
        type: "number",
        writable: false,
        readable: true,
      },
      {
        attributeId: 0x0001,
        name: "vendorName",
        type: "string",
        writable: false,
        readable: true,
      },
      {
        attributeId: 0x0002,
        name: "vendorID",
        type: "number",
        writable: false,
        readable: true,
      },
      {
        attributeId: 0x0003,
        name: "productName",
        type: "string",
        writable: false,
        readable: true,
      },
      {
        attributeId: 0x0004,
        name: "productID",
        type: "number",
        writable: false,
        readable: true,
      },
    ],
  });

  // Device-type specific clusters
  switch (homecoreType) {
    case "light": {
      clusters.push({
        clusterId: MATTER_CLUSTER_IDS.ON_OFF,
        name: "OnOff",
        attributes: [
          {
            attributeId: MATTER_ATTRIBUTE_IDS.ON_OFF,
            name: "onOff",
            type: "boolean",
            writable: true,
            readable: true,
            homecoreAttribute: "on",
          },
        ],
      });

      clusters.push({
        clusterId: MATTER_CLUSTER_IDS.LEVEL_CONTROL,
        name: "LevelControl",
        attributes: [
          {
            attributeId: MATTER_ATTRIBUTE_IDS.CURRENT_LEVEL,
            name: "currentLevel",
            type: "number",
            writable: true,
            readable: true,
            homecoreAttribute: "brightness_pct",
          },
        ],
      });

      clusters.push({
        clusterId: MATTER_CLUSTER_IDS.COLOR_CONTROL,
        name: "ColorControl",
        attributes: [
          {
            attributeId: MATTER_ATTRIBUTE_IDS.COLOR_TEMPERATURE_MIREDS,
            name: "colorTemperatureMireds",
            type: "number",
            writable: true,
            readable: true,
            homecoreAttribute: "color_temperature_mireds",
          },
        ],
      });
      break;
    }

    case "dimmer_light": {
      clusters.push({
        clusterId: MATTER_CLUSTER_IDS.ON_OFF,
        name: "OnOff",
        attributes: [
          {
            attributeId: MATTER_ATTRIBUTE_IDS.ON_OFF,
            name: "onOff",
            type: "boolean",
            writable: true,
            readable: true,
            homecoreAttribute: "on",
          },
        ],
      });

      clusters.push({
        clusterId: MATTER_CLUSTER_IDS.LEVEL_CONTROL,
        name: "LevelControl",
        attributes: [
          {
            attributeId: MATTER_ATTRIBUTE_IDS.CURRENT_LEVEL,
            name: "currentLevel",
            type: "number",
            writable: true,
            readable: true,
            homecoreAttribute: "brightness_pct",
          },
        ],
      });
      break;
    }

    case "switch": {
      clusters.push({
        clusterId: MATTER_CLUSTER_IDS.ON_OFF,
        name: "OnOff",
        attributes: [
          {
            attributeId: MATTER_ATTRIBUTE_IDS.ON_OFF,
            name: "onOff",
            type: "boolean",
            writable: true,
            readable: true,
            homecoreAttribute: "on",
          },
        ],
      });
      break;
    }

    case "contact_sensor": {
      clusters.push({
        clusterId: MATTER_CLUSTER_IDS.BOOLEAN_STATE,
        name: "BooleanState",
        attributes: [
          {
            attributeId: MATTER_ATTRIBUTE_IDS.STATE_VALUE,
            name: "stateValue",
            type: "boolean",
            writable: false,
            readable: true,
            homecoreAttribute: "open",
          },
        ],
      });
      break;
    }

    case "motion_sensor": {
      clusters.push({
        clusterId: MATTER_CLUSTER_IDS.OCCUPANCY_SENSING,
        name: "OccupancySensing",
        attributes: [
          {
            attributeId: MATTER_ATTRIBUTE_IDS.OCCUPANCY,
            name: "occupancy",
            type: "bitmap",
            writable: false,
            readable: true,
            homecoreAttribute: "motion_detected",
          },
        ],
      });
      break;
    }

    case "temp_sensor": {
      clusters.push({
        clusterId: MATTER_CLUSTER_IDS.TEMPERATURE_MEASUREMENT,
        name: "TemperatureMeasurement",
        attributes: [
          {
            attributeId: MATTER_ATTRIBUTE_IDS.MEASURED_VALUE,
            name: "measuredValue",
            type: "number",
            writable: false,
            readable: true,
            homecoreAttribute: "temperature_c",
          },
        ],
      });
      break;
    }

    case "humidity_sensor": {
      clusters.push({
        clusterId: MATTER_CLUSTER_IDS.RELATIVE_HUMIDITY_MEASUREMENT,
        name: "RelativeHumidityMeasurement",
        attributes: [
          {
            attributeId: MATTER_ATTRIBUTE_IDS.RELATIVE_HUMIDITY,
            name: "relativeHumidity",
            type: "number",
            writable: false,
            readable: true,
            homecoreAttribute: "humidity_pct",
          },
        ],
      });
      break;
    }

    case "lock": {
      clusters.push({
        clusterId: MATTER_CLUSTER_IDS.DOOR_LOCK,
        name: "DoorLock",
        attributes: [
          {
            attributeId: MATTER_ATTRIBUTE_IDS.LOCK_STATE,
            name: "lockState",
            type: "enum",
            writable: true,
            readable: true,
            homecoreAttribute: "locked",
          },
        ],
      });
      break;
    }

    case "cover":
    case "shade": {
      clusters.push({
        clusterId: MATTER_CLUSTER_IDS.WINDOW_COVERING,
        name: "WindowCovering",
        attributes: [
          {
            attributeId: MATTER_ATTRIBUTE_IDS.TARGET_POSITION_LIFT_PERCENTAGE,
            name: "targetPositionLiftPercentage",
            type: "number",
            writable: true,
            readable: true,
            homecoreAttribute: "target_position",
          },
          {
            attributeId: MATTER_ATTRIBUTE_IDS.CURRENT_POSITION_LIFT_PERCENTAGE,
            name: "currentPositionLiftPercentage",
            type: "number",
            writable: false,
            readable: true,
            homecoreAttribute: "current_position",
          },
        ],
      });
      break;
    }

    default: {
      logger.warn("Unknown HomeCore device type for cluster composition", {
        homecoreType,
      });
      break;
    }
  }

  return clusters;
}

/**
 * Compose a complete Matter endpoint specification from a HomeCore device configuration.
 */
export function composeEndpoint(
  config: EndpointCompositionConfig,
  logger: Logger
): ComposedEndpoint {
  const clusters = composeDeviceClusters(config.homecoreType, logger);

  return {
    homecoreId: config.homecoreId,
    homecoreType: config.homecoreType,
    matterType: config.matterType,
    clusters,
    additionalMetadata: {
      nodeId: config.nodeId,
      endpointId: config.endpointId,
    },
  };
}

/**
 * Get the cluster IDs for a composed endpoint as an array of numbers
 * (useful for quick queries).
 */
export function getClusterIds(endpoint: ComposedEndpoint): number[] {
  return endpoint.clusters.map((c) => c.clusterId);
}

/**
 * Find an attribute specification within a composed endpoint by cluster and attribute name.
 */
export function findAttributeSpec(
  endpoint: ComposedEndpoint,
  clusterName: string,
  attributeName: string
): AttributeSpec | undefined {
  const cluster = endpoint.clusters.find((c) => c.name === clusterName);
  if (!cluster) {
    return undefined;
  }

  return cluster.attributes.find((a) => a.name === attributeName);
}

/**
 * Find all writable attributes in a composed endpoint (useful for command targeting).
 */
export function getWritableAttributes(endpoint: ComposedEndpoint): AttributeSpec[] {
  const writable: AttributeSpec[] = [];

  for (const cluster of endpoint.clusters) {
    for (const attr of cluster.attributes) {
      if (attr.writable) {
        writable.push(attr);
      }
    }
  }

  return writable;
}
