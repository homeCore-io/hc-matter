// The connection to matter-server's WebSocket API, over its unix socket.
//
// One MatterClient per connection: when the server restarts, the socket
// closes, and this connects again (with backoff) as soon as the supervisor
// says the new one is listening.

import { MatterClient, type MatterNode, type NodesChangedDetail } from "@matter-server/ws-client";
import WebSocket from "ws";
import type { NodeData } from "./devices.js";
import type { Log } from "./server.js";

export interface LinkEvents {
  /** Connected, with every node the server has. */
  onNodes(nodes: NodeData[]): void;
  onNodeChanged(detail: NodesChangedDetail, node: NodeData | null): void;
  onDown(): void;
}

export function nodeDataOf(node: MatterNode): NodeData {
  return {
    node_id: node.node_id,
    available: node.available,
    is_bridge: node.is_bridge,
    attributes: node.attributes,
    endpoint_parents: node.endpoint_parents,
    date_commissioned: node.date_commissioned,
    last_interview: node.last_interview,
  };
}

/** A node id from text: a bigint where a number would lose digits. */
export function parseNodeId(id: string | number | bigint): number | bigint {
  if (typeof id !== "string") return id;
  if (!/^\d+$/.test(id)) throw new Error(`not a node id: ${id}`);
  const n = Number(id);
  return Number.isSafeInteger(n) ? n : BigInt(id);
}

export class MatterLink {
  client: MatterClient | null = null;
  private retry: NodeJS.Timeout | null = null;
  private backoff = 500;
  private closed = false;

  constructor(private readonly socket: string, private readonly log: Log, private readonly events: LinkEvents) {}

  get connected(): boolean {
    return this.client !== null;
  }

  /** Connect now; on failure, keep trying. */
  connect(): void {
    if (this.closed || this.client) return;
    if (this.retry) {
      clearTimeout(this.retry);
      this.retry = null;
    }
    const url = `ws+unix://${this.socket}:/ws`;
    const client = new MatterClient(url, {
      wsFactory: (u: string) => new WebSocket(u) as never,
      logger: {
        debug: () => {},
        info: (m: string) => this.log("debug", `matter link: ${m}`),
        warn: (m: string) => this.log("warn", `matter link: ${m}`),
        error: (m: string) => this.log("error", `matter link: ${m}`),
      },
    });
    client.addEventListener("connection_lost", () => this.lost(client));
    client.addEventListener("server_shutdown", () => this.lost(client));
    client.addEventListener("nodes_changed", (detail) => {
      if (this.client !== client) return;
      const node = client.nodes[String(detail.nodeId)];
      this.events.onNodeChanged(detail, node ? nodeDataOf(node) : null);
    });
    client
      .startListening()
      .then(() => {
        if (this.closed) return client.disconnect();
        this.client = client;
        this.backoff = 500;
        const info = client.serverInfo;
        this.log("info", `connected to ${info.sdk_version}, schema ${info.schema_version}, fabric ${String(info.compressed_fabric_id)}`);
        this.events.onNodes(Object.values(client.nodes).map(nodeDataOf));
      })
      .catch((e: Error) => {
        this.log("debug", `matter-server is not answering yet: ${e.message}`);
        try {
          client.disconnect();
        } catch {
          // already closed
        }
        this.schedule();
      });
  }

  private lost(client: MatterClient): void {
    if (this.client !== client) return;
    this.client = null;
    this.log("warn", "lost the connection to matter-server");
    this.events.onDown();
    this.schedule();
  }

  private schedule(): void {
    if (this.closed || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      this.connect();
    }, this.backoff);
    this.backoff = Math.min(10_000, this.backoff * 2);
  }

  close(): void {
    this.closed = true;
    if (this.retry) clearTimeout(this.retry);
    const c = this.client;
    this.client = null;
    c?.disconnect();
  }
}
