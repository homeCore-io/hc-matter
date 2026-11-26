import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { devicesOf, type NodeData } from "../src/devices.js";
import { FIRMWARE_ALERT, FirmwareWatch, firmwareAlert, runningVersion } from "../src/firmware.js";

const fixture = (): NodeData => JSON.parse(readFileSync(new URL("./fixtures/standin-node.json", import.meta.url), "utf8"));
const json = (v: unknown) => JSON.parse(JSON.stringify(v));

describe("a firmware update, as an alert", () => {
  it("is news, off until someone turns it on", () => {
    expect(json(FIRMWARE_ALERT)).toMatchObject({ topic: "firmware_update", severity: "info", default_on: false });
  });

  it("goes on the node's first device, names the node, and its button installs that version", () => {
    const node = fixture();
    expect(runningVersion(node)).toBe(0);
    const said = firmwareAlert(node, { version: 3, version_string: "1.3.0" })!;
    expect(said.deviceId).toBe(devicesOf(node)[0].id);
    expect(json(said.alert)).toMatchObject({
      topic: "firmware_update",
      key: "1:3",
      message: "Stand-in bridge: firmware 1.3.0 is available",
      action: { label: "Update…", id: "update_firmware", target: "plugin", params: { node_id: "1", version: 3 }, confirm: true },
    });
  });

  it("says nothing when there is no update, or the node already runs it", () => {
    const node = fixture();
    expect(firmwareAlert(node, null)).toBeNull();
    node.attributes["0/40/9"] = 3;
    expect(firmwareAlert(node, { version: 3, version_string: "1.3.0" })).toBeNull();
  });
});

describe("the watch", () => {
  it("checks soon after starting, then on its interval, and never two at once", async () => {
    let calls = 0;
    let busy = 0;
    let overlapped = false;
    const watch = new FirmwareWatch(async () => {
      calls += 1;
      busy += 1;
      if (busy > 1) overlapped = true;
      await new Promise((r) => setTimeout(r, 5));
      busy -= 1;
    }, 5, 15);
    watch.start();
    watch.start();
    await new Promise((r) => setTimeout(r, 70));
    watch.stop();
    const seen = calls;
    await new Promise((r) => setTimeout(r, 40));
    expect(seen).toBeGreaterThanOrEqual(3);
    expect(calls).toBe(seen);
    expect(overlapped).toBe(false);
  });
});

describe("a check that throws", () => {
  it("does not stop the watch", async () => {
    let calls = 0;
    const watch = new FirmwareWatch(async () => {
      calls += 1;
      throw new Error("the ledger is down");
    }, 5, 10);
    watch.start();
    await new Promise((r) => setTimeout(r, 40));
    watch.stop();
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});
