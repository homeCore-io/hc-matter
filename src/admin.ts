// Pairing and administering Matter devices: the plugin's actions behind its
// screen (ui/), and what they say about a node.
//
// Everything here works on matter-server's view of a node; the summaries are
// pure (tested in tests/admin.test.ts), the actions are thin calls to it.

import { Action, Concurrency } from "homecore-plugin-sdk";
import { Attr, Cluster } from "./clusters.js";
import { availableOf, devicesOf, nodeIdOf, type NodeData } from "./devices.js";

const PAIR_TIMEOUT_MS = 5 * 60_000;
/** How long a shared device stays open to another app; Matter allows 15 minutes at most. */
export const SHARE_WINDOW_SECS = 15 * 60;

const nodeParam = { node_id: { type: "string", title: "Node", pattern: "^[0-9]+$" } };
const forNode = (extra: Record<string, unknown> = {}, required: string[] = []) => ({
  type: "object",
  required: ["node_id", ...required],
  properties: { ...nodeParam, ...extra },
});

export const ACTIONS = [
  new Action({
    id: "pair",
    label: "Pair a device",
    description: "Pair a Matter device from its setup code: the QR code's text (MT:…) or the 11 or 21 digit code. "
      + "The device must already be on the network: shared from another app (its \"share\" or \"pairing mode\" option), "
      + "or a Wi-Fi or Thread device that has been set up before.",
    params: { type: "object", required: ["code"], properties: { code: { type: "string", title: "Setup code", minLength: 11 } } },
    stream: true,
    concurrency: Concurrency.SINGLE,
    itemKey: "id",
    itemOperations: ["add"],
    timeoutMs: PAIR_TIMEOUT_MS + 30_000,
  }),
  new Action({
    id: "nodes",
    label: "List paired devices",
    description: "Every paired Matter device: what it is, whether it answers, and its homeCore devices.",
  }),
  new Action({
    id: "server_status",
    label: "Matter server status",
    description: "Whether the Matter server is running, its version, and whether Wi-Fi and Thread credentials are set for pairing.",
  }),
  new Action({
    id: "share_node",
    label: "Share a device",
    description: "Open a paired device to another app (Apple Home, Google Home, Alexa, another controller) for 15 minutes, and show the code to pair it there with.",
    params: forNode(),
    timeoutMs: 60_000,
  }),
  new Action({
    id: "fabrics",
    label: "Apps a device is shared with",
    description: "The controllers (fabrics) a device is paired with, this one included.",
    params: forNode(),
    timeoutMs: 30_000,
  }),
  new Action({
    id: "remove_fabric",
    label: "Unshare a device from an app",
    description: "Remove another controller from a device, so that app can no longer reach it. This controller cannot remove itself here; use \"Remove a device\".",
    params: forNode({ fabric_index: { type: "integer", title: "Fabric", minimum: 1, maximum: 254 } }, ["fabric_index"]),
    timeoutMs: 30_000,
  }),
  new Action({
    id: "reinterview",
    label: "Read a device again",
    description: "Ask a device again what it is and what it has, after a firmware update changed it.",
    params: forNode(),
    timeoutMs: 120_000,
  }),
  new Action({
    id: "check_update",
    label: "Check for a firmware update",
    description: "Ask whether a newer firmware is published for a device.",
    params: forNode(),
    timeoutMs: 60_000,
  }),
  new Action({
    id: "update_firmware",
    label: "Update a device's firmware",
    description: "Install a firmware version on a device. The device keeps working while it downloads and restarts at the end.",
    params: forNode({ version: { type: "integer", title: "Software version (its number)" } }, ["version"]),
    timeoutMs: 60_000,
  }),
  new Action({
    id: "remove_node",
    label: "Remove a device",
    description: "Remove a paired Matter device from homeCore and from this controller's fabric. Other apps it is shared with keep it.",
    params: forNode(),
    timeoutMs: 60_000,
  }),
  new Action({
    id: "set_wifi",
    label: "Wi-Fi for pairing",
    description: "The Wi-Fi network a newly paired Wi-Fi device joins. Only needed for a device that is not on the network yet.",
    params: {
      type: "object",
      required: ["ssid", "password"],
      properties: {
        ssid: { type: "string", title: "Network name", minLength: 1, maxLength: 32 },
        password: { type: "string", title: "Password", format: "password", maxLength: 64 },
      },
    },
    timeoutMs: 15_000,
  }),
  new Action({
    id: "set_thread_dataset",
    label: "Thread network for pairing",
    description: "The Thread network's operational dataset (hex, from your border router) that a newly paired Thread device joins.",
    params: {
      type: "object",
      required: ["dataset"],
      properties: { dataset: { type: "string", title: "Active operational dataset (hex)", format: "password", pattern: "^[0-9A-Fa-f]+$" } },
    },
    timeoutMs: 15_000,
  }),
];

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const basic = (node: NodeData, attr: number) => node.attributes[`0/${Cluster.BasicInformation}/${attr}`];

