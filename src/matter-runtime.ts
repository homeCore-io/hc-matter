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

export interface RuntimeNodeSnapshot {
  nodeId: string;
  endpoints: RuntimeBootstrapDevice[];
}

interface RuntimeInterviewEndpoint {
  endpointId: number;
  homecoreId: string;
  homecoreType: string;
  matterType: string;
  clusters: number[];
}

type OnOffChangedHandler = (on: boolean) => Promise<void> | void;
type BrightnessChangedHandler = (brightnessPct: number) => Promise<void> | void;

export class MatterRuntime {
  private logger: Logger;
  private node: unknown | null = null;
  private lightEndpoint: unknown | null = null;
  private bootstrapDevices: RuntimeBootstrapDevice[] = [];
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
    return this.bootstrapDevices[0] ?? null;
  }

  getBootstrapDevices(): RuntimeBootstrapDevice[] {
    return [...this.bootstrapDevices];
  }

  getNodeSnapshot(nodeId: string): RuntimeNodeSnapshot | null {
    const endpoints = this.bootstrapDevices
      .filter((device) => device.nodeId === nodeId)
      .sort((a, b) => a.endpointId - b.endpointId)
      .map((device) => ({ ...device }));

    if (endpoints.length === 0) {
      return null;
    }

    return {
      nodeId,
      endpoints,
    };
  }

  getCommissioningSnapshot(): RuntimeCommissioningSnapshot {
    const runtimeEnabled =
      process.env.HC_MATTER_ENABLE_RUNTIME === "1" ||
      process.env.HC_MATTER_SIMULATE_RUNTIME === "1";

    return {
      enabled: runtimeEnabled,
      started: this.started,
      bootstrapDeviceId: this.bootstrapDevices[0]?.homecoreId,
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
   * Get all known node IDs from the runtime.
   * Returns unique set of nodeIds from bootstrap devices.
   */
  getKnownNodeIds(): string[] {
    const nodeIds = new Set(this.bootstrapDevices.map((d) => d.nodeId));
    return Array.from(nodeIds).sort();
  }

  /**
   * Query runtime node capabilities and properties.
   * Attempts to fetch real matter.js node info if available.
   */
  async getNodeInfo(nodeId: string): Promise<Record<string, unknown> | null> {
    if (!this.started) {
      return null;
    }

    const snapshot = this.getNodeSnapshot(nodeId);
    if (!snapshot) {
      return null;
    }

    // Start with local snapshot data
    const info: Record<string, unknown> = {
      nodeId,
      endpointCount: snapshot.endpoints.length,
      endpoints: snapshot.endpoints.map((ep) => ({
        endpointId: ep.endpointId,
        homecoreId: ep.homecoreId,
        homecoreType: ep.homecoreType,
        matterType: ep.matterType,
        clusterCount: ep.clusters.length,
      })),
    };

    // Attempt to fetch runtime-level node info if available
    if (this.node && typeof this.node === "object") {
      const runtimeNode = this.node as {
        getNodeInfo?: (nodeId: string) => Promise<unknown>;
        nodeInfo?: Record<string, unknown>;
      };

      try {
        if (typeof runtimeNode.getNodeInfo === "function") {
          const runtimeInfo = await runtimeNode.getNodeInfo(nodeId);
          if (runtimeInfo && typeof runtimeInfo === "object") {
            info.runtimeInfo = runtimeInfo;
          }
        } else if (runtimeNode.nodeInfo && typeof runtimeNode.nodeInfo === "object") {
          info.runtimeInfo = runtimeNode.nodeInfo;
        }
      } catch (error) {
        this.logger.debug("Failed to fetch runtime node info", {
          nodeId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return info;
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
      this.bootstrapDevices = [
        {
          nodeId: "runtime-node-1",
          endpointId: 1,
          homecoreId: "matter_runtime_light_1",
          homecoreType: "light",
          matterType: "OnOffLight",
          clusters: [6, 8],
        },
        {
          nodeId: "runtime-node-1",
          endpointId: 2,
          homecoreId: "matter_runtime_lock_1",
          homecoreType: "lock",
          matterType: "DoorLock",
          clusters: [257],
        },
        {
          nodeId: "runtime-node-1",
          endpointId: 3,
          homecoreId: "matter_runtime_cover_1",
          homecoreType: "cover",
          matterType: "WindowCovering",
          clusters: [258],
        },
      ];
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
      this.bootstrapDevices = [
        {
          nodeId: "runtime-node-1",
          endpointId: endpointNumber,
          homecoreId: "matter_runtime_light_1",
          homecoreType: "light",
          matterType: "OnOffLight",
          clusters: [6, 8],
        },
      ];

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

  async setLockState(homecoreId: string, _locked: boolean): Promise<boolean> {
    if (!this.started) {
      return false;
    }

    return this.hasRuntimeDevice(homecoreId, "lock");
  }

  async setCoverPosition(homecoreId: string, _position: number): Promise<boolean> {
    if (!this.started) {
      return false;
    }

    return this.hasRuntimeDevice(homecoreId, "cover");
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
      this.bootstrapDevices = [];
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
      this.bootstrapDevices = [];
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
    if (!this.started || this.bootstrapDevices.length === 0) {
      return false;
    }

    if (!this.bootstrapDevices.some((device) => device.nodeId === nodeId)) {
      return false;
    }

    const interviewedEndpoints = await this.tryInterviewNodeEndpoints(nodeId);
    if (interviewedEndpoints && interviewedEndpoints.length > 0) {
      this.bootstrapDevices = [
        ...this.bootstrapDevices.filter((device) => device.nodeId !== nodeId),
        ...interviewedEndpoints.map((endpoint) => ({
          nodeId,
          endpointId: endpoint.endpointId,
          homecoreId: endpoint.homecoreId,
          homecoreType: endpoint.homecoreType,
          matterType: endpoint.matterType,
          clusters: [...endpoint.clusters],
        })),
      ].sort((a, b) => a.endpointId - b.endpointId);
    }

    this.logger.info("Matter runtime reinterview request accepted", { nodeId });
    return true;
  }

  /**
   * Best-effort runtime-side remove hook.
   * Returns true when runtime accepted the request for a known runtime node.
   */
  async removeNode(nodeId: string): Promise<boolean> {
    if (!this.started || this.bootstrapDevices.length === 0) {
      return false;
    }

    if (!this.bootstrapDevices.some((device) => device.nodeId === nodeId)) {
      return false;
    }

    await this.tryRemoveNodeFromRuntime(nodeId);

    this.lightEndpoint = null;
    this.bootstrapDevices = this.bootstrapDevices.filter(
      (device) => device.nodeId !== nodeId
    );
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

  private hasRuntimeDevice(homecoreId: string, homecoreType: string): boolean {
    return this.bootstrapDevices.some(
      (device) => device.homecoreId === homecoreId && device.homecoreType === homecoreType
    );
  }

  /**
   * Interview a runtime node for endpoint discovery.
   * Attempts multiple matter.js API patterns and gracefully falls back if unavailable.
   * Supports both local simulation and real matter.js runtime integration.
   */
  private async tryInterviewNodeEndpoints(
    nodeId: string
  ): Promise<RuntimeInterviewEndpoint[] | null> {
    if (!this.node) {
      this.logger.debug("Cannot interview node; runtime not initialized", { nodeId });
      return null;
    }

    const runtimeNode = this.node as {
      reinterviewNode?: (nodeId: string) => Promise<unknown>;
      interviewNode?: (nodeId: string) => Promise<unknown>;
      getNodeSnapshot?: (nodeId: string) => Promise<unknown>;
      discoverNode?: (nodeId: string) => Promise<unknown>;
    };

    let interviewResult: unknown = null;
    let attemptedMethod: string | null = null;

    // Try multiple matter.js API patterns in order of preference
    try {
      if (typeof runtimeNode.reinterviewNode === "function") {
        attemptedMethod = "reinterviewNode";
        interviewResult = await runtimeNode.reinterviewNode(nodeId);
      } else if (typeof runtimeNode.interviewNode === "function") {
        attemptedMethod = "interviewNode";
        interviewResult = await runtimeNode.interviewNode(nodeId);
      } else if (typeof runtimeNode.discoverNode === "function") {
        attemptedMethod = "discoverNode";
        interviewResult = await runtimeNode.discoverNode(nodeId);
      } else if (typeof runtimeNode.getNodeSnapshot === "function") {
        attemptedMethod = "getNodeSnapshot";
        interviewResult = await runtimeNode.getNodeSnapshot(nodeId);
      }
    } catch (error) {
      this.logger.warn("Runtime interview method threw error; gracefully degrading", {
        nodeId,
        attemptedMethod,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }

    if (!attemptedMethod) {
      this.logger.debug("No runtime interview methods available on node", { nodeId });
      return null;
    }

    if (!interviewResult || typeof interviewResult !== "object") {
      this.logger.debug("Runtime interview result missing or not an object", {
        nodeId,
        method: attemptedMethod,
        resultType: typeof interviewResult,
      });
      return null;
    }

    const resultRecord = interviewResult as Record<string, unknown>;
    const rawEndpoints = resultRecord.endpoints;
    if (!Array.isArray(rawEndpoints)) {
      this.logger.debug("Runtime interview result missing endpoints array", {
        nodeId,
        method: attemptedMethod,
      });
      return null;
    }

    const parsed = rawEndpoints
      .map((endpoint, idx): RuntimeInterviewEndpoint | null => {
        if (!endpoint || typeof endpoint !== "object") {
          this.logger.debug("Skipping malformed endpoint in interview result", {
            nodeId,
            index: idx,
            type: typeof endpoint,
          });
          return null;
        }

        const raw = endpoint as Record<string, unknown>;
        const endpointId =
          typeof raw.endpointId === "number"
            ? Math.floor(raw.endpointId)
            : typeof raw.endpoint_id === "number"
              ? Math.floor(raw.endpoint_id)
              : null;

        const homecoreId =
          (typeof raw.homecoreId === "string" && raw.homecoreId) ||
          (typeof raw.homecore_id === "string" && raw.homecore_id) ||
          null;

        const homecoreType =
          (typeof raw.homecoreType === "string" && raw.homecoreType) ||
          (typeof raw.homecore_type === "string" && raw.homecore_type) ||
          null;

        const matterType =
          (typeof raw.matterType === "string" && raw.matterType) ||
          (typeof raw.matter_type === "string" && raw.matter_type) ||
          null;

        const clustersRaw = raw.clusters;
        const clusters = Array.isArray(clustersRaw)
          ? clustersRaw.filter((cluster): cluster is number => typeof cluster === "number")
          : [];

        if (
          endpointId === null ||
          endpointId < 1 ||
          !homecoreId ||
          !homecoreType ||
          !matterType
        ) {
          this.logger.debug("Skipping endpoint with missing required fields", {
            nodeId,
            index: idx,
            endpointId,
            missingHomecoreId: !homecoreId,
            missingHomecoreType: !homecoreType,
            missingMatterType: !matterType,
          });
          return null;
        }

        return {
          endpointId,
          homecoreId,
          homecoreType,
          matterType,
          clusters,
        };
      })
      .filter((endpoint): endpoint is RuntimeInterviewEndpoint => endpoint !== null);

    this.logger.debug("Runtime interview completed successfully", {
      nodeId,
      method: attemptedMethod,
      endpointCount: parsed.length,
    });

    return parsed.length > 0 ? parsed : null;
  }

  /**
   * Remove a runtime node for lifecycle cleanup.
   * Attempts multiple matter.js API patterns and gracefully falls back if unavailable.
   * Logs all removal attempts for debugging and audit purposes.
   */
  private async tryRemoveNodeFromRuntime(nodeId: string): Promise<void> {
    if (!this.node) {
      this.logger.debug("Cannot remove node; runtime not initialized", { nodeId });
      return;
    }

    const runtimeNode = this.node as {
      removeNode?: (nodeId: string) => Promise<unknown>;
      unpairNode?: (nodeId: string) => Promise<unknown>;
      forgetNode?: (nodeId: string) => Promise<unknown>;
      decommissionNode?: (nodeId: string) => Promise<unknown>;
    };

    let attemptedMethod: string | null = null;

    try {
      // Try multiple matter.js API patterns in order of preference
      if (typeof runtimeNode.removeNode === "function") {
        attemptedMethod = "removeNode";
        this.logger.debug("Attempting removeNode on runtime", { nodeId });
        await runtimeNode.removeNode(nodeId);
        this.logger.info("Runtime node removed successfully", { nodeId, method: attemptedMethod });
        return;
      }

      if (typeof runtimeNode.unpairNode === "function") {
        attemptedMethod = "unpairNode";
        this.logger.debug("Attempting unpairNode on runtime", { nodeId });
        await runtimeNode.unpairNode(nodeId);
        this.logger.info("Runtime node unaired successfully", { nodeId, method: attemptedMethod });
        return;
      }

      if (typeof runtimeNode.forgetNode === "function") {
        attemptedMethod = "forgetNode";
        this.logger.debug("Attempting forgetNode on runtime", { nodeId });
        await runtimeNode.forgetNode(nodeId);
        this.logger.info("Runtime node forgotten successfully", { nodeId, method: attemptedMethod });
        return;
      }

      if (typeof runtimeNode.decommissionNode === "function") {
        attemptedMethod = "decommissionNode";
        this.logger.debug("Attempting decommissionNode on runtime", { nodeId });
        await runtimeNode.decommissionNode(nodeId);
        this.logger.info("Runtime node decommissioned successfully", { nodeId, method: attemptedMethod });
        return;
      }

      this.logger.debug("No runtime removal methods available on node; proceeding with local cleanup only", {
        nodeId,
      });
    } catch (error) {
      this.logger.warn("Runtime node removal attempt failed; proceeding with local cleanup only", {
        nodeId,
        attemptedMethod,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
