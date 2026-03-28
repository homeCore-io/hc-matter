use anyhow::{Context, Result};
use base64::Engine;
use chacha20poly1305::aead::{Aead, AeadCore, KeyInit, OsRng};
use chacha20poly1305::{ChaCha20Poly1305, Nonce};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::Digest;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::config::{KeyProvider, SecurityConfig};

const STORE_VERSION: u32 = 1;
const STORE_FILE: &str = "fabric_store.json";
const STORE_ALGORITHM: &str = "chacha20poly1305";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommissionedNode {
    pub node_id: String,
    pub commissioned_at_unix: u64,
    pub last_interview_unix: u64,
    #[serde(default)]
    pub endpoint: u16,
    #[serde(default)]
    pub clusters: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct FabricStoreDoc {
    version: u32,
    #[serde(default)]
    nodes: Vec<CommissionedNode>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct EncryptedFabricStoreDoc {
    version: u32,
    algorithm: String,
    nonce_b64: String,
    ciphertext_b64: String,
}

impl Default for FabricStoreDoc {
    fn default() -> Self {
        Self {
            version: STORE_VERSION,
            nodes: Vec::new(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct LoadResult {
    pub nodes: Vec<CommissionedNode>,
    pub warning: Option<String>,
}

#[derive(Debug, Clone)]
pub struct FabricStore {
    path: PathBuf,
    security: SecurityConfig,
}

impl FabricStore {
    pub fn new(storage_dir: &Path, security: SecurityConfig) -> Self {
        Self {
            path: storage_dir.join(STORE_FILE),
            security,
        }
    }

    pub fn load_or_recover(&self) -> Result<LoadResult> {
        if !self.path.exists() {
            return Ok(LoadResult {
                nodes: Vec::new(),
                warning: None,
            });
        }

        let raw = std::fs::read(&self.path)
            .with_context(|| format!("reading fabric store: {}", self.path.display()))?;

        if let Ok(doc) = serde_json::from_slice::<EncryptedFabricStoreDoc>(&raw) {
            let decrypted = self.decrypt_doc(&doc)?;
            let doc: FabricStoreDoc = serde_json::from_slice(&decrypted).with_context(|| {
                format!(
                    "parsing decrypted fabric store: {}",
                    self.path.display()
                )
            })?;

            let original_len = doc.nodes.len();
            let mut warning = None;
            let nodes = normalize_nodes(doc.nodes);

            if nodes.len() != original_len {
                warning = Some("fabric store had duplicate node entries; normalized on load".to_string());
                self.save_nodes(&nodes)?;
            }

            return Ok(LoadResult { nodes, warning });
        }

        match serde_json::from_slice::<FabricStoreDoc>(&raw) {
            Ok(doc) => {
                let original_len = doc.nodes.len();
                let mut warning = None;
                let nodes = normalize_nodes(doc.nodes);

                if nodes.len() != original_len {
                    warning = Some("fabric store had duplicate node entries; normalized on load".to_string());
                    self.save_nodes(&nodes)?;
                }

                Ok(LoadResult { nodes, warning })
            }
            Err(e) => {
                let corrupt_path = self.corrupt_path();
                std::fs::rename(&self.path, &corrupt_path).with_context(|| {
                    format!(
                        "moving corrupt fabric store {} -> {}",
                        self.path.display(),
                        corrupt_path.display()
                    )
                })?;

                let warning = format!(
                    "fabric store was corrupt and has been quarantined at {} ({})",
                    corrupt_path.display(),
                    e
                );

                Ok(LoadResult {
                    nodes: Vec::new(),
                    warning: Some(warning),
                })
            }
        }
    }

    pub fn upsert_node(
        &self,
        node_id: &str,
        endpoint: u16,
        clusters: &[&str],
    ) -> Result<Vec<CommissionedNode>> {
        let mut nodes = self.load_or_recover()?.nodes;
        let now = unix_now();

        if let Some(existing) = nodes.iter_mut().find(|n| n.node_id == node_id) {
            existing.last_interview_unix = now;
            existing.endpoint = endpoint;
            existing.clusters = clusters.iter().map(|c| (*c).to_string()).collect();
        } else {
            nodes.push(CommissionedNode {
                node_id: node_id.to_string(),
                commissioned_at_unix: now,
                last_interview_unix: now,
                endpoint,
                clusters: clusters.iter().map(|c| (*c).to_string()).collect(),
            });
        }

        self.save_nodes(&nodes)?;
        Ok(nodes)
    }

    pub fn reinterview_node(
        &self,
        node_id: &str,
        endpoint: u16,
        clusters: &[String],
    ) -> Result<Vec<CommissionedNode>> {
        let cluster_refs: Vec<&str> = clusters.iter().map(|c| c.as_str()).collect();
        self.upsert_node(node_id, endpoint, &cluster_refs)
    }

    pub fn remove_node(&self, node_id: &str) -> Result<(Vec<CommissionedNode>, bool)> {
        let mut nodes = self.load_or_recover()?.nodes;
        let before = nodes.len();
        nodes.retain(|n| n.node_id != node_id);
        let removed = nodes.len() != before;

        if removed {
            self.save_nodes(&nodes)?;
        }

        Ok((nodes, removed))
    }

    pub fn nodes_to_json(nodes: &[CommissionedNode]) -> serde_json::Value {
        json!(
            nodes
                .iter()
                .map(|n| {
                    json!({
                        "node_id": n.node_id,
                        "commissioned_at_unix": n.commissioned_at_unix,
                        "last_interview_unix": n.last_interview_unix,
                        "endpoint": n.endpoint,
                        "clusters": n.clusters,
                    })
                })
                .collect::<Vec<_>>()
        )
    }

    pub fn export_backup(&self, backup_dir: &Path) -> Result<PathBuf> {
        std::fs::create_dir_all(backup_dir)
            .with_context(|| format!("creating backup dir: {}", backup_dir.display()))?;

        let ts = unix_now();
        let backup_path = backup_dir.join(format!("fabric_store.{ts}.bak.json"));

        if self.path.exists() {
            let raw = std::fs::read(&self.path)
                .with_context(|| format!("reading fabric store for backup: {}", self.path.display()))?;
            std::fs::write(&backup_path, raw)
                .with_context(|| format!("writing fabric backup: {}", backup_path.display()))?;
        } else {
            let doc = FabricStoreDoc::default();
            std::fs::write(&backup_path, serde_json::to_vec_pretty(&doc)?)
                .with_context(|| format!("writing empty fabric backup: {}", backup_path.display()))?;
        }

        Ok(backup_path)
    }

    fn save_nodes(&self, nodes: &[CommissionedNode]) -> Result<()> {
        let doc = FabricStoreDoc {
            version: STORE_VERSION,
            nodes: nodes.to_vec(),
        };

        let plain = serde_json::to_vec_pretty(&doc)?;
        if let Some(key) = self.resolve_key()? {
            let cipher = ChaCha20Poly1305::new((&key).into());
            let nonce = ChaCha20Poly1305::generate_nonce(&mut OsRng);
            let ciphertext = cipher
                .encrypt(&nonce, plain.as_ref())
                .map_err(|_| anyhow::anyhow!("encrypting fabric store failed"))?;

            let encrypted = EncryptedFabricStoreDoc {
                version: STORE_VERSION,
                algorithm: STORE_ALGORITHM.to_string(),
                nonce_b64: base64::engine::general_purpose::STANDARD.encode(nonce.as_slice()),
                ciphertext_b64: base64::engine::general_purpose::STANDARD.encode(ciphertext),
            };

            return self.write_store_bytes(serde_json::to_vec_pretty(&encrypted)?);
        }

        self.write_store_bytes(plain)
    }

    fn write_store_bytes(&self, bytes: Vec<u8>) -> Result<()> {

        let tmp_path = self.path.with_extension("json.tmp");
        std::fs::write(&tmp_path, bytes)
            .with_context(|| format!("writing fabric store temp file: {}", tmp_path.display()))?;
        std::fs::rename(&tmp_path, &self.path).with_context(|| {
            format!(
                "persisting fabric store temp file {} -> {}",
                tmp_path.display(),
                self.path.display()
            )
        })?;

        Ok(())
    }

    fn resolve_key(&self) -> Result<Option<[u8; 32]>> {
        match self.security.key_provider {
            KeyProvider::Plaintext => Ok(None),
            KeyProvider::Env => {
                let secret = std::env::var(&self.security.key_env_var).with_context(|| {
                    format!(
                        "security.key_provider=env requires env var {}",
                        self.security.key_env_var
                    )
                })?;

                if secret.trim().is_empty() {
                    anyhow::bail!(
                        "env var {} is empty; cannot derive fabric store key",
                        self.security.key_env_var
                    );
                }

                let digest = sha2::Sha256::digest(secret.as_bytes());
                let mut key = [0u8; 32];
                key.copy_from_slice(&digest);
                Ok(Some(key))
            }
        }
    }

    fn decrypt_doc(&self, doc: &EncryptedFabricStoreDoc) -> Result<Vec<u8>> {
        if !doc.algorithm.eq_ignore_ascii_case(STORE_ALGORITHM) {
            anyhow::bail!("unsupported encrypted fabric store algorithm: {}", doc.algorithm);
        }

        let key = self.resolve_key()?.with_context(|| {
            "encrypted fabric store detected but no key provider is configured"
        })?;

        let nonce_bytes = base64::engine::general_purpose::STANDARD
            .decode(&doc.nonce_b64)
            .context("decoding encrypted fabric store nonce")?;
        if nonce_bytes.len() != 12 {
            anyhow::bail!(
                "encrypted fabric store nonce length is invalid: expected 12 got {}",
                nonce_bytes.len()
            );
        }

        let ciphertext = base64::engine::general_purpose::STANDARD
            .decode(&doc.ciphertext_b64)
            .context("decoding encrypted fabric store ciphertext")?;

        let cipher = ChaCha20Poly1305::new((&key).into());
        let nonce = Nonce::from_slice(&nonce_bytes);
        cipher
            .decrypt(nonce, ciphertext.as_ref())
            .map_err(|_| anyhow::anyhow!("decrypting encrypted fabric store payload failed"))
    }

    fn corrupt_path(&self) -> PathBuf {
        let ts = unix_now();
        self.path
            .with_file_name(format!("fabric_store.corrupt.{ts}.json"))
    }
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn normalize_nodes(mut nodes: Vec<CommissionedNode>) -> Vec<CommissionedNode> {
    let mut seen = HashSet::<String>::new();
    nodes.sort_by(|a, b| b.last_interview_unix.cmp(&a.last_interview_unix));
    let mut normalized = Vec::with_capacity(nodes.len());

    for node in nodes {
        if seen.insert(node.node_id.clone()) {
            normalized.push(node);
        }
    }

    normalized.sort_by(|a, b| a.node_id.cmp(&b.node_id));
    normalized
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_storage_dir(name: &str) -> PathBuf {
        let ts = unix_now();
        std::env::temp_dir().join(format!("hc-matter-{name}-{ts}"))
    }

    fn plaintext_security() -> SecurityConfig {
        SecurityConfig::default()
    }

    #[test]
    fn upsert_persists_nodes() {
        let dir = temp_storage_dir("upsert");
        std::fs::create_dir_all(&dir).unwrap();

        let store = FabricStore::new(&dir, plaintext_security());
        let nodes = store
            .upsert_node("matter_spike_node_1", 1, &["OnOff", "LevelControl"])
            .unwrap();

        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].node_id, "matter_spike_node_1");

        let loaded = store.load_or_recover().unwrap();
        assert_eq!(loaded.nodes.len(), 1);
        assert!(loaded.warning.is_none());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn upsert_updates_existing_node_without_duplicates() {
        let dir = temp_storage_dir("no-dup");
        std::fs::create_dir_all(&dir).unwrap();

        let store = FabricStore::new(&dir, plaintext_security());
        store
            .upsert_node("matter_spike_node_1", 1, &["OnOff", "LevelControl"])
            .unwrap();

        let nodes = store
            .upsert_node("matter_spike_node_1", 2, &["OnOff", "LevelControl", "Identify"])
            .unwrap();

        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].endpoint, 2);
        assert_eq!(nodes[0].clusters.len(), 3);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn corrupt_store_is_quarantined() {
        let dir = temp_storage_dir("corrupt");
        std::fs::create_dir_all(&dir).unwrap();

        let store_path = dir.join(STORE_FILE);
        std::fs::write(&store_path, b"not-json").unwrap();

        let store = FabricStore::new(&dir, plaintext_security());
        let loaded = store.load_or_recover().unwrap();

        assert!(loaded.nodes.is_empty());
        assert!(loaded.warning.is_some());
        assert!(!store_path.exists());

        let mut quarantined = 0usize;
        for entry in std::fs::read_dir(&dir).unwrap() {
            let entry = entry.unwrap();
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("fabric_store.corrupt.") {
                quarantined += 1;
            }
        }
        assert_eq!(quarantined, 1);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn remove_node_deletes_only_target() {
        let dir = temp_storage_dir("remove");
        std::fs::create_dir_all(&dir).unwrap();

        let store = FabricStore::new(&dir, plaintext_security());
        store
            .upsert_node("matter_spike_node_1", 1, &["OnOff", "LevelControl"])
            .unwrap();
        store
            .upsert_node("matter_spike_node_2", 1, &["OnOff"])
            .unwrap();

        let (nodes, removed) = store.remove_node("matter_spike_node_1").unwrap();
        assert!(removed);
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].node_id, "matter_spike_node_2");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn encrypted_store_round_trip_with_env_key() {
        let dir = temp_storage_dir("enc");
        std::fs::create_dir_all(&dir).unwrap();

        let key_name = format!("HC_MATTER_STORE_KEY_TEST_{}", unix_now());
        std::env::set_var(&key_name, "unit-test-secret");

        let security = SecurityConfig {
            key_provider: KeyProvider::Env,
            key_env_var: key_name.clone(),
            backup_dir: "backups".to_string(),
        };

        let store = FabricStore::new(&dir, security);
        store
            .upsert_node("matter_spike_node_1", 1, &["OnOff", "LevelControl"])
            .unwrap();

        let raw = std::fs::read(dir.join(STORE_FILE)).unwrap();
        let raw_str = String::from_utf8(raw).unwrap();
        assert!(raw_str.contains("ciphertext_b64"));

        let loaded = store.load_or_recover().unwrap();
        assert_eq!(loaded.nodes.len(), 1);

        std::env::remove_var(key_name);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn export_backup_writes_file() {
        let dir = temp_storage_dir("backup");
        std::fs::create_dir_all(&dir).unwrap();

        let store = FabricStore::new(&dir, plaintext_security());
        store
            .upsert_node("matter_spike_node_1", 1, &["OnOff", "LevelControl"])
            .unwrap();

        let backup_dir = dir.join("backups");
        let backup_path = store.export_backup(&backup_dir).unwrap();
        assert!(backup_path.exists());

        std::fs::remove_dir_all(&dir).ok();
    }
}
