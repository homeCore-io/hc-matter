# hc-matter security and backup

## Fabric store protection

`fabric_store.json` can be protected with a pluggable key provider in `config/config.toml`:

```toml
[matter.security]
key_provider = "env"
key_env_var = "HC_MATTER_STORE_KEY"
backup_dir = "backups"
```

Supported providers:

- `plaintext`: legacy/dev mode (no encryption).
- `env`: encrypts at rest using key material from `key_env_var`.

When `key_provider = "env"`, set the env var before launching the plugin:

```bash
export HC_MATTER_STORE_KEY="replace-with-long-random-secret"
```

## Backup/export flow

The plugin supports fabric snapshot export through `matter_controller` commands.

Send command topic payload:

```json
{"action":"backup_fabric"}
```

Alias action is also supported:

```json
{"action":"export_fabric"}
```

Backups are written to `matter.security.backup_dir` (relative to config dir unless absolute) with timestamped filenames:

- `fabric_store.<unix_ts>.bak.json`

If the live fabric store is encrypted, backup content remains encrypted.
