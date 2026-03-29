/**
 * State Publisher
 *
 * Publishes Matter device state updates back to HomeCore via WebSocket.
 * Deduplicates unchanged state to avoid MQTT spam.
 */

import { WebSocketBridge } from "./ws-bridge.js";
import { Logger } from "./logger.js";
import { fromMatterValue } from "./mapper/index.js";

interface DeviceState {
  [key: string]: unknown;
}

interface PublishOptions {
  origin?: string;
  correlationId?: string;
}

export class StatePublisher {
  private lastState: Map<string, DeviceState> = new Map();
  private logger: Logger;

  constructor(
    private wsBridge: WebSocketBridge,
    parentLogger: Logger
  ) {
    this.logger = parentLogger.child("state-publisher");
  }

  /**
   * Publish device state to HomeCore
   * Only publishes if state has changed to avoid MQTT spam
   */
  async publishState(
    deviceId: string,
    state: DeviceState,
    options: PublishOptions = {}
  ): Promise<void> {
    // Check if state changed
    const lastState = this.lastState.get(deviceId);
    if (lastState && this.stateEqual(lastState, state)) {
      this.logger.debug("State unchanged; skipping publish", { deviceId });
      return;
    }

    // Store new state
    this.lastState.set(deviceId, JSON.parse(JSON.stringify(state)));

    // Add metadata
    const payload = {
      ...state,
      origin: options.origin || "matter_controller",
      correlation_id: options.correlationId,
      timestamp: new Date().toISOString(),
    };

    // Publish to HomeCore
    const topic = `homecore/devices/${deviceId}/state`;
    await this.wsBridge.publish(topic, payload);

    this.logger.debug("State published", { deviceId, state });
  }

  /**
   * Convert Matter attribute report to HomeCore state
   */
  convertAttributeToState(
    homecoreKey: string,
    matterValue: unknown
  ): unknown {
    return fromMatterValue(homecoreKey, matterValue);
  }

  /**
   * Check if two states are equal (deep comparison)
   */
  private stateEqual(state1: DeviceState, state2: DeviceState): boolean {
    const keys1 = Object.keys(state1);
    const keys2 = Object.keys(state2);

    if (keys1.length !== keys2.length) {
      return false;
    }

    for (const key of keys1) {
      if (state1[key] !== state2[key]) {
        return false;
      }
    }

    return true;
  }

  /**
   * Reset state cache (useful on restart)
   */
  reset(): void {
    this.lastState.clear();
    this.logger.debug("State cache reset");
  }
}
