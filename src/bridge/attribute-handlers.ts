/**
 * Bridge Attribute Handlers
 *
 * Manages bidirectional synchronization between HomeCore device state and Matter endpoint attributes.
 * Handles: HomeCore state → Matter attribute updates, Matter attribute commands → HomeCore device commands
 */

import { Logger } from "../logger.js";
import { WebSocketBridge } from "../ws-bridge.js";
import { MatterBridgeBinding } from "./matter-bridge-binding.js";
import { ComposedEndpoint, findAttributeSpec } from "./endpoint-factory.js";

/**
 * Configuration for setting up attribute handlers
 */
export interface AttributeHandlerConfig {
  logger: Logger;
  wsBridge: WebSocketBridge;
  bridgeBinding: MatterBridgeBinding;
}

/**
 * Manages attribute synchronization between HomeCore and Matter
 */
export class BridgeAttributeHandlers {
  private logger: Logger;
  private wsBridge: WebSocketBridge;
  private bridgeBinding: MatterBridgeBinding;
  private stateSubscriptions: Map<string, { unsubscribe?: () => void }> = new Map();

  constructor(config: AttributeHandlerConfig) {
    this.logger = config.logger.child("attribute-handlers");
    this.wsBridge = config.wsBridge;
    this.bridgeBinding = config.bridgeBinding;
  }

