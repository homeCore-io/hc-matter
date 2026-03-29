/**
 * Matter Bridge
 *
 * Exposes HomeCore devices as Matter endpoints for external controllers
 * to discover and control.
 */

import { Logger } from "../logger.js";
import { BridgeConfig } from "../config.js";
import { WebSocketBridge } from "../ws-bridge.js";
import { MatterController } from "../controller/index.js";

export interface BridgeEndpoint {
  homecoreId: string;
  homecoreType: string;
  matterType: string;
  nodeId: string;
  endpointId: number;
  clusters: number[];
  lastState?: Record<string, unknown>;
  lastUpdatedAt?: string;
}

export interface BridgeMetrics {
  bridge_enabled: boolean;
  bridge_started: boolean;
  bridged_endpoints: number;
  bridged_endpoints_with_state: number;
  bridge_reconnect_restores: number;
  bridge_commands_forwarded: number;
  bridge_commands_rejected: number;
}

export class MatterBridge {
  private logger: Logger;
  private controller: MatterController;
  private wsBridge: WebSocketBridge;
  private started = false;
  private handlersAttached = false;
  private endpoints: Map<string, BridgeEndpoint> = new Map();
  private reconnectRestores = 0;
  private commandsForwarded = 0;
  private commandsRejected = 0;