/** OtaSoftwareUpdateRequestor UpdateStateEnum, as words. */
const UPDATE_STATES = ["unknown", "idle", "querying", "delayed_on_query", "downloading", "applying", "delayed_on_apply", "rolling_back", "delayed_on_user_consent"];

export interface NodeSummary {
  node_id: string;
  name: string;
  vendor: string | null;
  product: string | null;
  firmware: string | null;
  serial_number: string | null;
  available: boolean;
  is_bridge: boolean;
  commissioned: string | null;
  update_state: string | null;
  update_percent: number | null;
  devices: { id: string; name: string; type: string; available: boolean }[];
}

/** What the screen lists for one node. */
export function summarize(node: NodeData): NodeSummary {
  const B = Attr.BasicInformation;
  const devices = devicesOf(node);
  // The requestor is on whichever endpoint carries cluster 42, usually 0.
  const otaKey = Object.keys(node.attributes).find((k) => /^\d+\/42\/2$/.test(k));
  const state = otaKey ? node.attributes[otaKey] : undefined;
  const progress = otaKey ? node.attributes[otaKey.replace(/\/2$/, "/3")] : undefined;
  return {
    node_id: nodeIdOf(node),
    name: text(basic(node, B.NodeLabel)) ?? text(basic(node, B.ProductName)) ?? `Matter device ${nodeIdOf(node)}`,
    vendor: text(basic(node, B.VendorName)),
    product: text(basic(node, B.ProductName)),
    firmware: text(basic(node, B.SoftwareVersionString)),
    serial_number: text(basic(node, B.SerialNumber)),
    available: node.available,
    is_bridge: node.is_bridge,
    commissioned: node.date_commissioned ?? null,
    update_state: typeof state === "number" ? (UPDATE_STATES[state] ?? null) : null,
    update_percent: typeof progress === "number" ? progress : null,
    devices: devices.map((d) => ({ id: d.id, name: d.name, type: d.kind, available: availableOf(node, d) })),
  };
}

/** This controller's fabric index on a node (OperationalCredentials CurrentFabricIndex). */
export function ownFabricIndex(node: NodeData): number | null {
  const v = node.attributes["0/62/5"];
  return typeof v === "number" ? v : null;
}

export interface FabricSummary {
  fabric_index: number | null;
  label: string | null;
  vendor_id: number | null;
  vendor: string | null;
  this_controller: boolean;
}

/** matter-server's fabric list, with this controller's marked. */
export function summarizeFabrics(
  fabrics: { fabric_index?: number; fabric_label?: string; vendor_id?: number; vendor_name?: string }[],
  own: number | null,
): FabricSummary[] {
  return fabrics.map((f) => ({
    fabric_index: f.fabric_index ?? null,
    label: text(f.fabric_label),
    vendor_id: f.vendor_id ?? null,
    vendor: text(f.vendor_name) ?? (f.vendor_id !== undefined ? knownVendor(f.vendor_id) : null),
    this_controller: own !== null && f.fabric_index === own,
  }));
}

/** The ecosystems people will recognise in a fabric list. */
function knownVendor(id: number): string | null {
  const names: Record<number, string> = {
    0x1349: "Apple Home", 0x6006: "Google Home", 0x1217: "Amazon Alexa", 0x110a: "Samsung SmartThings",
    0x100b: "Philips Hue", 0x134b: "Home Assistant", 0xfff1: "Test vendor",
  };
  return names[id] ?? null;
}
