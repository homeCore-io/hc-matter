/**
 * Phase 4: Matter Bridge MDNS Discovery Tests
 *
 * Test MDNS (mDNS) service publishing:
 * - Bridge service advertisement
 * - Service instance naming
 * - Address records (IPv4/IPv6)
 * - Subtype advertisement (device types, features)
 * - Service discovery by controllers
 * - Advertisement lifecycle
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Logger } from "../src/logger.js";

const logger = new Logger("test/mdns-discovery");

/**
 * Mock Service instance for MDNS advertising
 */
class MockServiceInstance {
  private name: string;
  private type: string;
  private domain: string;
  private port: number;
  private addresses: Set<string> = new Set();
  private txtRecords: Map<string, string> = new Map();
  private subtypes: Set<string> = new Set();

  constructor(name: string, type: string, domain: string, port: number) {
    this.name = name;
    this.type = type;
    this.domain = domain;
    this.port = port;
  }

  getName(): string {
    return this.name;
  }

  getType(): string {
    return this.type;
  }

  getDomain(): string {
    return this.domain;
  }

  getFullName(): string {
    return `${this.name}.${this.type}.${this.domain}`;
  }

  getPort(): number {
    return this.port;
  }

  addAddress(address: string): void {
    this.addresses.add(address);
  }

  getAddresses(): string[] {
    return Array.from(this.addresses);
  }

  addTxtRecord(key: string, value: string): void {
    this.txtRecords.set(key, value);
  }

  getTxtRecords(): Record<string, string> {
    const records: Record<string, string> = {};
    for (const [key, value] of this.txtRecords) {
      records[key] = value;
    }
    return records;
  }

  addSubtype(subtype: string): void {
    this.subtypes.add(subtype);
  }

  getSubtypes(): string[] {
    return Array.from(this.subtypes);
  }

  getTxtRecord(key: string): string | undefined {
    return this.txtRecords.get(key);
  }
}

/**
 * Mock MDNS Browser for service discovery
 */
class MockMDNSBrowser {
  private listeners: Map<string, Set<(event: unknown) => void>> = new Map();
  private discoveredServices: Map<string, MockServiceInstance> = new Map();

  on(event: string, handler: (event: unknown) => void): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler);
  }

  discoverService(instance: MockServiceInstance): void {
    this.discoveredServices.set(instance.getFullName(), instance);
    this.emit("serviceUp", {
      name: instance.getName(),
      type: instance.getType(),
      addresses: instance.getAddresses(),
      port: instance.getPort(),
      fullName: instance.getFullName(),
    });
  }

  removeService(fullName: string): void {
    this.discoveredServices.delete(fullName);
    this.emit("serviceDown", { fullName });
  }

  getDiscoveredServices(): Record<string, { name: string; addresses: string[]; port: number }> {
    const services: Record<string, { name: string; addresses: string[]; port: number }> = {};
    for (const [fullName, instance] of this.discoveredServices) {
      services[fullName] = {
        name: instance.getName(),
        addresses: instance.getAddresses(),
        port: instance.getPort(),
      };
    }
    return services;
  }

  emit(event: string, data: unknown): void {
    const handlers = this.listeners.get(event) || new Set();
    for (const handler of handlers) {
      handler(data);
    }
  }

  reset(): void {
    this.discoveredServices.clear();
    this.listeners.clear();
  }
}

/**
 * Mock MDNS Advertiser for service publishing
 */
class MockMDNSAdvertiser {
  private publishedServices: Map<string, MockServiceInstance> = new Map();
  private listeners: Map<string, Set<(event: unknown) => void>> = new Map();

  publishService(instance: MockServiceInstance): boolean {
    const fullName = instance.getFullName();
    this.publishedServices.set(fullName, instance);
    this.emit("servicePublished", {
      name: instance.getName(),
      type: instance.getType(),
      fullName,
    });
    return true;
  }

  unpublishService(fullName: string): boolean {
    const removed = this.publishedServices.delete(fullName);
    if (removed) {
      this.emit("serviceUnpublished", { fullName });
    }
    return removed;
  }