  private readonly onBridgeMessage = (msg: unknown) => this.handleMessage(msg);
  private readonly onBridgeConnected = () => {
    this.onReconnected().catch((error) => {
      this.logger.warn("Bridge reconnect restore failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  constructor(
    private config: BridgeConfig,
    controller: MatterController,
    wsBridge: WebSocketBridge,
    parentLogger: Logger
  ) {
    this.logger = parentLogger.child("bridge");
    this.controller = controller;
    this.wsBridge = wsBridge;
  }

  /**
   * Start the Matter bridge
   */
  async start(): Promise<void> {
    if (this.started) {
      this.logger.debug("Matter bridge already started; skipping duplicate start");
      return;
    }

    this.logger.info("Starting Matter bridge", {
      include_ids: this.config.include_ids,
      exclude_ids: this.config.exclude_ids,
    });

    if (!this.handlersAttached) {
      this.wsBridge.on("message", this.onBridgeMessage);
      this.wsBridge.on("connected", this.onBridgeConnected);
      this.handlersAttached = true;
    }

    await this.refreshEndpointsFromController();

    if (this.wsBridge.isConnected()) {
      await this.onReconnected();
    }

    this.started = true;
    this.logger.info("Matter bridge started");
  }

  /**
   * Stop the Matter bridge
   */
  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    this.logger.info("Stopping Matter bridge");

    if (this.handlersAttached) {
      this.wsBridge.off("message", this.onBridgeMessage);
      this.wsBridge.off("connected", this.onBridgeConnected);
      this.handlersAttached = false;
    }

    this.endpoints.clear();
    this.started = false;

    this.logger.info("Matter bridge stopped");
  }

  /**
   * Get bridged endpoints
   */
  async getEndpoints(): Promise<BridgeEndpoint[]> {
    return Array.from(this.endpoints.values()).sort((a, b) =>
      a.homecoreId.localeCompare(b.homecoreId)
    );
  }

  getMetrics(): BridgeMetrics {
    let endpointsWithState = 0;
    for (const endpoint of this.endpoints.values()) {
      if (endpoint.lastState) {
        endpointsWithState++;
      }
    }

    return {
      bridge_enabled: this.config.enabled,
      bridge_started: this.started,
      bridged_endpoints: this.endpoints.size,
      bridged_endpoints_with_state: endpointsWithState,
      bridge_reconnect_restores: this.reconnectRestores,
      bridge_commands_forwarded: this.commandsForwarded,
      bridge_commands_rejected: this.commandsRejected,
    };
  }

  private async onReconnected(): Promise<void> {
    this.reconnectRestores++;
    await this.wsBridge.subscribe("homecore/devices/+/state");
    await this.wsBridge.subscribe("homecore/plugins/matter/device_registered");
    await this.wsBridge.subscribe("homecore/plugins/matter/bridge/cmd");
    await this.wsBridge.subscribe("homecore/plugins/matter/bridge/+/cmd");
  }

  private async refreshEndpointsFromController(): Promise<void> {
    const devices = await this.controller.getDevices();
    this.endpoints.clear();

    for (const device of devices) {
      if (!this.isIncluded(device.homecoreId, device.homecoreType)) {
        continue;
      }

      this.endpoints.set(device.homecoreId, {
        homecoreId: device.homecoreId,
        homecoreType: device.homecoreType,
        matterType: device.matterType,
        nodeId: device.nodeId,
        endpointId: device.endpointId,
        clusters: [...device.clusters],
      });
    }

    this.logger.info("Bridge endpoints refreshed", {
      endpoints: this.endpoints.size,
    });
  }

  private isIncluded(homecoreId: string, homecoreType: string): boolean {
    const includeIds = this.config.include_ids.length > 0 ? this.config.include_ids : ["*"];
    const included = includeIds.some((pattern) => this.globMatch(pattern, homecoreId));
    if (!included) {
      return false;
    }

    if (this.config.exclude_ids.some((pattern) => this.globMatch(pattern, homecoreId))) {
      return false;
    }

    if (
      this.config.device_type_filter &&
      this.config.device_type_filter.length > 0 &&
      !this.config.device_type_filter.includes(homecoreType)
    ) {
      return false;
    }

    return true;
  }

  private globMatch(pattern: string, value: string): boolean {
    if (pattern === "*") {
      return true;
    }

    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`^${escaped.replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
    return regex.test(value);
  }

  private handleMessage(msg: unknown): void {
    if (typeof msg !== "object" || msg === null) {
      return;
    }

    const message = msg as Record<string, unknown>;

    if (
      message.type === "mqtt_message" &&
      typeof message.topic === "string" &&
      typeof message.payload === "object" &&
      message.payload !== null
    ) {
      this.handleMqttMessage(message.topic, message.payload as Record<string, unknown>);
      return;
    }

    if (
      typeof message.topic === "string" &&
      typeof message.payload === "object" &&
      message.payload !== null
    ) {
      this.handleMqttMessage(message.topic, message.payload as Record<string, unknown>);
    }
  }

  private handleMqttMessage(topic: string, payload: Record<string, unknown>): void {
    if (topic === "homecore/plugins/matter/device_registered") {
      this.handleDeviceRegistered(payload);
      return;
    }

    const bridgeCommandDeviceId = this.extractDeviceIdFromBridgeCmdTopic(topic, payload);
    if (bridgeCommandDeviceId) {
      this.forwardBridgeCommand(bridgeCommandDeviceId, payload).catch((error) => {
        this.commandsRejected++;
        this.logger.warn("Failed to forward bridge command", {
          error: error instanceof Error ? error.message : String(error),
          topic,
          deviceId: bridgeCommandDeviceId,
        });
      });
      return;
    }

    const deviceId = this.extractDeviceIdFromStateTopic(topic);
    if (!deviceId) {
      return;
    }

    const endpoint = this.endpoints.get(deviceId);
    if (!endpoint) {
      return;
    }

    endpoint.lastState = { ...payload };
    endpoint.lastUpdatedAt = new Date().toISOString();
  }

  private async forwardBridgeCommand(
    deviceId: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    const endpoint = this.endpoints.get(deviceId);
    if (!endpoint) {
      this.commandsRejected++;
      this.logger.warn("Bridge command ignored for unknown endpoint", { deviceId });
      return;
    }

    const command = this.translateBridgeCommand(endpoint, payload);
    if (!command) {
      this.commandsRejected++;
      this.logger.warn("Bridge command ignored due to unsupported payload", {
        deviceId,
        payload,
      });
      return;
    }

    await this.wsBridge.publish(`homecore/devices/${deviceId}/cmd`, {
      ...command,
      origin: "matter_bridge",
      timestamp: new Date().toISOString(),
    });

    this.commandsForwarded++;
  }

  private translateBridgeCommand(
    endpoint: BridgeEndpoint,
    payload: Record<string, unknown>
  ): Record<string, unknown> | null {
    const explicitCommand = payload.command;
    if (explicitCommand && typeof explicitCommand === "object") {
      return explicitCommand as Record<string, unknown>;
    }

    const action = typeof payload.action === "string" ? payload.action : null;
    const value = payload.value;
    const correlationId =
      (typeof payload.correlation_id === "string" && payload.correlation_id) ||
      (typeof payload.correlationId === "string" && payload.correlationId) ||
      undefined;

    const withCorrelation = (base: Record<string, unknown>) => {
      if (!correlationId) {
        return base;
      }
      return {
        ...base,
        correlation_id: correlationId,
      };
    };

    switch (endpoint.homecoreType) {
      case "light":
      case "dimmer_light": {
        if (action === "on" || action === "off") {
          return withCorrelation({ command: action });
        }

        if (action === "set_on" && typeof value === "boolean") {
          return withCorrelation({ on: value });
        }

        if (action === "set_brightness" && typeof value === "number") {
          return withCorrelation({
            brightness_pct: Math.max(0, Math.min(100, Math.round(value))),
          });
        }

        return null;
      }
      case "lock": {
        if (action === "lock" || action === "unlock") {
          return withCorrelation({ command: action });
        }

        if (action === "set_locked" && typeof value === "boolean") {
          return withCorrelation({ locked: value });
        }

        return null;
      }
      case "cover": {
        if (action === "open" || action === "close") {
          return withCorrelation({ command: action });
        }

        if (action === "set_position" && typeof value === "number") {
          return withCorrelation({
            position: Math.max(0, Math.min(100, Math.round(value))),
          });
        }

        return null;
      }
      default:
        return null;
    }
  }

  private handleDeviceRegistered(payload: Record<string, unknown>): void {
    const homecoreId = typeof payload.homecore_id === "string" ? payload.homecore_id : null;
    const matterType = typeof payload.matter_type === "string" ? payload.matter_type : null;
    const nodeId = typeof payload.node_id === "string" ? payload.node_id : null;

    if (!homecoreId || !matterType || !nodeId) {
      return;
    }

    const existing = this.endpoints.get(homecoreId);
    if (existing) {
      return;
    }

    const inferredType = this.inferHomecoreType(homecoreId);
    if (!this.isIncluded(homecoreId, inferredType)) {
      return;
    }

    this.endpoints.set(homecoreId, {
      homecoreId,
      homecoreType: inferredType,
      matterType,
      nodeId,
      endpointId: typeof payload.endpoint_id === "number" ? payload.endpoint_id : 0,
      clusters: Array.isArray(payload.clusters)
        ? payload.clusters.filter((item): item is number => typeof item === "number")
        : [],
    });
  }

  private inferHomecoreType(homecoreId: string): string {
    const [prefix] = homecoreId.split(/[._]/);
    return prefix || "unknown";
  }

  private extractDeviceIdFromStateTopic(topic: string): string | null {
    const match = topic.match(/^homecore\/devices\/([^/]+)\/state$/);
    if (!match) {
      return null;
    }
    return match[1];
  }

  private extractDeviceIdFromBridgeCmdTopic(
    topic: string,
    payload: Record<string, unknown>
  ): string | null {
    const direct = topic.match(/^homecore\/plugins\/matter\/bridge\/([^/]+)\/cmd$/);
    if (direct) {
      return direct[1];
    }

    if (topic !== "homecore/plugins/matter/bridge/cmd") {
      return null;
    }

    if (typeof payload.device_id === "string" && payload.device_id) {
      return payload.device_id;
    }

    if (typeof payload.homecore_id === "string" && payload.homecore_id) {
      return payload.homecore_id;
    }

    return null;
  }
}
