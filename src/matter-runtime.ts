/**
 * Matter Runtime Adapter
 *
 * Phase 0/1 bridge into real matter.js runtime classes.
 * Kept behind env gate to avoid disrupting local dev/test until commissioning
 * and endpoint modeling are fully implemented.
 */

import { Logger } from "./logger.js";

export interface RuntimeBootstrapDevice {
  nodeId: string;
  endpointId: number;
  homecoreId: string;
  homecoreType: string;
  matterType: string;
  clusters: number[];
}

type OnOffChangedHandler = (on: boolean) => Promise<void> | void;

export class MatterRuntime {
  private logger: Logger;
  private node: unknown | null = null;
  private lightEndpoint: unknown | null = null;
  private bootstrapDevice: RuntimeBootstrapDevice | null = null;
  private onOnOffChanged: OnOffChangedHandler | null = null;
  private runPromise: Promise<void> | null = null;
  private started = false;

  constructor(parentLogger: Logger) {
    this.logger = parentLogger.child("matter-runtime");
  }

  isStarted(): boolean {
    return this.started;
  }

  getBootstrapDevice(): RuntimeBootstrapDevice | null {
    return this.bootstrapDevice;
  }

  setOnOffChangedHandler(handler: OnOffChangedHandler): void {
    this.onOnOffChanged = handler;
  }

  /**
   * Start a minimal matter.js ServerNode with an OnOff light endpoint.
   * This is a concrete runtime bootstrap proving matter.js is wired in-process.
   */
  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    // Feature gate while controller/commissioning integration is still evolving.
    if (process.env.HC_MATTER_ENABLE_RUNTIME !== "1") {
      this.logger.info("Matter runtime disabled (set HC_MATTER_ENABLE_RUNTIME=1 to enable)");
      return;
    }

    try {
      const matterMain = (await import("@matter/main")) as Record<string, unknown>;
      const deviceModule = (await import("@matter/main/devices")) as Record<string, unknown>;

      const ServerNode = matterMain.ServerNode as {
        create: () => Promise<{
          add: (deviceType: unknown) => Promise<unknown>;
          start?: () => Promise<void>;
          run: () => Promise<void>;
          close?: () => Promise<void>;
          cancel?: () => Promise<void>;
        }>;
      };

      const OnOffLightDevice = deviceModule.OnOffLightDevice;

      if (!ServerNode?.create || !OnOffLightDevice) {
        throw new Error("matter.js exports missing ServerNode or OnOffLightDevice");
      }

      const node = await ServerNode.create();
      const lightEndpoint = await node.add(OnOffLightDevice);

      if (typeof node.start === "function") {
        await node.start();
      } else {
        // Some matter.js node variants expose only run(); run in background to avoid blocking plugin startup.
        this.runPromise = node.run().catch((error) => {
          this.logger.warn("Matter runtime background run() exited with error", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }

      const endpointNumber =
        typeof (lightEndpoint as { number?: unknown }).number === "number"
          ? ((lightEndpoint as { number: number }).number)
          : 1;

      this.node = node;
      this.lightEndpoint = lightEndpoint;
      this.bootstrapDevice = {
        nodeId: "runtime-node-1",
        endpointId: endpointNumber,
        homecoreId: "matter_runtime_light_1",
        homecoreType: "light",
        matterType: "OnOffLight",
        clusters: [6],
      };

      this.installOnOffChangeListener(lightEndpoint);
      this.started = true;

      this.logger.info("Matter runtime started with OnOffLightDevice endpoint");
    } catch (error) {
      // Non-fatal for now; plugin can continue in spike mode.
      this.logger.error("Matter runtime start failed; continuing in spike mode", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Best-effort OnOff update hook for bridge/controller command routing.
   */
  async setOnOff(on: boolean): Promise<void> {
    if (!this.started || !this.lightEndpoint) {
      return;
    }

    try {
      const endpoint = this.lightEndpoint as {
        act?: (purpose: string, actor: (agent: any) => Promise<void> | void) => Promise<void>;
      };

      if (endpoint.act) {
        await endpoint.act("set-onoff", (agent: any) => {
          // Keep this defensive; concrete behavior wiring is finalized in Phase 1.
          if (agent?.onOff?.state) {
            agent.onOff.state.onOff = on;
          }
        });
      }
    } catch (error) {
      this.logger.warn("Failed to apply OnOff state to matter runtime endpoint", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async stop(): Promise<void> {
    if (!this.node) {
      this.started = false;
      this.bootstrapDevice = null;
      return;
    }

    try {
      const node = this.node as { close?: () => Promise<void>; cancel?: () => Promise<void> };
      if (typeof node.close === "function") {
        await node.close();
      } else if (typeof node.cancel === "function") {
        await node.cancel();
      }

      if (this.runPromise) {
        await this.runPromise;
      }
    } catch (error) {
      this.logger.warn("Matter runtime shutdown encountered an error", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.node = null;
      this.lightEndpoint = null;
      this.bootstrapDevice = null;
      this.runPromise = null;
      this.started = false;
      this.logger.info("Matter runtime stopped");
    }
  }

  private installOnOffChangeListener(endpoint: unknown): void {
    try {
      const maybeEvents = (endpoint as any)?.events?.onOff?.onOff$Change;
      if (typeof maybeEvents?.on !== "function") {
        return;
      }

      maybeEvents.on((newValue: unknown) => {
        if (typeof newValue !== "boolean" || !this.onOnOffChanged) {
          return;
        }

        Promise.resolve(this.onOnOffChanged(newValue)).catch((error) => {
          this.logger.warn("OnOff change handler failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      });
    } catch (error) {
      this.logger.warn("Failed to install OnOff change listener", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
