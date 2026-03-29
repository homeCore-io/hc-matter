import { EventEmitter } from "events";
import WebSocket from "ws";
import { Logger } from "./logger.js";

interface WsBridgeOptions {
  reconnectDelayMs?: number;
  maxReconnectAttempts?: number;
}

export class WebSocketBridge extends EventEmitter {
  private ws: WebSocket | null = null;
  private reconnectDelayMs: number;
  private maxReconnectAttempts: number;
  private reconnectCount = 0;
  private shouldReconnect = true;
  private logger: Logger;

  constructor(
    private wsUrl: string,
    options: WsBridgeOptions = {}
  ) {
    super();
    this.reconnectDelayMs = options.reconnectDelayMs ?? 5000;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 0; // 0 = infinite
    this.logger = new Logger("ws-bridge");
  }

  /**
   * Establish WebSocket connection to HomeCore MQTT bridge
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.logger.debug(`Connecting to ${this.wsUrl}`);
      this.shouldReconnect = true;

      this.ws = new WebSocket(this.wsUrl);
      let settled = false;

      this.ws.on("open", () => {
        settled = true;
        this.logger.info("WebSocket connected");
        this.reconnectCount = 0;
        this.emit("connected");
        resolve();
      });

      this.ws.on("message", (data: WebSocket.Data) => {
        try {
          const message = JSON.parse(data.toString());
          this.emit("message", message);
        } catch (error) {
          this.logger.error("Failed to parse WebSocket message", { error, data });
        }
      });

      this.ws.on("error", (error: Error) => {
        this.logger.error("WebSocket error", { error: error.message });
        this.emit("error", error);
        if (!settled) {
          settled = true;
          reject(error);
        }
      });

      this.ws.on("close", () => {
        this.logger.warn("WebSocket closed");
        this.emit("disconnected");
        if (this.shouldReconnect) {
          this.attemptReconnect();
        }
      });
    });
  }

  /**
   * Attempt to reconnect with exponential backoff
   */
  private attemptReconnect(): void {
    if (this.maxReconnectAttempts > 0 && this.reconnectCount >= this.maxReconnectAttempts) {
      this.logger.error("Max reconnection attempts reached; giving up");
      return;
    }

    this.reconnectCount++;
    const delay = this.reconnectDelayMs * Math.pow(1.5, this.reconnectCount - 1);
    this.logger.info(`Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${this.reconnectCount})`);

    setTimeout(() => {
      this.connect().catch((error) => {
        this.logger.error("Reconnection failed", { error });
      });
    }, delay);
  }

  /**
   * Publish MQTT message through WebSocket
   */
  async publish(topic: string, payload: unknown): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.logger.warn("WebSocket not connected; queueing message", { topic });
      return;
    }

    try {
      const message = {
        type: "publish",
        topic,
        payload,
      };
      this.ws.send(JSON.stringify(message));
      this.logger.debug("Published message", { topic });
    } catch (error) {
      this.logger.error("Failed to publish message", { topic, error });
    }
  }

  /**
   * Subscribe to MQTT topic through WebSocket
   */
  async subscribe(topic: string): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.logger.warn("WebSocket not connected; subscription queued", { topic });
      return;
    }

    try {
      const message = {
        type: "subscribe",
        topic,
      };
      this.ws.send(JSON.stringify(message));
      this.logger.debug("Subscribed to topic", { topic });
    } catch (error) {
      this.logger.error("Failed to subscribe to topic", { topic, error });
    }
  }

  /**
   * Register plugin with HomeCore
   */
  async register(pluginId: string, capabilities: string[], version: string): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.logger.warn("WebSocket not connected; registration queued");
      return;
    }

    try {
      const message = {
        type: "register",
        plugin_id: pluginId,
        capabilities,
        version,
      };
      this.ws.send(JSON.stringify(message));
      this.logger.debug("Registered plugin", { pluginId, capabilities });
    } catch (error) {
      this.logger.error("Failed to register plugin", { error });
    }
  }

  /**
   * Disconnect WebSocket
   */
  async disconnect(): Promise<void> {
    if (this.ws) {
      this.shouldReconnect = false;
      this.ws.close();
      this.ws = null;
      this.logger.info("WebSocket disconnected");
    }
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return (this.ws?.readyState ?? WebSocket.CLOSED) === WebSocket.OPEN;
  }
}
