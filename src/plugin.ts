// hc-matter: Matter devices in homeCore.
//
// matter-server (a child process) is the Matter controller: it holds the
// fabric, pairs, subscribes to every node and keeps their attributes. This
// plugin turns that into homeCore devices (devices.ts), state and commands.

import { Action, Capabilities, Concurrency, PluginBase, PluginNotice, type Caller, type StreamContext } from "homecore-plugin-sdk";
import type { NodesChangedDetail } from "@matter-server/ws-client";
import type { Config } from "./config.js";
import { availableOf, commandFor, devicesOf, devicesTouchedBy, nodeIdOf, stateOf, type Device, type MatterOp, type NodeData } from "./devices.js";
import { MatterLink, nodeDataOf, parseNodeId } from "./link.js";
import { MatterServerProcess, type Log, type LogLevel } from "./server.js";

/** State that follows a command within this long is reported as its result. */
const CAUSE_WINDOW_MS = 5_000;
const PAIR_TIMEOUT_MS = 5 * 60_000;
const LEVEL_RANK: Record<string, number> = { trace: 0, debug: 1, info: 2, warn: 3, error: 4 };

export const ACTIONS = [
  new Action({
    id: "pair",
    label: "Pair a device",
    description: "Pair a Matter device from its setup code: the QR code's text (MT:…) or the 11 or 21 digit code. "
      + "The device must already be on the network: shared from another app (its \"share\" or \"pairing mode\" option), "
      + "or a Wi-Fi or Thread device that has been set up before.",
    params: {
      type: "object",
      required: ["code"],
      properties: { code: { type: "string", title: "Setup code", minLength: 11 } },
    },
    stream: true,
    concurrency: Concurrency.SINGLE,
    itemKey: "id",
    itemOperations: ["add"],
    timeoutMs: PAIR_TIMEOUT_MS + 30_000,
  }),
  new Action({
    id: "remove_node",
    label: "Remove a device",
    description: "Remove a paired Matter device from homeCore and from this controller's fabric. "
      + "Other apps it is shared with keep it.",
    params: {
      type: "object",
      required: ["node_id"],
      properties: { node_id: { type: "string", title: "Node id", pattern: "^[0-9]+$" } },
    },
  }),
];

export class MatterPlugin extends PluginBase {
  private readonly nodes = new Map<string, NodeData>();
  private readonly devices = new Map<string, Device>();
  /** What each device last published, to send only what changed. */
  private readonly published = new Map<string, Record<string, unknown>>();
  private readonly availability = new Map<string, boolean>();
  private readonly causes = new Map<string, { payload: Record<string, unknown>; until: number }>();
  private readonly server: MatterServerProcess;
  private readonly link: MatterLink;
  private mqttUp = false;
  private serverProblem: PluginNotice | null = null;
  /** Nodes are known only once the link has listed them; until then reconcile nothing. */
  private synced = false;

  constructor(private readonly config: Config, private readonly version: string) {
    super({
      pluginId: config.homecore.pluginId,
      brokerHost: config.homecore.brokerHost,
      brokerPort: config.homecore.brokerPort,
      password: config.homecore.password,
    });
    const log: Log = (level, message) => this.log(level, message);
    this.server = new MatterServerProcess(config.matter, log, {
      onReady: () => {
        this.serverProblem = null;
        this.refreshNotices();
        this.link.connect();
      },
      onExit: (code, signal, crashes, lastLines) => {
        if (crashes >= 3) {
          const last = lastLines.filter((l) => /error|fatal/i.test(l)).slice(-1)[0] ?? lastLines.slice(-1)[0] ?? "";
          this.serverProblem = PluginNotice.error(
            "matter_server_failing",
            `The Matter server keeps stopping (${signal ?? `exit ${code}`}), so no Matter device can be reached. ${last}`.trim(),
            { remedy: "Check the plugin's log. Matter needs host networking with IPv6; a runtime in a bridged container network cannot reach devices." },
          );
          this.refreshNotices();
        }
      },
    });
    this.link = new MatterLink(config.matter.socketPath, log, {
      onNodes: (nodes) => this.onNodes(nodes),
      onNodeChanged: (detail, node) => this.onNodeChanged(detail, node),
      onDown: () => this.onLinkDown(),
    });
  }

