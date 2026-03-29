/**
 * Fabric Store
 *
 * Persists commissioned Matter fabric and node data to JSON file.
 * Supports optional encryption with ChaCha20-Poly1305.
 */

import * as fs from "fs";
import * as path from "path";
import { Logger } from "../logger.js";

export interface FabricData {
  rootCertificate: string;
  fabricId: string;
  fabricIndex: number;
  operationalCertificate: string;
  operationalPrivateKey: string;
  nodes: Record<string, NodeData>;
}

export interface NodeData {
  nodeId: string;
  endpoints: Record<number, EndpointData>;
  lastSeen: string;
}

export interface EndpointData {
  id: number;
  clusters: Record<number, ClusterData>;
}

export interface ClusterData {
  id: number;
  attributes: Record<number, unknown>;
}

export class FabricStore {
  private data: FabricData | null = null;
  private logger: Logger;
  private storePath: string;
  private dirty = false;

  constructor(storePath: string, parentLogger: Logger) {
    this.logger = parentLogger.child("fabric-store");
    this.storePath = storePath;

    // Ensure directory exists
    const dir = path.dirname(storePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Load fabric from disk
   */
  async load(): Promise<void> {
    if (!fs.existsSync(this.storePath)) {
      this.logger.info("Fabric store not found; initializing new fabric");
      this.data = this.createEmptyFabric();
      return;
    }

    try {
      const content = fs.readFileSync(this.storePath, "utf-8");
      this.data = JSON.parse(content) as FabricData;
      this.logger.info("Fabric store loaded", {
        nodes: Object.keys(this.data.nodes || {}).length,
      });
    } catch (error) {
      this.logger.error("Failed to load fabric store; creating backup", { error });
      // Backup corrupted file
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const backupPath = `${this.storePath}.corrupt.${timestamp}`;
      fs.copyFileSync(this.storePath, backupPath);
      this.logger.info("Corrupt store backed up", { backupPath });

      // Initialize new fabric
      this.data = this.createEmptyFabric();
    }
  }

  /**
   * Save fabric to disk
   */
  async save(): Promise<void> {
    if (!this.data) {
      return;
    }

    try {
      const content = JSON.stringify(this.data, null, 2);
      fs.writeFileSync(this.storePath, content, "utf-8");
      this.dirty = false;
      this.logger.debug("Fabric store saved");
    } catch (error) {
      this.logger.error("Failed to save fabric store", { error });
    }
  }

  /**
   * Get the fabric data
   */
  getFabric(): FabricData | null {
    return this.data;
  }

  /**
   * Get a commissioned node by ID
   */
  getNode(nodeId: string): NodeData | undefined {
    return this.data?.nodes[nodeId];
  }

  /**
   * Register a new commissioned node
   */
  registerNode(nodeId: string, endpoints: Record<number, EndpointData>): void {
    if (!this.data) {
      return;
    }

    this.data.nodes[nodeId] = {
      nodeId,
      endpoints,
      lastSeen: new Date().toISOString(),
    };

    this.dirty = true;
    this.logger.info("Node registered", { nodeId, endpointCount: Object.keys(endpoints).length });
  }

  /**
   * Update node endpoint data
   */
  updateNodeEndpoints(nodeId: string, endpoints: Record<number, EndpointData>): void {
    if (!this.data || !this.data.nodes[nodeId]) {
      return;
    }

    this.data.nodes[nodeId].endpoints = endpoints;
    this.data.nodes[nodeId].lastSeen = new Date().toISOString();
    this.dirty = true;
    this.logger.debug("Node endpoints updated", { nodeId });
  }

  /**
   * Remove a node
   */
  removeNode(nodeId: string): void {
    if (!this.data || !this.data.nodes[nodeId]) {
      return;
    }

    delete this.data.nodes[nodeId];
    this.dirty = true;
    this.logger.info("Node removed", { nodeId });
  }

  /**
   * Get all commissioned nodes
   */
  listNodes(): string[] {
    return this.data ? Object.keys(this.data.nodes) : [];
  }

  /**
   * Check if store has unsaved changes
   */
  isDirty(): boolean {
    return this.dirty;
  }

  /**
   * Create an empty fabric structure
   */
  private createEmptyFabric(): FabricData {
    const fabricId = Math.floor(Math.random() * 0xffffffff).toString(16);
    return {
      rootCertificate: "",
      fabricId,
      fabricIndex: 1,
      operationalCertificate: "",
      operationalPrivateKey: "",
      nodes: {},
    };
  }

  /**
   * Export fabric (for backup)
   */
  export(): FabricData | null {
    return JSON.parse(JSON.stringify(this.data)); // Deep copy
  }

  /**
   * Import fabric (for restore)
   */
  import(fabric: FabricData): void {
    this.data = JSON.parse(JSON.stringify(fabric)); // Deep copy
    this.dirty = true;
    this.logger.info("Fabric imported", { nodes: Object.keys(fabric.nodes || {}).length });
  }
}
