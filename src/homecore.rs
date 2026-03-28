use anyhow::{Context, Result};
use rumqttc::{AsyncClient, Event, MqttOptions, Packet, QoS};
use serde_json::Value;
use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::sync::RwLock;
use tracing::{error, info, warn};

use crate::config::HomecoreConfig;

#[derive(Clone)]
pub struct HomecorePublisher {
    client: AsyncClient,
    plugin_id: String,
    command_subscriptions: Arc<RwLock<HashSet<String>>>,
    subscription_reconnects: Arc<AtomicU64>,
}

impl HomecorePublisher {
    pub async fn publish_state(&self, device_id: &str, state: &Value) -> Result<()> {
        let topic = format!("homecore/devices/{device_id}/state");
        let payload = serde_json::to_vec(state)?;
        self.client
            .publish(&topic, QoS::AtLeastOnce, true, payload)
            .await
            .context("publish_state failed")
    }

    pub async fn subscribe_commands(&self, device_id: &str) -> Result<()> {
        let topic = format!("homecore/devices/{device_id}/cmd");
        {
            let mut subs = self.command_subscriptions.write().await;
            subs.insert(topic.clone());
        }
        self.client
            .subscribe(&topic, QoS::AtLeastOnce)
            .await
            .context("subscribe_commands failed")
    }

    pub async fn publish_event(&self, event_type: &str, payload: &Value) -> Result<()> {
        let topic = format!("homecore/events/{event_type}");
        self.client
            .publish(&topic, QoS::AtLeastOnce, false, serde_json::to_vec(payload)?)
            .await
            .context("publish_event failed")
    }

    pub async fn register_device_typed(
        &self,
        device_id: &str,
        name: &str,
        device_type: &str,
        area: Option<&str>,
    ) -> Result<()> {
        let topic = format!("homecore/plugins/{}/register", self.plugin_id);
        let mut payload = serde_json::json!({
            "device_id": device_id,
            "plugin_id": self.plugin_id,
            "name": name,
            "device_type": device_type,
        });

        if let Some(a) = area {
            payload["area"] = Value::String(a.to_string());
        }

        self.client
            .publish(&topic, QoS::AtLeastOnce, false, serde_json::to_vec(&payload)?)
            .await
            .context("register_device_typed failed")
    }

    pub async fn publish_plugin_status(&self, status: &str) -> Result<()> {
        let topic = format!("homecore/plugins/{}/status", self.plugin_id);
        self.client
            .publish(&topic, QoS::AtLeastOnce, true, status.as_bytes())
            .await
            .context("publish_plugin_status failed")
    }

    pub fn subscription_reconnects(&self) -> u64 {
        self.subscription_reconnects.load(Ordering::Relaxed)
    }
}

pub struct HomecoreClient {
    client: AsyncClient,
    eventloop: rumqttc::EventLoop,
    plugin_id: String,
    command_subscriptions: Arc<RwLock<HashSet<String>>>,
    subscription_reconnects: Arc<AtomicU64>,
}

impl HomecoreClient {
    pub async fn connect(cfg: &HomecoreConfig) -> Result<Self> {
        let mut opts = MqttOptions::new(&cfg.plugin_id, &cfg.broker_host, cfg.broker_port);
        opts.set_keep_alive(Duration::from_secs(30));
        opts.set_clean_session(true);

        if !cfg.password.is_empty() {
            opts.set_credentials(&cfg.plugin_id, &cfg.password);
        }

        let (client, eventloop) = AsyncClient::new(opts, 64);
        let command_subscriptions = Arc::new(RwLock::new(HashSet::new()));
        let subscription_reconnects = Arc::new(AtomicU64::new(0));
        info!(
            host = %cfg.broker_host,
            port = cfg.broker_port,
            plugin_id = %cfg.plugin_id,
            "HomeCore MQTT client created"
        );

        Ok(Self {
            client,
            eventloop,
            plugin_id: cfg.plugin_id.clone(),
            command_subscriptions,
            subscription_reconnects,
        })
    }

    pub fn publisher(&self) -> HomecorePublisher {
        HomecorePublisher {
            client: self.client.clone(),
            plugin_id: self.plugin_id.clone(),
            command_subscriptions: Arc::clone(&self.command_subscriptions),
            subscription_reconnects: Arc::clone(&self.subscription_reconnects),
        }
    }

    pub async fn run(mut self, tx: mpsc::Sender<(String, Value)>) -> Result<()> {
        info!("HomeCore MQTT event loop starting");
        let mut connected_once = false;
        loop {
            match self.eventloop.poll().await {
                Ok(Event::Incoming(Packet::ConnAck(_))) => {
                    info!("Connected to HomeCore broker");
                    if connected_once {
                        self.subscription_reconnects
                            .fetch_add(1, Ordering::Relaxed);
                    }
                    connected_once = true;

                    if let Err(e) = resubscribe_command_topics(
                        self.client.clone(),
                        Arc::clone(&self.command_subscriptions),
                    )
                    .await
                    {
                        warn!(error = %e, "Failed to re-subscribe command topics after reconnect");
                    }
                }
                Ok(Event::Incoming(Packet::Publish(p))) => {
                    let parts: Vec<&str> = p.topic.splitn(4, '/').collect();
                    if parts.len() == 4
                        && parts[0] == "homecore"
                        && parts[1] == "devices"
                        && parts[3] == "cmd"
                    {
                        let device_id = parts[2].to_string();
                        match serde_json::from_slice::<Value>(&p.payload) {
                            Ok(cmd) => {
                                if tx.send((device_id, cmd)).await.is_err() {
                                    return Ok(());
                                }
                            }
                            Err(e) => {
                                warn!(topic = %p.topic, error = %e, "Non-JSON cmd payload");
                            }
                        }
                    }
                }
                Ok(_) => {}
                Err(e) => {
                    error!(error = %e, "HomeCore MQTT error; retrying in 2 s");
                    tokio::time::sleep(Duration::from_secs(2)).await;
                }
            }
        }
    }

}

async fn resubscribe_command_topics(
    client: AsyncClient,
    command_subscriptions: Arc<RwLock<HashSet<String>>>,
) -> Result<()> {
    let topics: Vec<String> = {
        let subs = command_subscriptions.read().await;
        subs.iter().cloned().collect()
    };

    for topic in topics {
        client
            .subscribe(&topic, QoS::AtLeastOnce)
            .await
            .with_context(|| format!("re-subscribing to topic: {topic}"))?;
    }

    Ok(())
}
