// The parts of homecore-plugin-sdk (plain JavaScript) that hc-matter uses.
declare module "homecore-plugin-sdk" {
  export interface Caller { uid?: string; username?: string; role?: string; scopes?: string[]; kind?: string }

  export class StreamContext {
    caller: Caller | null;
    progress(p: { percent?: number; label?: string; message?: string; data?: unknown }): void;
    itemAdd(data: Record<string, unknown>): void;
    itemUpdate(data: Record<string, unknown>): void;
    warning(message: string): void;
    complete(data?: unknown): void;
    error(message: string): void;
    canceled(): void;
    isCanceled(): boolean;
  }

  export class PluginNotice {
    static info(code: string, message: string, opts?: { remedy?: string }): PluginNotice;
    static warning(code: string, message: string, opts?: { remedy?: string }): PluginNotice;
    static error(code: string, message: string, opts?: { remedy?: string }): PluginNotice;
  }

  export class PluginNotices {
    raise(notice: PluginNotice): void;
    clear(code: string): void;
    set(notices: PluginNotice[]): void;
  }

  export class Action {
    constructor(opts: {
      id: string; label: string; description?: string; params?: object; result?: object;
      stream?: boolean; cancelable?: boolean; concurrency?: string; itemKey?: string;
      itemOperations?: string[]; requiresRole?: string; timeoutMs?: number;
    });
  }

  export class Capabilities {
    constructor(actions?: Action[], opts?: { configSchema?: object; configDescriptor?: object; alertKinds?: unknown[]; apiScopes?: string[] });
  }

  export const Concurrency: { SINGLE: string; MULTI: string };

  export const AlertSeverity: { INFO: string; WARNING: string; ERROR: string };
  export const AlertActionTarget: { DEVICE: string; PLUGIN: string };
  export class AlertAction {
    constructor(label: string, id: string, opts?: { target?: string; params?: unknown; confirm?: boolean });
  }
  export class PluginAlertKind {
    constructor(topic: string, label: string, opts?: { description?: string; severity?: string; defaultOn?: boolean });
  }
  export class PluginAlert {
    constructor(topic: string, reason: string, opts?: { key?: string; message?: string; severity?: string; action?: AlertAction });
  }

  export interface PluginOptions { pluginId: string; brokerHost: string; brokerPort: number; password?: string }

  export class PluginBase {
    constructor(opts: PluginOptions);
    readonly pluginId: string;
    notices: PluginNotices;
    logLevel: string;
    run(): unknown;
    stop(): Promise<void>;
    enableManagement(opts: { intervalSecs?: number; version?: string; configPath?: string; capabilities?: Capabilities }): void;
    enableLogForwarding(minLevel?: string): void;
    withUiDir(dir: string, version: string): this;
    enableDevicePersistence(path: string): void;
    reconcileDevices(live: Iterable<string>): { staleUnregistered: string[]; unknownInLive: string[] };
    registerDeviceFull(deviceId: string, name: string, opts?: { deviceType?: string; area?: string; capabilities?: object }): void;
    registerDeviceSchema(deviceId: string, schema: object): void;
    unregisterDevice(deviceId: string): void;
    publishState(deviceId: string, state: object, options?: { change?: object }): void;
    publishStatePartial(deviceId: string, patch: object, options?: { change?: object }): void;
    publishStateForCommand(deviceId: string, state: object, commandPayload: object, fallbackSource?: string): void;
    publishStatePartialForCommand(deviceId: string, patch: object, commandPayload: object, fallbackSource?: string): void;
    publishAvailability(deviceId: string, available: boolean): void;
    publishPluginStatus(status: "active" | "degraded" | "offline"): void;
    setAlerts(deviceId: string, alerts: PluginAlert[]): void;
    forwardLog(level: string, message: string, fields?: object | null): void;
    onConnect(): void;
    onCommand(deviceId: string, payload: Record<string, unknown>): void;
    onAction(action: string, params: Record<string, unknown>, ctx: StreamContext | null, caller?: Caller | null): unknown;
    onLogLevel(level: string): void;
    onApiAccess(url: string, key: string, scopes: string[]): void;
    onStop(): void | Promise<void>;
  }
}
