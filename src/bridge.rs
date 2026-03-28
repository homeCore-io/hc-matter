use crate::config::BridgeConfig;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BridgeCandidate {
    pub device_id: String,
    pub name: String,
    pub device_type: String,
    pub area: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BridgedEndpoint {
    pub endpoint_id: u16,
    pub candidate: BridgeCandidate,
}

pub fn select_bridged_endpoints(
    cfg: &BridgeConfig,
    candidates: &[BridgeCandidate],
) -> Vec<BridgedEndpoint> {
    candidates
        .iter()
        .filter(|c| should_include(cfg, c))
        .map(|c| BridgedEndpoint {
            endpoint_id: derive_endpoint_id(&cfg.endpoint_id_salt, &c.device_id),
            candidate: c.clone(),
        })
        .collect()
}

fn should_include(cfg: &BridgeConfig, candidate: &BridgeCandidate) -> bool {
    if !cfg.include_ids.is_empty() && !cfg.include_ids.iter().any(|id| id == &candidate.device_id) {
        return false;
    }

    if cfg.exclude_ids.iter().any(|id| id == &candidate.device_id) {
        return false;
    }

    if let Some(filter) = cfg.device_type_filter.as_deref() {
        if !candidate.device_type.eq_ignore_ascii_case(filter) {
            return false;
        }
    }

    if let Some(filter) = cfg.area_filter.as_deref() {
        if candidate
            .area
            .as_deref()
            .map(|a| a.eq_ignore_ascii_case(filter))
            != Some(true)
        {
            return false;
        }
    }

    true
}

pub fn derive_endpoint_id(salt: &str, device_id: &str) -> u16 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in salt.as_bytes().iter().chain(device_id.as_bytes()) {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x00000100000001B3);
    }

    // Keep 0 and 1 reserved; deterministic output in [2, 65534].
    ((hash % 65_533) + 2) as u16
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_candidates() -> Vec<BridgeCandidate> {
        vec![
            BridgeCandidate {
                device_id: "light.office_main".to_string(),
                name: "Office Main".to_string(),
                device_type: "light".to_string(),
                area: Some("office".to_string()),
            },
            BridgeCandidate {
                device_id: "sensor.office_motion".to_string(),
                name: "Office Motion".to_string(),
                device_type: "motion_sensor".to_string(),
                area: Some("office".to_string()),
            },
        ]
    }

    #[test]
    fn endpoint_id_is_deterministic() {
        let a = derive_endpoint_id("plugin.matter", "light.office_main");
        let b = derive_endpoint_id("plugin.matter", "light.office_main");
        assert_eq!(a, b);
    }

    #[test]
    fn include_and_exclude_work() {
        let mut cfg = BridgeConfig::default();
        cfg.include_ids = vec!["light.office_main".to_string()];
        cfg.exclude_ids = vec!["sensor.office_motion".to_string()];

        let selected = select_bridged_endpoints(&cfg, &sample_candidates());
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].candidate.device_id, "light.office_main");
    }

    #[test]
    fn optional_filters_work() {
        let mut cfg = BridgeConfig::default();
        cfg.device_type_filter = Some("motion_sensor".to_string());
        cfg.area_filter = Some("office".to_string());

        let selected = select_bridged_endpoints(&cfg, &sample_candidates());
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].candidate.device_type, "motion_sensor");
    }
}
