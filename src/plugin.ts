// hc-matter: Matter devices in homeCore.
//
// matter-server (a child process) is the Matter controller: it holds the
// fabric, pairs, subscribes to every node and keeps their attributes. This
// plugin turns that into homeCore devices (devices.ts), state and commands.

import { Capabilities, PluginBase, PluginNotice, type Caller, type StreamContext } from "homecore-plugin-sdk";
import type { NodesChangedDetail } from "@matter-server/ws-client";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.js";
import { Cluster } from "./clusters.js";
import { availableOf, buttonPatches, commandFor, devicesOf, devicesTouchedBy, nodeIdOf, stateOf, type Device, type MatterOp, type NodeData } from "./devices.js";
import { MatterLink, nodeDataOf, parseNodeId } from "./link.js";
import { ACTIONS, SHARE_WINDOW_SECS, ownFabricIndex, summarize, summarizeFabrics } from "./admin.js";
import { FIRMWARE_ALERT, FirmwareWatch, firmwareAlert, type FoundUpdate } from "./firmware.js";
import { BRIDGE_ACTIONS, BRIDGE_SCOPES, BridgeService } from "./bridge/service.js";
import { CONFIG_DESCRIPTOR, CONFIG_SCHEMA } from "./settings.js";
import { apply, collect, lastBackup, pack, pieces, recordBackup, sha256, unpack } from "./backup.js";
import { MatterServerProcess, type Log, type LogLevel } from "./server.js";

/** State that follows a command within this long is reported as its result. */
const CAUSE_WINDOW_MS = 5_000;
const PAIR_TIMEOUT_MS = 5 * 60_000;
const LEVEL_RANK: Record<string, number> = { trace: 0, debug: 1, info: 2, warn: 3, error: 4 };


export class MatterPlugin extends PluginBase {
  private readonly nodes = new Map<string, NodeData>();
  private readonly devices = new Map<string, Device>();
  /** What each device last published, to send only what changed. */
  private readonly published = new Map<string, Record<string, unknown>>();
  private readonly availability = new Map<string, boolean>();
  private readonly causes = new Map<string, { payload: Record<string, unknown>; until: number }>();
  private readonly server: MatterServerProcess;
  private link: MatterLink;
  private mqttUp = false;
  private serverProblem: PluginNotice | null = null;
  /** Nodes are known only once the link has listed them; until then reconcile nothing. */
  private synced = false;
  /** Firmware found for a node, by node id, and the device its alert is on. */
  private readonly updates = new Map<string, FoundUpdate>();
  private readonly alertedOn = new Map<string, string>();
  private readonly firmware = new FirmwareWatch(() => this.checkAllFirmware());
  /** homeCore's devices shown to other Matter apps. */
  private readonly bridge: BridgeService;

  constructor(private readonly config: Config, private readonly version: string) {
    super({
      pluginId: config.homecore.pluginId,
      brokerHost: config.homecore.brokerHost,
      brokerPort: config.homecore.brokerPort,
      password: config.homecore.password,
    });
    const log: Log = (level, message) => this.log(level, message);
    this.bridge = new BridgeService(dirname(config.matter.storageDir), config.homecore.pluginId, log, () => this.refreshNotices());
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
    this.link = this.newLink();
  }

  private newLink(): MatterLink {
    return new MatterLink(this.config.matter.socketPath, (level, message) => this.log(level, message), {
      onNodes: (nodes) => this.onNodes(nodes),
      onNodeChanged: (detail, node) => this.onNodeChanged(detail, node),
      onDown: () => this.onLinkDown(),
      onEvent: (e) => this.onMatterEvent(e),
    });
  }

