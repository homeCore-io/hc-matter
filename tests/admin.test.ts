import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ACTIONS, ownFabricIndex, summarize, summarizeFabrics } from "../src/admin.js";
import type { NodeData } from "../src/devices.js";

const fixture = (): NodeData => JSON.parse(readFileSync(new URL("./fixtures/standin-node.json", import.meta.url), "utf8"));

describe("a node, as the screen lists it", () => {
  it("says what it is, whether it answers, and its devices", () => {
    const s = summarize(fixture());
    expect(s).toMatchObject({
      node_id: "1", name: "Stand-in bridge", vendor: "homeCore stand-in", product: "Stand-in bridge",
      serial_number: "standin-0001", available: true, is_bridge: true, update_state: null,
    });
    expect(s.devices).toHaveLength(12);
    expect(s.devices[0]).toMatchObject({ name: "Desk Lamp", type: "light", available: true });
  });

  it("shows a firmware update in progress", () => {
    const n = fixture();
    n.attributes["0/42/2"] = 4;
    n.attributes["0/42/3"] = 37;
    expect(summarize(n)).toMatchObject({ update_state: "downloading", update_percent: 37 });
  });
});

describe("fabrics", () => {
  it("marks this controller's, and names the ecosystems people know", () => {
    const own = ownFabricIndex(fixture());
    expect(own).toBe(1);
    expect(summarizeFabrics([
      { fabric_index: 1, fabric_label: "homeCore", vendor_id: 0xfff1 },
      { fabric_index: 2, vendor_id: 0x1349 },
      { fabric_index: 3, vendor_id: 0x6006, vendor_name: "Google LLC" },
    ], own)).toEqual([
      { fabric_index: 1, label: "homeCore", vendor_id: 0xfff1, vendor: "Test vendor", this_controller: true },
      { fabric_index: 2, label: null, vendor_id: 0x1349, vendor: "Apple Home", this_controller: false },
      { fabric_index: 3, label: null, vendor_id: 0x6006, vendor: "Google LLC", this_controller: false },
    ]);
  });
});

describe("the actions", () => {
  it("give every slow one longer than core's 5-second default", () => {
    const slow = ["share_node", "fabrics", "remove_fabric", "reinterview", "check_update", "update_firmware", "remove_node", "pair"];
    for (const a of ACTIONS as unknown as { id: string; timeoutMs: number | null }[]) {
      if (slow.includes(a.id)) expect(a.timeoutMs, a.id).toBeGreaterThan(5_000);
    }
  });

  it("mask secrets in their forms", () => {
    const params = (id: string) => (ACTIONS as unknown as { id: string; params: { properties: Record<string, { format?: string }> } }[])
      .find((a) => a.id === id)!.params.properties;
    expect(params("set_wifi").password.format).toBe("password");
    expect(params("set_thread_dataset").dataset.format).toBe("password");
  });
});

describe("who may", () => {
  it("leaves pairing, unpairing, sharing, firmware and network secrets to admins", async () => {
    const { BRIDGE_ACTIONS } = await import("../src/bridge/service.js");
    const all = [...ACTIONS, ...BRIDGE_ACTIONS] as unknown as { id: string; requiresRole: string }[];
    const admin = ["pair", "share_node", "remove_fabric", "reinterview", "update_firmware", "remove_node", "set_wifi",
      "set_thread_dataset", "bridge_status", "bridge_enable", "bridge_share", "bridge_reset", "backup", "restore_backup"];
    for (const a of all) expect(a.requiresRole, a.id).toBe(admin.includes(a.id) ? "admin" : "user");
  });
});
