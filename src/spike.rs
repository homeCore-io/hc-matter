use anyhow::Result;
use serde_json::json;
use tracing::info;

use crate::config::{MatterConfig, MatterRole};
use crate::homecore::HomecorePublisher;

// Force linkage against the selected MAT-003 crate from the rs-matter project.
use matter_rs as _;

pub struct SpikeRuntime {
    enabled: bool,
    role: MatterRole,
    test_node_id: String,
    bridge_endpoint_id: String,
    advertise_bridge_endpoint: bool,
    on: bool,
    brightness_pct: u8,
}

impl SpikeRuntime {
    pub fn controller_state(&self) -> serde_json::Value {
        json!({
            "spike_enabled": self.enabled,
            "node_id": self.test_node_id,
            "bridge_endpoint_id": self.bridge_endpoint_id,
            "commissioned": true,
            "on": self.on,
            "brightness_pct": self.brightness_pct,
            "role": format!("{:?}", self.role).to_lowercase(),
        })
    }

    pub async fn new(cfg: &MatterConfig, publisher: &HomecorePublisher) -> Result<Self> {
        let runtime = Self {
            enabled: cfg.matter.spike.enabled,
            role: cfg.matter.role.clone(),
            test_node_id: cfg.matter.spike.test_node_id.clone(),
            bridge_endpoint_id: cfg.matter.spike.bridge_endpoint_id.clone(),
            advertise_bridge_endpoint: cfg.matter.spike.advertise_bridge_endpoint,
            on: false,
            brightness_pct: 25,
        };

        if !runtime.enabled {
            return Ok(runtime);
        }

        runtime.publish_bootstrap(publisher).await?;
        Ok(runtime)
    }

    pub fn enabled(&self) -> bool {
        self.enabled
    }

    pub async fn on_heartbeat(&self, publisher: &HomecorePublisher) -> Result<()> {
        if !self.enabled {
            return Ok(());
        }

        let payload = json!({
            "phase": "spike_heartbeat",
            "node_id": self.test_node_id,
            "bridge_endpoint_id": self.bridge_endpoint_id,
            "on": self.on,
            "brightness_pct": self.brightness_pct,
            "role": format!("{:?}", self.role).to_lowercase(),
        });
        publisher.publish_event("plugin_metrics", &payload).await
    }

    pub async fn handle_command(
        &mut self,
        device_id: &str,
        cmd: &serde_json::Value,
        publisher: &HomecorePublisher,
    ) -> Result<()> {
        if !self.enabled {
            return Ok(());
        }

        if device_id == "matter_controller" {
            return self.handle_controller_command(cmd, publisher).await;
        }

        if device_id != self.test_node_id {
            return Ok(());
        }

        if let Some(on) = cmd.get("on").and_then(|v| v.as_bool()) {
            self.on = on;
        }

        if let Some(brightness_pct) = cmd.get("brightness_pct").and_then(|v| v.as_u64()) {
            self.brightness_pct = brightness_pct.min(100) as u8;
        }

        publisher
            .publish_state(
                &self.test_node_id,
                &json!({
                    "on": self.on,
                    "brightness_pct": self.brightness_pct,
                }),
            )
            .await?;

        let payload = json!({
            "phase": "command_roundtrip",
            "node_id": self.test_node_id,
            "on": self.on,
            "brightness_pct": self.brightness_pct,
        });
        publisher.publish_event("plugin_metrics", &payload).await?;

        Ok(())
    }

    async fn handle_controller_command(
        &mut self,
        cmd: &serde_json::Value,
        publisher: &HomecorePublisher,
    ) -> Result<()> {
        let action = cmd
            .get("action")
            .and_then(|v| v.as_str())
            .unwrap_or("read");

        match action {
            "commission" => {
                self.publish_bootstrap(publisher).await?;
                let payload = json!({
                    "phase": "commission",
                    "node_id": self.test_node_id,
                    "result": "ok",
                });
                publisher.publish_event("plugin_metrics", &payload).await?;
            }
            "read" => {
                let payload = json!({
                    "phase": "read_onoff_level",
                    "node_id": self.test_node_id,
                    "on": self.on,
                    "brightness_pct": self.brightness_pct,
                });
                publisher.publish_event("plugin_metrics", &payload).await?;
            }
            "toggle" => {
                self.on = !self.on;
                publisher
                    .publish_state(
                        &self.test_node_id,
                        &json!({
                            "on": self.on,
                            "brightness_pct": self.brightness_pct,
                        }),
                    )
                    .await?;
                let payload = json!({
                    "phase": "toggle_onoff",
                    "node_id": self.test_node_id,
                    "on": self.on,
                });
                publisher.publish_event("plugin_metrics", &payload).await?;
            }
            "advertise_bridge" => {
                if self.advertise_bridge_endpoint {
                    publisher
                        .register_device_typed(
                            &self.bridge_endpoint_id,
                            "Matter Spike Bridge Endpoint",
                            "light",
                            None,
                        )
                        .await?;
                    let payload = json!({
                        "phase": "bridge_advertise",
                        "bridge_endpoint_id": self.bridge_endpoint_id,
                        "result": "ok",
                    });
                    publisher.publish_event("plugin_metrics", &payload).await?;
                }
            }
            _ => {}
        }

        publisher
            .publish_state("matter_controller", &self.controller_state())
            .await?;

        Ok(())
    }

    async fn publish_bootstrap(&self, publisher: &HomecorePublisher) -> Result<()> {
        info!(
            node_id = %self.test_node_id,
            bridge_endpoint_id = %self.bridge_endpoint_id,
            "MAT-003 spike mode enabled"
        );

        publisher
            .register_device_typed(&self.test_node_id, "Matter Spike Node", "light", None)
            .await?;
        publisher.subscribe_commands(&self.test_node_id).await?;

        publisher
            .publish_state(
                &self.test_node_id,
                &json!({
                    "on": self.on,
                    "brightness_pct": self.brightness_pct,
                }),
            )
            .await?;

        let commissioned_payload = json!({
            "phase": "commission",
            "node_id": self.test_node_id,
            "on": self.on,
            "brightness_pct": self.brightness_pct,
            "note": "spike node commissioned (simulated while matter-rs wiring is in progress)",
        });
        publisher
            .publish_event("plugin_metrics", &commissioned_payload)
            .await?;

        if self.advertise_bridge_endpoint {
            publisher
                .register_device_typed(
                    &self.bridge_endpoint_id,
                    "Matter Spike Bridge Endpoint",
                    "light",
                    None,
                )
                .await?;
            publisher
                .publish_state(
                    &self.bridge_endpoint_id,
                    &json!({
                        "on": false,
                        "brightness_pct": 0,
                    }),
                )
                .await?;

            let bridge_payload = json!({
                "phase": "bridge_advertise",
                "bridge_endpoint_id": self.bridge_endpoint_id,
            });
            publisher
                .publish_event("plugin_metrics", &bridge_payload)
                .await?;
        }

        Ok(())
    }
}
