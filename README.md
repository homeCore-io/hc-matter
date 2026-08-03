> [!IMPORTANT]
> **This repository was never implemented.**
>
> It held no source — only a scaffold — and was archived on 2026-08-03 rather
> than folded into [homeCore-io/homeCore](https://github.com/homeCore-io/homeCore)
> with the plugins that were real. Nothing here ever shipped, and no release or
> registry entry refers to it.
>
> If this device type gets built, it starts as a new plugin under `plugins/` in
> the monorepo.

# hc-matter — HomeCore Matter Plugin

A fresh TypeScript-based Matter controller and bridge plugin for HomeCore, using [matter.js](https://github.com/matter-js/matter.js).

## Overview

**hc-matter** enables HomeCore to:

1. **Commission and control** native Matter devices (lights, sensors, switches, locks, etc.) as a Matter controller
2. **Expose HomeCore devices** as Matter-compliant endpoints so external controllers (Apple Home, Google Home, Alexa) can discover and control them
3. **Persist fabric state** with optional encryption for security

## Features (Phases)

### Phase 0 (Spike)
- ✅ Node.js + TypeScript scaffold
- ✅ matter.js 0.16+ integration
- WebSocket client to HomeCore MQTT
- Basic commissioning test

### Phase 1 (Controller MVP)
- Fabric store with encryption support
- Commission flow (QR code, passcode)
- Device type mapping (OnOff, Dimmer, Sensor, etc.)
- Subscription engine for attribute changes
- Command handling
- Plugin status & metrics

### Phase 2 (Bridge MVP)
- Endpoint registration & discovery
- State bidirectional sync
- External controller command routing
- Loop prevention

### Phase 3 (Ops)
- Backup/export flows
- Test matrix
- hc-tui integration
- Docker support

## Quick Start

### Requirements
- Node.js 20.x or later
- npm 10+

### Setup
```bash
cd plugins/hc-matter
npm install
npm run build
npm start
```

### Optional: Enable real matter.js runtime
By default, hc-matter runs in safe spike mode (no live matter.js node runtime).

To enable the in-process matter.js ServerNode bootstrap used for Phase 1 integration testing:

```bash
export HC_MATTER_ENABLE_RUNTIME=1
npm start
```

### Configuration
Edit `config/homecore-matter.toml` to set:
- `homecore.ws_url` — WebSocket address of HomeCore MQTT bridge (default: `ws://localhost:9001`)
- `matter.storage_dir` — Where to store fabric data (default: `data/matter`)
- `matter.security_provider` — Encryption mode (`plaintext` or `env`)
- `controller.enabled` / `bridge.enabled` — Which roles to enable

### Example
```toml
[homecore]
ws_url = "ws://localhost:9001"

[matter]
storage_dir = "data/matter"
security_provider = "plaintext"
instance_name = "HomeCore"

[controller]
enabled = true

[bridge]
enabled = true
include_ids = ["light.*", "switch.*"]
```

## Architecture

### Core Modules
- **src/main.ts** — Entry point, config loading, logging setup
- **src/ws-bridge.ts** — WebSocket client to HomeCore MQTT bridge
- **src/controller/** — Matter controller (fabric, commissioning, subscriptions)
- **src/bridge/** — Matter bridge (endpoint registry, state sync)
- **src/mapper/** — HomeCore ↔ Matter device/attribute mapping

### Plugin Configuration
- **config/homecore-matter.toml** — TOML configuration with schema
- **data/matter/** — Persistent storage (fabric_store.json, node configs)
- **logs/hc-matter.log** — Daily rolling log file

## API Integration

### Plugin Status
```
GET /api/v1/plugins/matter/status → { active, node_count, health }
```

### Commissioning
```
POST /api/v1/plugins/matter/commission
Body: { passcode, discriminator?, qr_code? }
```

### Node Management
```
GET    /api/v1/plugins/matter/nodes          # List commissioned nodes
POST   /api/v1/plugins/matter/nodes/{id}/reinterview  # Refresh metadata
DELETE /api/v1/plugins/matter/nodes/{id}     # Unpair node
GET    /api/v1/plugins/matter/metrics        # Runtime metrics
```

## MQTT Contract

### Topics
- **Publish**: `homecore/devices/{device_id}/state` — Device state updates
- **Subscribe**: `homecore/devices/{device_id}/cmd` — Inbound commands
- **Status**: `homecore/plugins/matter/status` — Plugin lifecycle
- **Metrics**: `homecore/plugins/matter/metrics` — Performance data

### Payload Example
```json
{
  "on": true,
  "brightness_pct": 75,
  "color_xy": [0.33, 0.33],
  "origin": "matter_controller",
  "timestamp": "2026-03-29T12:34:56Z"
}
```

## Supported Device Types (Initial)

| HomeCore Type   | Matter Device    | Clusters               |
|-----------------|------------------|------------------------|
| light           | DimmableLight    | OnOff, LevelControl    |
| light_color     | ExtendedColorLight | OnOff, LevelControl, ColorControl |
| switch          | OnOffSwitch      | OnOff, Scenes          |
| contact_sensor  | ContactSensor    | BooleanState           |
| motion_sensor   | OccupancySensor  | Occupancy, BooleanState |
| occupancy_sensor | OccupancySensor | Occupancy              |
| temperature_sensor | TemperatureSensor | TemperatureMeasurement |

## Development

### Build
```bash
npm run build       # TypeScript → ES2022
npm run build:watch # Watch mode
```

### Test
```bash
npm test            # Run tests
npm run test:watch  # Test watch mode
```

### Lint
```bash
npm run lint        # Check style
npm run lint:fix    # Auto-fix issues
```

## Security

### Fabric Store Encryption
For production, use encrypted fabric store:

```bash
export HC_MATTER_STORE_KEY="your-secret-key-here"
# In config/homecore-matter.toml:
# security_provider = "env"
# security_key_env_var = "HC_MATTER_STORE_KEY"
```

The plugin will encrypt `data/matter/fabric_store.json` using ChaCha20-Poly1305.

### Backup
Timestamped backups are saved to `data/matter/backups/` on export.

## Troubleshooting

### WebSocket Connection Fails
- Check `homecore.ws_url` in config (default `ws://localhost:9001`)
- Ensure HomeCore is running and MQTT bridge is accessible
- Check firewall rules

### Commissioning Not Working
- Verify `matter.passcode_default` is a 28-bit number (1–134217727)
- Check Matter device is in commissioning mode
- Review logs: `tail -f logs/hc-matter.log`

### State Updates Don't Appear
- Verify `controller.enabled = true` in config
- Check Matter device is commissioned and subscribed
- Verify HomeCore MQTT bridge is receiving state messages

## References

- [matter.js GitHub](https://github.com/matter-js/matter.js)
- [Matter Specification](https://buildwithmatter.com)
- [HomeCore Plugin Architecture](../../AGENTS.md)
- [Matter Implementation Plan](../../core/docs/matterPlan.md)

## License

Part of HomeCore. See [LICENSE](../../LICENSE).
