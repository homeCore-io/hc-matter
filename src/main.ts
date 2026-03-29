import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { Logger, initializeLogger } from "./logger.js";
import { loadConfig } from "./config.js";
import { WebSocketBridge } from "./ws-bridge.js";
import { MatterController } from "./controller/index.js";
import { MatterBridge } from "./bridge/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let logger: Logger;
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_SECS = 60;
const METRICS_INTERVAL_MS = 30000;

/**
 * Main entry point for hc-matter plugin.
 *
 * CLI usage:
 *   node dist/main.js [config_path]
 *
 * Environment variables:
 *   - WS_URL: override homecore.ws_url
 *   - HC_MATTER_STORE_KEY: encryption key for secure fabric store
 */
async function main(): Promise<void> {
  const configPath =
    process.argv[2] || join(dirname(__dirname), "config", "homecore-matter.toml");

  // Initialize logger before config to catch config errors
  logger = new Logger("hc-matter");
  logger.info(`Starting hc-matter plugin (config: ${configPath})`);

  // Load configuration
  let config;
  try {
    config = await loadConfig(configPath);
    logger = initializeLogger(config.logging.level, config.logging.file_path);
  } catch (error) {
    logger.error("Failed to load configuration", { error });
    process.exit(1);
  }

  logger.info(`Configuration loaded`, {
    ws_url: config.homecore.ws_url,
    controller_enabled: config.controller.enabled,
    bridge_enabled: config.bridge.enabled,
  });

  // Create WebSocket bridge
  const wsBridge = new WebSocketBridge(config.homecore.ws_url, {
    reconnectDelayMs: config.homecore.reconnect_delay_secs * 1000,
    maxReconnectAttempts: config.homecore.max_reconnect_attempts,
  });

  // Create controller and bridge (will start after WS connects)
  let controller: MatterController | null = null;
  let bridge: MatterBridge | null = null;
  let metricsTimer: NodeJS.Timeout | null = null;
  let componentsInitialized = false;

  const stopMetricsTimer = () => {
    if (metricsTimer) {
      clearInterval(metricsTimer);
      metricsTimer = null;
    }
  };

  const publishPluginStatus = async (status: string, extra: Record<string, unknown> = {}) => {
    await wsBridge.publish("homecore/plugins/matter/status", {
      status,
      controller_enabled: config.controller.enabled,
      bridge_enabled: config.bridge.enabled,
      timestamp: new Date().toISOString(),
      ...extra,
    });
  };

  const publishPluginMetrics = async () => {
    if (!controller) {
      return;
    }

    const controllerMetrics = await controller.getMetrics();
    const bridgeMetrics = bridge?.getMetrics() ?? {
      bridge_enabled: config.bridge.enabled,
      bridge_started: false,
      bridged_endpoints: 0,
      bridged_endpoints_with_state: 0,
      bridge_reconnect_restores: 0,
    };

    await wsBridge.publish("homecore/plugins/matter/metrics", {
      ...controllerMetrics,
      ...bridgeMetrics,
      timestamp: new Date().toISOString(),
    });
  };

  // Setup lifecycle handlers
  const gracefulShutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down gracefully...`);

    if (controller) {
      try {
        await controller.stop();
      } catch (error) {
        logger.error("Error stopping controller", { error });
      }
    }
    if (bridge) {
      try {
        await bridge.stop();
      } catch (error) {
        logger.error("Error stopping bridge", { error });
      }
    }
    try {
      stopMetricsTimer();

      if (wsBridge.isConnected()) {
        await publishPluginStatus("stopping", { signal });
      }

      await wsBridge.disconnect();
    } catch (error) {
      logger.error("Error disconnecting WebSocket", { error });
    }

    process.exit(0);
  };

  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));

  // Start WebSocket bridge
  wsBridge.on("connected", async () => {
    logger.info("Connected to HomeCore MQTT bridge");

    try {
      if (!componentsInitialized) {
        // Initialize controller if enabled
        if (config.controller.enabled) {
          controller = new MatterController(config.matter, wsBridge, logger);
          await controller.start();
        }

        // Initialize bridge if enabled
        if (config.bridge.enabled) {
          if (!controller) {
            logger.warn(
              "Bridge requires controller to be enabled; skipping bridge init"
            );
          } else {
            bridge = new MatterBridge(config.bridge, controller, wsBridge, logger);
            await bridge.start();
          }
        }

        componentsInitialized = true;
      }

      // Publish plugin status
      await publishPluginStatus("active");
      await publishPluginMetrics();

      stopMetricsTimer();
      metricsTimer = setInterval(() => {
        publishPluginMetrics().catch((error) => {
          logger.warn("Failed to publish plugin metrics", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }, METRICS_INTERVAL_MS);

      logger.info("Plugin initialized successfully");
    } catch (error) {
      logger.error("Failed to initialize plugin components", { error });
      process.exit(1);
    }
  });

  wsBridge.on("disconnected", () => {
    stopMetricsTimer();
    logger.warn("Disconnected from HomeCore MQTT bridge");
  });

  wsBridge.on("error", (error) => {
    logger.warn("WebSocket bridge emitted error", {
      error: error instanceof Error ? error.message : String(error),
    });
  });

  // Start WebSocket connection with retry logic
  let attempt = 1;
  while (attempt <= MAX_ATTEMPTS) {
    try {
      await wsBridge.connect();
      return; // Success
    } catch (error) {
      if (attempt < MAX_ATTEMPTS) {
        logger.error(`Connection attempt ${attempt} failed; retrying in ${RETRY_DELAY_SECS}s`, {
          error,
        });
        await new Promise((resolve) =>
          setTimeout(resolve, RETRY_DELAY_SECS * 1000)
        );
        attempt++;
      } else {
        logger.error(
          `Connection failed after ${MAX_ATTEMPTS} attempts; exiting`,
          { error }
        );
        process.exit(1);
      }
    }
  }
}

main().catch((error) => {
  if (logger) {
    logger.error("Unhandled error in main", { error });
  } else {
    console.error("Unhandled error before logger init", error);
  }
  process.exit(1);
});