  /**
   * Start listening for state changes and command events
   */
  async start(): Promise<void> {
    try {
      // Subscribe to device state changes
      await this.wsBridge.subscribe("homecore/devices/+/state");
      await this.wsBridge.subscribe("homecore/devices/+/state/partial");

      // Subscribe to bridge command responses
      await this.wsBridge.subscribe("homecore/plugins/matter/bridge/+/response");

      // Setup message handler
      this.wsBridge.on("message", this.onMessage.bind(this));

      this.logger.info("Attribute handlers started");
    } catch (error) {
      this.logger.warn("Failed to start attribute handlers", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Stop listening for state changes and clean up
   */
  async stop(): Promise<void> {
    for (const subscription of this.stateSubscriptions.values()) {
      if (subscription.unsubscribe) {
        subscription.unsubscribe();
      }
    }
    this.stateSubscriptions.clear();
    this.logger.debug("Attribute handlers stopped");
  }

  /**
   * Handle incoming WebSocket messages for state updates and command responses
   */
  private async onMessage(message: unknown): Promise<void> {
    if (!message || typeof message !== "object") {
      return;
    }

    const msg = message as {
      topic?: string;
      payload?: unknown;
    };

    if (!msg.topic || typeof msg.topic !== "string") {
      return;
    }

    // Handle device state updates
    if (msg.topic.startsWith("homecore/devices/") && msg.topic.endsWith("/state")) {
      try {
        await this.handleStateUpdate(msg.topic, msg.payload);
      } catch (error) {
        this.logger.debug("Error handling state update", {
          topic: msg.topic,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Handle device partial state updates
    if (msg.topic.startsWith("homecore/devices/") && msg.topic.includes("/state/partial")) {
      try {
        await this.handleStateUpdate(msg.topic, msg.payload);
      } catch (error) {
        this.logger.debug("Error handling partial state update", {
          topic: msg.topic,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Handle command responses from bridge
    if (msg.topic.startsWith("homecore/plugins/matter/bridge/")) {
      try {
        await this.handleCommandResponse(msg.topic, msg.payload);
      } catch (error) {
        this.logger.debug("Error handling command response", {
          topic: msg.topic,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Process HomeCore device state update and sync to Matter endpoint attributes
   */
  private async handleStateUpdate(_topic: string, payload: unknown): Promise<void> {
    // Extract HomeCore device ID from topic: homecore/devices/{id}/state
    const match = _topic.match(/homecore\/devices\/([^/]+)\//);
    if (!match || !match[1]) {
      return;
    }

    const homecoreId = match[1];
    const stateData = payload as Record<string, unknown> | null | undefined;

    if (!stateData || typeof stateData !== "object") {
      return;
    }

    const binding = this.bridgeBinding.getEndpointBinding(homecoreId);
    if (!binding) {
      return;
    }

    // Map HomeCore state properties to Matter attributes
    await this.syncStateToAttributes(homecoreId, binding.composedEndpoint, stateData);
  }

  /**
   * Synchronize HomeCore device state to Matter endpoint attributes
   */
  private async syncStateToAttributes(
    homecoreId: string,
    endpoint: ComposedEndpoint,
    stateData: Record<string, unknown>
  ): Promise<void> {
    for (const cluster of endpoint.clusters) {
      for (const attr of cluster.attributes) {
        if (attr.homecoreAttribute && stateData.hasOwnProperty(attr.homecoreAttribute)) {
          const value = stateData[attr.homecoreAttribute];

          // Convert value if needed (e.g., brightness percentage → Matter level 0-254)
          const convertedValue = this.convertHomeCorValueToMatter(
            attr.homecoreAttribute,
            value,
            endpoint.homecoreType
          );

          // Update attribute on the matter endpoint
          const updated = await this.bridgeBinding.setAttributeValue(
            homecoreId,
            cluster.name,
            attr.name,
            convertedValue
          );

          if (updated) {
            this.logger.debug("Attribute synced to matter endpoint", {
              homecoreId,
              cluster: cluster.name,
              attribute: attr.name,
              value: convertedValue,
            });
          }
        }
      }
    }
  }

  /**
   * Convert HomeCore state values to Matter attribute values
   */
  private convertHomeCorValueToMatter(
    homecoreAttribute: string,
    value: unknown,
    _homecoreType: string
  ): unknown {
    // Brightness percentage (0-100) → Matter level (0-254)
    if (homecoreAttribute === "brightness_pct" && typeof value === "number") {
      return Math.round((value / 100) * 254);
    }

    // Color temperature in mireds is already in correct format
    if (homecoreAttribute === "color_temperature_mireds") {
      return value;
    }

    // Temperature in Celsius → Matter 0.01°C units
    if (homecoreAttribute === "temperature_c" && typeof value === "number") {
      return Math.round(value * 100);
    }

    // Humidity percentage is already in correct format (0-100)
    if (homecoreAttribute === "humidity_pct") {
      return value;
    }

    // Motion detected boolean → occupancy bitmap (bit 0)
    if (homecoreAttribute === "motion_detected" && typeof value === "boolean") {
      return value ? 1 : 0;
    }

    // Lock state
    if (homecoreAttribute === "locked" && typeof value === "boolean") {
      // Matter DoorLock lockState: 0=not fully locked, 1=locked, 2=unlocked, etc.
      return value ? 1 : 2;
    }

    // Pass through as-is
    return value;
  }

  /**
   * Handle command responses from previous Matter → HomeCore device commands
   */
  private async handleCommandResponse(_topic: string, payload: unknown): Promise<void> {
    const responseData = payload as Record<string, unknown> | null | undefined;

    if (!responseData || typeof responseData !== "object") {
      return;
    }

    // Log successful device command execution
    const status = responseData.status;
    const homecoreId = responseData.homecoreId;

    if (status === "success" && homecoreId) {
      this.logger.debug("Bridge device command executed successfully", {
        homecoreId,
        command: responseData.command,
      });
    } else if (status === "error") {
      this.logger.warn("Bridge device command failed", {
        homecoreId,
        error: responseData.error,
      });
    }
  }

  /**
   * Send a HomeCore device command from a Matter endpoint attribute write
   */
  async sendDeviceCommand(
    homecoreId: string,
    clusterName: string,
    attributeName: string,
    value: unknown
  ): Promise<boolean> {
    try {
      const binding = this.bridgeBinding.getEndpointBinding(homecoreId);
      if (!binding) {
        this.logger.warn("Bridge endpoint not found for command", { homecoreId });
        return false;
      }

      const attr = findAttributeSpec(
        binding.composedEndpoint,
        clusterName,
        attributeName
      );

      if (!attr || !attr.writable) {
        this.logger.warn("Attribute not writable", {
          homecoreId,
          cluster: clusterName,
          attribute: attributeName,
        });
        return false;
      }

      // Convert Matter value back to HomeCore expected format
      const homecoreValue = this.convertMatterValueToHomeCore(
        attr.homecoreAttribute ?? attributeName,
        value,
        binding.composedEndpoint.homecoreType
      );

      // Send command to HomeCore device
      const commandTopic = `homecore/devices/${homecoreId}/cmd`;
      const commandPayload = {
        action: "set",
        attribute: attr.homecoreAttribute ?? attributeName,
        value: homecoreValue,
        timestamp: new Date().toISOString(),
        source: "matter-bridge",
      };

      await this.wsBridge.publish(commandTopic, commandPayload);

      this.logger.debug("Device command sent from Matter", {
        homecoreId,
        attribute: attr.homecoreAttribute ?? attributeName,
        value: homecoreValue,
      });

      return true;
    } catch (error) {
      this.logger.warn("Failed to send device command", {
        homecoreId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Convert Matter attribute values back to HomeCore state format
   */
  private convertMatterValueToHomeCore(
    homecoreAttribute: string,
    value: unknown,
    _homecoreType: string
  ): unknown {
    // Matter level (0-254) → brightness percentage (0-100)
    if (homecoreAttribute === "brightness_pct" && typeof value === "number") {
      return Math.round((value / 254) * 100);
    }

    // Color temperature in mireds is already correct
    if (homecoreAttribute === "color_temperature_mireds") {
      return value;
    }

    // Matter 0.01°C → Celsius
    if (homecoreAttribute === "temperature_c" && typeof value === "number") {
      return value / 100;
    }

    // Humidity percentage already correct
    if (homecoreAttribute === "humidity_pct") {
      return value;
    }

    // Occupancy bitmap → motion detected boolean
    if (homecoreAttribute === "motion_detected" && typeof value === "number") {
      return (value & 1) !== 0;
    }

    // Lock state enum → locked boolean
    if (homecoreAttribute === "locked" && typeof value === "number") {
      return value === 1; // 1 = locked
    }

    // Pass through as-is
    return value;
  }

  /**
   * Get list of writable attributes for a bridge endpoint
   */
  getWritableAttributes(homecoreId: string): Array<{
    cluster: string;
    attribute: string;
    homecoreAttribute?: string;
  }> {
    const binding = this.bridgeBinding.getEndpointBinding(homecoreId);
    if (!binding) {
      return [];
    }

    const writable: Array<{
      cluster: string;
      attribute: string;
      homecoreAttribute?: string;
    }> = [];

    for (const cluster of binding.composedEndpoint.clusters) {
      for (const attr of cluster.attributes) {
        if (attr.writable) {
          writable.push({
            cluster: cluster.name,
            attribute: attr.name,
            homecoreAttribute: attr.homecoreAttribute,
          });
        }
      }
    }

    return writable;
  }
}
