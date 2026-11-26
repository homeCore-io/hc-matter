// homeCore as the bridge sees it: every device and its state, kept current
// from the event stream, and commands sent back through the API. With the
// plugin's own key (api_access: devices:read, devices:command), reminted by
// homeCore on every start.

import WebSocket from "ws";
import type { Log } from "../server.js";
import type { HomeDevice } from "./model.js";

export interface HomeEvents {
  /** The whole house: on connecting, and again after falling behind. */
  onSnapshot(devices: HomeDevice[]): void;
  onState(deviceId: string, current: Record<string, unknown>): void;
  onAvailability(deviceId: string, available: boolean): void;
  /** Added, or its name, room, type or security changed. */
  onDevice(device: HomeDevice): void;
  onRemoved(deviceId: string): void;
}

const TYPES = ["device_state_changed", "device_availability_changed", "device_added", "device_metadata_changed", "device_removed"];

export class HomeLink {
  private ws: WebSocket | null = null;
  private retry: NodeJS.Timeout | null = null;
  private backoff = 1000;
  private closed = false;
  private access: { url: string; key: string } | null = null;

  constructor(private readonly log: Log, private readonly events: HomeEvents) {}

  /** New access from homeCore: (re)connect with it. */
  setAccess(url: string, key: string): void {
    this.access = { url: url.replace(/\/+$/, ""), key };
    this.pause();
    this.connect();
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private connect(): void {
    if (this.closed || !this.access || this.ws) return;
    const { url, key } = this.access;
    const wsUrl = `${url.replace(/^http/, "ws")}/events/stream?snapshot=true&type=${TYPES.join(",")}&token=${encodeURIComponent(key)}`;
    const ws = new WebSocket(wsUrl);
    this.ws = ws;
    ws.on("open", () => {
      this.backoff = 1000;
      this.log("info", "bridge: following homeCore's devices");
    });
    ws.on("message", (raw) => {
      let e: Record<string, unknown>;
      try {
        e = JSON.parse(raw.toString());
      } catch {
        return;
      }
      this.dispatch(e);
    });
    ws.on("error", (err) => this.log("debug", `bridge: homeCore stream: ${err.message}`));
    ws.on("close", (code) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.closed) return;
      this.log(code === 1008 ? "info" : "warn", `bridge: homeCore stream closed (${code}); reconnecting`);
      this.retry = setTimeout(() => {
        this.retry = null;
        this.connect();
      }, this.backoff);
      this.backoff = Math.min(30_000, this.backoff * 2);
    });
  }

  private dispatch(e: Record<string, unknown>): void {
    switch (e.type) {
      case "snapshot":
        if (Array.isArray(e.devices)) this.events.onSnapshot(e.devices as HomeDevice[]);
        break;
      case "lagged":
        // Missed events and no snapshot coming: start again for one.
        this.ws?.close();
        break;
      case "device_state_changed":
        if (typeof e.device_id === "string" && e.current && typeof e.current === "object") {
          this.events.onState(e.device_id, e.current as Record<string, unknown>);
        }
        break;
      case "device_availability_changed":
        if (typeof e.device_id === "string") this.events.onAvailability(e.device_id, e.available === true);
        break;
      case "device_added":
      case "device_metadata_changed":
        if (e.device && typeof e.device === "object") this.events.onDevice(e.device as HomeDevice);
        break;
      case "device_removed":
        if (typeof e.device_id === "string") this.events.onRemoved(e.device_id);
        break;
    }
  }

  /** Command a device, as the other app asked. */
  async command(deviceId: string, body: Record<string, unknown>): Promise<void> {
    if (!this.access) throw new Error("no access to homeCore yet");
    const res = await fetch(`${this.access.url}/devices/${encodeURIComponent(deviceId)}/state`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${this.access.key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`homeCore answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  /** Stop following homeCore until access is set again (the bridge was turned off). */
  pause(): void {
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }

  close(): void {
    this.closed = true;
    if (this.retry) clearTimeout(this.retry);
    this.ws?.close();
    this.ws = null;
  }
}
