use anyhow::Result;
use serde_json::json;
use std::path::PathBuf;
use tracing::info;

use crate::config::{MatterConfig, MatterRole};
use crate::fabric_store::{CommissionedNode, FabricStore};
use crate::homecore::HomecorePublisher;
use crate::mapper::{self, MatterDeviceClass};

// Force linkage against the selected MAT-003 crate from the rs-matter project.
#[cfg(feature = "matter-stack")]
use matter_rs as _;

pub struct SpikeRuntime {
    enabled: bool,
    role: MatterRole,
    test_node_id: String,
    bridge_endpoint_id: String,
    advertise_bridge_endpoint: bool,
    network_interface: Option<String>,
    storage_dir: PathBuf,
    fabric_store: FabricStore,
    commissioned_nodes: Vec<CommissionedNode>,
    store_warning: Option<String>,
    test_node_class: MatterDeviceClass,
    contact_sensor_id: String,
    occupancy_sensor_id: String,
    temperature_sensor_id: String,
    stack_probe: Option<serde_json::Value>,
    last_discovery: Option<serde_json::Value>,
    on: bool,
    brightness_pct: u8,
    contact_open: bool,
    occupied: bool,
    temperature_c: f64,
}

impl SpikeRuntime {
    pub async fn new(
        cfg: &MatterConfig,
        config_path: &str,
        publisher: &HomecorePublisher,
    ) -> Result<Self> {
        let storage_dir = cfg.resolve_storage_dir(config_path);
        let fabric_store = FabricStore::new(&storage_dir);
        let load = fabric_store.load_or_recover()?;

        let runtime = Self {
            enabled: cfg.matter.spike.enabled,
            role: cfg.matter.role.clone(),
            test_node_id: cfg.matter.spike.test_node_id.clone(),
            bridge_endpoint_id: cfg.matter.spike.bridge_endpoint_id.clone(),
            advertise_bridge_endpoint: cfg.matter.spike.advertise_bridge_endpoint,
            network_interface: cfg.matter.network.interface.clone(),
            storage_dir,
            fabric_store,
            commissioned_nodes: load.nodes,
            store_warning: load.warning,
            test_node_class: MatterDeviceClass::DimmableLight,
            contact_sensor_id: "matter_spike_contact_1".to_string(),
            occupancy_sensor_id: "matter_spike_occupancy_1".to_string(),
            temperature_sensor_id: "matter_spike_temp_1".to_string(),
            stack_probe: None,
            last_discovery: None,
            on: false,
            brightness_pct: 25,
            contact_open: false,
            occupied: false,
            temperature_c: 21.5,
        };

        if let Some(warning) = &runtime.store_warning {
            publisher
                .publish_event(
                    "plugin_metrics",
                    &json!({
                        "phase": "fabric_store_recovery",
                        "warning": warning,
                    }),
                )
                .await?;
        }

        publisher
            .publish_event(
                "plugin_metrics",
                &json!({
                    "phase": "fabric_store_loaded",
                    "nodes": runtime.commissioned_nodes.len(),
                }),
            )
            .await?;

        if !runtime.enabled {
            return Ok(runtime);
        }

        runtime.publish_bootstrap(publisher).await?;
        runtime.persist_snapshot()?;
        Ok(runtime)
    }

    pub fn enabled(&self) -> bool {
        self.enabled
    }

    pub fn set_stack_probe(&mut self, stack_probe: serde_json::Value) {
        self.stack_probe = Some(stack_probe);
    }

