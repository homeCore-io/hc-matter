# MAT-017 Restart and Recovery Test Matrix

This matrix captures automated scenarios for controller and bridge restart behavior and external controller compatibility profiles.

## Automated scenarios

Run from `plugins/hc-matter`:

```bash
cargo test -q
```

### Controller restart/recovery

- `controller_restart_recovers_plaintext_commissioned_nodes`
  - Verifies commissioned nodes survive restart with plaintext store.
- `controller_restart_recovers_encrypted_commissioned_nodes`
  - Verifies commissioned nodes survive restart with encrypted store and key provider.

### Bridge restart/recovery

- `bridge_restart_keeps_endpoint_inventory_stable`
  - Verifies deterministic endpoint assignment and ordering is stable across restart.

## External controller compatibility profiles (automated)

These tests validate metadata extraction and bridge-origin detection for two controller ecosystems:

- `home_assistant_profile_metadata_is_extracted`
  - Uses Home Assistant style payload metadata (`origin`, `context.id`).
- `apple_home_profile_metadata_is_extracted`
  - Uses Apple Home / HomeKit style metadata (`meta.origin`, `meta.correlation_id`).

Both profiles are validated as bridge-origin inputs and feed MAT-014 loop-prevention/correlation logic.

## Notes

- The external controller tests are schema compatibility checks against representative payload shapes.
- Full hardware interoperability against real controller apps remains a separate staged validation task outside unit test scope.
