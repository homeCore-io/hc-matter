/**
 * Matter Bridge Binding
 *
 * Converts composed endpoint specifications into actual matter.js bridge endpoints.
 * Handles cluster initialization and attribute state management for bridged devices.
 */

import { Logger } from "../logger.js";
import { ComposedEndpoint } from "./endpoint-factory.js";

/**
 * Represents a single Matter bridge endpoint created from a composed endpoint spec
 */
export interface BridgeEndpointBinding {
  homecoreId: string;
  matterType: string;
  bridgedEndpoint: unknown; // matter.js BridgedDevice instance
  composedEndpoint: ComposedEndpoint;
  clusterState: Map<number, Record<string, unknown>>;
}

/**
 * Configuration for creating a matter.js Bridge with endpoints
 */
export interface BridgeCreationConfig {
  composedEndpoints: ComposedEndpoint[];
  logger: Logger;
}

/**
 * Factory for creating matter.js Bridge with composed endpoints
 */
export class MatterBridgeBinding {
  private logger: Logger;
  private bridge: unknown | null = null;
  private bridgeEndpoints: Map<string, BridgeEndpointBinding> = new Map();

  constructor(parentLogger: Logger) {
    this.logger = parentLogger.child("matter-bridge-binding");
  }

  /**
   * Create and initialize a matter.js Bridge with the provided composed endpoints.
   * Returns the created bridge instance for further configuration (e.g., adding to ServerNode).
   */
  async createBridge(config: BridgeCreationConfig): Promise<unknown> {
    try {
      // Import matter.js main module and Bridge device if available
      const matterMain = (await import("@matter/main")) as Record<string, unknown>;

      const Bridge = matterMain.Bridge as {
        create?: (opts?: Record<string, unknown>) => Promise<{
          addBridgedDevice?: (
            device: unknown,
            opts?: Record<string, unknown>
          ) => Promise<unknown>;
          [key: string]: unknown;
        }>;
      };

      if (!Bridge?.create) {
        this.logger.warn(
          "matter.js Bridge not available; endpoints will be tracked but not created"
        );
        return null;
      }

      const bridgeInstance = await Bridge.create({
        vendorName: "HomeCore",
        vendorId: 0xfff1,
        productName: "HomeCore Matter Bridge",
        productId: 0x8000,
      });

      this.bridge = bridgeInstance;

      // Create bridge endpoints for each composed endpoint
      for (const composed of config.composedEndpoints) {
        try {
          const binding = await this.createBridgeEndpoint(composed, bridgeInstance);
          if (binding) {
            this.bridgeEndpoints.set(composed.homecoreId, binding);
            this.logger.debug("Bridge endpoint created", {
              homecoreId: composed.homecoreId,
              matterType: composed.matterType,
            });
          }
        } catch (error) {
          this.logger.warn("Failed to create bridge endpoint", {
            homecoreId: composed.homecoreId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      this.logger.info("Matter bridge created with endpoints", {
        endpoints: this.bridgeEndpoints.size,
      });

      return bridgeInstance;
    } catch (error) {
      this.logger.warn("Failed to create matter.js bridge", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Create a single bridged endpoint from a composed endpoint specification.
   * Initializes all clusters and attributes based on the specification.
   */
  private async createBridgeEndpoint(
    composed: ComposedEndpoint,
    bridge: any
  ): Promise<BridgeEndpointBinding | null> {
    try {
      // Determine device type based on matter type
      const deviceType = this.getDeviceType(composed.matterType);
      if (!deviceType) {
        this.logger.warn("Unknown Matter device type for bridge endpoint", {
          matterType: composed.matterType,
        });
        return null;
      }

      // Build cluster initialization specs for matter.js
      const clusterState = new Map<number, Record<string, unknown>>();
      const clusterInitializers: Array<{
        clusterId: number;
        attributes: Record<string, unknown>;
      }> = [];

      for (const cluster of composed.clusters) {
        const attrMap: Record<string, unknown> = {};

        for (const attr of cluster.attributes) {
          // Initialize attributes with default values
          attrMap[attr.name] = this.getDefaultAttributeValue(attr.type, composed.homecoreType);
        }

        clusterState.set(cluster.clusterId, attrMap);
        clusterInitializers.push({
          clusterId: cluster.clusterId,
          attributes: attrMap,
        });
      }

      // Create the bridged device (duck typing since matter.js types may vary)
      const bridgedDevice = {
        vendorName: "HomeCore",
        vendorId: 0xfff1,
        productName: composed.homecoreType,
        productId: 0x8001,
        deviceType,
        clusters: clusterInitializers,
      };

      // Add to bridge if the method exists
      let createdEndpoint = null;
      if (typeof bridge.addBridgedDevice === "function") {
        createdEndpoint = await bridge.addBridgedDevice(bridgedDevice);
      } else if (typeof bridge.add === "function") {
        // Fallback in case the API uses 'add' instead of 'addBridgedDevice'
        createdEndpoint = await bridge.add(bridgedDevice);
      }

      return {
        homecoreId: composed.homecoreId,
        matterType: composed.matterType,
        bridgedEndpoint: createdEndpoint || bridgedDevice,
        composedEndpoint: composed,
        clusterState,
      };
    } catch (error) {
      this.logger.warn("Error creating bridge endpoint", {
        homecoreId: composed.homecoreId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Get Matter device type ID based on HomeCore device type.
   * These are standard Matter device type identifiers.
   */
  private getDeviceType(matterType: string): number | null {
    // Matter device type identifiers (from Matter spec)
    const deviceTypes: Record<string, number> = {
      // Lighting
      OnOffLight: 0x0100, // ColorTemperatureLightBulb
      DimmableLight: 0x0101,
      ColorLight: 0x0102,
      // Smart Plugs & Outlets
      OnOffPlugInUnit: 0x010a,
      // Doors & Locks
      DoorLock: 0x000a,
      // Window Coverings
      WindowCovering: 0x0202,
      // Sensors
      TemperatureSensor: 0x0302,
      HumiditySensor: 0x0303,
      LightSensor: 0x0106,
      OccupancySensor: 0x0107,
      ContactSensor: 0x0015,
      // Default fallback (Generic Device)
      GenericDevice: 0x0000,
    };

    return deviceTypes[matterType] ?? deviceTypes.GenericDevice;
  }

  /**
   * Get default/initial value for a Matter attribute based on its type
   */
  private getDefaultAttributeValue(attrType: string, homecoreType: string): unknown {
    switch (attrType) {
      case "boolean":
        // Default for boolean sensors: false (not occupied/not open)
        // Default for boolean actuators: false (off)
        return homecoreType.includes("sensor") ? false : false;
      case "number":
        // Default for numeric values: 0
        return 0;
      case "string":
        return "";
      case "enum":
        return 0;
      case "bitmap":
        return 0;
      case "array":
        return [];
      case "struct":
        return {};
      default:
        return null;
    }
  }

  /**
   * Get created bridge instance
   */
  getBridge(): unknown {
    return this.bridge;
  }

  /**
   * Get a specific endpoint binding by HomeCore device ID
   */
  getEndpointBinding(homecoreId: string): BridgeEndpointBinding | null {
    return this.bridgeEndpoints.get(homecoreId) ?? null;
  }

  /**
   * Get all created endpoint bindings
   */
  getAllEndpointBindings(): BridgeEndpointBinding[] {
    return Array.from(this.bridgeEndpoints.values());
  }

  /**
   * Update an attribute value on a bridge endpoint
   */
  async setAttributeValue(
    homecoreId: string,
    clusterName: string,
    attributeName: string,
    value: unknown
  ): Promise<boolean> {
    const binding = this.bridgeEndpoints.get(homecoreId);
    if (!binding) {
      this.logger.warn("Bridge endpoint not found for attribute update", { homecoreId });
      return false;
    }

    const cluster = binding.composedEndpoint.clusters.find((c) => c.name === clusterName);
    if (!cluster) {
      this.logger.warn("Cluster not found in endpoint specification", {
        homecoreId,
        clusterName,
      });
      return false;
    }

    const attr = cluster.attributes.find((a) => a.name === attributeName);
    if (!attr) {
      this.logger.warn("Attribute not found in cluster specification", {
        homecoreId,
        clusterName,
        attributeName,
      });
      return false;
    }

    if (!attr.writable) {
      this.logger.warn("Attribute is not writable", {
        homecoreId,
        clusterName,
        attributeName,
      });
      return false;
    }

    // Update the cluster state map
    const clusterState = binding.clusterState.get(cluster.clusterId);
    if (clusterState) {
      clusterState[attributeName] = value;

      // Attempt to update the actual matter.js endpoint if possible
      if (binding.bridgedEndpoint && typeof binding.bridgedEndpoint === "object") {
        const endpoint = binding.bridgedEndpoint as {
          act?: (purpose: string, actor: (agent: any) => void) => Promise<void>;
          emit?: (eventName: string, data: unknown) => void;
          [key: string]: unknown;
        };

        try {
          if (typeof endpoint.act === "function") {
            await endpoint.act("set-attribute", (agent: any) => {
              if (agent?.[clusterName]) {
                agent[clusterName][attributeName] = value;
              }
            });
          } else if (typeof endpoint.emit === "function") {
            endpoint.emit("attribute-changed", {
              cluster: clusterName,
              attribute: attributeName,
              value,
            });
          }
        } catch (error) {
          this.logger.debug("Could not propagate attribute update to matter.js endpoint", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      return true;
    }

    return false;
  }

  /**
   * Clean up and dispose of the bridge
   */
  async dispose(): Promise<void> {
    if (this.bridge && typeof this.bridge === "object") {
      const bridge = this.bridge as { close?: () => Promise<void>; dispose?: () => void };
      try {
        if (typeof bridge.close === "function") {
          await bridge.close();
        } else if (typeof bridge.dispose === "function") {
          bridge.dispose();
        }
      } catch (error) {
        this.logger.warn("Error disposing bridge", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.bridgeEndpoints.clear();
    this.bridge = null;
    this.logger.debug("Matter bridge binding disposed");
  }
}
