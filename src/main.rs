mod config;
mod fabric_store;
mod homecore;
mod matter_stack;
mod spike;

use anyhow::{Context, Result};
use serde_json::json;
use std::path::Path;
use std::time::Duration;
use tokio::sync::mpsc;
use tracing::{error, info, warn};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter, Layer};

use config::MatterConfig;
use spike::SpikeRuntime;

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

    if let Err(e) = ensure_storage_layout(&cfg, &config_path) {
        error!(error = %e, path = %config_path, "Failed to prepare Matter storage directory");
        std::process::exit(1);
    }

    for attempt in 1..=MAX_ATTEMPTS {
        info!(attempt, max = MAX_ATTEMPTS, "Starting hc-matter plugin");
        match try_start(&cfg, &config_path).await {
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

async fn try_start(cfg: &MatterConfig, config_path: &str) -> Result<()> {
    info!(
        role = ?cfg.matter.role,
        storage_dir = %cfg.matter.storage_dir,
        vendor_id = cfg.matter.commissioner.vendor_id,
        product_id = cfg.matter.commissioner.product_id,
        interface = ?cfg.matter.network.interface,
        "Matter runtime configuration loaded"
    );

    let hc_client = homecore::HomecoreClient::connect(&cfg.homecore)
        .await
        .context("connecting to HomeCore MQTT")?;
    let publisher = hc_client.publisher();

    let (cmd_tx, mut cmd_rx) = mpsc::channel::<(String, serde_json::Value)>(64);
    let mut mqtt_task = tokio::spawn(hc_client.run(cmd_tx));

    let mut spike_runtime = SpikeRuntime::new(cfg, config_path, &publisher)
        .await
        .context("initializing MAT-003 spike runtime")?;

    let stack_probe = matter_stack::probe(cfg).context("running matter-stack probe")?;
    spike_runtime.set_stack_probe(stack_probe.clone());

    let probe_path = cfg.resolve_storage_dir(config_path).join("matter_stack_probe.json");
    std::fs::write(&probe_path, serde_json::to_vec_pretty(&stack_probe)?)
        .with_context(|| format!("writing matter-stack probe file: {}", probe_path.display()))?;

    publisher
        .publish_event(
            "plugin_metrics",
            &json!({
                "phase": "matter_stack_probe",
                "details": stack_probe,
            }),
        )
        .await
        .context("publishing matter-stack probe event")?;

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
        .subscribe_commands(BOOTSTRAP_DEVICE_ID)
        .await
        .context("subscribing controller command topic")?;

    if spike_runtime.enabled() {
        publisher
            .publish_state(BOOTSTRAP_DEVICE_ID, &spike_runtime.controller_state())
            .await
            .context("publishing controller spike state")?;
    }

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
                match maybe_cmd {
                    Some((device_id, cmd)) => {
                        if let Err(e) = spike_runtime
                            .handle_command(&device_id, &cmd, &publisher)
                            .await
                        {
                            warn!(error = %e, device_id = %device_id, "MAT-003 spike command handling failed");
                        }
                    }
                    None => {
                        warn!("Command channel closed; terminating plugin loop");
                        break;
                    }
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

                if spike_runtime.enabled() {
                    if let Err(e) = spike_runtime.on_heartbeat(&publisher).await {
                        warn!(error = %e, "MAT-003 spike heartbeat publish failed");
                    }
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

fn ensure_storage_layout(cfg: &MatterConfig, config_path: &str) -> Result<()> {
    let storage_dir = cfg.resolve_storage_dir(config_path);
    std::fs::create_dir_all(&storage_dir)
        .with_context(|| format!("creating storage dir: {}", storage_dir.display()))?;

    set_strict_permissions(&storage_dir)?;

    Ok(())
}

#[cfg(unix)]
fn set_strict_permissions(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;

    let perms = std::fs::Permissions::from_mode(0o700);
    std::fs::set_permissions(path, perms)
        .with_context(|| format!("setting permissions 0700 on {}", path.display()))?;
    Ok(())
}

#[cfg(not(unix))]
fn set_strict_permissions(_path: &Path) -> Result<()> {
    Ok(())
}