  // ── Logging ────────────────────────────────────────────────────────────────

  log(level: LogLevel, message: string): void {
    const threshold = this.logLevel ?? "info";
    if ((LEVEL_RANK[level] ?? 2) >= (LEVEL_RANK[threshold] ?? 2)) {
      (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(`[${level}] ${message}`);
    }
    this.forwardLog(level, message);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  start(): void {
    this.enableLogForwarding("info");
    this.enableDevicePersistence(`${this.config.matter.storageDir}/../.published-device-ids.json`);
    this.server.start();
    this.run();
  }

  onConnect(): void {
    this.mqttUp = true;
    this.enableManagement({ version: this.version, configPath: this.config.path, capabilities: new Capabilities(ACTIONS) });
    this.publishPluginStatus("active");
    // A reconnect: say every device again (core may have restarted).
    for (const d of this.devices.values()) this.announce(d, true);
    this.refreshNotices();
  }

  async onStop(): Promise<void> {
    this.link.close();
    await this.server.stop();
  }

  // ── Nodes in, devices out ─────────────────────────────────────────────────

  private onNodes(nodes: NodeData[]): void {
    this.nodes.clear();
    for (const n of nodes) this.nodes.set(nodeIdOf(n), n);
    const live = new Set<string>();
    for (const n of nodes) for (const d of this.syncNode(n)) live.add(d);
    // Devices no node has any more (removed while we were down) go.
    for (const id of [...this.devices.keys()]) if (!live.has(id)) this.forget(id);
    if (this.mqttUp) this.reconcileDevices(live);
    this.synced = true;
    this.log("info", `${nodes.length} Matter node(s), ${live.size} device(s)`);
    this.refreshNotices();
  }

  /** Register what a node has now; returns its device ids. */
  private syncNode(node: NodeData): string[] {
    const nodeId = nodeIdOf(node);
    const fresh = devicesOf(node);
    const ids = new Set(fresh.map((d) => d.id));
    for (const [id, d] of this.devices) if (d.nodeId === nodeId && !ids.has(id)) this.forget(id);
    for (const d of fresh) {
      const before = this.devices.get(d.id);
      this.devices.set(d.id, d);
      const changed = !before || before.name !== d.name || before.kind !== d.kind || JSON.stringify(before.schema) !== JSON.stringify(d.schema);
      if (changed) {
        this.published.delete(d.id);
        this.availability.delete(d.id);
      }
      this.announce(d, changed);
    }
    return [...ids];
  }

  /** Register (when new or changed) and publish state and availability. */
  private announce(d: Device, register: boolean): void {
    if (!this.mqttUp) return;
    const node = this.nodes.get(d.nodeId);
    if (!node) return;
    if (register) {
      this.registerDeviceFull(d.id, d.name, { deviceType: d.kind });
      this.registerDeviceSchema(d.id, d.schema);
      this.published.delete(d.id);
      this.availability.delete(d.id);
    }
    this.publishChanges(d, node);
  }

  private publishChanges(d: Device, node: NodeData): void {
    if (!this.mqttUp) return;
    const state = stateOf(node, d);
    const last = this.published.get(d.id);
    const cause = this.causes.get(d.id);
    const caused = cause && cause.until > Date.now() ? cause.payload : null;
    if (!last) {
      if (caused) this.publishStateForCommand(d.id, state, caused, this.pluginId);
      else this.publishState(d.id, state);
    } else {
      const patch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(state)) if (JSON.stringify(v) !== JSON.stringify(last[k])) patch[k] = v;
      if (Object.keys(patch).length > 0) {
        if (caused) this.publishStatePartialForCommand(d.id, patch, caused, this.pluginId);
        else this.publishStatePartial(d.id, patch);
      }
    }
    this.published.set(d.id, state);
    const up = availableOf(node, d);
    if (this.availability.get(d.id) !== up) {
      this.publishAvailability(d.id, up);
      this.availability.set(d.id, up);
    }
  }

  private forget(id: string): void {
    this.devices.delete(id);
    this.published.delete(id);
    this.availability.delete(id);
    this.causes.delete(id);
    if (this.mqttUp) this.unregisterDevice(id);
  }

  private onNodeChanged(detail: NodesChangedDetail, node: NodeData | null): void {
    const nodeId = String(detail.nodeId);
    if (detail.reason === "node_removed" || !node) {
      this.nodes.delete(nodeId);
      for (const [id, d] of [...this.devices]) if (d.nodeId === nodeId) this.forget(id);
      this.log("info", `Matter node ${nodeId} was removed`);
      this.refreshNotices();
      return;
    }
    this.nodes.set(nodeId, node);
    if (detail.reason === "attribute_updated") {
      const mine = [...this.devices.values()].filter((d) => d.nodeId === nodeId);
      // A changed descriptor means the node's shape changed (a bridge added a device).
      if (/^\d+\/29\//.test(detail.attributeKey)) {
        this.syncNode(node);
        return;
      }
      for (const d of devicesTouchedBy(node, mine, detail.attributeKey)) this.publishChanges(d, node);
      return;
    }
    // node_added, node_updated (an interview, availability): its whole shape.
    this.syncNode(node);
    this.refreshNotices();
  }

  private onLinkDown(): void {
    // Not "offline": the devices are as they were; the controller is
    // restarting. If it stays down, the server notice says so.
    this.refreshNotices();
  }

  // ── Notices ────────────────────────────────────────────────────────────────

  private refreshNotices(): void {
    const notices: PluginNotice[] = [];
    if (this.serverProblem) notices.push(this.serverProblem);
    else if (!this.link.connected && this.synced) {
      notices.push(PluginNotice.warning("matter_server_restarting", "The Matter server is restarting; device state may be a little behind."));
    }
    if (this.synced && this.nodes.size === 0) {
      notices.push(PluginNotice.info("no_devices", "No Matter devices are paired yet.", {
        remedy: "Use \"Pair a device\" with the device's setup code. To bring one over from Apple Home, Google Home or Alexa, use that app's option to share it (it shows a new code).",
      }));
    }
    const offline = [...this.nodes.values()].filter((n) => !n.available).length;
    if (offline > 0) {
      notices.push(PluginNotice.warning("nodes_unreachable", `${offline} Matter device(s) are not answering.`, {
        remedy: "Check they have power and are on the network. Thread devices also need a Thread border router.",
      }));
    }
    if (this.config.matter.allowTestDevices) {
      notices.push(PluginNotice.info("test_devices_allowed", "Test devices are allowed (allow_test_devices): devices with Matter's test certificates can be paired."));
    }
    this.notices.set(notices);
  }

  // ── Commands ───────────────────────────────────────────────────────────────

  onCommand(deviceId: string, payload: Record<string, unknown>): void {
    void this.command(deviceId, payload);
  }

  private async command(deviceId: string, payload: Record<string, unknown>): Promise<void> {
    const d = this.devices.get(deviceId);
    const node = d && this.nodes.get(d.nodeId);
    const client = this.link.client;
    if (!d || !node) return this.log("warn", `command for ${deviceId}, which is not a Matter device here`);
    const plan = commandFor(node, d, payload);
    if (plan.ignored.length) this.log("debug", `${deviceId}: ignoring ${plan.ignored.join(", ")}`);
    if (plan.error) return this.log("warn", `${deviceId}: ${plan.error}`);
    if (!client) return this.log("warn", `${deviceId}: the Matter server is not connected; command dropped`);
    this.causes.set(deviceId, { payload, until: Date.now() + CAUSE_WINDOW_MS });
    try {
      for (const op of plan.ops) await this.send(client, node.node_id, op);
    } catch (e) {
      this.log("warn", `${d.name} (${deviceId}) refused ${JSON.stringify(stripMeta(payload))}: ${(e as Error).message}`);
      // Say again what it is, so nothing shows the change as made.
      this.published.delete(deviceId);
      this.publishChanges(d, node);
    }
  }

  private async send(client: NonNullable<MatterLink["client"]>, nodeId: number | bigint, op: MatterOp): Promise<void> {
    if (op.op === "command") {
      await client.deviceCommand(nodeId, op.endpoint, op.cluster, op.command, op.payload ?? {}, {
        timeout: 30_000,
        ...(op.timedMs ? { timedRequestTimeoutMs: op.timedMs } : {}),
      });
    } else {
      await client.writeAttribute(nodeId, `${op.endpoint}/${op.cluster}/${op.attribute}`, op.value, { timeout: 30_000 });
    }
  }

  // ── Plugin actions ─────────────────────────────────────────────────────────

  async onAction(action: string, params: Record<string, unknown>, ctx: StreamContext | null, caller?: Caller | null): Promise<unknown> {
    if (action === "pair" && ctx) return this.pair(String(params.code ?? ""), ctx, caller);
    if (action === "remove_node") return this.removeNode(String(params.node_id ?? ""), caller);
    return null;
  }

  private async pair(code: string, ctx: StreamContext, caller?: Caller | null): Promise<void> {
    const client = this.link.client;
    if (!client) return ctx.error("The Matter server is not running yet; try again in a moment.");
    const clean = code.trim();
    if (!/^MT:[0-9A-Z.\-]+$/.test(clean) && !/^[0-9]{11}([0-9]{10})?$/.test(clean.replace(/[\s-]/g, ""))) {
      return ctx.error("That is not a Matter setup code: it is the text of the QR code (starting MT:) or 11 or 21 digits.");
    }
    const normalised = clean.startsWith("MT:") ? clean : clean.replace(/[\s-]/g, "");
    this.log("info", `pairing a device for ${caller?.username ?? "someone"}`);
    ctx.progress({ percent: 5, message: "Looking for the device on the network" });
    const before = new Set(this.nodes.keys());
    try {
      const node = await client.commissionWithCode(normalised, true, { timeout: PAIR_TIMEOUT_MS });
      const nodeId = String(node.node_id);
      ctx.progress({ percent: 90, message: "Paired; reading what it is" });
      const data = this.nodes.get(nodeId) ?? nodeDataOf(node);
      const devices = devicesOf(data);
      for (const d of devices) ctx.itemAdd({ id: d.id, name: d.name, type: d.kind });
      ctx.complete({
        node_id: nodeId,
        new: !before.has(nodeId),
        devices: devices.map((d) => ({ id: d.id, name: d.name, type: d.kind })),
      });
    } catch (e) {
      ctx.error(pairingError(e as Error & { reason?: string; errorCode?: number }));
    }
  }

  private async removeNode(nodeIdText: string, caller?: Caller | null): Promise<unknown> {
    const client = this.link.client;
    if (!client) throw new Error("The Matter server is not running yet; try again in a moment.");
    if (!this.nodes.has(nodeIdText)) throw new Error(`No Matter node ${nodeIdText} is paired`);
    this.log("info", `removing Matter node ${nodeIdText} for ${caller?.username ?? "someone"}`);
    await client.removeNode(parseNodeId(nodeIdText));
    return { removed: nodeIdText };
  }
}

function stripMeta(p: Record<string, unknown>): Record<string, unknown> {
  const { _hc, ...rest } = p;
  void _hc;
  return rest;
}

/** What went wrong pairing, in words a person can act on. */
export function pairingError(e: Error & { reason?: string; errorCode?: number }): string {
  const reason = e.reason ?? "";
  if (reason === "attestation-rejected") {
    return "The device's certificate is not one Matter trusts, so it was not paired. A product sold as Matter certified should pass; a devkit or test device needs allow_test_devices.";
  }
  if (/discover|not found|timed? ?out/i.test(`${reason} ${e.message}`)) {
    return "No device with that code answered. Check it is powered, on the same network as homeCore, and in pairing mode (or freshly shared from its app, which gives a new code).";
  }
  if (/passcode|pase|setup code/i.test(e.message)) return "The device did not accept the code. Check it, or share the device again for a new one.";
  return `Pairing failed: ${e.message}`;
}
