/**
 * Matter Controller
 *
 * Handles commissioning and controlling of Matter devices.
 * Manages fabric store, subscriptions, and command dispatch.
 */

import { Logger } from "../logger.js";
import { MatterConfig } from "../config.js";
import { WebSocketBridge } from "../ws-bridge.js";
import { FabricStore } from "./fabric-store.js";
import { DeviceRegistry, MatterDevice } from "../device-registry.js";
import { StatePublisher } from "../state-publisher.js";
import { MatterRuntime } from "../matter-runtime.js";
import { z } from "zod";

const ControllerActionSchema = z.enum([
  "commission",
  "reinterview",
  "remove_node",
  "status",
  "nodes",
]);

const CommissionPayloadSchema = z.object({
  action: z.literal("commission"),
  passcode: z.number().int().positive().optional(),
  discriminator: z.number().int().min(0).max(4095).optional(),
  correlation_id: z.string().optional(),
  correlationId: z.string().optional(),
});

const ReinterviewPayloadSchema = z.object({
  action: z.literal("reinterview"),
  node_id: z.string().min(1),
  correlation_id: z.string().optional(),
  correlationId: z.string().optional(),
});

const RemoveNodePayloadSchema = z.object({
  action: z.literal("remove_node"),
  node_id: z.string().min(1),
  correlation_id: z.string().optional(),
  correlationId: z.string().optional(),
});

class ControllerCommandError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "ControllerCommandError";
  }
}

export class MatterController {
  private logger: Logger;
  private fabricStore: FabricStore;
  private deviceRegistry: DeviceRegistry;
  private statePublisher: StatePublisher;
  private matterRuntime: MatterRuntime;
  private commissioningActive = false;
  private runtimeDeviceId: string = "matter_runtime_light_1";
  private lastCommissioningCode: string | null = null;
  private readonly controllerDeviceId = "matter_controller";
  private started = false;
  private bridgeHandlersAttached = false;

  private readonly onBridgeMessage = (msg: unknown) => this.handleMessage(msg);
  private readonly onBridgeConnected = () => {
    this.onBridgeReconnected().catch((error) => {
      this.logger.error("Failed to restore controller subscriptions after reconnect", {
        error,
      });
    });
  };

  constructor(
    private config: MatterConfig,
    private wsBridge: WebSocketBridge,
    parentLogger: Logger
  ) {
    this.logger = parentLogger.child("controller");
    this.fabricStore = new FabricStore(
      `${config.storage_dir}/fabric_store.json`,
      this.logger
    );
    this.deviceRegistry = new DeviceRegistry(this.logger);
    this.statePublisher = new StatePublisher(wsBridge, this.logger);
    this.matterRuntime = new MatterRuntime(this.logger);
    this.matterRuntime.setOnOffChangedHandler(async (on: boolean) => {
      await this.statePublisher.publishState(this.runtimeDeviceId, { on }, { origin: "matter_runtime" });
    });
  }

  /**
   * Start the Matter controller
   */
  async start(): Promise<void> {
    if (this.started) {
      this.logger.debug("Matter controller already started; skipping duplicate start");
      return;
    }

    this.logger.info("Starting Matter controller", {
      storage_dir: this.config.storage_dir,
      instance_name: this.config.instance_name,
    });

    try {
      // Load fabric store
      await this.fabricStore.load();

      if (!this.bridgeHandlersAttached) {
        this.wsBridge.on("message", this.onBridgeMessage);
        this.wsBridge.on("connected", this.onBridgeConnected);
        this.bridgeHandlersAttached = true;
      }

      if (this.wsBridge.isConnected()) {
        await this.onBridgeReconnected();
      }

      // Best-effort real matter.js bootstrap (feature-flagged).
      await this.matterRuntime.start();

      this.logger.info("Matter controller started", {
        nodes: this.fabricStore.listNodes().length,
        matter_runtime: this.matterRuntime.isStarted(),
      });

      // Bootstrap device registration/state source.
      if (!(await this.bootstrapRuntimeOnOffDevice())) {
        // Fallback for spike mode when runtime is disabled/unavailable.
        this.bootstrapOnOffSpikeDevice();
      }

      await this.publishControllerState();
      this.started = true;
    } catch (error) {
      this.logger.error("Failed to start Matter controller", { error });
      throw error;
    }
  }

