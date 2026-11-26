import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { CONFIG_DESCRIPTOR, CONFIG_SCHEMA, NOT_IN_FORM } from "../src/settings.js";

const formKeys = CONFIG_DESCRIPTOR.sections.flatMap((s) => s.fields.map((f) => f.key.replace(/^matter\./, "")));
// Every [matter] key config.ts reads, from its own source: m.<key>.
const readKeys = [...readFileSync(new URL("../src/config.ts", import.meta.url), "utf8").matchAll(/\bm\.([a-z_]+)/g)].map((x) => x[1]);

describe("the settings form", () => {
  it("covers every setting the plugin reads, or says why not", () => {
    const missing = [...new Set(readKeys)].filter((k) => !formKeys.includes(k) && !(k in NOT_IN_FORM));
    expect(missing).toEqual([]);
    expect(new Set(readKeys).size).toBeGreaterThanOrEqual(8);
  });

  it("names only settings that exist, with the plugin's own defaults", () => {
    const defaults = parseConfig("[homecore]\n", "/x/config.toml").matter;
    const props = CONFIG_SCHEMA.properties.matter.properties as Record<string, { default: unknown }>;
    for (const k of formKeys) expect(props[k], k).toBeDefined();
    expect(props.fabric_label.default).toBe(defaults.fabricLabel);
    expect(props.firmware_updates.default).toBe(defaults.firmwareUpdates);
    expect(props.thread_diagnostics.default).toBe(defaults.threadDiagnostics);
    expect(props.allow_test_devices.default).toBe(defaults.allowTestDevices);
    expect(props.dcl_offline.default).toBe(defaults.dclOffline);
    expect(props.log_level.default).toBe(defaults.serverLogLevel);
  });
});
