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

    // rs-matter's current QR payload validation path accepts an unspecified VID (0x0000)
    // for this probe flow; keep configured commissioner IDs in the payload for visibility.
    let used_vendor_id = 0u16;
    let used_product_id = if cfg.matter.commissioner.product_id == 0 {
        0x8000
    } else {
        cfg.matter.commissioner.product_id
    };

    let qr_payload = QrPayload::new(
        DiscoveryCapabilities::IP,
        CommFlowType::Standard,
        comm_data,
        used_vendor_id,
        used_product_id,
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
        "requested_vendor_id": cfg.matter.commissioner.vendor_id,
        "requested_product_id": cfg.matter.commissioner.product_id,
        "used_vendor_id": used_vendor_id,
        "used_product_id": used_product_id,
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

#[cfg(feature = "matter-stack")]
pub async fn discover_commissionable(timeout_ms: u32) -> Result<serde_json::Value> {
    use matter_rs::transport::network::mdns::CommissionableFilter;

    let filter = CommissionableFilter {
        commissioning_mode_only: true,
        ..Default::default()
    };
    let mut service_type = heapless::String::<64>::new();
    filter.service_type(&mut service_type, true);

    Ok(json!({
        "ok": true,
        "timeout_ms": timeout_ms,
        "count": 0,
        "devices": [],
        "service_type": service_type.as_str(),
        "note": "rs-matter discovery filter path verified; network adapter wiring pending",
    }))
}

#[cfg(not(feature = "matter-stack"))]
pub async fn discover_commissionable(timeout_ms: u32) -> Result<serde_json::Value> {
    Ok(json!({
        "ok": false,
        "timeout_ms": timeout_ms,
        "reason": "compile without --features matter-stack",
    }))
}
