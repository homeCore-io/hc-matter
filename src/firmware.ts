// Firmware updates, as alerts.
//
// matter-server checks the CSA's ledger for newer firmware itself, but installs
// nothing without consent (update_firmware gives it) and says nothing when it
// finds one. So the plugin asks, for each paired device, soon after it starts
// and then twice a day, and says what it found as a `firmware_update` alert on
// the node's first homeCore device, with a button that installs it. The kind
// is off until someone turns it on: news, not a problem.

import { AlertAction, AlertActionTarget, AlertSeverity, PluginAlert, PluginAlertKind } from "homecore-plugin-sdk";
import { Attr, Cluster } from "./clusters.js";
import { devicesOf, nodeIdOf, type NodeData } from "./devices.js";

export const FIRMWARE_ALERT = new PluginAlertKind("firmware_update", "Firmware update available", {
  description: "A newer firmware is published for a Matter device. Its button installs it.",
  severity: AlertSeverity.INFO,
  defaultOn: false,
});

export const FIRST_CHECK_MS = 10 * 60_000;
export const CHECK_EVERY_MS = 12 * 60 * 60_000;

export interface FoundUpdate {
  version: number;
  version_string: string;
}

const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** The node's name, as the plugin's page shows it. */
function nodeName(node: NodeData): string {
  const at = (a: number) => text(node.attributes[`0/${Cluster.BasicInformation}/${a}`]);
  return at(Attr.BasicInformation.NodeLabel) ?? at(Attr.BasicInformation.ProductName) ?? `Matter device ${nodeIdOf(node)}`;
}

/** The software version the node runs now (BasicInformation SoftwareVersion), if it says. */
export function runningVersion(node: NodeData): number | null {
  const v = node.attributes[`0/${Cluster.BasicInformation}/9`];
  return typeof v === "number" ? v : null;
}

/**
 * Where a node's alert goes and what it says, or null when there is nothing
 * to say: no update, the node already runs it, or the node has no device.
 */
export function firmwareAlert(node: NodeData, found: FoundUpdate | null): { deviceId: string; alert: PluginAlert } | null {
  if (!found) return null;
  const running = runningVersion(node);
  if (running !== null && running >= found.version) return null;
  const device = devicesOf(node)[0];
  if (!device) return null;
  const nodeId = nodeIdOf(node);
  const name = nodeName(node);
  return {
    deviceId: device.id,
    alert: new PluginAlert("firmware_update", `Firmware ${found.version_string} is available`, {
      // "Skip this one" skips this version, not every update.
      key: `${nodeId}:${found.version}`,
      message: `${name}: firmware ${found.version_string} is available`,
      action: new AlertAction("Update…", "update_firmware", {
        target: AlertActionTarget.PLUGIN,
        params: { node_id: nodeId, version: found.version },
        confirm: true,
      }),
    }),
  };
}

/** Ask for each node in turn, on a timer. */
export class FirmwareWatch {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  constructor(
    private readonly check: () => Promise<void>,
    private readonly firstMs = FIRST_CHECK_MS,
    private readonly everyMs = CHECK_EVERY_MS,
  ) {}

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setTimeout(() => this.tick(), this.firstMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (!this.running) {
      this.running = true;
      try {
        await this.check();
      } catch {
        // Nothing is listening for this promise; a check that throws must not
        // end the process. The next one tries again.
      } finally {
        this.running = false;
      }
    }
    // Stopped while that check ran: schedule nothing more.
    if (this.stopped) return;
    this.timer = setTimeout(() => this.tick(), this.everyMs);
    this.timer.unref?.();
  }
}