    pub fn controller_state(&self) -> serde_json::Value {
        json!({
            "spike_enabled": self.enabled,
            "node_id": self.test_node_id,
            "bridge_endpoint_id": self.bridge_endpoint_id,
            "commissioned": true,
            "on": self.on,
            "brightness_pct": self.brightness_pct,
            "role": format!("{:?}", self.role).to_lowercase(),
            "interview": self.interview_payload(),
            "commissioned_nodes": FabricStore::nodes_to_json(&self.commissioned_nodes),
            "fabric_store": {
                "node_count": self.commissioned_nodes.len(),
                "warning": self.store_warning,
            },
            "mapping": {
                "test_node_class": format!("{:?}", self.test_node_class),
            },
            "sensor_snapshot": {
                "contact_open": self.contact_open,
                "occupied": self.occupied,
                "temperature_c": self.temperature_c,
            },
            "matter_stack": self.stack_probe,
            "last_discovery": self.last_discovery,
        })
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
            "interview": self.interview_payload(),
        });
        publisher.publish_event("plugin_metrics", &payload).await?;
        self.persist_snapshot()
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

        let mapped = mapper::map_homecore_command(self.test_node_class, cmd);

        if let Some(on) = mapped.on {
            self.on = on;
        }

        if let Some(level) = mapped.level {
            self.brightness_pct = mapper::level_to_pct(level);
        }

        self.publish_mapped_node_state(publisher).await?;

        let payload = json!({
            "phase": "mapped_command_roundtrip",
            "node_id": self.test_node_id,
            "mapped": {
                "on": mapped.on,
                "level": mapped.level,
            },
            "state": {
                "on": self.on,
                "brightness_pct": self.brightness_pct,
            }
        });
        publisher.publish_event("plugin_metrics", &payload).await?;
        self.persist_snapshot()?;

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
                self.upsert_commissioned_node()?;
                let payload = json!({
                    "phase": "commission",
                    "node_id": self.test_node_id,
                    "result": "ok",
                    "persisted_nodes": self.commissioned_nodes.len(),
                });
                publisher.publish_event("plugin_metrics", &payload).await?;
            }
            "read" => {
                let mapped_state = self.current_homecore_state();
                let payload = json!({
                    "phase": "read_onoff_level_mapped",
                    "node_id": self.test_node_id,
                    "state": mapped_state,
                    "interview": self.interview_payload(),
                });
                publisher.publish_event("plugin_metrics", &payload).await?;
            }
            "interview" => {
                let payload = json!({
                    "phase": "interview",
                    "node_id": self.test_node_id,
                    "details": self.interview_payload(),
                });
                publisher.publish_event("plugin_metrics", &payload).await?;
            }
            "nodes" => {
                let payload = json!({
                    "phase": "inventory",
                    "count": self.commissioned_nodes.len(),
                    "nodes": FabricStore::nodes_to_json(&self.commissioned_nodes),
                });
                publisher.publish_event("plugin_metrics", &payload).await?;
            }
            "reinterview" => {
                let node_id = cmd
                    .get("node_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or(&self.test_node_id)
                    .to_string();

                let endpoint = cmd
                    .get("endpoint")
                    .and_then(|v| v.as_u64())
                    .map(|v| v.min(u16::MAX as u64) as u16)
                    .unwrap_or(1);

                let clusters: Vec<String> = cmd
                    .get("clusters")
                    .and_then(|v| v.as_array())
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(|v| v.as_str())
                            .map(|s| s.to_string())
                            .collect::<Vec<_>>()
                    })
                    .filter(|v| !v.is_empty())
                    .unwrap_or_else(|| vec!["OnOff".to_string(), "LevelControl".to_string()]);

                if node_id == self.test_node_id {
                    self.test_node_class = mapper::classify_from_clusters(&clusters);
                }

                self.commissioned_nodes = self
                    .fabric_store
                    .reinterview_node(&node_id, endpoint, &clusters)?;
                self.store_warning = None;

                let payload = json!({
                    "phase": "reinterview",
                    "node_id": node_id,
                    "endpoint": endpoint,
                    "clusters": clusters,
                    "persisted_nodes": self.commissioned_nodes.len(),
                });
                publisher.publish_event("plugin_metrics", &payload).await?;
            }
            "sensor_report" => {
                if let Some(open) = cmd.get("open").and_then(|v| v.as_bool()) {
                    self.contact_open = open;
                }
                if let Some(occupied) = cmd.get("occupied").and_then(|v| v.as_bool()) {
                    self.occupied = occupied;
                }
                if let Some(temp_c) = cmd.get("temperature_c").and_then(|v| v.as_f64()) {
                    self.temperature_c = temp_c;
                }

                self.publish_mapped_sensor_states(publisher).await?;

                let payload = json!({
                    "phase": "sensor_report_mapped",
                    "contact_open": self.contact_open,
                    "occupied": self.occupied,
                    "temperature_c": self.temperature_c,
                });
                publisher.publish_event("plugin_metrics", &payload).await?;
            }
            "remove_node" | "delete_node" => {
                let node_id = cmd
                    .get("node_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or(&self.test_node_id)
                    .to_string();

                let (nodes, removed) = self.fabric_store.remove_node(&node_id)?;
                self.commissioned_nodes = nodes;
                self.store_warning = None;

                let payload = json!({
                    "phase": "remove_node",
                    "node_id": node_id,
                    "removed": removed,
                    "persisted_nodes": self.commissioned_nodes.len(),
                });
                publisher.publish_event("plugin_metrics", &payload).await?;
            }
            "toggle" => {
                self.on = !self.on;
                self.publish_mapped_node_state(publisher).await?;
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
            "discover" => {
                let timeout_ms = cmd
                    .get("timeout_ms")
                    .and_then(|v| v.as_u64())
                    .map(|v| v.min(10_000) as u32)
                    .unwrap_or(2_000);

                let discovery = match crate::matter_stack::discover_commissionable(
                    timeout_ms,
                    self.network_interface.as_deref(),
                )
                .await
                {
                    Ok(v) => v,
                    Err(e) => json!({
                        "ok": false,
                        "timeout_ms": timeout_ms,
                        "error": e.to_string(),
                    }),
                };

                self.last_discovery = Some(discovery.clone());

                let payload = json!({
                    "phase": "discover_commissionable",
                    "details": discovery,
                });
                publisher.publish_event("plugin_metrics", &payload).await?;
            }
            _ => {}
        }

        publisher
            .publish_state("matter_controller", &self.controller_state())
            .await?;
        self.persist_snapshot()?;

        Ok(())
    }

    fn interview_payload(&self) -> serde_json::Value {
        json!({
            "endpoint": 1,
            "clusters": ["OnOff", "LevelControl"],
            "bridge_endpoint": {
                "id": self.bridge_endpoint_id,
                "advertised": self.advertise_bridge_endpoint,
            }
        })
    }

    fn current_homecore_state(&self) -> serde_json::Value {
        let matter_attrs = mapper::synthetic_matter_attributes(self.on, self.brightness_pct);
        mapper::map_matter_attributes(self.test_node_class, &matter_attrs)
    }

    async fn publish_mapped_node_state(&self, publisher: &HomecorePublisher) -> Result<()> {
        publisher
            .publish_state(&self.test_node_id, &self.current_homecore_state())
            .await
    }

    async fn publish_mapped_sensor_states(&self, publisher: &HomecorePublisher) -> Result<()> {
        let contact_attrs = mapper::synthetic_contact_attributes(self.contact_open);
        let contact_state = mapper::map_matter_attributes(MatterDeviceClass::ContactSensor, &contact_attrs);
        publisher.publish_state(&self.contact_sensor_id, &contact_state).await?;

        let occupancy_attrs = mapper::synthetic_occupancy_attributes(self.occupied);
        let occupancy_state =
            mapper::map_matter_attributes(MatterDeviceClass::OccupancySensor, &occupancy_attrs);
        publisher
            .publish_state(&self.occupancy_sensor_id, &occupancy_state)
            .await?;

        let temp_attrs = mapper::synthetic_temperature_attributes(self.temperature_c);
        let temp_state =
            mapper::map_matter_attributes(MatterDeviceClass::TemperatureMeasurement, &temp_attrs);
        publisher
            .publish_state(&self.temperature_sensor_id, &temp_state)
            .await?;

        Ok(())
    }

    fn persist_snapshot(&self) -> Result<()> {
        let snapshot_path = self.storage_dir.join("spike_state.json");
        let payload = json!({
            "node_id": self.test_node_id,
            "bridge_endpoint_id": self.bridge_endpoint_id,
            "on": self.on,
            "brightness_pct": self.brightness_pct,
            "commissioned_nodes": FabricStore::nodes_to_json(&self.commissioned_nodes),
            "fabric_store_warning": self.store_warning,
            "controller": self.controller_state(),
        });
        std::fs::write(&snapshot_path, serde_json::to_vec_pretty(&payload)?)?;
        Ok(())
    }

    fn upsert_commissioned_node(&mut self) -> Result<()> {
        self.commissioned_nodes = self.fabric_store.upsert_node(
            &self.test_node_id,
            1,
            &["OnOff", "LevelControl"],
        )?;
        self.test_node_class = MatterDeviceClass::DimmableLight;
        self.store_warning = None;
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

        self.publish_mapped_node_state(publisher).await?;

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

        publisher
            .register_device_typed(
                &self.contact_sensor_id,
                "Matter Spike Contact Sensor",
                "contact_sensor",
                None,
            )
            .await?;
        publisher
            .register_device_typed(
                &self.occupancy_sensor_id,
                "Matter Spike Occupancy Sensor",
                "motion_sensor",
                None,
            )
            .await?;
        publisher
            .register_device_typed(
                &self.temperature_sensor_id,
                "Matter Spike Temperature Sensor",
                "temperature_sensor",
                None,
            )
            .await?;

        self.publish_mapped_sensor_states(publisher).await?;

        Ok(())
    }
}
