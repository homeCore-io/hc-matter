use serde_json::{json, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MatterDeviceClass {
    OnOffLight,
    DimmableLight,
    ContactSensor,
    OccupancySensor,
    TemperatureMeasurement,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MappedMatterCommand {
    pub on: Option<bool>,
    pub level: Option<u8>,
}

pub fn classify_from_clusters(clusters: &[String]) -> MatterDeviceClass {
    if clusters
        .iter()
        .any(|c| c.eq_ignore_ascii_case("temperaturemeasurement"))
    {
        return MatterDeviceClass::TemperatureMeasurement;
    }

    if clusters
        .iter()
        .any(|c| c.eq_ignore_ascii_case("occupancysensing"))
    {
        return MatterDeviceClass::OccupancySensor;
    }

    if clusters
        .iter()
        .any(|c| c.eq_ignore_ascii_case("booleanstate") || c.eq_ignore_ascii_case("contactsensor"))
    {
        return MatterDeviceClass::ContactSensor;
    }

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
        MatterDeviceClass::OnOffLight
        | MatterDeviceClass::ContactSensor
        | MatterDeviceClass::OccupancySensor
        | MatterDeviceClass::TemperatureMeasurement => None,
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

    match class {
        MatterDeviceClass::OnOffLight | MatterDeviceClass::DimmableLight => {
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
        }
        MatterDeviceClass::ContactSensor => {
            if let Some(open) = attributes
                .get("open")
                .and_then(|v| v.as_bool())
                .or_else(|| attributes.get("contact_open").and_then(|v| v.as_bool()))
            {
                out.insert("open".to_string(), Value::Bool(open));
                out.insert("contact".to_string(), Value::Bool(!open));
            } else if let Some(contact) = attributes.get("contact").and_then(|v| v.as_bool()) {
                out.insert("contact".to_string(), Value::Bool(contact));
                out.insert("open".to_string(), Value::Bool(!contact));
            }
        }
        MatterDeviceClass::OccupancySensor => {
            if let Some(occupied) = attributes
                .get("occupied")
                .and_then(|v| v.as_bool())
                .or_else(|| attributes.get("occupancy").and_then(|v| v.as_bool()))
                .or_else(|| attributes.get("motion").and_then(|v| v.as_bool()))
            {
                out.insert("occupied".to_string(), Value::Bool(occupied));
                out.insert("motion".to_string(), Value::Bool(occupied));
            }
        }
        MatterDeviceClass::TemperatureMeasurement => {
            if let Some(normalized) = normalize_temperature_attributes(attributes) {
                out.insert("temperature_c".to_string(), json!(normalized.temperature_c));
                // Keep `temperature` deterministic by aliasing Celsius in mapper v2.
                out.insert("temperature".to_string(), json!(normalized.temperature));
            }
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

pub fn synthetic_contact_attributes(open: bool) -> Value {
    json!({
        "open": open,
    })
}

pub fn synthetic_occupancy_attributes(occupied: bool) -> Value {
    json!({
        "occupancy": occupied,
    })
}

pub fn synthetic_temperature_attributes(temperature_c: f64) -> Value {
    let measured_value = (temperature_c * 100.0).round() as i64;
    json!({
        "measured_value": measured_value,
    })
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TemperatureNormalized {
    pub temperature_c: f64,
    pub temperature: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TemperatureUnit {
    Celsius,
    Fahrenheit,
    CentiCelsius,
}

pub fn normalize_temperature(value: f64, unit: TemperatureUnit) -> TemperatureNormalized {
    let c = match unit {
        TemperatureUnit::Celsius => value,
        TemperatureUnit::Fahrenheit => (value - 32.0) * (5.0 / 9.0),
        TemperatureUnit::CentiCelsius => value / 100.0,
    };

    let c = round2(c);
    TemperatureNormalized {
        temperature_c: c,
        // `temperature` is intentionally deterministic alias of Celsius for v2.
        temperature: c,
    }
}

fn normalize_temperature_attributes(attributes: &Value) -> Option<TemperatureNormalized> {
    if let Some(measured) = attributes.get("measured_value").and_then(|v| v.as_f64()) {
        return Some(normalize_temperature(measured, TemperatureUnit::CentiCelsius));
    }
    if let Some(c) = attributes.get("temperature_c").and_then(|v| v.as_f64()) {
        return Some(normalize_temperature(c, TemperatureUnit::Celsius));
    }
    if let Some(f) = attributes.get("temperature_f").and_then(|v| v.as_f64()) {
        return Some(normalize_temperature(f, TemperatureUnit::Fahrenheit));
    }
    attributes
        .get("temperature")
        .and_then(|v| v.as_f64())
        .map(|c| normalize_temperature(c, TemperatureUnit::Celsius))
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
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

    #[test]
    fn map_contact_sensor_normalized_keys() {
        let mapped = map_matter_attributes(MatterDeviceClass::ContactSensor, &json!({"contact": true}));
        assert_eq!(mapped.get("contact").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(mapped.get("open").and_then(|v| v.as_bool()), Some(false));
    }

    #[test]
    fn map_occupancy_sensor_normalized_keys() {
        let mapped = map_matter_attributes(MatterDeviceClass::OccupancySensor, &json!({"occupancy": true}));
        assert_eq!(mapped.get("occupied").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(mapped.get("motion").and_then(|v| v.as_bool()), Some(true));
    }

    #[test]
    fn map_temperature_sensor_measured_value() {
        let mapped = map_matter_attributes(
            MatterDeviceClass::TemperatureMeasurement,
            &json!({"measured_value": 2150}),
        );
        assert_eq!(mapped.get("temperature_c").and_then(|v| v.as_f64()), Some(21.5));
        assert_eq!(mapped.get("temperature").and_then(|v| v.as_f64()), Some(21.5));
    }

    #[test]
    fn normalize_temperature_from_fahrenheit() {
        let normalized = normalize_temperature(77.0, TemperatureUnit::Fahrenheit);
        assert_eq!(normalized.temperature_c, 25.0);
        assert_eq!(normalized.temperature, 25.0);
    }
}
