/**
 * Device Registry
 *
 * Tracks commissioned Matter devices and maps them to HomeCore device IDs.
 */

import { Logger } from "./logger.js";

export interface MatterDevice {
  nodeId: string;
  endpointId: number;
  matterType: string;
  homecoreId: string;
  homecoreType: string;
  clusters: number[];
}

export class DeviceRegistry {
  private devices: Map<string, MatterDevice> = new Map();
  private logger: Logger;

  constructor(parentLogger: Logger) {
    this.logger = parentLogger.child("device-registry");
  }

  /**
   * Register a device
   */
  register(device: MatterDevice): void {
    const key = `${device.nodeId}:${device.endpointId}`;
    this.devices.set(key, device);
    this.logger.info("Device registered", {
      nodeId: device.nodeId,
      endpointId: device.endpointId,
      homecoreId: device.homecoreId,
      matterType: device.matterType,
    });
  }

  /**
   * Get a device by node and endpoint
   */
  get(nodeId: string, endpointId: number): MatterDevice | undefined {
    return this.devices.get(`${nodeId}:${endpointId}`);
  }

  /**
   * Get all devices for a node
   */
  getNodeDevices(nodeId: string): MatterDevice[] {
    const devices: MatterDevice[] = [];
    for (const device of this.devices.values()) {
      if (device.nodeId === nodeId) {
        devices.push(device);
      }
    }
    return devices;
  }

  /**
   * Get a device by HomeCore ID
   */
  getByHomecoreId(homecoreId: string): MatterDevice | undefined {
    for (const device of this.devices.values()) {
      if (device.homecoreId === homecoreId) {
        return device;
      }
    }
    return undefined;
  }

  /**
   * List all devices
   */
  listAll(): MatterDevice[] {
    return Array.from(this.devices.values());
  }

  /**
   * Remove a device
   */
  remove(nodeId: string, endpointId: number): void {
    const key = `${nodeId}:${endpointId}`;
    this.devices.delete(key);
    this.logger.debug("Device removed", { nodeId, endpointId });
  }

  /**
   * Remove all devices for a node
   */
  removeNodeDevices(nodeId: string): void {
    const toRemove: string[] = [];
    for (const [key, device] of this.devices.entries()) {
      if (device.nodeId === nodeId) {
        toRemove.push(key);
      }
    }

    for (const key of toRemove) {
      this.devices.delete(key);
    }

    this.logger.info("Node devices removed", { nodeId, count: toRemove.length });
  }

  /**
   * Clear all devices
   */
  clear(): void {
    this.devices.clear();
    this.logger.debug("Device registry cleared");
  }
}
