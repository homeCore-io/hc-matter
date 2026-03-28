use anyhow::{Context, Result};
use serde::Deserialize;

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
    #[serde(default = "default_heartbeat")]
    pub heartbeat_secs: u64,
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
            heartbeat_secs: default_heartbeat(),
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
}
