// The bundled matter-server, run as a child process.
//
// hc-matter ships the pinned matter-server package and starts it on the Node
// it runs on itself, listening on a unix socket only, so nothing else on the
// host can reach its WebSocket API (which can pair and remove devices). It is
// restarted with backoff when it exits; its log lines become the plugin's.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import type { MatterSettings } from "./config.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Where the matter-server package is: beside this plugin's own node_modules. */
export function serverEntry(): string {
  // out/server.js → the package root holds node_modules.
  return join(HERE, "..", "node_modules", "matter-server", "dist", "esm", "bin.js");
}

/** The launcher that stops the server when the plugin goes (launch-server.ts). */
const LAUNCHER = join(HERE, "launch-server.js");

/** The command line, from the settings. Exported for its test. */
export function serverArgs(s: MatterSettings, socket: string): string[] {
  const args = [
    "--storage-path", s.storageDir,
    "--listen-address", socket,
    "--disable-dashboard",
    "--log-level", s.serverLogLevel,
    "--default-fabric-label", s.fabricLabel,
  ];
  if (s.primaryInterface) args.push("--primary-interface", s.primaryInterface);
  if (s.allowTestDevices) args.push("--enable-test-net-dcl");
  if (s.dclOffline) args.push("--dcl-offline");
  if (!s.threadDiagnostics) args.push("--disable-thread-diagnostics");
  if (!s.firmwareUpdates) args.push("--disable-ota");
  return args;
}

export type LogLevel = "debug" | "info" | "warn" | "error";
export type Log = (level: LogLevel, message: string) => void;

/** matter.js log lines: "2026-11-26 14:54:50.482 NOTICE WebServer Webserver listening ...". */
const LINE = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+ (\w+) (.*)$/;
// matter-server's INFO is every exchange with every device: the plugin's
// debug. NOTICE and up is what someone looking after the house wants.
const LEVELS: Record<string, LogLevel> = {
  DEBUG: "debug", INFO: "debug", NOTICE: "info", WARN: "warn", WARNING: "warn", ERROR: "error", FATAL: "error", CRITICAL: "error",
};

/** A matter-server output line as a level and a message. Continuation lines keep the last level. */
export function parseLine(line: string, last: LogLevel): { level: LogLevel; message: string } {
  const m = LINE.exec(line);
  if (!m) return { level: last, message: line };
  return { level: LEVELS[m[1]] ?? "info", message: m[2] };
}

const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
/** Up this long counts as having started; a crash after that resets the backoff. */
const HEALTHY_AFTER_MS = 30_000;

export interface ServerEvents {
  /** The socket accepts connections. */
  onReady(): void;
  /** It exited; `crashes` counts exits in a row that came too soon. */
  onExit(code: number | null, signal: string | null, crashes: number, lastLines: string[]): void;
}

export class MatterServerProcess {
  private child: ChildProcess | null = null;
  private stopping = false;
  private backoff = MIN_BACKOFF_MS;
  private crashes = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private tail: string[] = [];
  readonly socket: string;

  constructor(
    private readonly settings: MatterSettings,
    private readonly log: Log,
    private readonly events: ServerEvents,
    private readonly node = process.execPath,
    private readonly entry = serverEntry(),
  ) {
    this.socket = settings.socketPath;
  }

  start(): void {
    if (this.stopping) return;
    mkdirSync(this.settings.storageDir, { recursive: true, mode: 0o700 });
    mkdirSync(dirname(this.socket), { recursive: true, mode: 0o700 });
    // A socket left by a server that was killed refuses the new one's bind.
    if (existsSync(this.socket)) rmSync(this.socket, { force: true });
    const args = serverArgs(this.settings, this.socket);
    this.log("info", `starting matter-server: ${args.join(" ")}`);
    const started = Date.now();
    const child = spawn(this.node, ["--enable-source-maps", LAUNCHER, this.entry, ...args], {
      // stdin is the launcher's lifeline: it closes when this process goes.
      stdio: ["pipe", "pipe", "pipe"],
      // Its own settings come from argv; nothing of ours leaks to it by env.
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: this.settings.storageDir, NODE_ENV: "production" },
    });
    this.child = child;
    this.tail = [];
    let ready = false;
    const becameReady = () => {
      if (ready || this.child !== child) return;
      ready = true;
      clearInterval(watch);
      this.events.onReady();
    };
    // Ready when its socket exists: not from its log, whose "listening" line
    // is a notice that log_level = "warn" or "error" would filter out.
    const watch = setInterval(() => {
      if (existsSync(this.socket)) becameReady();
    }, 250);
    child.once("exit", () => clearInterval(watch));
    let level: LogLevel = "info";
    const onLine = (line: string) => {
      if (!line.trim()) return;
      const parsed = parseLine(line, level);
      level = parsed.level;
      this.tail.push(line);
      if (this.tail.length > 20) this.tail.shift();
      this.log(parsed.level, `matter-server: ${parsed.message}`);
      if (/listening on unix socket/i.test(parsed.message)) becameReady();
    };
    createInterface({ input: child.stdout! }).on("line", onLine);
    createInterface({ input: child.stderr! }).on("line", onLine);
    child.on("error", (e) => this.log("error", `could not start matter-server: ${e.message}`));
    child.on("exit", (code, signal) => {
      this.child = null;
      if (this.stopping) return;
      const ranFor = Date.now() - started;
      if (ranFor >= HEALTHY_AFTER_MS) {
        this.backoff = MIN_BACKOFF_MS;
        this.crashes = 0;
      } else {
        this.crashes += 1;
      }
      this.events.onExit(code, signal, this.crashes, [...this.tail]);
      this.log("warn", `matter-server exited (${signal ?? `code ${code}`}); restarting in ${Math.round(this.backoff / 1000)}s`);
      this.restartTimer = setTimeout(() => this.start(), this.backoff);
      this.backoff = Math.min(MAX_BACKOFF_MS, this.backoff * 2);
    });
  }

  /**
   * Ask it to stop, and wait up to `waitMs` for it to go. Never SIGKILL: its
   * SIGTERM handler closes the fabric's storage, and cutting that off
   * mid-write could lose every pairing. If this process goes first, the
   * launcher sees its pipe close and stops the server itself.
   */
  async stop(waitMs = 800): Promise<boolean> {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    const child = this.child;
    if (!child || child.exitCode !== null) return true;
    return new Promise<boolean>((resolve) => {
      const give = setTimeout(() => resolve(false), waitMs);
      child.once("exit", () => {
        clearTimeout(give);
        resolve(true);
      });
      child.stdin?.end();
      child.kill("SIGTERM");
    });
  }

  /** Start it again after stop (a backup pauses it). */
  resume(): void {
    this.stopping = false;
    this.backoff = MIN_BACKOFF_MS;
    if (!this.child) this.start();
  }
}