  getPublishedServices(): Record<string, { name: string; type: string; port: number }> {
    const services: Record<string, { name: string; type: string; port: number }> = {};
    for (const [fullName, instance] of this.publishedServices) {
      services[fullName] = {
        name: instance.getName(),
        type: instance.getType(),
        port: instance.getPort(),
      };
    }
    return services;
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
    this.publishedServices.clear();
    this.listeners.clear();
  }
}

describe("Phase 4: Matter Bridge MDNS Discovery", () => {
  let advertiser: MockMDNSAdvertiser;
  let browser: MockMDNSBrowser;

  beforeEach(() => {
    advertiser = new MockMDNSAdvertiser();
    browser = new MockMDNSBrowser();
  });

  afterEach(() => {
    advertiser.reset();
    browser.reset();
  });

  describe("Service Instance Creation", () => {
    it("should create service instance with basic properties", () => {
      const instance = new MockServiceInstance("HomeCore", "_hc._tcp", "local", 5353);

      expect(instance.getName()).toBe("HomeCore");
      expect(instance.getType()).toBe("_hc._tcp");
      expect(instance.getDomain()).toBe("local");
      expect(instance.getPort()).toBe(5353);
    });

    it("should build full service name", () => {
      const instance = new MockServiceInstance("HomeCore", "_hc._tcp", "local", 5353);

      expect(instance.getFullName()).toBe("HomeCore._hc._tcp.local");
    });

    it("should add addresses to service instance", () => {
      const instance = new MockServiceInstance("HomeCore", "_hc._tcp", "local", 5353);

      instance.addAddress("192.168.1.100");
      instance.addAddress("fd00::1");

      const addresses = instance.getAddresses();
      expect(addresses).toContain("192.168.1.100");
      expect(addresses).toContain("fd00::1");
    });

    it("should add TXT records", () => {
      const instance = new MockServiceInstance("HomeCore", "_hc._tcp", "local", 5353);

      instance.addTxtRecord("ver", "1.0");
      instance.addTxtRecord("id", "homecore-001");

      const records = instance.getTxtRecords();
      expect(records.ver).toBe("1.0");
      expect(records.id).toBe("homecore-001");
    });

    it("should query individual TXT record", () => {
      const instance = new MockServiceInstance("HomeCore", "_hc._tcp", "local", 5353);

      instance.addTxtRecord("fabric", "1");

      expect(instance.getTxtRecord("fabric")).toBe("1");
      expect(instance.getTxtRecord("nonexistent")).toBeUndefined();
    });

    it("should add subtypes for device discovery", () => {
      const instance = new MockServiceInstance("HomeCore", "_hc._tcp", "local", 5353);

      instance.addSubtype("_light");
      instance.addSubtype("_lock");
      instance.addSubtype("_sensor");

      const subtypes = instance.getSubtypes();
      expect(subtypes).toHaveLength(3);
      expect(subtypes).toContain("_light");
      expect(subtypes).toContain("_lock");
    });
  });

  describe("Service Publishing", () => {
    it("should publish service instance", () => {
      const instance = new MockServiceInstance("HomeCore", "_hc._tcp", "local", 5353);
      instance.addAddress("192.168.1.100");

      const success = advertiser.publishService(instance);

      expect(success).toBe(true);
    });

    it("should emit event when service published", async () => {
      const events: unknown[] = [];
      advertiser.on("servicePublished", (e) => events.push(e));

      const instance = new MockServiceInstance("HomeCore", "_hc._tcp", "local", 5353);
      advertiser.publishService(instance);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        name: "HomeCore",
        type: "_hc._tcp",
      });
    });

    it("should track published services", () => {
      const instance1 = new MockServiceInstance("HomeCore-1", "_hc._tcp", "local", 5353);
      const instance2 = new MockServiceInstance("HomeCore-2", "_hc._tcp", "local", 5353);

      advertiser.publishService(instance1);
      advertiser.publishService(instance2);

      const services = advertiser.getPublishedServices();
      expect(Object.keys(services)).toHaveLength(2);
    });

    it("should unpublish service instance", () => {
      const instance = new MockServiceInstance("HomeCore", "_hc._tcp", "local", 5353);
      advertiser.publishService(instance);

      const success = advertiser.unpublishService(instance.getFullName());

      expect(success).toBe(true);
      const services = advertiser.getPublishedServices();
      expect(Object.keys(services)).toHaveLength(0);
    });

    it("should emit event when service unpublished", async () => {
      const events: unknown[] = [];
      advertiser.on("serviceUnpublished", (e) => events.push(e));

      const instance = new MockServiceInstance("HomeCore", "_hc._tcp", "local", 5353);
      advertiser.publishService(instance);
      advertiser.unpublishService(instance.getFullName());

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ fullName: "HomeCore._hc._tcp.local" });
    });
  });

  describe("Service Discovery", () => {
    it("should discover advertised service", () => {
      const instance = new MockServiceInstance("HomeCore", "_hc._tcp", "local", 5353);
      instance.addAddress("192.168.1.100");

      browser.discoverService(instance);

      const discovered = browser.getDiscoveredServices();
      expect(Object.keys(discovered)).toHaveLength(1);
    });

    it("should emit event when service discovered", async () => {
      const events: unknown[] = [];
      browser.on("serviceUp", (e) => events.push(e));

      const instance = new MockServiceInstance("HomeCore", "_hc._tcp", "local", 5353);
      instance.addAddress("192.168.1.100");

      browser.discoverService(instance);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        name: "HomeCore",
        addresses: ["192.168.1.100"],
      });
    });

    it("should discover multiple services", () => {
      const instance1 = new MockServiceInstance("HomeCore-1", "_hc._tcp", "local", 5353);
      instance1.addAddress("192.168.1.100");

      const instance2 = new MockServiceInstance("HomeCore-2", "_hc._tcp", "local", 5354);
      instance2.addAddress("192.168.1.101");

      browser.discoverService(instance1);
      browser.discoverService(instance2);

      const discovered = browser.getDiscoveredServices();
      expect(Object.keys(discovered)).toHaveLength(2);
    });

    it("should remove discovered service", () => {
      const instance = new MockServiceInstance("HomeCore", "_hc._tcp", "local", 5353);
      instance.addAddress("192.168.1.100");

      browser.discoverService(instance);
      expect(Object.keys(browser.getDiscoveredServices())).toHaveLength(1);

      browser.removeService(instance.getFullName());
      expect(Object.keys(browser.getDiscoveredServices())).toHaveLength(0);
    });

    it("should emit event when service removed", async () => {
      const events: unknown[] = [];
      browser.on("serviceDown", (e) => events.push(e));

      const instance = new MockServiceInstance("HomeCore", "_hc._tcp", "local", 5353);
      instance.addAddress("192.168.1.100");

      browser.discoverService(instance);
      browser.removeService(instance.getFullName());

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ fullName: "HomeCore._hc._tcp.local" });
    });
  });

  describe("Multi-Address Advertisement", () => {
    it("should advertise both IPv4 and IPv6", () => {
      const instance = new MockServiceInstance("HomeCore", "_hc._tcp", "local", 5353);
      instance.addAddress("192.168.1.100");
      instance.addAddress("fd00::1");

      advertiser.publishService(instance);

      const services = advertiser.getPublishedServices();
      expect(Object.keys(services)).toHaveLength(1);
    });

    it("should discover service with multiple addresses", () => {
      const instance = new MockServiceInstance("HomeCore", "_hc._tcp", "local", 5353);
      instance.addAddress("192.168.1.100");
      instance.addAddress("fd00::1");

      browser.discoverService(instance);

      const discovered = browser.getDiscoveredServices();
      const service = Object.values(discovered)[0];
      expect(service.addresses).toHaveLength(2);
      expect(service.addresses).toContain("192.168.1.100");
      expect(service.addresses).toContain("fd00::1");
    });
  });

  describe("Complete Bridge Discovery Scenario", () => {
    it("should handle complete bridge discovery workflow", () => {
      // Step 1: Create service instance
      const instance = new MockServiceInstance("HomeCore-Bridge", "_hc._tcp", "local", 5353);
      instance.addAddress("192.168.1.100");
      instance.addTxtRecord("ver", "1.0");
      instance.addTxtRecord("id", "homecore-001");
      instance.addSubtype("_light");
      instance.addSubtype("_lock");

      // Step 2: Publish service
      advertiser.publishService(instance);
      expect(Object.keys(advertiser.getPublishedServices())).toHaveLength(1);

      // Step 3: Discover service
      browser.discoverService(instance);
      const discovered = browser.getDiscoveredServices();
      expect(Object.keys(discovered)).toHaveLength(1);

      // Step 4: Verify service details
      const service = Object.values(discovered)[0];
      expect(service.name).toBe("HomeCore-Bridge");
      expect(service.port).toBe(5353);

      // Step 5: Remove service
      advertiser.unpublishService(instance.getFullName());
      browser.removeService(instance.getFullName());

      expect(Object.keys(advertiser.getPublishedServices())).toHaveLength(0);
      expect(Object.keys(browser.getDiscoveredServices())).toHaveLength(0);
    });

    it("should handle multiple concurrent bridge instances", () => {
      // Publish multiple bridges
      const bridges = [];
      for (let i = 1; i <= 3; i++) {
        const instance = new MockServiceInstance(
          `HomeCore-${i}`,
          "_hc._tcp",
          "local",
          5353 + i
        );
        instance.addAddress(`192.168.1.${100 + i}`);
        instance.addTxtRecord("id", `homecore-00${i}`);
        advertiser.publishService(instance);
        bridges.push(instance);
      }

      // Discover all bridges
      for (const bridge of bridges) {
        browser.discoverService(bridge);
      }

      // Verify all discovered
      const discovered = browser.getDiscoveredServices();
      expect(Object.keys(discovered)).toHaveLength(3);
    });

    it("should emit discovery events in order", async () => {
      const events: unknown[] = [];

      browser.on("serviceUp", (e) => events.push({ type: "up", data: e }));
      browser.on("serviceDown", (e) => events.push({ type: "down", data: e }));

      const instance1 = new MockServiceInstance("HomeCore-1", "_hc._tcp", "local", 5353);
      instance1.addAddress("192.168.1.100");

      const instance2 = new MockServiceInstance("HomeCore-2", "_hc._tcp", "local", 5354);
      instance2.addAddress("192.168.1.101");

      browser.discoverService(instance1);
      browser.discoverService(instance2);
      browser.removeService(instance1.getFullName());

      expect(events).toHaveLength(3);
      expect(events[0].type).toBe("up");
      expect(events[1].type).toBe("up");
      expect(events[2].type).toBe("down");
    });
  });

  describe("Subtype Advertisement", () => {
    it("should advertise device type subtypes", () => {
      const instance = new MockServiceInstance("HomeCore", "_hc._tcp", "local", 5353);
      instance.addAddress("192.168.1.100");
      instance.addSubtype("_light");
      instance.addSubtype("_lock");
      instance.addSubtype("_thermostat");

      advertiser.publishService(instance);

      const services = advertiser.getPublishedServices();
      expect(Object.keys(services)).toHaveLength(1);
    });

    it("should track subtypes for discovery filtering", () => {
      const instance = new MockServiceInstance("HomeCore", "_hc._tcp", "local", 5353);
      instance.addAddress("192.168.1.100");
      instance.addSubtype("_light");
      instance.addSubtype("_lock");

      const subtypes = instance.getSubtypes();
      expect(subtypes).toContain("_light");
      expect(subtypes).toContain("_lock");
    });

    it("should support capability advertisement via subtypes", () => {
      const instance = new MockServiceInstance("HomeCore", "_hc._tcp", "local", 5353);
      instance.addAddress("192.168.1.100");

      // Advertise capabilities
      instance.addSubtype("_commissioning");
      instance.addSubtype("_extended_discovery");
      instance.addSubtype("_unicast_mdns");

      const capabilities = instance.getSubtypes();
      expect(capabilities.some((c) => c.includes("commissioning"))).toBe(true);
    });
  });
});
