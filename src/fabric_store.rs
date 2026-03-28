use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const STORE_VERSION: u32 = 1;
const STORE_FILE: &str = "fabric_store.json";

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
}

impl FabricStore {
    pub fn new(storage_dir: &Path) -> Self {
        Self {
            path: storage_dir.join(STORE_FILE),
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

    fn save_nodes(&self, nodes: &[CommissionedNode]) -> Result<()> {
        let doc = FabricStoreDoc {
            version: STORE_VERSION,
            nodes: nodes.to_vec(),
        };

        let tmp_path = self.path.with_extension("json.tmp");
        std::fs::write(&tmp_path, serde_json::to_vec_pretty(&doc)?)
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

    #[test]
    fn upsert_persists_nodes() {
        let dir = temp_storage_dir("upsert");
        std::fs::create_dir_all(&dir).unwrap();

        let store = FabricStore::new(&dir);
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

        let store = FabricStore::new(&dir);
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

        let store = FabricStore::new(&dir);
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
}
