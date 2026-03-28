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
pub async fn discover_commissionable(timeout_ms: u32, interface: Option<&str>) -> Result<serde_json::Value> {
    use std::net::UdpSocket;

    use async_io::Async;
    use matter_rs::transport::network::mdns::{
        CommissionableFilter, MDNS_IPV4_BROADCAST_ADDR, MDNS_SOCKET_DEFAULT_BIND_ADDR,
    };
    use socket2::{Domain, Protocol, Socket, Type};

    let filter = CommissionableFilter {
        commissioning_mode_only: true,
        ..Default::default()
    };
    let mut service_type = heapless::String::<64>::new();
    filter.service_type(&mut service_type, true);

    let socket = Socket::new(Domain::IPV6, Type::DGRAM, Some(Protocol::UDP))?;
    socket.set_reuse_address(true)?;
    socket.set_only_v6(false)?;
    socket.bind(&MDNS_SOCKET_DEFAULT_BIND_ADDR.into())?;

    let ipv4_interface = std::net::Ipv4Addr::UNSPECIFIED;
    socket
        .join_multicast_v4(&MDNS_IPV4_BROADCAST_ADDR, &ipv4_interface)
        .ok();

    let ipv6_interface = interface
        .map(interface_to_index)
        .transpose()?
        .flatten();

    if let Some(index) = ipv6_interface {
        socket
            .join_multicast_v6(&std::net::Ipv6Addr::new(0xff02, 0, 0, 0, 0, 0, 0, 0x00fb), index)
            .ok();
    }

    let socket = Async::<UdpSocket>::new_nonblocking(socket.into())?;
    let mut buf = vec![0u8; 1500];

    let discovered = matter_rs::transport::network::mdns::builtin::discover_commissionable::<_, _, 16, 4>(
        &socket,
        &socket,
        &filter,
        timeout_ms,
        &mut buf,
        Some(ipv4_interface),
        ipv6_interface,
    )
    .await?;

    let devices: Vec<serde_json::Value> = discovered
        .iter()
        .map(|d| {
            json!({
                "instance_name": d.instance_name.as_str(),
                "device_name": d.device_name.as_str(),
                "best_addr": d.addr().map(|a| a.to_string()),
                "addresses": d.addresses().iter().map(|a| a.to_string()).collect::<Vec<_>>(),
                "port": d.port,
                "discriminator": d.discriminator,
                "vendor_id": d.vendor_id,
                "product_id": d.product_id,
                "commissioning_mode": format!("{:?}", d.commissioning_mode),
                "device_type": d.device_type,
            })
        })
        .collect();

    Ok(json!({
        "ok": true,
        "timeout_ms": timeout_ms,
        "interface": interface,
        "count": devices.len(),
        "devices": devices,
        "service_type": service_type.as_str(),
    }))
}

#[cfg(not(feature = "matter-stack"))]
pub async fn discover_commissionable(timeout_ms: u32, _interface: Option<&str>) -> Result<serde_json::Value> {
    Ok(json!({
        "ok": false,
        "timeout_ms": timeout_ms,
        "reason": "compile without --features matter-stack",
    }))
}

#[cfg(feature = "matter-stack")]
fn interface_to_index(name: &str) -> Result<Option<u32>> {
    let c_name = std::ffi::CString::new(name)?;
    // libc returns 0 when no matching interface exists.
    let idx = unsafe { libc::if_nametoindex(c_name.as_ptr()) };
    if idx == 0 {
        return Ok(None);
    }

    Ok(Some(idx))
}
