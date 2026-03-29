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

export class MatterController {
  private logger: Logger;
  private fabricStore: FabricStore;
  private deviceRegistry: DeviceRegistry;
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
    // TODO: Initialize state publisher when wiring matter.js
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

    if (message.type === "device_command") {
      const deviceId = message.device_id as string | undefined;
      const command = message.command as Record<string, unknown> | undefined;

      if (deviceId && command) {
        this.handleDeviceCommand(deviceId, command).catch((error) => {
          this.logger.error("Failed to handle device command", { error, deviceId });
        });
      }
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

    // TODO: Route command to matter.js device
    // For spike, just log it
    this.logger.info("Device command executed", {
      deviceId,
      command,
      endpointId: device.endpointId,
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
