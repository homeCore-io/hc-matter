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

export class MatterController {
  private logger: Logger;
  private fabricStore: FabricStore;
  private deviceRegistry: DeviceRegistry;
  private statePublisher: StatePublisher;
  private commissioningActive = false;

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
  }

  /**
   * Start the Matter controller
   */
  async start(): Promise<void> {
    this.logger.info("Starting Matter controller", {
      storage_dir: this.config.storage_dir,
      instance_name: this.config.instance_name,
    });

    try {
      // Load fabric store
      await this.fabricStore.load();

      // Subscribe to HomeCore command topics
      await this.wsBridge.subscribe("homecore/devices/+/cmd");
      this.wsBridge.on("message", (msg: unknown) => this.handleMessage(msg));

      // Register plugin with HomeCore
      await this.wsBridge.register("matter", ["controller", "bridge"], "1.0.0");

      this.logger.info("Matter controller started", {
        nodes: this.fabricStore.listNodes().length,
      });

      // Phase 0 spike bootstrap: publish one synthetic OnOff light for command loop validation.
      this.bootstrapOnOffSpikeDevice();
    } catch (error) {
      this.logger.error("Failed to start Matter controller", { error });
      throw error;
    }
  }

  /**
   * Stop the Matter controller
   */
  async stop(): Promise<void> {
    this.logger.info("Stopping Matter controller");

    // Save fabric store if dirty
    if (this.fabricStore.isDirty()) {
      await this.fabricStore.save();
    }

    this.logger.info("Matter controller stopped");
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
      // TODO: Use matter.js to open commissioning window
      // For spike, just log and return a pairing code
      const pairingCode = this.generatePairingCode(passcode, discriminator);

      this.logger.info("Commissioning window opened", {
        pairingCode,
        discriminator: discriminator ?? "random",
      });

      return pairingCode;
    } finally {
      this.commissioningActive = false;
    }
  }

  /**
   * Reinterview a node (refresh endpoints and clusters)
   */
  async reinterview(nodeId: string): Promise<void> {
    this.logger.info("Reinterviewing node", { nodeId });

    // TODO: Query node endpoints and clusters from matter.js
    // TODO: Update device registry with new/removed endpoints

    this.logger.info("Reinterview completed", { nodeId });
  }

  /**
   * Remove a commissioned node
   */
  async removeNode(nodeId: string): Promise<void> {
    this.logger.info("Removing node", { nodeId });

    // Remove from fabric store
    this.fabricStore.removeNode(nodeId);

    // Remove devices from registry
    this.deviceRegistry.removeNodeDevices(nodeId);

    // Save fabric store
    await this.fabricStore.save();

    // TODO: Notify matter.js to remove from fabric

    this.logger.info("Node removed", { nodeId });
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
    const device = this.deviceRegistry.getByHomecoreId(deviceId);
    if (!device) {
      this.logger.warn("Device not found", { deviceId });
      return;
    }

    this.logger.debug("Handling device command", { deviceId, command });

    // Phase 0 spike: support basic OnOff command semantics.
    const normalized = this.normalizeOnOffCommand(command);
    if (normalized.on !== undefined) {
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

  /**
   * Generate a pairing code for commissioning
   */
  private generatePairingCode(
    passcode: number,
    discriminator?: number
  ): string {
    const disc = discriminator ?? Math.floor(Math.random() * 4096);
    const code = `${passcode.toString().padStart(8, "0")}-${disc.toString().padStart(4, "0")}`;
    return code;
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
