/**
 * Bridge Metrics and Observability Tests (Phase 3)
 *
 * Test bridge operational metrics and observability:
 * - Endpoint metrics (count, types, active endpoints)
 * - Command metrics (count, latency, success rate)
 * - Attribute update metrics (frequency, changes)
 * - Error tracking and recovery metrics
 * - Performance metrics (throughput, response times)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Logger } from "../src/logger.js";

/**
 * Bridge metrics collector
 */
class BridgeMetricsCollector {
  private metrics = {
    endpoints: {
      total: 0,
      byType: new Map<string, number>(),
      active: 0,
    },
    commands: {
      total: 0,
      success: 0,
      failed: 0,
      commandsByType: new Map<string, number>(),
      totalLatencyMs: 0,
      latencies: [] as number[],
    },
    attributes: {
      updates: 0,
      changes: 0,
      lastUpdateTime: 0,
      updatesByCluster: new Map<number, number>(),
    },
    errors: {
      total: 0,
      byType: new Map<string, number>(),
      recoveries: 0,
    },
    uptime: {
      startTime: Date.now(),
      lastCommandTime: 0,
    },
  };

  recordEndpointDiscovered(type: string): void {
    this.metrics.endpoints.total++;
    const count = this.metrics.endpoints.byType.get(type) || 0;
    this.metrics.endpoints.byType.set(type, count + 1);
  }

  recordEndpointActive(): void {
    this.metrics.endpoints.active++;
  }

  recordEndpointInactive(): void {
    this.metrics.endpoints.active = Math.max(0, this.metrics.endpoints.active - 1);
  }

  recordCommand(
    commandType: string,
    latencyMs: number,
    success: boolean
  ): void {
    this.metrics.commands.total++;
    if (success) {
      this.metrics.commands.success++;
    } else {
      this.metrics.commands.failed++;
    }

    const count = this.metrics.commands.commandsByType.get(commandType) || 0;
    this.metrics.commands.commandsByType.set(commandType, count + 1);

    this.metrics.commands.totalLatencyMs += latencyMs;
    this.metrics.commands.latencies.push(latencyMs);
    this.metrics.uptime.lastCommandTime = Date.now();
  }

  recordAttributeUpdate(clusterId: number): void {
    this.metrics.attributes.updates++;
    this.metrics.attributes.lastUpdateTime = Date.now();

    const count = this.metrics.attributes.updatesByCluster.get(clusterId) || 0;
    this.metrics.attributes.updatesByCluster.set(clusterId, count + 1);
  }

  recordAttributeChange(_clusterId: number): void {
    this.metrics.attributes.changes++;
  }

  recordError(errorType: string): void {
    this.metrics.errors.total++;
    const count = this.metrics.errors.byType.get(errorType) || 0;
    this.metrics.errors.byType.set(errorType, count + 1);
  }

  recordRecovery(): void {
    this.metrics.errors.recoveries++;
  }

  getMetrics() {
    return {
      endpoints: {
        total: this.metrics.endpoints.total,
        active: this.metrics.endpoints.active,
        byType: Object.fromEntries(this.metrics.endpoints.byType),
      },
      commands: {
        total: this.metrics.commands.total,
        success: this.metrics.commands.success,
        failed: this.metrics.commands.failed,
        successRate:
          this.metrics.commands.total > 0
            ? (this.metrics.commands.success / this.metrics.commands.total) * 100
            : 0,
        avgLatencyMs:
          this.metrics.commands.total > 0
            ? this.metrics.commands.totalLatencyMs / this.metrics.commands.total
            : 0,
        commandsByType: Object.fromEntries(
          this.metrics.commands.commandsByType
        ),
      },
      attributes: {
        total: this.metrics.attributes.updates,
        changes: this.metrics.attributes.changes,
        changeRate:
          this.metrics.attributes.updates > 0
            ? (this.metrics.attributes.changes / this.metrics.attributes.updates) *
              100
            : 0,
        updatesByCluster: Object.fromEntries(
          this.metrics.attributes.updatesByCluster
        ),
      },
      errors: {
        total: this.metrics.errors.total,
        recoveries: this.metrics.errors.recoveries,
        errorRate:
          this.metrics.commands.total > 0
            ? (this.metrics.errors.total / this.metrics.commands.total) * 100
            : 0,
        byType: Object.fromEntries(this.metrics.errors.byType),
      },
      latencies: {
        min: this.metrics.commands.latencies.length > 0
          ? Math.min(...this.metrics.commands.latencies)
          : 0,
        max: this.metrics.commands.latencies.length > 0
          ? Math.max(...this.metrics.commands.latencies)
          : 0,
        p50: this.getPercentile(50),
        p95: this.getPercentile(95),
        p99: this.getPercentile(99),
      },
      uptime: {
        startTime: this.metrics.uptime.startTime,
        lastCommandTime: this.metrics.uptime.lastCommandTime,
        uptimeSec: (Date.now() - this.metrics.uptime.startTime) / 1000,
      },
    };
  }

