use anyhow::Result;
use serde_json::json;

use crate::config::MatterConfig;

#[cfg(feature = "matter-stack")]
pub fn probe(cfg: &MatterConfig) -> Result<serde_json::Value> {
    use matter_rs::pairing::qr::{no_optional_data, CommFlowType, QrPayload};
    use matter_rs::pairing::DiscoveryCapabilities;
    use matter_rs::BasicCommData;

    let comm_data = BasicCommData {
        password: 123456_u32.to_le_bytes().into(),
        discriminator: 250,
    };

    let pairing_code = comm_data.compute_pretty_pairing_code().to_string();

    let qr_payload = QrPayload::new(
        DiscoveryCapabilities::IP,
        CommFlowType::Standard,
        comm_data,
        cfg.matter.commissioner.vendor_id,
        cfg.matter.commissioner.product_id,
        "hc-matter-spike",
        no_optional_data,
    );

    let mut qr_buf = vec![0u8; 512];
    let qr_text = match qr_payload.as_str(&mut qr_buf) {
        Ok((text, _rest)) => text.to_string(),
        Err(e) => format!("qr-encode-error:{e:?}"),
    };

    Ok(json!({
        "feature": "matter-stack",
        "linked": true,
        "pairing_code": pairing_code,
        "qr_payload_valid": qr_payload.is_valid(),
        "qr_payload": qr_text,
    }))
}

#[cfg(not(feature = "matter-stack"))]
pub fn probe(_cfg: &MatterConfig) -> Result<serde_json::Value> {
    Ok(json!({
        "feature": "matter-stack",
        "linked": false,
        "reason": "compile without --features matter-stack",
    }))
}
