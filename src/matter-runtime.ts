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

export interface RuntimeCommissioningSnapshot {
  enabled: boolean;
  started: boolean;
  bootstrapDeviceId?: string;
  lastPairingCode?: string;
  lastDiscriminator?: number;
}

export interface RuntimeCommissioningResult {
  pairingCode: string;
  discriminator: number;
  runtimeApplied: boolean;
}

export interface RuntimeSubscriptionMetrics {
  reattachAttempts: number;
  reattachSuccesses: number;
  reattachFailures: number;
}

type OnOffChangedHandler = (on: boolean) => Promise<void> | void;
type BrightnessChangedHandler = (brightnessPct: number) => Promise<void> | void;

export class MatterRuntime {
  private logger: Logger;
  private node: unknown | null = null;
  private lightEndpoint: unknown | null = null;
  private bootstrapDevice: RuntimeBootstrapDevice | null = null;
  private onOnOffChanged: OnOffChangedHandler | null = null;
  private onBrightnessChanged: BrightnessChangedHandler | null = null;
  private runPromise: Promise<void> | null = null;
  private started = false;
  private lastPairingCode: string | null = null;
  private lastDiscriminator: number | null = null;
  private subscriptionMetrics: RuntimeSubscriptionMetrics = {
    reattachAttempts: 0,
    reattachSuccesses: 0,
    reattachFailures: 0,
  };

  constructor(parentLogger: Logger) {
    this.logger = parentLogger.child("matter-runtime");
  }

  isStarted(): boolean {
    return this.started;
  }

  getBootstrapDevice(): RuntimeBootstrapDevice | null {
    return this.bootstrapDevice;
  }

  getCommissioningSnapshot(): RuntimeCommissioningSnapshot {
    const runtimeEnabled =
      process.env.HC_MATTER_ENABLE_RUNTIME === "1" ||
      process.env.HC_MATTER_SIMULATE_RUNTIME === "1";

    return {
      enabled: runtimeEnabled,
      started: this.started,
      bootstrapDeviceId: this.bootstrapDevice?.homecoreId,
      lastPairingCode: this.lastPairingCode ?? undefined,
      lastDiscriminator: this.lastDiscriminator ?? undefined,
    };
  }

  setOnOffChangedHandler(handler: OnOffChangedHandler): void {
    this.onOnOffChanged = handler;
  }

  setBrightnessChangedHandler(handler: BrightnessChangedHandler): void {
    this.onBrightnessChanged = handler;
  }

  getSubscriptionMetrics(): RuntimeSubscriptionMetrics {
    return {
      ...this.subscriptionMetrics,
    };
  }