  private getPercentile(p: number): number {
    if (this.metrics.commands.latencies.length === 0) return 0;
    const sorted = [...this.metrics.commands.latencies].sort((a, b) => a - b);
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  }

  reset(): void {
    this.metrics = {
      endpoints: {
        total: 0,
        byType: new Map(),
        active: 0,
      },
      commands: {
        total: 0,
        success: 0,
        failed: 0,
        commandsByType: new Map(),
        totalLatencyMs: 0,
        latencies: [],
      },
      attributes: {
        updates: 0,
        changes: 0,
        lastUpdateTime: 0,
        updatesByCluster: new Map(),
      },
      errors: {
        total: 0,
        byType: new Map(),
        recoveries: 0,
      },
      uptime: {
        startTime: Date.now(),
        lastCommandTime: 0,
      },
    };
  }
}

describe("Phase 3: Bridge Metrics and Observability", () => {
  let metrics: BridgeMetricsCollector;

  beforeEach(() => {
    metrics = new BridgeMetricsCollector();
  });

  afterEach(() => {
    metrics.reset();
  });

  describe("Endpoint Metrics", () => {
    it("should track total endpoint count", () => {
      metrics.recordEndpointDiscovered("light");
      metrics.recordEndpointDiscovered("light_color");
      metrics.recordEndpointDiscovered("switch");

      const m = metrics.getMetrics();
      expect(m.endpoints.total).toBe(3);
    });

    it("should track endpoints by type", () => {
      metrics.recordEndpointDiscovered("light");
      metrics.recordEndpointDiscovered("light");
      metrics.recordEndpointDiscovered("light_color");
      metrics.recordEndpointDiscovered("sensor");

      const m = metrics.getMetrics();
      expect(m.endpoints.byType.light).toBe(2);
      expect(m.endpoints.byType.light_color).toBe(1);
      expect(m.endpoints.byType.sensor).toBe(1);
    });

    it("should track active endpoint count", () => {
      metrics.recordEndpointDiscovered("light");
      metrics.recordEndpointDiscovered("light");
      metrics.recordEndpointDiscovered("light");

      metrics.recordEndpointActive();
      metrics.recordEndpointActive();
      metrics.recordEndpointActive();

      let m = metrics.getMetrics();
      expect(m.endpoints.active).toBe(3);

      metrics.recordEndpointInactive();
      m = metrics.getMetrics();
      expect(m.endpoints.active).toBe(2);
    });

    it("should not allow active count to go negative", () => {
      metrics.recordEndpointInactive();
      metrics.recordEndpointInactive();
      metrics.recordEndpointInactive();

      const m = metrics.getMetrics();
      expect(m.endpoints.active).toBe(0);
    });
  });

  describe("Command Metrics", () => {
    it("should track total command count", () => {
      metrics.recordCommand("on", 10, true);
      metrics.recordCommand("off", 12, true);
      metrics.recordCommand("brightness", 15, false);

      const m = metrics.getMetrics();
      expect(m.commands.total).toBe(3);
    });

    it("should track success and failure rates", () => {
      for (let i = 0; i < 80; i++) {
        metrics.recordCommand("on", 10, true);
      }
      for (let i = 0; i < 20; i++) {
        metrics.recordCommand("on", 10, false);
      }

      const m = metrics.getMetrics();
      expect(m.commands.total).toBe(100);
      expect(m.commands.success).toBe(80);
      expect(m.commands.failed).toBe(20);
      expect(m.commands.successRate).toBe(80);
    });

    it("should track commands by type", () => {
      metrics.recordCommand("on", 10, true);
      metrics.recordCommand("on", 11, true);
      metrics.recordCommand("off", 12, true);
      metrics.recordCommand("brightness", 15, true);
      metrics.recordCommand("brightness", 14, true);
      metrics.recordCommand("brightness", 16, true);

      const m = metrics.getMetrics();
      expect(m.commands.commandsByType.on).toBe(2);
      expect(m.commands.commandsByType.off).toBe(1);
      expect(m.commands.commandsByType.brightness).toBe(3);
    });

    it("should track average command latency", () => {
      metrics.recordCommand("on", 10, true);
      metrics.recordCommand("on", 20, true);
      metrics.recordCommand("on", 30, true);

      const m = metrics.getMetrics();
      expect(m.commands.avgLatencyMs).toBe(20);
    });

    it("should track latency percentiles", () => {
      const latencies = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50];
      for (const lat of latencies) {
        metrics.recordCommand("on", lat, true);
      }

      const m = metrics.getMetrics();
      expect(m.latencies.min).toBe(5);
      expect(m.latencies.max).toBe(50);
      expect(m.latencies.p50).toBeGreaterThanOrEqual(20);
      expect(m.latencies.p95).toBeGreaterThanOrEqual(45);
    });
  });

  describe("Attribute Metrics", () => {
    it("should track attribute update count", () => {
      const CLUSTER_ON_OFF = 0x0006;
      const CLUSTER_LEVEL = 0x0008;

      metrics.recordAttributeUpdate(CLUSTER_ON_OFF);
      metrics.recordAttributeUpdate(CLUSTER_ON_OFF);
      metrics.recordAttributeUpdate(CLUSTER_LEVEL);

      const m = metrics.getMetrics();
      expect(m.attributes.total).toBe(3);
    });

    it("should track attribute changes", () => {
      const CLUSTER_ON_OFF = 0x0006;

      metrics.recordAttributeUpdate(CLUSTER_ON_OFF);
      metrics.recordAttributeChange(CLUSTER_ON_OFF);
      metrics.recordAttributeUpdate(CLUSTER_ON_OFF);
      metrics.recordAttributeUpdate(CLUSTER_ON_OFF);
      metrics.recordAttributeChange(CLUSTER_ON_OFF);
      metrics.recordAttributeUpdate(CLUSTER_ON_OFF);

      const m = metrics.getMetrics();
      expect(m.attributes.total).toBe(4);
      expect(m.attributes.changes).toBe(2);
      expect(m.attributes.changeRate).toBe(50);
    });

    it("should track updates by cluster", () => {
      const CLUSTER_ON_OFF = 0x0006;
      const CLUSTER_LEVEL = 0x0008;
      const CLUSTER_TEMP = 0x0402;

      metrics.recordAttributeUpdate(CLUSTER_ON_OFF);
      metrics.recordAttributeUpdate(CLUSTER_ON_OFF);
      metrics.recordAttributeUpdate(CLUSTER_LEVEL);
      metrics.recordAttributeUpdate(CLUSTER_TEMP);
      metrics.recordAttributeUpdate(CLUSTER_TEMP);
      metrics.recordAttributeUpdate(CLUSTER_TEMP);

      const m = metrics.getMetrics();
      expect(m.attributes.updatesByCluster[CLUSTER_ON_OFF]).toBe(2);
      expect(m.attributes.updatesByCluster[CLUSTER_LEVEL]).toBe(1);
      expect(m.attributes.updatesByCluster[CLUSTER_TEMP]).toBe(3);
    });
  });

  describe("Error Metrics", () => {
    it("should track total error count", () => {
      metrics.recordError("timeout");
      metrics.recordError("connection_lost");
      metrics.recordError("timeout");

      const m = metrics.getMetrics();
      expect(m.errors.total).toBe(3);
    });

    it("should track errors by type", () => {
      metrics.recordError("timeout");
      metrics.recordError("timeout");
      metrics.recordError("connection_lost");
      metrics.recordError("invalid_state");
      metrics.recordError("invalid_state");
      metrics.recordError("invalid_state");

      const m = metrics.getMetrics();
      expect(m.errors.byType.timeout).toBe(2);
      expect(m.errors.byType.connection_lost).toBe(1);
      expect(m.errors.byType.invalid_state).toBe(3);
    });

    it("should track error rate", () => {
      // 100 successful commands
      for (let i = 0; i < 100; i++) {
        metrics.recordCommand("on", 10, true);
      }
      // 10 errors
      for (let i = 0; i < 10; i++) {
        metrics.recordError("timeout");
      }

      const m = metrics.getMetrics();
      expect(m.errors.errorRate).toBeCloseTo(10, 1);
    });

    it("should track recovery count", () => {
      metrics.recordError("connection_lost");
      metrics.recordRecovery();
      metrics.recordError("timeout");
      metrics.recordRecovery();
      metrics.recordRecovery();

      const m = metrics.getMetrics();
      expect(m.errors.total).toBe(2);
      expect(m.errors.recoveries).toBe(3);
    });
  });

  describe("Uptime and Timing Metrics", () => {
    it("should track bridge start time", () => {
      const before = Date.now();
      const newMetrics = new BridgeMetricsCollector();
      const after = Date.now();

      const m = newMetrics.getMetrics();
      expect(m.uptime.startTime).toBeGreaterThanOrEqual(before);
      expect(m.uptime.startTime).toBeLessThanOrEqual(after);
    });

    it("should calculate uptime in seconds", async () => {
      const m1 = metrics.getMetrics();
      const initialUptime = m1.uptime.uptimeSec;

      await new Promise((resolve) => setTimeout(resolve, 100));

      const m2 = metrics.getMetrics();
      const finalUptime = m2.uptime.uptimeSec;

      expect(finalUptime).toBeGreaterThan(initialUptime);
    });

    it("should track last command time", () => {
      const before = Date.now();
      metrics.recordCommand("on", 10, true);
      const after = Date.now();

      const m = metrics.getMetrics();
      expect(m.uptime.lastCommandTime).toBeGreaterThanOrEqual(before);
      expect(m.uptime.lastCommandTime).toBeLessThanOrEqual(after);
    });
  });

  describe("Realistic Workload Simulation", () => {
    it("should collect metrics during typical operation", () => {
      // Simulate bridge startup with 10 endpoints
      for (let i = 0; i < 10; i++) {
        metrics.recordEndpointDiscovered(i % 2 === 0 ? "light" : "sensor");
        metrics.recordEndpointActive();
      }

      // Simulate command activity
      for (let i = 0; i < 100; i++) {
        const latency = Math.random() * 50; // 0-50ms
        const success = Math.random() > 0.05; // 95% success
        metrics.recordCommand("on", latency, success);
      }

      // Simulate attribute updates
      for (let i = 0; i < 500; i++) {
        const clusterId = 0x0006 + (Math.random() > 0.5 ? 0 : 2); // ON_OFF or LEVEL
        metrics.recordAttributeUpdate(clusterId);
        if (Math.random() > 0.8) {
          metrics.recordAttributeChange(clusterId);
        }
      }

      // Simulate recovery scenario
      metrics.recordError("connection_lost");
      for (let i = 0; i < 10; i++) {
        metrics.recordCommand("ping", 10, false);
      }
      metrics.recordRecovery();
      for (let i = 0; i < 20; i++) {
        metrics.recordCommand("on", 15, true);
      }

      const m = metrics.getMetrics();

      // Verify collected metrics
      expect(m.endpoints.total).toBe(10);
      expect(m.endpoints.active).toBe(10);
      expect(m.commands.total).toBeGreaterThan(100);
      expect(m.commands.successRate).toBeGreaterThan(85);
      expect(m.attributes.total).toBeGreaterThan(400);
      expect(m.errors.total).toBeGreaterThan(0);
      expect(m.errors.recoveries).toBeGreaterThan(0);
      expect(m.latencies.p95).toBeGreaterThan(0);
    });

    it("should provide comprehensive observability data", () => {
      // Build metrics through realistic operations
      const operationTypes = ["light", "light_color", "switch", "sensor"];
      for (const type of operationTypes) {
        metrics.recordEndpointDiscovered(type);
      }

      for (let i = 0; i < 50; i++) {
        metrics.recordCommand("on", 10 + Math.random() * 20, true);
        metrics.recordAttributeUpdate(0x0006);
        if (i % 10 === 0) {
          metrics.recordAttributeChange(0x0006);
        }
      }

      const m = metrics.getMetrics();

      // Verify all observability fields present
      expect(m.endpoints).toBeDefined();
      expect(m.commands).toBeDefined();
      expect(m.attributes).toBeDefined();
      expect(m.errors).toBeDefined();
      expect(m.latencies).toBeDefined();
      expect(m.uptime).toBeDefined();

      // Verify specific fields
      expect(m.endpoints.total).toBeGreaterThan(0);
      expect(m.commands.successRate).toBeGreaterThanOrEqual(0);
      expect(m.attributes.changeRate).toBeGreaterThanOrEqual(0);
      expect(m.latencies.min).toBeLessThanOrEqual(m.latencies.max);
    });
  });
});
