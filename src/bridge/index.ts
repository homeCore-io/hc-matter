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

export class MatterBridge {
  private logger: Logger;

  constructor(
    private config: BridgeConfig,
    _controller: MatterController,
    _wsBridge: WebSocketBridge,
    parentLogger: Logger
  ) {
    this.logger = parentLogger.child("bridge");
  }

  /**
   * Start the Matter bridge
   */
  async start(): Promise<void> {
    this.logger.info("Starting Matter bridge", {
      include_ids: this.config.include_ids,
      exclude_ids: this.config.exclude_ids,
    });

    // TODO: Initialize bridge endpoints
    // TODO: Subscribe to HomeCore device states
    // TODO: Setup command routing

    this.logger.info("Matter bridge started");
  }

  /**
   * Stop the Matter bridge
   */
  async stop(): Promise<void> {
    this.logger.info("Stopping Matter bridge");

    // TODO: Shutdown bridge
    // TODO: Unsubscribe from device states

    this.logger.info("Matter bridge stopped");
  }

  /**
   * Get bridged endpoints
   */
  async getEndpoints(): Promise<unknown[]> {
    // TODO: Return list of bridged endpoints
    return [];
  }
}
