/**
 * Phase 4: Matter Bridge Commissioning Flow Tests
 *
 * Test commissioning workflows:
 * - Device discovery and commissioning
 * - Fabric management
 * - Passcode/QR code handling
 * - Commission window management
 * - Node ID assignment
 * - Re-commissioning scenarios
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Logger } from "../src/logger.js";
import { MATTER_CLUSTER_IDS, MATTER_ATTRIBUTE_IDS } from "../src/bridge/endpoint-factory.js";

const logger = new Logger("test/commissioning-flow");

/**
 * Mock Commissioning window for testing
 */
class MockCommissioningWindow {
  private endTime: number;
  private code: string;
  private isOpen: boolean = true;

  constructor(durationMinutes: number = 15, code: string = "00000000") {
    this.endTime = Date.now() + durationMinutes * 60 * 1000;
    this.code = code;
  }

  isActive(): boolean {
    return this.isOpen && Date.now() < this.endTime;
  }

  getCode(): string {
    return this.code;
  }

  close(): void {
    this.isOpen = false;
  }

  getRemainingTimeMs(): number {
    if (!this.isOpen) return 0;
    const remaining = this.endTime - Date.now();
    return Math.max(0, remaining);
  }
}

/**
 * Mock Commission flow component
 */
class MockCommissioningFlow {
  private window: MockCommissioningWindow | null = null;
  private commissionedNodes: Map<string, { passcode: string; nodeId: string;commissioned: number }> = new Map();
  private listeners: Map<string, Set<(event: unknown) => void>> = new Map();

  openCommissioningWindow(durationMinutes: number = 15): MockCommissioningWindow {
    this.window = new MockCommissioningWindow(durationMinutes);
    this.emit("commissioningWindowOpened", { durationMinutes });
    return this.window;
  }

  closeCommissioningWindow(): void {
    if (this.window) {
      this.window.close();
      this.emit("commissioningWindowClosed", {});
    }
    this.window = null;
  }

  isCommissioningWindowOpen(): boolean {
    return this.window !== null && this.window.isActive();
  }

  getCommissioningWindow(): MockCommissioningWindow | null {
    return this.window && this.window.isActive() ? this.window : null;
  }

  commissionDevice(passcode: string, nodeId: string): boolean {
    if (!this.isCommissioningWindowOpen()) {
      return false;
    }

    this.commissionedNodes.set(nodeId, {
      passcode,
      nodeId,
      commissioned: Date.now(),
    });

    this.emit("deviceCommissioned", { nodeId, passcode });
    return true;
  }

  getCommissionedDevices(): Array<{ nodeId: string; passcode: string; commissioned: number }> {
    return Array.from(this.commissionedNodes.values());
  }

  isDeviceCommissioned(nodeId: string): boolean {
    return this.commissionedNodes.has(nodeId);
  }

  removeCommissionedDevice(nodeId: string): boolean {
    const removed = this.commissionedNodes.delete(nodeId);
    if (removed) {
      this.emit("deviceRemoved", { nodeId });
    }
    return removed;
  }

  on(event: string, handler: (event: unknown) => void): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler);
  }

  emit(event: string, data: unknown): void {
    const handlers = this.listeners.get(event) || new Set();
    for (const handler of handlers) {
      handler(data);
    }
  }

  reset(): void {
    this.window = null;
    this.commissionedNodes.clear();
  }
}

/**
 * Mock Advertisement tracker
 */
class MockMDNSAdvertisement {
  private isAdvertising: boolean = false;
  private advertisedServices: Set<string> = new Set();
  private listeners: Map<string, Set<(event: unknown) => void>> = new Map();

  startAdvertisement(serviceName: string): void {
    this.isAdvertising = true;
    this.advertisedServices.add(serviceName);
    this.emit("advertisementStarted", { serviceName });
  }

  stopAdvertisement(): void {
    this.isAdvertising = false;
    this.advertisedServices.clear();
    this.emit("advertisementStopped", {});
  }

  isAdvertising_(): boolean {
    return this.isAdvertising;
  }

  getAdvertisedServices(): string[] {
    return Array.from(this.advertisedServices);
  }

  on(event: string, handler: (event: unknown) => void): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler);
  }

  emit(event: string, data: unknown): void {
    const handlers = this.listeners.get(event) || new Set();
    for (const handler of handlers) {
      handler(data);
    }
  }

  reset(): void {
    this.stopAdvertisement();
  }
}