  /**
   * Start a minimal matter.js ServerNode with an OnOff light endpoint.
   * This is a concrete runtime bootstrap proving matter.js is wired in-process.
   */
  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    // Deterministic runtime simulation path for tests/CI when full matter.js startup is unavailable.
    if (process.env.HC_MATTER_SIMULATE_RUNTIME === "1") {
      this.bootstrapDevice = {
        nodeId: "runtime-node-1",
        endpointId: 1,
        homecoreId: "matter_runtime_light_1",
        homecoreType: "light",
        matterType: "OnOffLight",
        clusters: [6],
      };
      this.node = {};
      this.lightEndpoint = {};
      this.started = true;
      this.logger.info("Matter runtime simulation mode enabled");
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
      this.installLevelChangeListener(lightEndpoint);
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

  /**
   * Best-effort LevelControl update hook for dimmable devices.
   * Accepts HomeCore brightness percentage (0-100).
   */
  async setBrightness(brightnessPct: number): Promise<void> {
    if (!this.started || !this.lightEndpoint) {
      return;
    }

    const clampedPct = Math.max(0, Math.min(100, brightnessPct));
    const matterLevel = Math.round((clampedPct / 100) * 254);

    try {
      const endpoint = this.lightEndpoint as {
        act?: (purpose: string, actor: (agent: any) => Promise<void> | void) => Promise<void>;
      };

      if (endpoint.act) {
        await endpoint.act("set-brightness", (agent: any) => {
          if (agent?.levelControl?.state) {
            agent.levelControl.state.currentLevel = matterLevel;
          }
        });
      }
    } catch (error) {
      this.logger.warn("Failed to apply brightness to matter runtime endpoint", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async openCommissioningWindow(
    passcode: number,
    discriminator?: number
  ): Promise<RuntimeCommissioningResult> {
    const disc = discriminator ?? Math.floor(Math.random() * 4096);
    const fallbackPairingCode = `${passcode.toString().padStart(8, "0")}-${disc
      .toString()
      .padStart(4, "0")}`;

    if (process.env.HC_MATTER_SIMULATE_RUNTIME === "1") {
      this.lastPairingCode = fallbackPairingCode;
      this.lastDiscriminator = disc;
      this.logger.info("Matter runtime simulation commissioning window opened", {
        discriminator: disc,
      });
      return {
        pairingCode: fallbackPairingCode,
        discriminator: disc,
        runtimeApplied: true,
      };
    }

    if (!this.started || !this.node) {
      this.lastPairingCode = fallbackPairingCode;
      this.lastDiscriminator = disc;
      return {
        pairingCode: fallbackPairingCode,
        discriminator: disc,
        runtimeApplied: false,
      };
    }

    try {
      const node = this.node as {
        openCommissioningWindow?: (opts?: {
          passcode?: number;
          discriminator?: number;
        }) => Promise<Record<string, unknown>>;
      };

      if (typeof node.openCommissioningWindow === "function") {
        const result = await node.openCommissioningWindow({
          passcode,
          discriminator: disc,
        });

        const pairingCode =
          (typeof result.pairingCode === "string" && result.pairingCode) ||
          (typeof result.manualPairingCode === "string" && result.manualPairingCode) ||
          (typeof result.qrPairingCode === "string" && result.qrPairingCode) ||
          fallbackPairingCode;

        this.lastPairingCode = pairingCode;
        this.lastDiscriminator = disc;

        this.logger.info("Matter runtime commissioning window opened", {
          discriminator: disc,
          runtimeApplied: true,
        });

        return {
          pairingCode,
          discriminator: disc,
          runtimeApplied: true,
        };
      }
    } catch (error) {
      this.logger.warn("Runtime commissioning attempt failed; using fallback code", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    this.lastPairingCode = fallbackPairingCode;
    this.lastDiscriminator = disc;
    return {
      pairingCode: fallbackPairingCode,
      discriminator: disc,
      runtimeApplied: false,
    };
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
      this.lastPairingCode = null;
      this.lastDiscriminator = null;
      this.subscriptionMetrics = {
        reattachAttempts: 0,
        reattachSuccesses: 0,
        reattachFailures: 0,
      };
      this.logger.info("Matter runtime stopped");
    }
  }

  /**
   * Best-effort runtime-side reinterview hook.
   * Returns true when runtime accepted the request for a known runtime node.
   */
  async reinterviewNode(nodeId: string): Promise<boolean> {
    if (!this.started || !this.bootstrapDevice) {
      return false;
    }

    if (nodeId !== this.bootstrapDevice.nodeId) {
      return false;
    }

    // Phase 1 placeholder for concrete matter.js endpoint/cluster refresh operations.
    this.logger.info("Matter runtime reinterview request accepted", { nodeId });
    return true;
  }

  /**
   * Best-effort runtime-side remove hook.
   * Returns true when runtime accepted the request for a known runtime node.
   */
  async removeNode(nodeId: string): Promise<boolean> {
    if (!this.started || !this.bootstrapDevice) {
      return false;
    }

    if (nodeId !== this.bootstrapDevice.nodeId) {
      return false;
    }

    // Phase 1 placeholder for concrete matter.js fabric removal operations.
    this.lightEndpoint = null;
    this.bootstrapDevice = null;
    this.logger.info("Matter runtime remove node request accepted", { nodeId });
    return true;
  }

  async reattachSubscriptions(): Promise<boolean> {
    this.subscriptionMetrics.reattachAttempts++;

    if (!this.started || !this.lightEndpoint) {
      this.subscriptionMetrics.reattachFailures++;
      return false;
    }

    try {
      this.installOnOffChangeListener(this.lightEndpoint);
      this.installLevelChangeListener(this.lightEndpoint);
      this.subscriptionMetrics.reattachSuccesses++;
      return true;
    } catch (_error) {
      this.subscriptionMetrics.reattachFailures++;
      return false;
    }
  }

  /**
   * Test-only helper to exercise runtime -> controller -> state publisher path.
   */
  async emitOnOffChangedForTest(on: boolean): Promise<void> {
    if (!this.onOnOffChanged) {
      return;
    }

    await Promise.resolve(this.onOnOffChanged(on));
  }

  /**
   * Test-only helper to exercise runtime LevelControl callbacks.
   */
  async emitBrightnessChangedForTest(brightnessPct: number): Promise<void> {
    if (!this.onBrightnessChanged) {
      return;
    }

    const clampedPct = Math.max(0, Math.min(100, Math.round(brightnessPct)));
    await Promise.resolve(this.onBrightnessChanged(clampedPct));
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

  private installLevelChangeListener(endpoint: unknown): void {
    try {
      const maybeEvents = (endpoint as any)?.events?.levelControl?.currentLevel$Change;
      if (typeof maybeEvents?.on !== "function") {
        return;
      }

      maybeEvents.on((newValue: unknown) => {
        if (typeof newValue !== "number" || !this.onBrightnessChanged) {
          return;
        }

        const brightnessPct = Math.max(0, Math.min(100, Math.round((newValue / 254) * 100)));
        Promise.resolve(this.onBrightnessChanged(brightnessPct)).catch((error) => {
          this.logger.warn("Brightness change handler failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      });
    } catch (error) {
      this.logger.warn("Failed to install LevelControl change listener", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
