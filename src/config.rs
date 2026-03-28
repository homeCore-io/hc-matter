use anyhow::{Context, Result};
use serde::Deserialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Deserialize)]
pub struct MatterConfig {
    #[serde(default)]
    pub homecore: HomecoreConfig,
    #[serde(default)]
    pub matter: MatterRuntimeConfig,
}

#[derive(Debug, Clone, Deserialize)]
pub struct HomecoreConfig {
    #[serde(default = "default_host")]
    pub broker_host: String,
    #[serde(default = "default_port")]
    pub broker_port: u16,
    #[serde(default = "default_plugin_id")]
    pub plugin_id: String,
    #[serde(default)]
    pub password: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MatterRuntimeConfig {
    #[serde(default)]
    pub role: MatterRole,
    #[serde(default = "default_storage_dir")]
    pub storage_dir: String,
    #[serde(default = "default_heartbeat")]
    pub heartbeat_secs: u64,
    #[serde(default)]
    pub commissioner: CommissionerConfig,
    #[serde(default)]
    pub network: NetworkConfig,
    #[serde(default)]
    pub spike: SpikeConfig,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MatterRole {
    Controller,
    Bridge,
    Both,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CommissionerConfig {
    #[serde(default = "default_vendor_id")]
    pub vendor_id: u16,
    #[serde(default = "default_product_id")]
    pub product_id: u16,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct NetworkConfig {
    #[serde(default)]
    pub interface: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SpikeConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_spike_node_id")]
    pub test_node_id: String,
    #[serde(default = "default_spike_endpoint_id")]
    pub bridge_endpoint_id: String,
    #[serde(default)]
    pub advertise_bridge_endpoint: bool,
}

fn default_host() -> String {
    "127.0.0.1".into()
}

fn default_port() -> u16 {
    1883
}

fn default_plugin_id() -> String {
    "plugin.matter".into()
}

fn default_heartbeat() -> u64 {
    30
}

fn default_storage_dir() -> String {
    "data/matter".into()
}

fn default_vendor_id() -> u16 {
    0xFFF1
}

fn default_product_id() -> u16 {
    0x8000
}

fn default_spike_node_id() -> String {
    "matter_spike_node_1".into()
}

fn default_spike_endpoint_id() -> String {
    "matter_spike_bridge_1".into()
}

impl Default for HomecoreConfig {
    fn default() -> Self {
        Self {
            broker_host: default_host(),
            broker_port: default_port(),
            plugin_id: default_plugin_id(),
            password: String::new(),
        }
    }
}

impl Default for MatterRuntimeConfig {
    fn default() -> Self {
        Self {
            role: MatterRole::Both,
            storage_dir: default_storage_dir(),
            heartbeat_secs: default_heartbeat(),
            commissioner: CommissionerConfig::default(),
            network: NetworkConfig::default(),
            spike: SpikeConfig::default(),
        }
    }
}

impl Default for CommissionerConfig {
    fn default() -> Self {
        Self {
            vendor_id: default_vendor_id(),
            product_id: default_product_id(),
        }
    }
}

impl Default for MatterRole {
    fn default() -> Self {
        Self::Both
    }
}

impl Default for SpikeConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            test_node_id: default_spike_node_id(),
            bridge_endpoint_id: default_spike_endpoint_id(),
            advertise_bridge_endpoint: true,
        }
    }
}

impl Default for MatterConfig {
    fn default() -> Self {
        Self {
            homecore: HomecoreConfig::default(),
            matter: MatterRuntimeConfig::default(),
        }
    }
}

impl MatterConfig {
    pub fn load(path: &str) -> Result<Self> {
        let content = std::fs::read_to_string(path)
            .with_context(|| format!("reading config: {path}"))?;
        toml::from_str(&content).with_context(|| format!("parsing config: {path}"))
    }

    pub fn resolve_storage_dir(&self, config_path: &str) -> PathBuf {
        let candidate = PathBuf::from(&self.matter.storage_dir);
        if candidate.is_absolute() {
            return candidate;
        }

        let config_dir = Path::new(config_path)
            .parent()
            .unwrap_or_else(|| Path::new("."));
        config_dir.join(candidate)
    }
}