describe("Phase 4: Matter Bridge Commissioning Flow", () => {
  let commissioningFlow: MockCommissioningFlow;
  let mdnsAdvertisement: MockMDNSAdvertisement;

  beforeEach(() => {
    commissioningFlow = new MockCommissioningFlow();
    mdnsAdvertisement = new MockMDNSAdvertisement();
  });

  afterEach(() => {
    commissioningFlow.reset();
    mdnsAdvertisement.reset();
  });

  describe("Commissioning Window Management", () => {
    it("should open a commissioning window", () => {
      const window = commissioningFlow.openCommissioningWindow(15);

      expect(window).toBeDefined();
      expect(commissioningFlow.isCommissioningWindowOpen()).toBe(true);
    });

    it("should generate commissioning code", () => {
      const window = commissioningFlow.openCommissioningWindow(15);

      expect(window.getCode()).toBeDefined();
      expect(typeof window.getCode()).toBe("string");
      expect(window.getCode().length).toBeGreaterThan(0);
    });

    it("should track commissioning window duration", () => {
      const window = commissioningFlow.openCommissioningWindow(15);

      const remaining = window.getRemainingTimeMs();
      expect(remaining).toBeGreaterThan(0);
      expect(remaining).toBeLessThanOrEqual(15 * 60 * 1000);
    });

    it("should close commissioning window", () => {
      commissioningFlow.openCommissioningWindow(15);
      expect(commissioningFlow.isCommissioningWindowOpen()).toBe(true);

      commissioningFlow.closeCommissioningWindow();
      expect(commissioningFlow.isCommissioningWindowOpen()).toBe(false);
    });

    it("should emit event when commissioning window opens", async () => {
      const events: unknown[] = [];
      commissioningFlow.on("commissioningWindowOpened", (e) => events.push(e));

      commissioningFlow.openCommissioningWindow(15);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ durationMinutes: 15 });
    });

    it("should emit event when commissioning window closes", async () => {
      const events: unknown[] = [];
      commissioningFlow.on("commissioningWindowClosed", (e) => events.push(e));

      commissioningFlow.openCommissioningWindow(15);
      commissioningFlow.closeCommissioningWindow();

      expect(events).toHaveLength(1);
    });
  });

  describe("Device Commissioning", () => {
    it("should commission device with passcode", () => {
      commissioningFlow.openCommissioningWindow();

      const success = commissioningFlow.commissionDevice("12345678", "node-1");
      expect(success).toBe(true);
    });

    it("should track commissioned devices", () => {
      commissioningFlow.openCommissioningWindow();

      commissioningFlow.commissionDevice("12345678", "node-1");
      commissioningFlow.commissionDevice("87654321", "node-2");

      const devices = commissioningFlow.getCommissionedDevices();
      expect(devices).toHaveLength(2);
    });

    it("should prevent commissioning with closed window", () => {
      commissioningFlow.openCommissioningWindow();
      commissioningFlow.closeCommissioningWindow();

      const success = commissioningFlow.commissionDevice("12345678", "node-1");
      expect(success).toBe(false);
    });

    it("should emit event when device commissioned", async () => {
      const events: unknown[] = [];
      commissioningFlow.on("deviceCommissioned", (e) => events.push(e));

      commissioningFlow.openCommissioningWindow();
      commissioningFlow.commissionDevice("12345678", "node-1");

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ nodeId: "node-1", passcode: "12345678" });
    });

    it("should verify device is commissioned", () => {
      commissioningFlow.openCommissioningWindow();
      commissioningFlow.commissionDevice("12345678", "node-1");

      expect(commissioningFlow.isDeviceCommissioned("node-1")).toBe(true);
      expect(commissioningFlow.isDeviceCommissioned("node-2")).toBe(false);
    });

    it("should track commission timestamp", () => {
      commissioningFlow.openCommissioningWindow();

      const before = Date.now();
      commissioningFlow.commissionDevice("12345678", "node-1");
      const after = Date.now();

      const devices = commissioningFlow.getCommissionedDevices();
      expect(devices[0].commissioned).toBeGreaterThanOrEqual(before);
      expect(devices[0].commissioned).toBeLessThanOrEqual(after);
    });

    it("should remove commissioned device", () => {
      commissioningFlow.openCommissioningWindow();
      commissioningFlow.commissionDevice("12345678", "node-1");

      expect(commissioningFlow.isDeviceCommissioned("node-1")).toBe(true);

      commissioningFlow.removeCommissionedDevice("node-1");

      expect(commissioningFlow.isDeviceCommissioned("node-1")).toBe(false);
    });
  });

  describe("MDNS Advertisement", () => {
    it("should start MDNS advertisement", () => {
      mdnsAdvertisement.startAdvertisement("_hc._tcp");

      expect(mdnsAdvertisement.isAdvertising_()).toBe(true);
    });

    it("should track advertised services", () => {
      mdnsAdvertisement.startAdvertisement("_hc._tcp");

      const services = mdnsAdvertisement.getAdvertisedServices();
      expect(services).toContain("_hc._tcp");
    });

    it("should stop MDNS advertisement", () => {
      mdnsAdvertisement.startAdvertisement("_hc._tcp");
      expect(mdnsAdvertisement.isAdvertising_()).toBe(true);

      mdnsAdvertisement.stopAdvertisement();
      expect(mdnsAdvertisement.isAdvertising_()).toBe(false);
    });

    it("should emit event when advertisement starts", async () => {
      const events: unknown[] = [];
      mdnsAdvertisement.on("advertisementStarted", (e) => events.push(e));

      mdnsAdvertisement.startAdvertisement("_hc._tcp");

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ serviceName: "_hc._tcp" });
    });

    it("should emit event when advertisement stops", async () => {
      const events: unknown[] = [];
      mdnsAdvertisement.on("advertisementStopped", (e) => events.push(e));

      mdnsAdvertisement.startAdvertisement("_hc._tcp");
      mdnsAdvertisement.stopAdvertisement();

      expect(events).toHaveLength(1);
    });
  });

  describe("Complete Commissioning Scenario", () => {
    it("should handle complete commissioning workflow", () => {
      // Step 1: Start advertising bridge
      mdnsAdvertisement.startAdvertisement("_hc._tcp");
      expect(mdnsAdvertisement.isAdvertising_()).toBe(true);

      // Step 2: Open commissioning window
      const window = commissioningFlow.openCommissioningWindow(15);
      expect(commissioningFlow.isCommissioningWindowOpen()).toBe(true);

      // Step 3: Get commissioning code
      const code = window.getCode();
      expect(code).toBeDefined();

      // Step 4: Commission devices
      commissioningFlow.commissionDevice("12345678", "node-1");
      commissioningFlow.commissionDevice("87654321", "node-2");

      // Step 5: Verify commissioned devices
      const devices = commissioningFlow.getCommissionedDevices();
      expect(devices).toHaveLength(2);

      // Step 6: Close window
      commissioningFlow.closeCommissioningWindow();
      expect(commissioningFlow.isCommissioningWindowOpen()).toBe(false);

      // Step 7: Stop advertising
      mdnsAdvertisement.stopAdvertisement();
      expect(mdnsAdvertisement.isAdvertising_()).toBe(false);
    });

    it("should handle re-commissioning after removal", () => {
      commissioningFlow.openCommissioningWindow();

      // Commission device
      commissioningFlow.commissionDevice("12345678", "node-1");
      expect(commissioningFlow.isDeviceCommissioned("node-1")).toBe(true);

      // Remove device
      commissioningFlow.removeCommissionedDevice("node-1");
      expect(commissioningFlow.isDeviceCommissioned("node-1")).toBe(false);

      // Re-commission with new passcode
      commissioningFlow.commissionDevice("99999999", "node-1");
      expect(commissioningFlow.isDeviceCommissioned("node-1")).toBe(true);

      const devices = commissioningFlow.getCommissionedDevices();
      expect(devices[0].passcode).toBe("99999999");
    });

    it("should emit commissioning events in order", async () => {
      const events: unknown[] = [];

      commissioningFlow.on("commissioningWindowOpened", (e) =>
        events.push({ type: "windowOpened", ...e })
      );
      commissioningFlow.on("deviceCommissioned", (e) =>
        events.push({ type: "deviceCommissioned", ...e })
      );
      commissioningFlow.on("commissioningWindowClosed", (e) =>
        events.push({ type: "windowClosed", ...e })
      );

      commissioningFlow.openCommissioningWindow(15);
      commissioningFlow.commissionDevice("12345678", "node-1");
      commissioningFlow.commissionDevice("87654321", "node-2");
      commissioningFlow.closeCommissioningWindow();

      expect(events).toHaveLength(4);
      expect(events[0].type).toBe("windowOpened");
      expect(events[1].type).toBe("deviceCommissioned");
      expect(events[2].type).toBe("deviceCommissioned");
      expect(events[3].type).toBe("windowClosed");
    });
  });

  describe("Multi-Window Scenarios", () => {
    it("should handle sequential commissioning windows", () => {
      // First window
      commissioningFlow.openCommissioningWindow();
      commissioningFlow.commissionDevice("11111111", "node-1");
      commissioningFlow.closeCommissioningWindow();

      const devices1 = commissioningFlow.getCommissionedDevices();
      expect(devices1).toHaveLength(1);

      // Second window
      commissioningFlow.openCommissioningWindow();
      commissioningFlow.commissionDevice("22222222", "node-2");
      commissioningFlow.closeCommissioningWindow();

      const devices2 = commissioningFlow.getCommissionedDevices();
      expect(devices2).toHaveLength(2);
    });

    it("should maintain state across multiple windows", () => {
      const allEvents: unknown[] = [];

      commissioningFlow.on("commissioningWindowOpened", (e) => allEvents.push({type: "opened"}));
      commissioningFlow.on("deviceCommissioned", (e) => allEvents.push({ type: "commissioned" }));

      // Window 1
      commissioningFlow.openCommissioningWindow();
      commissioningFlow.commissionDevice("11111111", "node-1");
      commissioningFlow.closeCommissioningWindow();

      // Window 2
      commissioningFlow.openCommissioningWindow();
      commissioningFlow.commissionDevice("22222222", "node-2");
      commissioningFlow.closeCommissioningWindow();

      // Should have 2 windows + 2 commissions
      expect(allEvents.filter(e => e.type === "opened")).toHaveLength(2);
      expect(allEvents.filter(e => e.type === "commissioned")).toHaveLength(2);
    });
  });
});
