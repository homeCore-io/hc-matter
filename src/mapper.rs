use serde_json::{json, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MatterDeviceClass {
    OnOffLight,
    DimmableLight,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MappedMatterCommand {
    pub on: Option<bool>,
    pub level: Option<u8>,
}

pub fn classify_from_clusters(clusters: &[String]) -> MatterDeviceClass {
    if clusters
        .iter()
        .any(|c| c.eq_ignore_ascii_case("levelcontrol"))
    {
        MatterDeviceClass::DimmableLight
    } else {
        MatterDeviceClass::OnOffLight
    }
}

pub fn map_homecore_command(class: MatterDeviceClass, cmd: &Value) -> MappedMatterCommand {
    let on = cmd
        .get("on")
        .and_then(|v| v.as_bool())
        .or_else(|| cmd.get("on_off").and_then(|v| v.as_bool()));

    let level = match class {
        MatterDeviceClass::OnOffLight => None,
        MatterDeviceClass::DimmableLight => {
            if let Some(pct) = cmd.get("brightness_pct").and_then(|v| v.as_u64()) {
                Some(pct_to_level(pct as u8))
            } else {
                cmd.get("brightness")
                    .and_then(|v| v.as_u64())
                    .or_else(|| cmd.get("level").and_then(|v| v.as_u64()))
                    .map(|v| v.min(254) as u8)
            }
        }
    };

    MappedMatterCommand { on, level }
}

pub fn map_matter_attributes(class: MatterDeviceClass, attributes: &Value) -> Value {
    let mut out = serde_json::Map::new();

    if let Some(on) = attributes
        .get("on_off")
        .and_then(|v| v.as_bool())
        .or_else(|| attributes.get("on").and_then(|v| v.as_bool()))
    {
        out.insert("on".to_string(), Value::Bool(on));
    }

    if matches!(class, MatterDeviceClass::DimmableLight) {
        if let Some(level) = attributes
            .get("current_level")
            .and_then(|v| v.as_u64())
            .or_else(|| attributes.get("level").and_then(|v| v.as_u64()))
        {
            out.insert(
                "brightness_pct".to_string(),
                Value::Number((level_to_pct(level as u8) as u64).into()),
            );
        }
    }

    Value::Object(out)
}

pub fn synthetic_matter_attributes(on: bool, brightness_pct: u8) -> Value {
    json!({
        "on_off": on,
        "current_level": pct_to_level(brightness_pct),
    })
}

pub fn pct_to_level(pct: u8) -> u8 {
    let clamped = pct.min(100) as u16;
    ((clamped * 254 + 50) / 100) as u8
}

pub fn level_to_pct(level: u8) -> u8 {
    let clamped = level.min(254) as u16;
    ((clamped * 100 + 127) / 254) as u8
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn map_dimmable_report_to_homecore_keys() {
        let mapped = map_matter_attributes(
            MatterDeviceClass::DimmableLight,
            &json!({"on_off": true, "current_level": 127}),
        );

        assert_eq!(mapped.get("on").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(mapped.get("brightness_pct").and_then(|v| v.as_u64()), Some(50));
    }

    #[test]
    fn map_homecore_command_to_matter_dimmable() {
        let cmd = map_homecore_command(
            MatterDeviceClass::DimmableLight,
            &json!({"on": true, "brightness_pct": 75}),
        );

        assert_eq!(cmd.on, Some(true));
        assert_eq!(cmd.level, Some(pct_to_level(75)));
    }

    #[test]
    fn onoff_ignores_level_commands() {
        let cmd = map_homecore_command(
            MatterDeviceClass::OnOffLight,
            &json!({"on": false, "brightness_pct": 30}),
        );

        assert_eq!(cmd.on, Some(false));
        assert_eq!(cmd.level, None);
    }

    #[test]
    fn classify_uses_level_control_cluster() {
        let clusters = vec!["OnOff".to_string(), "LevelControl".to_string()];
        assert_eq!(classify_from_clusters(&clusters), MatterDeviceClass::DimmableLight);
    }
}
