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
    pub bridge: BridgeConfig,
    #[serde(default)]
    pub security: SecurityConfig,
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
    #[serde(default = "default_commissioner_backend")]
    pub backend: String,
    #[serde(default = "default_commissioner_binary")]
    pub binary: String,
    #[serde(default = "default_commissioner_timeout_secs")]
    pub timeout_secs: u64,
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

#[derive(Debug, Clone, Deserialize)]
pub struct BridgeConfig {
    #[serde(default)]
    pub include_ids: Vec<String>,
    #[serde(default)]
    pub exclude_ids: Vec<String>,
    #[serde(default)]
    pub device_type_filter: Option<String>,
    #[serde(default)]
    pub area_filter: Option<String>,
    #[serde(default = "default_endpoint_id_salt")]
    pub endpoint_id_salt: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SecurityConfig {
    #[serde(default)]
    pub key_provider: KeyProvider,
    #[serde(default = "default_key_env_var")]
    pub key_env_var: String,
    #[serde(default = "default_backup_dir")]
    pub backup_dir: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KeyProvider {
    Plaintext,
    Env,
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

fn default_commissioner_backend() -> String {
    "chip-tool".into()
}

fn default_commissioner_binary() -> String {
    "chip-tool".into()
}

fn default_commissioner_timeout_secs() -> u64 {
    90
}

fn default_spike_node_id() -> String {
    "matter_spike_node_1".into()
}

fn default_spike_endpoint_id() -> String {
    "matter_spike_bridge_1".into()
}

fn default_endpoint_id_salt() -> String {
    "plugin.matter".into()
}

fn default_key_env_var() -> String {
    "HC_MATTER_STORE_KEY".into()
}

fn default_backup_dir() -> String {
    "backups".into()
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
            bridge: BridgeConfig::default(),
            security: SecurityConfig::default(),
            spike: SpikeConfig::default(),
        }
    }
}

impl Default for CommissionerConfig {
    fn default() -> Self {
        Self {
            vendor_id: default_vendor_id(),
            product_id: default_product_id(),
            backend: default_commissioner_backend(),
            binary: default_commissioner_binary(),
            timeout_secs: default_commissioner_timeout_secs(),
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

impl Default for BridgeConfig {
    fn default() -> Self {
        Self {
            include_ids: Vec::new(),
            exclude_ids: Vec::new(),
            device_type_filter: None,
            area_filter: None,
            endpoint_id_salt: default_endpoint_id_salt(),
        }
    }
}

impl Default for SecurityConfig {
    fn default() -> Self {
        Self {
            key_provider: KeyProvider::Plaintext,
            key_env_var: default_key_env_var(),
            backup_dir: default_backup_dir(),
        }
    }
}

impl Default for KeyProvider {
    fn default() -> Self {
        Self::Plaintext
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

    pub fn resolve_backup_dir(&self, config_path: &str) -> PathBuf {
        let candidate = PathBuf::from(&self.matter.security.backup_dir);
        if candidate.is_absolute() {
            return candidate;
        }

        let config_dir = Path::new(config_path)
            .parent()
            .unwrap_or_else(|| Path::new("."));
        config_dir.join(candidate)
    }
}
