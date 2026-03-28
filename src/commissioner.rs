use anyhow::{anyhow, bail, Context, Result};
use serde_json::json;
use std::path::Path;
use tokio::process::Command;
use tokio::time::{timeout, Duration};

pub struct ChipToolCommissionRequest<'a> {
    pub binary: &'a Path,
    pub timeout_secs: u64,
    pub node_numeric_id: u64,
    pub pairing_code: Option<&'a str>,
    pub passcode: Option<u32>,
    pub discriminator: Option<u16>,
}

pub async fn commission_with_chip_tool(req: &ChipToolCommissionRequest<'_>) -> Result<serde_json::Value> {
    let mut cmd = Command::new(req.binary);
    cmd.arg("pairing");

    if let Some(code) = req.pairing_code {
        cmd.arg("code")
            .arg(req.node_numeric_id.to_string())
            .arg(code);
    } else if let Some(pin) = req.passcode {
        cmd.arg("onnetwork")
            .arg(req.node_numeric_id.to_string())
            .arg(pin.to_string());

        if let Some(discriminator) = req.discriminator {
            cmd.arg(discriminator.to_string());
        }
    } else {
        bail!("commissioning requires pairing_code or passcode");
    }

    let rendered = render_command(&cmd);
    let wait = timeout(
        Duration::from_secs(req.timeout_secs.max(10)),
        cmd.output(),
    )
    .await
    .map_err(|_| anyhow!("commission command timed out after {}s", req.timeout_secs.max(10)))?;

    let out = wait.with_context(|| format!("failed to spawn commission command: {rendered}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();

    if !out.status.success() {
        bail!(
            "commission command failed: status={}; cmd={}; stderr={}; stdout={}",
            out.status,
            rendered,
            stderr,
            stdout
        );
    }

    Ok(json!({
        "backend": "chip-tool",
        "command": rendered,
        "status": out.status.code(),
        "stdout": stdout,
        "stderr": stderr,
        "node_numeric_id": req.node_numeric_id,
    }))
}

fn render_command(cmd: &Command) -> String {
    let program = cmd.as_std().get_program().to_string_lossy().to_string();
    let args = cmd
        .as_std()
        .get_args()
        .map(|a| a.to_string_lossy().to_string())
        .collect::<Vec<_>>();

    if args.is_empty() {
        return program;
    }

    format!("{} {}", program, args.join(" "))
}