  /**
   * Stop the Matter controller
   */
  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    this.logger.info("Stopping Matter controller");

    if (this.bridgeHandlersAttached) {
      this.wsBridge.off("message", this.onBridgeMessage);
      this.wsBridge.off("connected", this.onBridgeConnected);
      this.bridgeHandlersAttached = false;
    }

    await this.matterRuntime.stop();

    // Save fabric store if dirty
    if (this.fabricStore.isDirty()) {
      await this.fabricStore.save();
    }

    this.logger.info("Matter controller stopped");
    this.started = false;
  }

  private async onBridgeReconnected(): Promise<void> {
    if (!this.started && !this.bridgeHandlersAttached) {
      return;
    }

    await this.wsBridge.subscribe("homecore/devices/+/cmd");
    await this.wsBridge.register("matter", ["controller", "bridge"], "1.0.0");
    await this.publishControllerState();
  }

  /**
   * Get commissioned nodes
   */
  async getNodes(): Promise<{ nodeId: string; deviceCount: number }[]> {
    return this.fabricStore.listNodes().map((nodeId) => ({
      nodeId,
      deviceCount: this.deviceRegistry.getNodeDevices(nodeId).length,
    }));
  }

  /**
   * Get all registered devices
   */
  async getDevices(): Promise<MatterDevice[]> {
    return this.deviceRegistry.listAll();
  }

  /**
   * Commission a new Matter device
   */
  async commission(passcode: number, discriminator?: number): Promise<string> {
    this.logger.info("Starting commissioning window", {
      passcode,
      discriminator: discriminator ?? "random",
    });

    if (this.commissioningActive) {
      throw new Error("Commissioning already in progress");
    }

    this.commissioningActive = true;

    try {
      const result = await this.matterRuntime.openCommissioningWindow(
        passcode,
        discriminator
      );
      const pairingCode = result.pairingCode;

      this.logger.info("Commissioning window opened", {
        pairingCode,
        discriminator: result.discriminator,
        runtime_applied: result.runtimeApplied,
      });

      this.lastCommissioningCode = pairingCode;

      return pairingCode;
    } finally {
      this.commissioningActive = false;
    }
  }

  /**
   * Reinterview a node (refresh endpoints and clusters)
   */
  async reinterview(nodeId: string): Promise<boolean> {
    const node = this.fabricStore.getNode(nodeId);
    if (!node) {
      throw new ControllerCommandError("NODE_NOT_FOUND", `Node not found: ${nodeId}`);
    }

    this.logger.info("Reinterviewing node", { nodeId });

    // TODO: Query node endpoints and clusters from matter.js
    // TODO: Update device registry with new/removed endpoints
    this.fabricStore.updateNodeEndpoints(nodeId, node.endpoints);
    const runtimeApplied = await this.matterRuntime.reinterviewNode(nodeId);

    this.logger.info("Reinterview completed", { nodeId });
    return runtimeApplied;
  }

  /**
   * Remove a commissioned node
   */
  async removeNode(nodeId: string): Promise<boolean> {
    const node = this.fabricStore.getNode(nodeId);
    if (!node) {
      throw new ControllerCommandError("NODE_NOT_FOUND", `Node not found: ${nodeId}`);
    }

    this.logger.info("Removing node", { nodeId });

    const runtimeApplied = await this.matterRuntime.removeNode(nodeId);

    // Remove from fabric store
    this.fabricStore.removeNode(nodeId);

    // Remove devices from registry
    this.deviceRegistry.removeNodeDevices(nodeId);

    // Save fabric store
    await this.fabricStore.save();

    // TODO: Notify matter.js to remove from fabric

    this.logger.info("Node removed", { nodeId });
    return runtimeApplied;
  }

  /**
   * Register a device discovered on a commissioned node
   */
  registerDevice(nodeId: string, device: MatterDevice): void {
    this.deviceRegistry.register(device);

    // Publish registration to HomeCore
    this.wsBridge.publish(`homecore/plugins/matter/device_registered`, {
      node_id: nodeId,
      homecore_id: device.homecoreId,
      matter_type: device.matterType,
      clusters: device.clusters,
      timestamp: new Date().toISOString(),
    }).catch((error) => {
      this.logger.error("Failed to publish device registration", { error });
    });
  }

  /**
   * Handle incoming message from HomeCore
   */
  private handleMessage(msg: unknown): void {
    if (typeof msg !== "object" || msg === null) {
      return;
    }

    const message = msg as Record<string, unknown>;

    // Shape A (synthetic): { type: "device_command", device_id, command }
    if (message.type === "device_command") {
      const deviceId = message.device_id as string | undefined;
      const command = message.command as Record<string, unknown> | undefined;

      if (deviceId && command) {
        this.handleDeviceCommand(deviceId, command).catch((error) => {
          this.logger.error("Failed to handle device command", { error, deviceId });
        });
      }
      return;
    }

    // Shape B (mqtt-forwarded): { type: "mqtt_message", topic, payload }
    if (message.type === "mqtt_message") {
      const topic = message.topic as string | undefined;
      const payload = message.payload as Record<string, unknown> | undefined;

      if (!topic || !payload) {
        return;
      }

      const maybeDeviceId = this.extractDeviceIdFromCmdTopic(topic);
      if (!maybeDeviceId) {
        return;
      }

      this.handleDeviceCommand(maybeDeviceId, payload).catch((error) => {
        this.logger.error("Failed to handle mqtt command", {
          error,
          deviceId: maybeDeviceId,
        });
      });
      return;
    }

    // Shape C (topic/payload without explicit type)
    if (typeof message.topic === "string" && message.payload && typeof message.payload === "object") {
      const maybeDeviceId = this.extractDeviceIdFromCmdTopic(message.topic);
      if (!maybeDeviceId) {
        return;
      }

      this.handleDeviceCommand(
        maybeDeviceId,
        message.payload as Record<string, unknown>
      ).catch((error) => {
        this.logger.error("Failed to handle topic/payload command", {
          error,
          deviceId: maybeDeviceId,
        });
      });
    }
  }

  /**
   * Handle device command from HomeCore
   */
  private async handleDeviceCommand(
    deviceId: string,
    command: Record<string, unknown>
  ): Promise<void> {
    if (deviceId === this.controllerDeviceId) {
      try {
        await this.handleControllerCommand(command);
      } catch (error) {
        const errorDetails = this.toControllerError(error);
        await this.publishCommandResult(
          typeof command.action === "string" ? command.action : "unknown",
          "error",
          errorDetails,
          this.extractCorrelationId(command)
        );
      }
      return;
    }

    const device = this.deviceRegistry.getByHomecoreId(deviceId);
    if (!device) {
      this.logger.warn("Device not found", { deviceId });
      return;
    }

    this.logger.debug("Handling device command", { deviceId, command });

    // Phase 0 spike: support basic OnOff command semantics.
    const normalized = this.normalizeOnOffCommand(command);
    if (normalized.on !== undefined) {
      await this.matterRuntime.setOnOff(normalized.on);

      await this.statePublisher.publishState(
        deviceId,
        { on: normalized.on },
        { origin: "matter_controller", correlationId: normalized.correlationId }
      );
    }

    this.logger.info("Device command executed", {
      deviceId,
      command,
      endpointId: device.endpointId,
      normalized,
    });
  }

  private async handleControllerCommand(command: Record<string, unknown>): Promise<void> {
    const action = ControllerActionSchema.parse(command.action);
    const correlationId = this.extractCorrelationId(command);

    switch (action) {
      case "commission": {
        const parsed = CommissionPayloadSchema.parse(command);
        const passcode = parsed.passcode ?? this.config.passcode_default;
        const discriminator = parsed.discriminator ?? this.config.discriminator_default;

        const pairingCode = await this.commission(passcode, discriminator);
        const runtime = this.matterRuntime.getCommissioningSnapshot();
        await this.publishCommandResult(
          action,
          "ok",
          {
            pairing_code: pairingCode,
            discriminator: runtime.lastDiscriminator,
            runtime_applied: runtime.started,
            runtime,
          },
          correlationId
        );
        break;
      }
      case "reinterview": {
        const parsed = ReinterviewPayloadSchema.parse(command);
        const runtimeApplied = await this.reinterview(parsed.node_id);
        await this.publishCommandResult(
          action,
          "ok",
          {
            node_id: parsed.node_id,
            runtime_applied: runtimeApplied,
          },
          correlationId
        );
        break;
      }
      case "remove_node": {
        const parsed = RemoveNodePayloadSchema.parse(command);
        const runtimeApplied = await this.removeNode(parsed.node_id);
        await this.publishCommandResult(
          action,
          "ok",
          {
            node_id: parsed.node_id,
            runtime_applied: runtimeApplied,
          },
          correlationId
        );
        break;
      }
      case "nodes":
      case "status": {
        const nodes = await this.getNodes();
        const status = await this.getStatus();
        await this.publishCommandResult(
          action,
          "ok",
          {
            info: this.getCommissioningInfo(),
            controller_status: status,
            nodes: nodes.map((node) => ({
              node_id: node.nodeId,
              device_count: node.deviceCount,
            })),
          },
          correlationId
        );
        break;
      }
    }

    await this.publishControllerState();
  }

  private extractCorrelationId(command: Record<string, unknown>): string | undefined {
    return (
      (typeof command.correlation_id === "string" && command.correlation_id) ||
      (typeof command.correlationId === "string" && command.correlationId) ||
      undefined
    );
  }

  private async publishCommandResult(
    action: string,
    status: "ok" | "error",
    details: Record<string, unknown>,
    correlationId?: string
  ): Promise<void> {
    await this.wsBridge.publish("homecore/plugins/matter/command_result", {
      action,
      status,
      ...details,
      correlation_id: correlationId,
      timestamp: new Date().toISOString(),
    });
  }

  private toControllerError(error: unknown): { error: string; code: string } {
    if (error instanceof ControllerCommandError) {
      return { error: error.message, code: error.code };
    }
    if (error instanceof z.ZodError) {
      return {
        error: "Invalid controller command payload",
        code: "INVALID_CONTROLLER_COMMAND",
      };
    }
    return {
      error: error instanceof Error ? error.message : String(error),
      code: "CONTROLLER_COMMAND_FAILED",
    };
  }

  private normalizeOnOffCommand(command: Record<string, unknown>): {
    on?: boolean;
    correlationId?: string;
  } {
    const correlationId =
      (typeof command.correlation_id === "string" && command.correlation_id) ||
      (typeof command.correlationId === "string" && command.correlationId) ||
      undefined;

    if (typeof command.on === "boolean") {
      return { on: command.on, correlationId };
    }

    const raw = command.command;
    if (raw === "on") {
      return { on: true, correlationId };
    }
    if (raw === "off") {
      return { on: false, correlationId };
    }

    return { correlationId };
  }

  private extractDeviceIdFromCmdTopic(topic: string): string | null {
    // Expected: homecore/devices/{device_id}/cmd
    const match = topic.match(/^homecore\/devices\/([^/]+)\/cmd$/);
    if (!match) {
      return null;
    }
    return match[1];
  }

  private bootstrapOnOffSpikeDevice(): void {
    const spikeDeviceId = "matter_spike_light_1";
    this.registerDevice("spike-node-1", {
      nodeId: "spike-node-1",
      endpointId: 1,
      matterType: "OnOffLight",
      homecoreId: spikeDeviceId,
      homecoreType: "light",
      clusters: [6], // OnOff cluster
    });

    this.statePublisher
      .publishState(spikeDeviceId, { on: false }, { origin: "matter_controller" })
      .catch((error) => {
        this.logger.error("Failed to publish spike bootstrap state", { error });
      });
  }

  private async bootstrapRuntimeOnOffDevice(): Promise<boolean> {
    const runtimeDevice = this.matterRuntime.getBootstrapDevice();
    if (!runtimeDevice) {
      return false;
    }

    this.runtimeDeviceId = runtimeDevice.homecoreId;

    this.registerDevice(runtimeDevice.nodeId, {
      nodeId: runtimeDevice.nodeId,
      endpointId: runtimeDevice.endpointId,
      matterType: runtimeDevice.matterType,
      homecoreId: runtimeDevice.homecoreId,
      homecoreType: runtimeDevice.homecoreType,
      clusters: runtimeDevice.clusters,
    });

    if (!this.fabricStore.getNode(runtimeDevice.nodeId)) {
      this.fabricStore.registerNode(runtimeDevice.nodeId, {
        [runtimeDevice.endpointId]: {
          id: runtimeDevice.endpointId,
          clusters: runtimeDevice.clusters.reduce<Record<number, { id: number; attributes: Record<number, unknown> }>>((acc, clusterId) => {
            acc[clusterId] = { id: clusterId, attributes: {} };
            return acc;
          }, {}),
        },
      });

      await this.fabricStore.save();
    }

    this.statePublisher
      .publishState(runtimeDevice.homecoreId, { on: false }, { origin: "matter_runtime" })
      .catch((error) => {
        this.logger.error("Failed to publish runtime bootstrap state", { error });
      });

    return true;
  }

  /**
   * Returns latest commissioning metadata for admin/API surfacing.
   */
  getCommissioningInfo(): {
    active: boolean;
    lastPairingCode: string | null;
    runtimeEnabled: boolean;
    runtimeDeviceId: string;
    runtime: {
      enabled: boolean;
      started: boolean;
      bootstrapDeviceId?: string;
    };
  } {
    return {
      active: this.commissioningActive,
      lastPairingCode: this.lastCommissioningCode,
      runtimeEnabled: this.matterRuntime.isStarted(),
      runtimeDeviceId: this.runtimeDeviceId,
      runtime: this.matterRuntime.getCommissioningSnapshot(),
    };
  }

  async getMetrics(): Promise<{
    commissioned_nodes: number;
    registered_devices: number;
    commissioning_active: boolean;
    runtime_enabled: boolean;
    runtime_started: boolean;
  }> {
    const info = this.getCommissioningInfo();
    return {
      commissioned_nodes: this.fabricStore.listNodes().length,
      registered_devices: this.deviceRegistry.listAll().length,
      commissioning_active: info.active,
      runtime_enabled: info.runtime.enabled,
      runtime_started: info.runtime.started,
    };
  }

  /**
   * Test helper to simulate runtime-originated OnOff updates without hardware.
   */
  async simulateRuntimeOnOffChangedForTest(on: boolean): Promise<void> {
    await this.matterRuntime.emitOnOffChangedForTest(on);
  }

  private async publishControllerState(): Promise<void> {
    const nodes = await this.getNodes();
    const info = this.getCommissioningInfo();

    await this.wsBridge.publish(`homecore/devices/${this.controllerDeviceId}/state`, {
      commissioned_nodes: nodes.map((n) => ({
        node_id: n.nodeId,
        device_count: n.deviceCount,
      })),
      commissioning_active: info.active,
      last_pairing_code: info.lastPairingCode,
      runtime_enabled: info.runtimeEnabled,
      runtime_device_id: info.runtimeDeviceId,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Get controller status
   */
  async getStatus(): Promise<{
    active: boolean;
    commissioning: boolean;
    nodes: number;
    devices: number;
  }> {
    return {
      active: true,
      commissioning: this.commissioningActive,
      nodes: this.fabricStore.listNodes().length,
      devices: this.deviceRegistry.listAll().length,
    };
  }
}