  /** A device's event: a remote's button, as homeCore's remotes report them. */
  private onMatterEvent(e: { node_id: number | bigint; endpoint_id: number; cluster_id: number; event_id: number; data: unknown }): void {
    if (e.cluster_id !== Cluster.Switch || !this.mqttUp) return;
    const nodeId = String(e.node_id);
    for (const d of this.devices.values()) {
      if (d.nodeId !== nodeId || !d.buttons?.includes(e.endpoint_id)) continue;
      for (const patch of buttonPatches(d, e.endpoint_id, e.event_id, e.data)) this.publishStatePartial(d.id, patch);
      return;
    }
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
    // Its screen (ui/): where a runtime unpacked it, else the built folder
    // beside the source.
    const ui = process.env.HC_PLUGIN_UI_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "..", "ui", "dist");
    if (existsSync(join(ui, "manifest.json"))) this.withUiDir(ui, this.version);
    this.enableDevicePersistence(`${this.config.matter.storageDir}/../.published-device-ids.json`);
    this.server.start();
    this.run();
    this.bridge.start().catch((e) => this.log("error", `bridge: could not start: ${(e as Error).message}`));
  }

  onConnect(): void {
    this.mqttUp = true;
    this.enableManagement({ version: this.version, configPath: this.config.path, capabilities: new Capabilities([...ACTIONS, ...BRIDGE_ACTIONS], {
      alertKinds: [FIRMWARE_ALERT],
      // The bridge reads homeCore's devices and commands them for other apps.
      apiScopes: BRIDGE_SCOPES,
      // The settings form; homeCore writes what it saves to its own copy of
      // the config, and the runtime restarts the plugin on it.
      configSchema: CONFIG_SCHEMA,
      configDescriptor: CONFIG_DESCRIPTOR,
    }) });
    this.publishPluginStatus("active");
    // A reconnect: say every device again (core may have restarted).
    for (const d of this.devices.values()) this.announce(d, true);
    // The node list may have arrived before the broker connection: what
    // onNodes skipped without MQTT happens now.
    if (this.synced) {
      this.reconcileDevices(new Set(this.devices.keys()));
      for (const id of this.updates.keys()) this.refreshFirmwareAlert(id);
    }
    this.refreshNotices();
  }

  onApiAccess(url: string, key: string): void {
    this.bridge.setAccess(url, key);
  }

  async onStop(): Promise<void> {
    this.firmware.stop();
    this.link.close();
    // Together: the SDK gives this a second in all.
    await Promise.all([this.bridge.stop().catch(() => {}), this.server.stop()]);
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
    if (this.config.matter.firmwareUpdates) this.firmware.start();
    for (const id of this.updates.keys()) this.refreshFirmwareAlert(id);
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
      this.updates.delete(nodeId);
      this.refreshFirmwareAlert(nodeId);
      for (const [id, d] of [...this.devices]) if (d.nodeId === nodeId) this.forget(id);
      this.log("info", `Matter node ${nodeId} was removed`);
      this.refreshNotices();
      return;
    }
    this.nodes.set(nodeId, node);
    if (detail.reason === "attribute_updated") {
      const mine = [...this.devices.values()].filter((d) => d.nodeId === nodeId);
      // A changed descriptor means the node's shape changed (a bridge added a device).
      // Its software version changed: an update was installed.
      if (detail.attributeKey === "0/40/9") this.refreshFirmwareAlert(nodeId);
      // Its shape changed: a bridge added a device (Descriptor), or what it is
      // called, can do (FeatureMap) or ranges over (colour limits).
      if (/^\d+\/29\/|\/65532$|^0\/40\/5$|^\d+\/57\/5$|^\d+\/768\/1639[56]$/.test(detail.attributeKey)) {
        this.syncNode(node);
        return;
      }
      for (const d of devicesTouchedBy(node, mine, detail.attributeKey)) this.publishChanges(d, node);
      return;
    }
    // node_added, node_updated (an interview, availability): its whole shape.
    this.syncNode(node);
    this.refreshFirmwareAlert(nodeId);
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
    const last = lastBackup(this.dataDir);
    const newest = [...this.nodes.values()].map((n) => n.date_commissioned ?? "").sort().pop() ?? "";
    if (this.nodes.size > 0 && (!last || (newest && newest > last))) {
      notices.push(PluginNotice.info("not_backed_up", last
        ? "Some Matter pairings are newer than the last backup."
        : "The Matter pairings have never been backed up.", {
        remedy: "Use \"Back up the pairings\" on the Matter page and keep the file. Without it, losing the runtime's data means pairing every device again.",
      }));
    }
    if (this.bridge?.problem) {
      notices.push(PluginNotice.error("bridge_failing", this.bridge.problem, {
        remedy: "Check the plugin's log. Port 5541 must be free on the runtime's host; turning the bridge off and on again retries.",
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
      // Say again what it is, so nothing shows the change as made; and the
      // state that follows is not this command's doing.
      this.causes.delete(deviceId);
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
    if (action === "backup" && ctx) return this.backup(ctx, caller);
    if (action === "restore_backup") return this.restore(String(params.file_path ?? ""), caller);
    if (action === "remove_node") return this.removeNode(String(params.node_id ?? ""), caller);
    if (action === "nodes") return { nodes: [...this.nodes.values()].map(summarize) };
    const bridged = await this.bridge.action(action, params, caller?.username ?? "someone");
    if (bridged !== undefined) return bridged;
    if (action === "server_status") return this.serverStatus();
    const who = caller?.username ?? "someone";
    if (action === "share_node") {
      const { client, nodeId, text } = this.target(params);
      this.log("info", `sharing Matter node ${text} for ${who}`);
      const p = await client.openCommissioningWindow(nodeId, SHARE_WINDOW_SECS);
      return {
        manual_code: p.setup_manual_code,
        qr_code: p.setup_qr_code,
        expires_in_secs: p.commissioning_timeout ?? SHARE_WINDOW_SECS,
      };
    }
    if (action === "fabrics") {
      const { client, nodeId, node } = this.target(params);
      return { fabrics: summarizeFabrics(await client.getMatterFabrics(nodeId), ownFabricIndex(node)) };
    }
    if (action === "remove_fabric") {
      const { client, nodeId, node, text } = this.target(params);
      const index = Number(params.fabric_index);
      if (!Number.isInteger(index)) throw new Error("fabric_index is required");
      const own = ownFabricIndex(node);
      if (own === null) throw new Error("This device hasn't said which of its controllers is homeCore yet, so nothing is removed. Read it again and retry.");
      if (index === own) throw new Error("That is this controller. To take the device out of homeCore, remove the device.");
      this.log("info", `removing fabric ${index} from Matter node ${text} for ${who}`);
      await client.removeMatterFabric(nodeId, index);
      return { removed: index };
    }
    if (action === "reinterview") {
      const { client, nodeId, text } = this.target(params);
      this.log("info", `re-interviewing Matter node ${text} for ${who}`);
      await client.interviewNode(nodeId);
      return { node_id: text };
    }
    if ((action === "check_update" || action === "update_firmware") && !this.config.matter.firmwareUpdates) {
      throw new Error("Firmware updates are turned off in this plugin's settings (firmware_updates = false).");
    }
    if (action === "check_update") {
      const { client, nodeId } = this.target(params);
      const v = await client.checkNodeUpdate(nodeId);
      this.recordUpdate(String(nodeId), v);
      return v
        ? { available: true, version: v.software_version, version_string: v.software_version_string, release_notes_url: v.release_notes_url ?? null }
        : { available: false };
    }
    if (action === "update_firmware") {
      const { client, nodeId, text } = this.target(params);
      const version = Number(params.version);
      if (!Number.isInteger(version)) throw new Error("version is required");
      this.log("info", `updating Matter node ${text} to firmware ${version} for ${who}`);
      await client.updateNode(nodeId, version);
      return { node_id: text, version };
    }
    if (action === "set_wifi") {
      const client = this.requireClient();
      const ssid = String(params.ssid ?? "");
      if (!ssid) throw new Error("ssid is required");
      await client.setWifiCredentials(ssid, String(params.password ?? ""));
      this.log("info", `Wi-Fi credentials for pairing set by ${who}`);
      return { wifi_credentials_set: true };
    }
    if (action === "set_thread_dataset") {
      const client = this.requireClient();
      const dataset = String(params.dataset ?? "").trim();
      if (!/^[0-9A-Fa-f]+$/.test(dataset) || dataset.length % 2) throw new Error("the dataset is hex, an even number of digits");
      await client.setThreadOperationalDataset(dataset);
      this.log("info", `Thread dataset for pairing set by ${who}`);
      return { thread_credentials_set: true };
    }
    return null;
  }

  /** Ask about every node that answers, one at a time. */
  private async checkAllFirmware(): Promise<void> {
    const client = this.link.client;
    if (!client || !this.config.matter.firmwareUpdates) return;
    let found = 0;
    for (const [nodeId, node] of [...this.nodes]) {
      if (!node.available) continue;
      try {
        const v = await client.checkNodeUpdate(parseNodeId(nodeId));
        this.recordUpdate(nodeId, v);
        if (v) found += 1;
      } catch (e) {
        this.log("debug", `firmware check for Matter node ${nodeId} failed: ${(e as Error).message}`);
      }
    }
    this.log("info", `firmware checked for ${this.nodes.size} Matter node(s); ${found} with an update`);
  }

  private recordUpdate(nodeId: string, v: { software_version: number; software_version_string: string } | null): void {
    if (v) this.updates.set(nodeId, { version: v.software_version, version_string: v.software_version_string });
    else this.updates.delete(nodeId);
    this.refreshFirmwareAlert(nodeId);
  }

  /** Say what is known about a node's firmware: on its first device, or nowhere. */
  private refreshFirmwareAlert(nodeId: string): void {
    if (!this.mqttUp) return;
    const node = this.nodes.get(nodeId);
    const said = node ? firmwareAlert(node, this.updates.get(nodeId) ?? null) : null;
    if (!said) this.updates.delete(nodeId);
    const before = this.alertedOn.get(nodeId);
    if (before && before !== said?.deviceId) this.setAlerts(before, []);
    if (said) {
      this.setAlerts(said.deviceId, [said.alert]);
      this.alertedOn.set(nodeId, said.deviceId);
    } else {
      this.alertedOn.delete(nodeId);
    }
  }

  /** The data folder: beside the plugin's installed versions. */
  private get dataDir(): string {
    return dirname(this.config.matter.storageDir);
  }

  /** Pause Matter (the controller and the bridge), for a consistent copy of their storage. */
  private async pauseMatter(): Promise<boolean> {
    this.link.close();
    const [stopped] = await Promise.all([this.server.stop(15_000), this.bridge.pause()]);
    return stopped;
  }

  private resumeMatter(): void {
    this.link = this.newLink();
    this.server.resume();
    this.bridge.resume().catch((e) => this.log("error", `bridge: could not start again: ${(e as Error).message}`));
  }

  private async backup(ctx: StreamContext, caller?: Caller | null): Promise<void> {
    ctx.progress({ percent: 5, message: "Pausing Matter for a moment" });
    let file: Buffer;
    try {
      if (!(await this.pauseMatter())) {
        return ctx.error("The Matter server didn't pause in time, so no backup was made. Try again.");
      }
      ctx.progress({ percent: 25, message: "Copying the pairings" });
      file = pack(collect(this.dataDir), this.version);
    } finally {
      this.resumeMatter();
    }
    recordBackup(this.dataDir);
    this.refreshNotices();
    const parts = pieces(file);
    parts.forEach((piece, i) => ctx.progress({
      percent: 30 + Math.round((70 * (i + 1)) / parts.length),
      message: "Sending the backup",
      data: { piece, index: i, of: parts.length },
    }));
    const name = `hc-matter-backup-${new Date().toISOString().slice(0, 10)}.json.gz`;
    this.log("info", `backup of the Matter pairings made for ${caller?.username ?? "someone"} (${file.length} bytes)`);
    ctx.complete({ name, size: file.length, sha256: sha256(file), pieces: parts.length });
  }

  private async restore(filePath: string, caller?: Caller | null): Promise<Record<string, unknown>> {
    if (!filePath) throw new Error("Send the backup file with this action (an upload).");
    const { readFileSync } = await import("node:fs");
    const { backup, files } = unpack(readFileSync(filePath));
    if (!(await this.pauseMatter())) {
      this.resumeMatter();
      throw new Error("The Matter server didn't pause in time, so nothing was restored. Try again.");
    }
    const aside = apply(this.dataDir, files);
    this.log("warn", `Matter pairings restored from a backup of ${backup.created} by ${caller?.username ?? "someone"}; the previous ones are in ${aside}. Restarting.`);
    // Start afresh on what was restored: the runtime starts the plugin again.
    setTimeout(() => process.exit(0), 1500).unref();
    return { restored: backup.created, files: Object.keys(files).length, previous_kept_in: aside };
  }

  private requireClient(): NonNullable<MatterLink["client"]> {
    const client = this.link.client;
    if (!client) throw new Error("The Matter server is not running yet; try again in a moment.");
    return client;
  }

  /** The client and the node an admin action names. */
  private target(params: Record<string, unknown>) {
    const client = this.requireClient();
    const text = String(params.node_id ?? "");
    const node = this.nodes.get(text);
    if (!node) throw new Error(`No Matter node ${text} is paired`);
    return { client, node, text, nodeId: parseNodeId(text) };
  }

  private serverStatus(): Record<string, unknown> {
    const client = this.link.client;
    if (!client) return { connected: false, problem: this.serverProblem ? "failing" : "starting" };
    const i = client.serverInfo;
    return {
      connected: true,
      version: i.sdk_version,
      schema_version: i.schema_version,
      fabric_id: String(i.compressed_fabric_id),
      wifi_credentials_set: i.wifi_credentials_set,
      thread_credentials_set: i.thread_credentials_set,
      bluetooth: i.bluetooth_enabled,
      allow_test_devices: this.config.matter.allowTestDevices,
      nodes: this.nodes.size,
    };
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
    const client = this.requireClient();
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
