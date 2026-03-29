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
  "node_detail",
  "metrics",
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

const NodeDetailPayloadSchema = z.object({
  action: z.literal("node_detail"),
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
  private readonly processedCommandIds: Map<string, number> = new Map();
  private readonly commandIdTtlMs = 5 * 60 * 1000;
  private deviceCommandsProcessed = 0;
  private deviceCommandsDuplicate = 0;
  private deviceCommandsFailed = 0;

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
    this.matterRuntime.setBrightnessChangedHandler(async (brightnessPct: number) => {
      await this.statePublisher.publishState(
        this.runtimeDeviceId,
        { brightness_pct: brightnessPct },
        { origin: "matter_runtime" }
      );
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
      if (!(await this.bootstrapRuntimeDevices())) {
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

    if (this.matterRuntime.isStarted()) {
      const reattached = await this.matterRuntime.reattachSubscriptions();
      this.logger.info("Runtime subscription restore attempt completed", {
        reattached,
      });
    }

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

  async getNodeDetail(nodeId: string): Promise<{
    node_id: string;
    last_seen: string;
    endpoint_count: number;
    endpoints: Array<{
      endpoint_id: number;
      cluster_count: number;
      clusters: Array<{
        cluster_id: number;
        attribute_count: number;
        attributes: Record<string, unknown>;
      }>;
    }>;
  }> {
    const node = this.fabricStore.getNode(nodeId);
    if (!node) {
      throw new ControllerCommandError("NODE_NOT_FOUND", `Node not found: ${nodeId}`);
    }

    const endpoints = Object.values(node.endpoints ?? {})
      .sort((a, b) => a.id - b.id)
      .map((endpoint) => {
        const clusters = Object.values(endpoint.clusters ?? {})
          .sort((a, b) => a.id - b.id)
          .map((cluster) => {
            const attributes = (cluster.attributes ?? {}) as Record<string, unknown>;
            return {
              cluster_id: cluster.id,
              attribute_count: Object.keys(attributes).length,
              attributes,
            };
          });

        return {
          endpoint_id: endpoint.id,
          cluster_count: clusters.length,
          clusters,
        };
      });

    return {
      node_id: node.nodeId,
      last_seen: node.lastSeen,
      endpoint_count: endpoints.length,
      endpoints,
    };
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

    const runtimeApplied = await this.matterRuntime.reinterviewNode(nodeId);

    const runtimeSnapshot = this.matterRuntime.getNodeSnapshot(nodeId);
    if (runtimeSnapshot) {
      this.deviceRegistry.removeNodeDevices(nodeId);

      const runtimeEndpoints = runtimeSnapshot.endpoints.reduce<
        Record<number, { id: number; clusters: Record<number, { id: number; attributes: Record<number, unknown> }> }>
      >((acc, runtimeEndpoint) => {
        const clusterMap = runtimeEndpoint.clusters.reduce<
          Record<number, { id: number; attributes: Record<number, unknown> }>
        >((clusters, clusterId) => {
          clusters[clusterId] = {
            id: clusterId,
            attributes: {},
          };
          return clusters;
        }, {});

        acc[runtimeEndpoint.endpointId] = {
          id: runtimeEndpoint.endpointId,
          clusters: clusterMap,
        };

        this.registerDevice(nodeId, {
          nodeId,
          endpointId: runtimeEndpoint.endpointId,
          matterType: runtimeEndpoint.matterType,
          homecoreId: runtimeEndpoint.homecoreId,
          homecoreType: runtimeEndpoint.homecoreType,
          clusters: [...runtimeEndpoint.clusters],
        });

        return acc;
      }, {});

      this.fabricStore.updateNodeEndpoints(nodeId, runtimeEndpoints);
    } else {
      this.fabricStore.updateNodeEndpoints(nodeId, node.endpoints);
    }

    if (this.fabricStore.isDirty()) {
      await this.fabricStore.save();
    }

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
      this.deviceCommandsFailed++;
      await this.publishCommandResult(
        "device_command",
        "error",
        {
          device_id: deviceId,
          code: "DEVICE_NOT_FOUND",
          error: `Device not found: ${deviceId}`,
        },
        this.extractCorrelationId(command)
      );
      return;
    }

    const correlationId = this.extractCorrelationId(command);
    if (this.isDuplicateDeviceCommand(deviceId, correlationId)) {
      this.deviceCommandsDuplicate++;
      await this.publishCommandResult(
        "device_command",
        "ok",
        {
          device_id: deviceId,
          duplicate: true,
          code: "DUPLICATE_COMMAND_IGNORED",
        },
        correlationId
      );
      return;
    }

    this.logger.debug("Handling device command", { deviceId, command });

    try {
      let normalized: Record<string, unknown> = {};
      let runtimeApplied = false;
      let applied = false;

      if (device.homecoreType === "lock") {
        const parsed = this.normalizeLockCommand(command);
        normalized = parsed;

        if (parsed.locked !== undefined) {
          runtimeApplied = await this.matterRuntime.setLockState(
            device.homecoreId,
            parsed.locked
          );
          await this.statePublisher.publishState(
            deviceId,
            { locked: parsed.locked },
            { origin: "matter_controller", correlationId: parsed.correlationId }
          );
          applied = true;
        }
      } else if (device.homecoreType === "cover") {
        const parsed = this.normalizeCoverCommand(command);
        normalized = parsed;

        if (parsed.position !== undefined) {
          runtimeApplied = await this.matterRuntime.setCoverPosition(
            device.homecoreId,
            parsed.position
          );
          await this.statePublisher.publishState(
            deviceId,
            { position: parsed.position },
            { origin: "matter_controller", correlationId: parsed.correlationId }
          );
          applied = true;
        }
      } else if (device.homecoreType === "switch") {
        const parsed = this.normalizeLightCommand(command);
        normalized = parsed;

        if (parsed.on !== undefined) {
          await this.matterRuntime.setOnOff(parsed.on);
          await this.statePublisher.publishState(
            deviceId,
            { on: parsed.on },
            { origin: "matter_controller", correlationId: parsed.correlationId }
          );
          applied = true;
          runtimeApplied = this.matterRuntime.isStarted();
        }
      } else {
        const parsed = this.normalizeLightCommand(command);
        normalized = parsed;

        if (parsed.on !== undefined) {
          await this.matterRuntime.setOnOff(parsed.on);
          await this.statePublisher.publishState(
            deviceId,
            { on: parsed.on },
            { origin: "matter_controller", correlationId: parsed.correlationId }
          );
          applied = true;
          runtimeApplied = this.matterRuntime.isStarted();
        }

        if (parsed.brightnessPct !== undefined) {
          await this.matterRuntime.setBrightness(parsed.brightnessPct);
          await this.statePublisher.publishState(
            deviceId,
            { brightness_pct: parsed.brightnessPct },
            { origin: "matter_controller", correlationId: parsed.correlationId }
          );
          applied = true;
          runtimeApplied = this.matterRuntime.isStarted() || runtimeApplied;
        }
      }

      if (!applied) {
        this.deviceCommandsFailed++;
        await this.publishCommandResult(
          "device_command",
          "error",
          {
            device_id: deviceId,
            code: "UNSUPPORTED_DEVICE_COMMAND",
            error: "Unsupported device command payload",
          },
          correlationId
        );
        return;
      }

      this.deviceCommandsProcessed++;
      await this.publishCommandResult(
        "device_command",
        "ok",
        {
          device_id: deviceId,
          runtime_applied: runtimeApplied,
          duplicate: false,
        },
        correlationId
      );

      this.logger.info("Device command executed", {
        deviceId,
        command,
        endpointId: device.endpointId,
        normalized,
      });
    } catch (error) {
      this.deviceCommandsFailed++;
      await this.publishCommandResult(
        "device_command",
        "error",
        {
          device_id: deviceId,
          code: "DEVICE_COMMAND_FAILED",
          error: error instanceof Error ? error.message : String(error),
        },
        correlationId
      );
      throw error;
    }
  }

  private isDuplicateDeviceCommand(
    deviceId: string,
    correlationId?: string
  ): boolean {
    this.pruneProcessedCommandIds();

    if (!correlationId) {
      return false;
    }

    const key = `${deviceId}:${correlationId}`;
    if (this.processedCommandIds.has(key)) {
      return true;
    }

    this.processedCommandIds.set(key, Date.now());
    return false;
  }

  private pruneProcessedCommandIds(): void {
    const now = Date.now();
    for (const [key, timestamp] of this.processedCommandIds.entries()) {
      if (now - timestamp > this.commandIdTtlMs) {
        this.processedCommandIds.delete(key);
      }
    }
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
      case "metrics": {
        const metrics = await this.getMetrics();
        await this.publishCommandResult(
          action,
          "ok",
          {
            metrics,
          },
          correlationId
        );
        break;
      }
      case "node_detail": {
        const parsed = NodeDetailPayloadSchema.parse(command);
        const node = await this.getNodeDetail(parsed.node_id);
        await this.publishCommandResult(
          action,
          "ok",
          {
            node,
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

  private normalizeLightCommand(command: Record<string, unknown>): {
    on?: boolean;
    brightnessPct?: number;
    correlationId?: string;
  } {
    const correlationId =
      (typeof command.correlation_id === "string" && command.correlation_id) ||
      (typeof command.correlationId === "string" && command.correlationId) ||
      undefined;

    const normalized: {
      on?: boolean;
      brightnessPct?: number;
      correlationId?: string;
    } = { correlationId };

    if (typeof command.on === "boolean") {
      normalized.on = command.on;
    }

    if (typeof command.brightness_pct === "number") {
      normalized.brightnessPct = Math.max(0, Math.min(100, Math.round(command.brightness_pct)));
    } else if (typeof command.brightness === "number") {
      normalized.brightnessPct = Math.max(0, Math.min(100, Math.round(command.brightness)));
    }

    const raw = command.command;
    if (raw === "on") {
      normalized.on = true;
    }
    if (raw === "off") {
      normalized.on = false;
    }

    return normalized;
  }

  private normalizeLockCommand(command: Record<string, unknown>): {
    locked?: boolean;
    correlationId?: string;
  } {
    const correlationId =
      (typeof command.correlation_id === "string" && command.correlation_id) ||
      (typeof command.correlationId === "string" && command.correlationId) ||
      undefined;

    if (typeof command.locked === "boolean") {
      return { locked: command.locked, correlationId };
    }

    if (command.command === "lock") {
      return { locked: true, correlationId };
    }

    if (command.command === "unlock") {
      return { locked: false, correlationId };
    }

    return { correlationId };
  }

  private normalizeCoverCommand(command: Record<string, unknown>): {
    position?: number;
    correlationId?: string;
  } {
    const correlationId =
      (typeof command.correlation_id === "string" && command.correlation_id) ||
      (typeof command.correlationId === "string" && command.correlationId) ||
      undefined;

    if (typeof command.position === "number") {
      return {
        position: Math.max(0, Math.min(100, Math.round(command.position))),
        correlationId,
      };
    }

    if (command.command === "open") {
      return { position: 100, correlationId };
    }

    if (command.command === "close") {
      return { position: 0, correlationId };
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

  private async bootstrapRuntimeDevices(): Promise<boolean> {
    const runtimeDevices = this.matterRuntime.getBootstrapDevices();
    if (runtimeDevices.length === 0) {
      return false;
    }

    const runtimeLight = runtimeDevices.find((device) => device.homecoreType === "light");
    this.runtimeDeviceId = runtimeLight?.homecoreId ?? runtimeDevices[0].homecoreId;

    for (const runtimeDevice of runtimeDevices) {
      this.registerDevice(runtimeDevice.nodeId, {
        nodeId: runtimeDevice.nodeId,
        endpointId: runtimeDevice.endpointId,
        matterType: runtimeDevice.matterType,
        homecoreId: runtimeDevice.homecoreId,
        homecoreType: runtimeDevice.homecoreType,
        clusters: runtimeDevice.clusters,
      });

      const existingNode = this.fabricStore.getNode(runtimeDevice.nodeId);
      const endpointClusters = runtimeDevice.clusters.reduce<
        Record<number, { id: number; attributes: Record<number, unknown> }>
      >((acc, clusterId) => {
        acc[clusterId] = { id: clusterId, attributes: {} };
        return acc;
      }, {});

      if (!existingNode) {
        this.fabricStore.registerNode(runtimeDevice.nodeId, {
          [runtimeDevice.endpointId]: {
            id: runtimeDevice.endpointId,
            clusters: endpointClusters,
          },
        });
      } else {
        this.fabricStore.updateNodeEndpoints(runtimeDevice.nodeId, {
          ...existingNode.endpoints,
          [runtimeDevice.endpointId]: {
            id: runtimeDevice.endpointId,
            clusters: endpointClusters,
          },
        });
      }

      const initialState = this.initialStateForRuntimeDevice(runtimeDevice.homecoreType);
      this.statePublisher
        .publishState(runtimeDevice.homecoreId, initialState, { origin: "matter_runtime" })
        .catch((error) => {
          this.logger.error("Failed to publish runtime bootstrap state", { error });
        });
    }

    await this.fabricStore.save();

    return true;
  }

  private initialStateForRuntimeDevice(homecoreType: string): Record<string, unknown> {
    switch (homecoreType) {
      case "lock":
        return { locked: true };
      case "cover":
        return { position: 0 };
      default:
        return { on: false, brightness_pct: 0 };
    }
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
    runtime_subscription_reattach_attempts: number;
    runtime_subscription_reattach_successes: number;
    runtime_subscription_reattach_failures: number;
    device_commands_processed: number;
    device_commands_duplicates: number;
    device_commands_failed: number;
  }> {
    const info = this.getCommissioningInfo();
    const runtimeSubscriptionMetrics = this.matterRuntime.getSubscriptionMetrics();
    return {
      commissioned_nodes: this.fabricStore.listNodes().length,
      registered_devices: this.deviceRegistry.listAll().length,
      commissioning_active: info.active,
      runtime_enabled: info.runtime.enabled,
      runtime_started: info.runtime.started,
      runtime_subscription_reattach_attempts:
        runtimeSubscriptionMetrics.reattachAttempts,
      runtime_subscription_reattach_successes:
        runtimeSubscriptionMetrics.reattachSuccesses,
      runtime_subscription_reattach_failures:
        runtimeSubscriptionMetrics.reattachFailures,
      device_commands_processed: this.deviceCommandsProcessed,
      device_commands_duplicates: this.deviceCommandsDuplicate,
      device_commands_failed: this.deviceCommandsFailed,
    };
  }

  /**
   * Test helper to simulate runtime-originated OnOff updates without hardware.
   */
  async simulateRuntimeOnOffChangedForTest(on: boolean): Promise<void> {
    await this.matterRuntime.emitOnOffChangedForTest(on);
  }

  /**
   * Test helper to simulate runtime-originated brightness updates without hardware.
   */
  async simulateRuntimeBrightnessChangedForTest(brightnessPct: number): Promise<void> {
    await this.matterRuntime.emitBrightnessChangedForTest(brightnessPct);
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
