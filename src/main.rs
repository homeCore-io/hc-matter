mod config;
mod homecore;

use anyhow::{Context, Result};
use std::time::Duration;
use tokio::sync::mpsc;
use tracing::{error, info, warn};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter, Layer};

use config::MatterConfig;

const MAX_ATTEMPTS: u32 = 3;
const RETRY_DELAY_SECS: u64 = 60;
const BOOTSTRAP_DEVICE_ID: &str = "matter_controller";
const BOOTSTRAP_DEVICE_NAME: &str = "Matter Controller";
const BOOTSTRAP_DEVICE_TYPE: &str = "bridge";

#[tokio::main]
async fn main() {
    let config_path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "config/config.toml".to_string());

    let _log_guard = init_logging(&config_path);

    let cfg = match MatterConfig::load(&config_path) {
        Ok(c) => c,
        Err(e) => {
            error!(error = %e, path = %config_path, "Failed to load config");
            std::process::exit(1);
        }
    };

    for attempt in 1..=MAX_ATTEMPTS {
        info!(attempt, max = MAX_ATTEMPTS, "Starting hc-matter plugin");
        match try_start(&cfg).await {
            Ok(()) => return,
            Err(e) => {
                if attempt < MAX_ATTEMPTS {
                    error!(error = %e, attempt, "Startup failed; retrying in {RETRY_DELAY_SECS} s");
                    tokio::time::sleep(Duration::from_secs(RETRY_DELAY_SECS)).await;
                } else {
                    error!(error = %e, "Startup failed after {MAX_ATTEMPTS} attempts; exiting");
                    std::process::exit(1);
                }
            }
        }
    }
}

fn init_logging(config_path: &str) -> tracing_appender::non_blocking::WorkerGuard {
    let log_dir = std::path::Path::new(config_path)
        .parent()
        .and_then(|p| p.parent())
        .map(|p| p.join("logs"))
        .unwrap_or_else(|| std::path::PathBuf::from("logs"));
    std::fs::create_dir_all(&log_dir).ok();

    let file_appender = tracing_appender::rolling::daily(&log_dir, "hc-matter.log");
    let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);

    let stderr_filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| {
        "hc_matter=info,rumqttc=warn"
            .parse()
            .expect("valid static env filter")
    });
    let file_filter = EnvFilter::new("debug");

    let stderr_layer = tracing_subscriber::fmt::layer()
        .with_writer(std::io::stderr)
        .with_filter(stderr_filter);

    let file_layer = tracing_subscriber::fmt::layer()
        .with_writer(non_blocking)
        .with_ansi(false)
        .with_filter(file_filter);

    tracing_subscriber::registry()
        .with(stderr_layer)
        .with(file_layer)
        .init();

    guard
}

async fn try_start(cfg: &MatterConfig) -> Result<()> {
    let hc_client = homecore::HomecoreClient::connect(&cfg.homecore)
        .await
        .context("connecting to HomeCore MQTT")?;
    let publisher = hc_client.publisher();

    let (cmd_tx, mut cmd_rx) = mpsc::channel::<(String, serde_json::Value)>(64);
    let mut mqtt_task = tokio::spawn(hc_client.run(cmd_tx));

    publisher
        .register_device_typed(
            BOOTSTRAP_DEVICE_ID,
            BOOTSTRAP_DEVICE_NAME,
            BOOTSTRAP_DEVICE_TYPE,
            None,
        )
        .await
        .context("publishing bootstrap registration")?;

    publisher
        .publish_plugin_status("active")
        .await
        .context("publishing startup status")?;

    info!("hc-matter skeleton is online");

    let heartbeat_secs = cfg.matter.heartbeat_secs.max(5);
    let mut heartbeat = tokio::time::interval(Duration::from_secs(heartbeat_secs));

    loop {
        tokio::select! {
            maybe_cmd = cmd_rx.recv() => {
                if maybe_cmd.is_none() {
                    warn!("Command channel closed; terminating plugin loop");
                    break;
                }
            }
            _ = heartbeat.tick() => {
                if let Err(e) = publisher
                    .register_device_typed(
                        BOOTSTRAP_DEVICE_ID,
                        BOOTSTRAP_DEVICE_NAME,
                        BOOTSTRAP_DEVICE_TYPE,
                        None,
                    )
                    .await
                {
                    warn!(error = %e, "Failed to publish heartbeat registration");
                }

                if let Err(e) = publisher.publish_plugin_status("active").await {
                    warn!(error = %e, "Failed to publish heartbeat status");
                }
            }
            mqtt_result = &mut mqtt_task => {
                match mqtt_result {
                    Ok(Ok(())) => {
                        warn!("MQTT event loop exited cleanly");
                        break;
                    }
                    Ok(Err(e)) => {
                        return Err(anyhow::anyhow!("MQTT event loop failed: {e}"));
                    }
                    Err(e) => {
                        return Err(anyhow::anyhow!("MQTT task join failure: {e}"));
                    }
                }
            }
            _ = shutdown_signal() => {
                info!("Shutdown signal received; stopping hc-matter");
                break;
            }
        }
    }

    let _ = publisher.publish_plugin_status("offline").await;

    Ok(())
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};

        let mut sigterm = signal(SignalKind::terminate()).expect("SIGTERM handler setup failed");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {},
            _ = sigterm.recv() => {},
        }
    }

    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
