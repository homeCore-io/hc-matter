// What the bridge keeps between starts, beside the plugin's other data:
// whether it is on, which homeCore devices it shares, and its pairing code.
// matter.js keeps the bridge's fabrics itself, under data/bridge/.

import { randomInt } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface BridgeChoices {
  enabled: boolean;
  /** Shared devices, by homeCore id; `security_confirmed` once someone accepted the warning. */
  devices: Record<string, { security_confirmed?: boolean }>;
  passcode: number;
  discriminator: number;
}

/** Passcodes Matter forbids (§ 5.1.7.1): all one digit, and the two runs. */
const FORBIDDEN = new Set([0, 11111111, 22222222, 33333333, 44444444, 55555555, 66666666, 77777777, 88888888, 99999999, 12345678, 87654321]);

export function newPasscode(rand: (lo: number, hi: number) => number = randomInt): number {
  for (;;) {
    const p = rand(1, 99999999);
    if (!FORBIDDEN.has(p)) return p;
  }
}

export class BridgeStore {
  private choices: BridgeChoices;

  constructor(private readonly path: string) {
    this.choices = this.load();
  }

  private load(): BridgeChoices {
    if (existsSync(this.path)) {
      const c = JSON.parse(readFileSync(this.path, "utf8")) as Partial<BridgeChoices>;
      if (typeof c.passcode === "number" && typeof c.discriminator === "number") {
        return { enabled: !!c.enabled, devices: c.devices ?? {}, passcode: c.passcode, discriminator: c.discriminator };
      }
    }
    const fresh: BridgeChoices = { enabled: false, devices: {}, passcode: newPasscode(), discriminator: randomInt(0, 4096) };
    this.choices = fresh;
    this.save();
    return fresh;
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.choices, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  get(): Readonly<BridgeChoices> {
    return this.choices;
  }

  setEnabled(on: boolean): void {
    this.choices.enabled = on;
    this.save();
  }

  share(deviceId: string, securityConfirmed: boolean): void {
    this.choices.devices[deviceId] = securityConfirmed ? { security_confirmed: true } : {};
    this.save();
  }

  unshare(deviceId: string): void {
    delete this.choices.devices[deviceId];
    this.save();
  }

  /** After a reset: a new code, as a new bridge. What it shares stays chosen. */
  reset(): void {
    this.choices = { ...this.choices, passcode: newPasscode(), discriminator: randomInt(0, 4096) };
    this.save();
  }
}
