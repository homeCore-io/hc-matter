// The bridge, as the plugin runs it: what is chosen (store.ts), homeCore's
// devices as they are now (home.ts), and the matter.js bridge (bridge.ts),
// which is loaded only once the bridge is turned on.

import { Action, RequiresRole } from "homecore-plugin-sdk";
import { rmSync } from "node:fs";
import type { Log } from "../server.js";
import type { MatterBridge } from "./bridge.js";
import { HomeLink } from "./home.js";
import { BRIDGE_KIND_NAMES, homeName, needsSecurityConfirm, partsFor, type HomeDevice } from "./model.js";
import { BridgeStore } from "./store.js";

export const BRIDGE_SCOPES = ["devices:read", "devices:command"];

export const BRIDGE_ACTIONS = [
  new Action({
    id: "bridge_status",
    requiresRole: RequiresRole.ADMIN,
    label: "Matter bridge status",
    description: "Whether homeCore's Matter bridge is on, its pairing code, and the apps it is paired with.",
  }),
  new Action({
    id: "bridge_enable",
    requiresRole: RequiresRole.ADMIN,
    label: "Turn the Matter bridge on or off",
    description: "Show shared homeCore devices to Apple Home, Google Home, Alexa or another Matter app, through one bridge they pair.",
    params: { type: "object", required: ["on"], properties: { on: { type: "boolean", title: "On" } } },
    timeoutMs: 60_000,
  }),
  new Action({
    id: "bridge_devices",
    label: "Devices the bridge can share",
    description: "Every homeCore device, whether the bridge can show it, and whether it does.",
  }),
  new Action({
    id: "bridge_share",
    requiresRole: RequiresRole.ADMIN,
    label: "Share a device through the bridge",
    description: "Show a homeCore device to the apps the bridge is paired with, or stop. A lock or a garage door needs confirm_security: the other app's users and its voice assistant could then unlock or open it.",
    params: {
      type: "object",
      required: ["device_id", "shared"],
      properties: {
        device_id: { type: "string", title: "Device" },
        shared: { type: "boolean", title: "Shared" },
        confirm_security: { type: "boolean", title: "I understand the other app can unlock or open it" },
      },
    },
    timeoutMs: 30_000,
  }),
  new Action({
    id: "bridge_reset",
    requiresRole: RequiresRole.ADMIN,
    label: "Reset the Matter bridge",
    description: "Unpair the bridge from every app and give it a new pairing code. The devices it shares stay chosen.",
    timeoutMs: 60_000,
  }),
];

/**
 * An error with what caused it: matter.js wraps the reason ("Matter requires
 * you to set this attribute") in "Behaviors have errors".
 */
export function describe(e: unknown, depth = 0): string {
  const err = e as { message?: string; cause?: unknown; errors?: unknown[] };
  const own = err?.message ?? String(e);
  if (depth > 3) return own;
  const inner = [...(err?.errors ?? []), ...(err?.cause ? [err.cause] : [])].map((x) => describe(x, depth + 1));
  return inner.length ? `${own} (${inner.join("; ")})` : own;
}

/** What the page lists for one device. */
export interface BridgeCandidate {
  device_id: string;
  name: string;
  type: string | null;
  shared: boolean;
  can_share: boolean;
  shows_as: string | null;
  reason: string | null;
  needs_confirm: boolean;
  available: boolean;
}

