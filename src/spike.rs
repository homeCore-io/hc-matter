use anyhow::Result;
use serde_json::json;
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, Instant};
use tracing::info;

use crate::bridge::{self, BridgeCandidate, BridgedEndpoint};
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
    bridge_cfg: crate::config::BridgeConfig,
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
    last_published_state: HashMap<String, serde_json::Value>,
    dedup_suppressed_updates: u64,
    recent_applied_commands: HashMap<String, RecentAppliedCommand>,
    loop_prevented_writes: u64,
    subscription_reconnects: u64,
    command_count: u64,
    command_latency_total_ms: u64,
    last_command_latency_ms: u64,
    failed_commands: u64,
    last_error: Option<String>,
}

struct RecentAppliedCommand {
    signature: String,
    origin: String,
    correlation_id: Option<String>,
    seen_at: Instant,
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

        let mut runtime = Self {
            enabled: cfg.matter.spike.enabled,
            role: cfg.matter.role.clone(),
            test_node_id: cfg.matter.spike.test_node_id.clone(),
            bridge_endpoint_id: cfg.matter.spike.bridge_endpoint_id.clone(),
            advertise_bridge_endpoint: cfg.matter.spike.advertise_bridge_endpoint,
            network_interface: cfg.matter.network.interface.clone(),
            storage_dir,
            fabric_store,
            bridge_cfg: cfg.matter.bridge.clone(),
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
            last_published_state: HashMap::new(),
            dedup_suppressed_updates: 0,
            recent_applied_commands: HashMap::new(),
            loop_prevented_writes: 0,
            subscription_reconnects: 0,
            command_count: 0,
            command_latency_total_ms: 0,
            last_command_latency_ms: 0,
            failed_commands: 0,
            last_error: None,
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
        let health_errors = self.health_errors();
        let status = if health_errors.is_empty() {
            "ok"
        } else {
            "degraded"
        };

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
            "bridge": {
                "selection": {
                    "include_ids": self.bridge_cfg.include_ids,
                    "exclude_ids": self.bridge_cfg.exclude_ids,
                    "device_type_filter": self.bridge_cfg.device_type_filter,
                    "area_filter": self.bridge_cfg.area_filter,
                },
                "endpoints": self.bridged_endpoints_json(),
            },
            "sensor_snapshot": {
                "contact_open": self.contact_open,
                "occupied": self.occupied,
                "temperature_c": self.temperature_c,
            },
            "dedup": {
                "suppressed_updates": self.dedup_suppressed_updates,
                "loop_prevented_writes": self.loop_prevented_writes,
            },
            "metrics": {
                "commissioned_nodes": self.commissioned_nodes.len(),
                "bridged_endpoints": self.bridged_endpoints().len(),
                "subscription_reconnects": self.subscription_reconnects,
                "command_latency_ms": self.last_command_latency_ms,
                "failed_commands": self.failed_commands,
                "avg_command_latency_ms": self.average_command_latency_ms(),
            },
            "health": {
                "status": status,
                "errors": health_errors,
                "last_error": self.last_error,
            },
            "matter_stack": self.stack_probe,
            "last_discovery": self.last_discovery,
        })
    }

    pub async fn on_heartbeat(&mut self, publisher: &HomecorePublisher) -> Result<()> {
        if !self.enabled {
            return Ok(());
        }

        self.subscription_reconnects = publisher.subscription_reconnects();

        let payload = json!({
            "phase": "spike_heartbeat",
            "node_id": self.test_node_id,
            "bridge_endpoint_id": self.bridge_endpoint_id,
            "on": self.on,
            "brightness_pct": self.brightness_pct,
            "role": format!("{:?}", self.role).to_lowercase(),
            "interview": self.interview_payload(),
            "dedup_suppressed_updates": self.dedup_suppressed_updates,
            "loop_prevented_writes": self.loop_prevented_writes,
        });
        publisher.publish_event("plugin_metrics", &payload).await?;

        self.emit_ops_metrics(publisher).await?;

        self.persist_snapshot()
    }

    pub fn plugin_status(&self) -> &'static str {
        if self.health_errors().is_empty() {
            "active"
        } else {
            "degraded"
        }
    }

    pub fn record_failed_command(&mut self, device_id: &str, error: &str) {
        self.failed_commands = self.failed_commands.saturating_add(1);
        self.last_error = Some(format!("device={device_id}: {error}"));
    }

    pub async fn handle_command(
        &mut self,
        device_id: &str,
        cmd: &serde_json::Value,
        publisher: &HomecorePublisher,
    ) -> Result<()> {
        let started = Instant::now();

        if !self.enabled {
            return Ok(());
        }

        self.subscription_reconnects = publisher.subscription_reconnects();

        if device_id == "matter_controller" {
            self.handle_controller_command(cmd, publisher).await?;
            self.record_command_latency(started.elapsed());
            return Ok(());
        }

        if !self.is_bridged_light_endpoint(device_id) {
            return Ok(());
        }

        let mapped = mapper::map_homecore_command(self.test_node_class, cmd);
        let command_signature = command_signature(&mapped);
        let origin = extract_origin(cmd);
        let correlation_id = extract_correlation_id(cmd);

        if self.should_prevent_bridge_loop(
            &self.test_node_id,
            &origin,
            &correlation_id,
            &command_signature,
        ) {
            self.loop_prevented_writes = self.loop_prevented_writes.saturating_add(1);
            let payload = json!({
                "phase": "loop_prevented",
                "reason": "bridge_echo_duplicate",
                "node_id": device_id,
                "source_node_id": self.test_node_id,
                "origin": origin,
                "correlation_id": correlation_id,
                "mapped": {
                    "on": mapped.on,
                    "level": mapped.level,
                }
            });
            publisher.publish_event("plugin_metrics", &payload).await?;
            self.record_command_latency(started.elapsed());
            return Ok(());
        }

        if let Some(on) = mapped.on {
            self.on = on;
        }

        if let Some(level) = mapped.level {
            self.brightness_pct = mapper::level_to_pct(level);
        }

        self.publish_mapped_node_state(publisher).await?;
        self.publish_bridged_light_states(publisher).await?;

        let source_node_id = self.test_node_id.clone();
        self.record_applied_command(
            &source_node_id,
            command_signature,
            origin.clone(),
            correlation_id.clone(),
        );

        let payload = json!({
            "phase": "mapped_command_roundtrip",
            "node_id": device_id,
            "source_node_id": self.test_node_id,
            "origin": origin,
            "correlation_id": correlation_id,
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
        self.record_command_latency(started.elapsed());
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
                self.publish_bridge_inventory(publisher).await?;
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

    fn bridge_candidates(&self) -> Vec<BridgeCandidate> {
        let mut candidates = vec![
            BridgeCandidate {
                device_id: self.test_node_id.clone(),
                name: "Matter Spike Node".to_string(),
                device_type: "light".to_string(),
                area: Some("office".to_string()),
            },
            BridgeCandidate {
                device_id: self.contact_sensor_id.clone(),
                name: "Matter Spike Contact Sensor".to_string(),
                device_type: "contact_sensor".to_string(),
                area: Some("entryway".to_string()),
            },
            BridgeCandidate {
                device_id: self.occupancy_sensor_id.clone(),
                name: "Matter Spike Occupancy Sensor".to_string(),
                device_type: "motion_sensor".to_string(),
                area: Some("hallway".to_string()),
            },
            BridgeCandidate {
                device_id: self.temperature_sensor_id.clone(),
                name: "Matter Spike Temperature Sensor".to_string(),
                device_type: "temperature_sensor".to_string(),
                area: Some("hallway".to_string()),
            },
        ];

        if self.advertise_bridge_endpoint {
            candidates.push(BridgeCandidate {
                device_id: self.bridge_endpoint_id.clone(),
                name: "Matter Spike Bridge Endpoint".to_string(),
                device_type: "light".to_string(),
                area: Some("bridge".to_string()),
            });
        }

        candidates
    }

    fn bridged_endpoints(&self) -> Vec<BridgedEndpoint> {
        bridge::select_bridged_endpoints(&self.bridge_cfg, &self.bridge_candidates())
    }

    fn is_bridged_light_endpoint(&self, device_id: &str) -> bool {
        self.bridged_endpoints().iter().any(|e| {
            e.candidate.device_id == device_id
                && e.candidate.device_type.eq_ignore_ascii_case("light")
        })
    }

    fn bridged_light_ids(&self) -> Vec<String> {
        self.bridged_endpoints()
            .into_iter()
            .filter(|e| e.candidate.device_type.eq_ignore_ascii_case("light"))
            .map(|e| e.candidate.device_id)
            .collect()
    }

    fn bridged_sensor_endpoints(&self) -> Vec<BridgedEndpoint> {
        self.bridged_endpoints()
            .into_iter()
            .filter(|e| {
                let t = e.candidate.device_type.as_str();
                t.eq_ignore_ascii_case("contact_sensor")
                    || t.eq_ignore_ascii_case("motion_sensor")
                    || t.eq_ignore_ascii_case("temperature_sensor")
            })
            .collect()
    }

    fn sensor_state_for_type(&self, device_type: &str) -> Option<serde_json::Value> {
        if device_type.eq_ignore_ascii_case("contact_sensor") {
            let attrs = mapper::synthetic_contact_attributes(self.contact_open);
            return Some(mapper::map_matter_attributes(
                MatterDeviceClass::ContactSensor,
                &attrs,
            ));
        }

        if device_type.eq_ignore_ascii_case("motion_sensor") {
            let attrs = mapper::synthetic_occupancy_attributes(self.occupied);
            return Some(mapper::map_matter_attributes(
                MatterDeviceClass::OccupancySensor,
                &attrs,
            ));
        }

        if device_type.eq_ignore_ascii_case("temperature_sensor") {
            let attrs = mapper::synthetic_temperature_attributes(self.temperature_c);
            return Some(mapper::map_matter_attributes(
                MatterDeviceClass::TemperatureMeasurement,
                &attrs,
            ));
        }

        None
    }

    fn bridged_endpoints_json(&self) -> serde_json::Value {
        json!(
            self.bridged_endpoints()
                .into_iter()
                .map(|e| {
                    json!({
                        "device_id": e.candidate.device_id,
                        "name": e.candidate.name,
                        "device_type": e.candidate.device_type,
                        "area": e.candidate.area,
                        "endpoint_id": e.endpoint_id,
                    })
                })
                .collect::<Vec<_>>()
        )
    }

    async fn publish_bridge_inventory(&mut self, publisher: &HomecorePublisher) -> Result<()> {
        let endpoints = self.bridged_endpoints();
        for endpoint in &endpoints {
            publisher
                .register_device_typed(
                    &endpoint.candidate.device_id,
                    &endpoint.candidate.name,
                    &endpoint.candidate.device_type,
                    endpoint.candidate.area.as_deref(),
                )
                .await?;

            if endpoint.candidate.device_type.eq_ignore_ascii_case("light") {
                publisher
                    .subscribe_commands(&endpoint.candidate.device_id)
                    .await?;
            }
        }

        let payload = json!({
            "phase": "bridge_advertise",
            "bridged_endpoints": endpoints
                .iter()
                .map(|e| json!({
                    "device_id": e.candidate.device_id,
                    "endpoint_id": e.endpoint_id,
                }))
                .collect::<Vec<_>>(),
            "count": endpoints.len(),
        });
        publisher.publish_event("plugin_metrics", &payload).await?;

        self.emit_ops_metrics(publisher).await?;

        Ok(())
    }

    async fn emit_ops_metrics(&self, publisher: &HomecorePublisher) -> Result<()> {
        let payload = json!({
            "phase": "ops_metrics",
            "commissioned_nodes": self.commissioned_nodes.len(),
            "bridged_endpoints": self.bridged_endpoints().len(),
            "subscription_reconnects": self.subscription_reconnects,
            "command_latency_ms": self.last_command_latency_ms,
            "failed_commands": self.failed_commands,
            "avg_command_latency_ms": self.average_command_latency_ms(),
        });
        publisher.publish_event("plugin_metrics", &payload).await
    }

    fn average_command_latency_ms(&self) -> u64 {
        if self.command_count == 0 {
            return 0;
        }
        self.command_latency_total_ms / self.command_count
    }

    fn health_errors(&self) -> Vec<serde_json::Value> {
        let mut errors = Vec::new();

        if let Some(warning) = &self.store_warning {
            errors.push(json!({
                "code": "fabric_store_warning",
                "message": warning,
                "action": "Inspect data/matter/fabric_store*.json and reconcile corrupted snapshots.",
            }));
        }

        if let Some(last_error) = &self.last_error {
            errors.push(json!({
                "code": "command_failure",
                "message": last_error,
                "action": "Inspect command payload origin/correlation_id and plugin logs for bridge loop or mapping failures.",
            }));
        }

        errors
    }

    fn record_command_latency(&mut self, latency: Duration) {
        let latency_ms = latency.as_millis().min(u64::MAX as u128) as u64;
        self.last_command_latency_ms = latency_ms;
        self.command_count = self.command_count.saturating_add(1);
        self.command_latency_total_ms = self.command_latency_total_ms.saturating_add(latency_ms);
    }

    async fn publish_mapped_node_state(&mut self, publisher: &HomecorePublisher) -> Result<()> {
        let state = self.current_homecore_state();
        let node_id = self.test_node_id.clone();
        let _ = self
            .publish_state_dedup(publisher, &node_id, &state)
            .await?;
        Ok(())
    }

    async fn publish_bridged_light_states(&mut self, publisher: &HomecorePublisher) -> Result<()> {
        let state = self.current_homecore_state();
        let light_ids = self.bridged_light_ids();
        for device_id in light_ids {
            let _ = self
                .publish_state_dedup(publisher, &device_id, &state)
                .await?;
        }
        Ok(())
    }

    async fn publish_mapped_sensor_states(&mut self, publisher: &HomecorePublisher) -> Result<()> {
        for endpoint in self.bridged_sensor_endpoints() {
            if let Some(state) = self.sensor_state_for_type(&endpoint.candidate.device_type) {
                let _ = self
                    .publish_state_dedup(publisher, &endpoint.candidate.device_id, &state)
                    .await?;
            }
        }

        Ok(())
    }

    async fn publish_state_dedup(
        &mut self,
        publisher: &HomecorePublisher,
        device_id: &str,
        state: &serde_json::Value,
    ) -> Result<bool> {
        if let Some(previous) = self.last_published_state.get(device_id) {
            if previous == state {
                self.dedup_suppressed_updates = self.dedup_suppressed_updates.saturating_add(1);
                return Ok(false);
            }
        }

        publisher.publish_state(device_id, state).await?;
        self.last_published_state
            .insert(device_id.to_string(), state.clone());
        Ok(true)
    }

    fn should_prevent_bridge_loop(
        &self,
        source_node_id: &str,
        origin: &str,
        correlation_id: &Option<String>,
        signature: &str,
    ) -> bool {
        if !is_bridge_origin(origin) {
            return false;
        }

        let Some(previous) = self.recent_applied_commands.get(source_node_id) else {
            return false;
        };

        if previous.signature != signature {
            return false;
        }

        if !is_bridge_origin(&previous.origin) {
            return false;
        }

        if correlation_id.is_some() && previous.correlation_id == *correlation_id {
            return true;
        }

        previous.seen_at.elapsed() <= Duration::from_millis(1000)
    }

    fn record_applied_command(
        &mut self,
        source_node_id: &str,
        signature: String,
        origin: String,
        correlation_id: Option<String>,
    ) {
        self.recent_applied_commands.insert(
            source_node_id.to_string(),
            RecentAppliedCommand {
                signature,
                origin,
                correlation_id,
                seen_at: Instant::now(),
            },
        );
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

    async fn publish_bootstrap(&mut self, publisher: &HomecorePublisher) -> Result<()> {
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
        self.publish_bridged_light_states(publisher).await?;

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

        self.publish_bridge_inventory(publisher).await?;

        self.publish_mapped_sensor_states(publisher).await?;

        Ok(())
    }
}

fn command_signature(mapped: &mapper::MappedMatterCommand) -> String {
    format!("on={:?};level={:?}", mapped.on, mapped.level)
}

fn extract_origin(cmd: &serde_json::Value) -> String {
    cmd.get("origin")
        .and_then(|v| v.as_str())
        .or_else(|| cmd.get("source").and_then(|v| v.as_str()))
        .unwrap_or("homecore")
        .to_string()
}

fn extract_correlation_id(cmd: &serde_json::Value) -> Option<String> {
    cmd.get("correlation_id")
        .and_then(|v| v.as_str())
        .or_else(|| cmd.get("correlationId").and_then(|v| v.as_str()))
        .or_else(|| cmd.get("trace_id").and_then(|v| v.as_str()))
        .or_else(|| cmd.get("request_id").and_then(|v| v.as_str()))
        .map(|s| s.to_string())
}

fn is_bridge_origin(origin: &str) -> bool {
    origin.eq_ignore_ascii_case("matter_bridge")
        || origin.eq_ignore_ascii_case("bridge")
        || origin.eq_ignore_ascii_case("matter")
        || origin.to_ascii_lowercase().contains("bridge")
}
