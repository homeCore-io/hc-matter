#!/usr/bin/env node
// End to end, as homeCore drives it: the stand-in, the plugin (built, out/),
// and a broker. Pairs the stand-in through the plugin's pair action, then
// commands a device and presses buttons on the stand-in, and checks what the
// plugin publishes.
//
//   BROKER_HOST=127.0.0.1 BROKER_PORT=1883 node tests/e2e/pair.mjs
//
// mDNS goes out on every interface: run it only where that reaches nothing
// real (a CI runner, the hc-matter-lab Docker network). Never on a house LAN.

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const mqtt = createRequire(join(root, "node_modules", "homecore-plugin-sdk", "index.js"))("mqtt");
const host = process.env.BROKER_HOST ?? "127.0.0.1";
const port = Number(process.env.BROKER_PORT ?? 1883);
const work = mkdtempSync(join(tmpdir(), "hcm-e2e-"));
const children = [];
let failed = false;

const say = (m) => console.log(`e2e: ${m}`);
const fail = (m) => {
  console.error(`e2e: FAIL ${m}`);
  failed = true;
  finish();
};
function finish() {
  for (const c of children) c.kill("SIGTERM");
  setTimeout(() => process.exit(failed ? 1 : 0), 1500);
}
setTimeout(() => fail("took longer than 4 minutes"), 240_000).unref();

// ── The broker, and what the plugin publishes ────────────────────────────────
const client = mqtt.connect({ host, port, clientId: `e2e-${process.pid}` });
const seen = [];
const waiters = [];
/** Each device's state as homeCore would hold it: the full state, then each partial merged in. */
const states = new Map();
client.on("message", (topic, payload) => {
  let body = payload.toString();
  try {
    body = JSON.parse(body);
  } catch {
    // plain text (status, availability)
  }
  const m = /^homecore\/devices\/([^/]+)\/state(\/partial)?$/.exec(topic);
  if (m && body && typeof body === "object") {
    states.set(m[1], m[2] ? { ...(states.get(m[1]) ?? {}), ...body } : { ...body });
    body = { ...body, _merged: states.get(m[1]) };
  }
  seen.push({ topic, body });
  for (const w of [...waiters]) if (w.test(topic, body)) {
    waiters.splice(waiters.indexOf(w), 1);
    w.resolve({ topic, body });
  }
});
function waitFor(what, test, ms = 60_000) {
  const hit = seen.find((m) => test(m.topic, m.body));
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    const w = { test, resolve };
    waiters.push(w);
    setTimeout(() => reject(new Error(`no ${what} within ${ms / 1000}s`)), ms).unref();
  });
}
await new Promise((resolve, reject) => {
  client.once("connect", resolve);
  client.once("error", reject);
});
client.subscribe("homecore/#");
say(`broker at ${host}:${port}`);

// ── The stand-in and the plugin ──────────────────────────────────────────────
const node = process.execPath;
const standin = spawn(node, [join(root, "standin", "standin.mjs"), "--storage", join(work, "standin")], { stdio: ["pipe", "pipe", "pipe"] });
children.push(standin);
let code = null;
standin.stdout.on("data", (d) => {
  const m = /manual code (\d+)/.exec(String(d));
  if (m) code = m[1];
});
const press = (line) => standin.stdin.write(`${JSON.stringify(line)}\n`);

writeFileSync(join(work, "config.toml"), `[homecore]
broker_host = "${host}"
broker_port = ${port}
plugin_id = "plugin.matter"

[matter]
allow_test_devices = true
dcl_offline = true
thread_diagnostics = false
firmware_updates = false
`);
const plugin = spawn(node, [join(root, "out", "main.js"), join(work, "config.toml")], { stdio: ["ignore", "pipe", "pipe"] });
children.push(plugin);
const log = [];
for (const s of [plugin.stdout, plugin.stderr]) s.on("data", (d) => log.push(...String(d).split("\n").filter(Boolean)));
plugin.on("exit", (c) => {
  if (!failed && c !== null && c !== 0) {
    console.error(log.slice(-30).join("\n"));
    fail(`the plugin exited (${c})`);
  }
});

try {
  await waitFor("plugin status active", (t, b) => t === "homecore/plugins/plugin.matter/status" && b === "active");
  // Wait for the stand-in's code and the plugin's Matter server to answer.
  for (let i = 0; i < 60 && !code; i++) await new Promise((r) => setTimeout(r, 500));
  if (!code) throw new Error("the stand-in never printed its code");
  await waitFor("the Matter server connected", () => log.some((l) => /connected to matter-server/.test(l)));
  say("plugin up, Matter server connected");

  // ── Pair, through the plugin's action ───────────────────────────────────────
  const rid = `e2e-${Date.now()}`;
  client.publish("homecore/plugins/plugin.matter/manage/cmd", JSON.stringify({ action: "pair", request_id: rid, code }));
  const done = await waitFor("pairing to finish", (t, b) => t.includes(`/commands/${rid}/`) && ["complete", "error"].includes(b?.stage), 120_000);
  if (done.body.stage !== "complete") throw new Error(`pairing failed: ${done.body.message}`);
  const devices = done.body.data.devices;
  say(`paired: ${devices.length} devices`);
  if (devices.length < 14) throw new Error(`expected the stand-in's 14 devices, got ${devices.length}`);
  const id = (name) => {
    const d = devices.find((x) => x.name === name);
    if (!d) throw new Error(`no device named ${name}`);
    return d.id;
  };

  // ── A command, and the state that comes back ────────────────────────────────
  const lamp = id("Desk Lamp");
  client.publish(`homecore/devices/${lamp}/cmd`, JSON.stringify({ on: true, brightness_pct: 50 }));
  await waitFor("the lamp on at 50 %", (t, b) => t.startsWith(`homecore/devices/${lamp}/state`) && b?._merged?.on === true && b?._merged?.brightness_pct === 50);
  say("the lamp turned on at 50 %");

  // ── A button pressed on the device ──────────────────────────────────────────
  const remote = id("Bedside Button");
  press({ device: "remote", press: "short" });
  await waitFor("the remote's press", (t, b) => t === `homecore/devices/${remote}/state/partial` && b?.pushed === 1);
  say("the remote's press reached homeCore's names");

  // ── An alarm ───────────────────────────────────────────────────────────────
  const alarm = id("Hallway Alarm");
  press({ device: "alarm", co: 2 });
  await waitFor("carbon monoxide", (t, b) => t.startsWith(`homecore/devices/${alarm}/state`) && b?._merged?.co_detected === true);
  say("the alarm's CO reached homeCore's co_detected");

  say("PASS");
  finish();
} catch (e) {
  console.error(log.slice(-30).join("\n"));
  fail(e.message);
}