/** Every device, sorted by name, as the page lists them. Pure; tested. */
export function candidates(devices: Iterable<HomeDevice>, sharedIds: Set<string>, ownPluginId: string): BridgeCandidate[] {
  return [...devices]
    .map((d) => {
      const parts = partsFor(d, ownPluginId);
      const ok = Array.isArray(parts);
      return {
        device_id: d.device_id,
        name: homeName(d),
        type: d.device_type ?? null,
        shared: sharedIds.has(d.device_id),
        can_share: ok,
        shows_as: ok ? parts.map((p) => BRIDGE_KIND_NAMES[p.kind]).join(" and ") : null,
        reason: ok ? null : parts.reason,
        needs_confirm: ok && needsSecurityConfirm(d),
        available: d.available !== false,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export class BridgeService {
  private readonly store: BridgeStore;
  private readonly home: HomeLink;
  private readonly devices = new Map<string, HomeDevice>();
  private bridge: MatterBridge | null = null;
  private access: { url: string; key: string } | null = null;
  private synced = false;
  /** Why the bridge isn't running when it should be, for the page and the notices. */
  problem: string | null = null;
  /** Start, on, off and reset, one at a time: two at once could leave two bridges. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly dataDir: string,
    private readonly pluginId: string,
    private readonly log: Log,
    /** Something the plugin's notices show changed. */
    private readonly changed: () => void = () => {},
  ) {
    this.store = new BridgeStore(`${dataDir}/bridge.json`, (msg) => log("warn", `bridge: ${msg}`));
    this.home = new HomeLink(log, {
      onSnapshot: (list) => void this.onSnapshot(list),
      onState: (id, current) => {
        const d = this.devices.get(id);
        if (d) this.devices.set(id, { ...d, attributes: current });
        void this.bridge?.setState(id, current);
      },
      onAvailability: (id, available) => {
        const d = this.devices.get(id);
        if (d) this.devices.set(id, { ...d, available });
        void this.bridge?.setAvailable(id, available);
      },
      onDevice: (d) => {
        const known = this.devices.get(d.device_id);
        this.devices.set(d.device_id, { ...known, ...d });
        if (this.store.get().devices[d.device_id]) void this.placeOrSay(d.device_id);
      },
      onRemoved: (id) => {
        this.devices.delete(id);
        void this.bridge?.unshare(id);
      },
    });
  }

  get enabled(): boolean {
    return this.store.get().enabled;
  }

  /** Run one lifecycle step after the others. */
  private serial<T>(f: () => Promise<T>): Promise<T> {
    const next = this.queue.then(f, f);
    this.queue = next.catch(() => {});
    return next;
  }

  /** At start: run the bridge if it was on. */
  start(): Promise<void> {
    return this.serial(async () => {
      if (this.enabled) await this.run();
    });
  }

  async stop(): Promise<void> {
    this.home.close();
    await this.bridge?.stop();
  }

  /** Stop the bridge for a moment (a backup copies its storage), keeping it on. */
  pause(): Promise<void> {
    return this.serial(async () => {
      this.home.pause();
      await this.bridge?.stop();
      this.bridge = null;
    });
  }

  resume(): Promise<void> {
    return this.serial(async () => {
      if (this.enabled) await this.run();
    });
  }

  /** homeCore's key for this run; reminted every start. */
  setAccess(url: string, key: string): void {
    this.access = { url, key };
    if (this.enabled) this.home.setAccess(url, key);
  }

  private async run(): Promise<void> {
    try {
      if (!this.bridge) {
        const { MatterBridge } = await import("./bridge.js");
        const c = this.store.get();
        this.bridge = new MatterBridge(`${this.dataDir}/bridge`, { passcode: c.passcode, discriminator: c.discriminator }, this.log,
          (id, body) => this.home.command(id, body));
      }
      await this.bridge.start();
      this.problem = null;
    } catch (e) {
      this.problem = `The Matter bridge could not start: ${describe(e)}`;
      this.log("error", `bridge: ${this.problem}`);
      throw e;
    } finally {
      this.changed();
    }
    if (this.access) this.home.setAccess(this.access.url, this.access.key);
  }

  private async onSnapshot(list: HomeDevice[]): Promise<void> {
    this.devices.clear();
    for (const d of list) this.devices.set(d.device_id, d);
    this.synced = true;
    for (const id of Object.keys(this.store.get().devices)) await this.placeOrSay(id);
  }

  /** place, from an event: nobody waits for it, so it says what failed. */
  private async placeOrSay(id: string): Promise<void> {
    try {
      await this.place(id);
    } catch (e) {
      this.log("warn", `bridge: could not show ${id}: ${describe(e)}`);
    }
  }

  /** Put a chosen device on the bridge as it is now, or take it off if it can't be. */
  private async place(id: string): Promise<void> {
    const d = this.devices.get(id);
    const choice = this.store.get().devices[id];
    if (!this.bridge || !choice) return;
    if (!d) {
      if (this.synced) await this.bridge.unshare(id);
      return;
    }
    const parts = partsFor(d, this.pluginId);
    if (!Array.isArray(parts)) {
      await this.bridge.unshare(id);
      return;
    }
    // It became something that can be unlocked or opened since it was shared.
    if (needsSecurityConfirm(d) && !choice.security_confirmed) {
      this.log("warn", `bridge: stopped sharing ${homeName(d)}: it now counts as security; share it again to confirm`);
      this.store.unshare(id);
      await this.bridge.unshare(id);
      return;
    }
    await this.bridge.share(d, parts);
  }

  // ── Actions ─────────────────────────────────────────────────────────────

  /** One of the bridge's actions, or undefined when the id isn't one. */
  async action(id: string, params: Record<string, unknown>, who: string): Promise<Record<string, unknown> | undefined> {
    switch (id) {
      case "bridge_status":
        return this.status();
      case "bridge_enable":
        return this.serial(async () => {
          const on = params.on === true;
          this.store.setEnabled(on);
          if (on) await this.run();
          else {
            this.home.pause();
            await this.bridge?.stop();
            this.bridge = null;
            this.problem = null;
            this.changed();
          }
          this.log("info", `bridge turned ${on ? "on" : "off"} by ${who}`);
          return this.status();
        });
      case "bridge_devices":
        if (!this.enabled) return { devices: [], note: "Turn the bridge on to choose devices." };
        if (!this.synced) return { devices: [], note: "Still reading homeCore's devices." };
        return { devices: candidates(this.devices.values(), new Set(Object.keys(this.store.get().devices)), this.pluginId) };
      case "bridge_share":
        return this.share(String(params.device_id ?? ""), params.shared === true, params.confirm_security === true, who);
      case "bridge_reset":
        return this.serial(async () => {
          this.store.reset();
          const c = this.store.get();
          if (this.bridge?.running) {
            await this.bridge.reset({ passcode: c.passcode, discriminator: c.discriminator });
          } else {
            // Not running (off, or failed to start): forget its pairings by
            // removing what matter.js keeps for it, which no one has open.
            await this.bridge?.stop();
            rmSync(`${this.dataDir}/bridge`, { recursive: true, force: true });
          }
          this.bridge = null;
          if (this.enabled) await this.run();
          this.log("info", `bridge reset by ${who}`);
          return this.status();
        });
      default:
        return undefined;
    }
  }

  private status(): Record<string, unknown> {
    const info = this.bridge?.info() ?? { running: false, commissioned: false, qr_code: null, manual_code: null, fabrics: [] };
    return {
      enabled: this.enabled,
      error: this.problem,
      ...info,
      // The code is for pairing the first app; after that, share from that app.
      qr_code: info.commissioned ? null : info.qr_code,
      manual_code: info.commissioned ? null : info.manual_code,
      shared: Object.keys(this.store.get().devices).length,
      following_homecore: this.home.connected,
      has_access: this.access !== null,
    };
  }

  private async share(id: string, on: boolean, confirmed: boolean, who: string): Promise<Record<string, unknown>> {
    if (!this.enabled) throw new Error("Turn the bridge on first.");
    if (!on) {
      this.store.unshare(id);
      await this.bridge?.unshare(id);
      this.log("info", `bridge: ${who} stopped sharing ${id}`);
      return { device_id: id, shared: false };
    }
    const d = this.devices.get(id);
    if (!d) throw new Error(`homeCore has no device ${id}`);
    const parts = partsFor(d, this.pluginId);
    if (!Array.isArray(parts)) throw new Error(`${homeName(d)} can't be shared: ${parts.reason}`);
    if (needsSecurityConfirm(d) && !confirmed) {
      throw new Error(`${homeName(d)} can be unlocked or opened. Share it with confirm_security, knowing the other app's users and its voice assistant could do that.`);
    }
    this.store.share(id, needsSecurityConfirm(d) && confirmed);
    try {
      await this.place(id);
    } catch (e) {
      this.store.unshare(id);
      throw new Error(`${homeName(d)} could not be put on the bridge: ${describe(e)}`);
    }
    this.log("info", `bridge: ${who} shared ${homeName(d)}${needsSecurityConfirm(d) ? " (a security device, confirmed)" : ""}`);
    return { device_id: id, shared: true };
  }
}
