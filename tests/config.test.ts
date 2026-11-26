import { describe, expect, it } from "vitest";
import { dataDirFor, parseConfig, socketPathFor } from "../src/config.js";
import { parseLine, serverArgs } from "../src/server.js";
import { pairingError } from "../src/plugin.js";

const runtimePath = "/var/lib/hc-runtime/plugins/plugin.matter/0.2.0/config.toml";
const HC = `[homecore]\nbroker_host = "127.0.0.1"\nbroker_port = 21883\nplugin_id = "plugin.matter"\npassword = "x"\n`;

describe("config", () => {
  it("keeps the fabric beside the installed versions under a runtime, so upgrades keep it", () => {
    expect(dataDirFor(runtimePath, "plugin.matter")).toBe("/var/lib/hc-runtime/plugins/plugin.matter/data");
    const c = parseConfig(HC, runtimePath);
    expect(c.matter.storageDir).toBe("/var/lib/hc-runtime/plugins/plugin.matter/data/matter-server");
    expect(c.matter.socketPath).toBe("/var/lib/hc-runtime/plugins/plugin.matter/data/matter-server.sock");
  });

  it("uses data/ beside the config when run by hand", () => {
    expect(dataDirFor("/home/me/hc-matter/config.toml", "plugin.matter")).toBe("/home/me/hc-matter/data");
  });

  it("falls back to a short socket path when the data dir is too deep for one", () => {
    const deep = `/${"d".repeat(120)}`;
    expect(socketPathFor(deep).length).toBeLessThan(100);
  });

  it("defaults to what a house wants: production certificates only, Thread diagnostics and updates on", () => {
    const m = parseConfig(HC, runtimePath).matter;
    expect(m).toMatchObject({ allowTestDevices: false, dclOffline: false, threadDiagnostics: true, firmwareUpdates: true, fabricLabel: "homeCore" });
  });

  it("reads [matter] and refuses what it cannot use", () => {
    const m = parseConfig(`${HC}[matter]\nallow_test_devices = true\nlog_level = "debug"\nstorage_dir = "/srv/matter"\n`, runtimePath).matter;
    expect(m).toMatchObject({ allowTestDevices: true, serverLogLevel: "debug", storageDir: "/srv/matter", socketPath: "/srv/matter-server.sock" });
    expect(() => parseConfig(`${HC}[matter]\nlog_level = "loud"\n`, runtimePath)).toThrow(/log_level/);
    expect(() => parseConfig(`${HC}[matter]\nallow_test_devices = "yes"\n`, runtimePath)).toThrow(/true or false/);
    expect(() => parseConfig(`${HC}[matter]\nfabric_label = "${"x".repeat(33)}"\n`, runtimePath)).toThrow(/32 bytes/);
  });
});

describe("matter-server", () => {
  it("listens on its socket only, with no dashboard, and passes each setting", () => {
    const m = parseConfig(`${HC}[matter]\nallow_test_devices = true\ndcl_offline = true\nthread_diagnostics = false\nfirmware_updates = false\nprimary_interface = "eth0"\n`, runtimePath).matter;
    const args = serverArgs(m, m.socketPath);
    expect(args).toEqual(expect.arrayContaining(["--listen-address", m.socketPath, "--disable-dashboard", "--enable-test-net-dcl",
      "--dcl-offline", "--disable-thread-diagnostics", "--disable-ota", "--primary-interface", "eth0"]));
    expect(args).not.toContain("--port");
    const plain = serverArgs(parseConfig(HC, runtimePath).matter, "/s.sock");
    expect(plain).not.toContain("--enable-test-net-dcl");
    expect(plain).not.toContain("--disable-ota");
  });

  it("reads its log lines' levels, and keeps continuation lines at the last one", () => {
    expect(parseLine("2026-11-26 14:54:50.482 NOTICE WebServer Webserver listening on unix socket /s", "info"))
      .toEqual({ level: "info", message: "WebServer Webserver listening on unix socket /s" });
    expect(parseLine("2026-11-26 14:53:30.397 FATAL Unhandled Unhandled error detected", "info").level).toBe("error");
    expect(parseLine("  Cause #0: [behavior-initialization] ...", "error")).toEqual({ level: "error", message: "  Cause #0: [behavior-initialization] ..." });
  });
});

describe("pairing errors", () => {
  it("says what to do about an untrusted certificate and a device that never answered", () => {
    expect(pairingError(Object.assign(new Error("x"), { reason: "attestation-rejected" }))).toMatch(/allow_test_devices/);
    expect(pairingError(new Error("Discovery timed out"))).toMatch(/No device with that code answered/);
  });
});
