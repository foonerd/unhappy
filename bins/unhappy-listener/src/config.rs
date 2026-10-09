//! The listener's configuration: which devices to take over, the press
//! timing, and the bindings. The plugin writes it as JSON; the daemon reads
//! it at start and again whenever the file changes.
//!
//! A binding that does not hold up (a key name the kernel does not know, a
//! blank or multi-line command) is dropped with a warning and the rest run:
//! one typo must not leave a remote dead after a reboot. Timing outside its
//! range refuses the file, since the plugin never writes that.

use serde::{Deserialize, Serialize};
use std::fmt;
use std::path::Path;
use std::str::FromStr;

/// Where the plugin writes the configuration.
pub const DEFAULT_PATH: &str =
    "/data/configuration/system_controller/unhappy_triggerhappy/listener.json";

/// A device named by its identity rather than its event node, which changes
/// across reconnects. An empty `phys` or `uniq` matches any value.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct DeviceId {
    pub name: String,
    #[serde(default)]
    pub phys: String,
    #[serde(default)]
    pub uniq: String,
}

impl DeviceId {
    /// Whether a present device is the one this entry names.
    pub fn matches(&self, name: &str, phys: &str, uniq: &str) -> bool {
        self.name == name
            && (self.phys.is_empty() || self.phys == phys)
            && (self.uniq.is_empty() || self.uniq == uniq)
    }
}

/// Press timing in milliseconds.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct Timing {
    /// Held at least this long: a long press.
    #[serde(default = "Timing::default_long")]
    pub long_ms: u64,
    /// A second press within this gap after a release: a double press.
    #[serde(default = "Timing::default_double")]
    pub double_ms: u64,
    /// Presses closer together than this are contact bounce.
    #[serde(default = "Timing::default_debounce")]
    pub debounce_ms: u64,
}

impl Timing {
    fn default_long() -> u64 {
        400
    }
    fn default_double() -> u64 {
        300
    }
    fn default_debounce() -> u64 {
        30
    }
}

impl Default for Timing {
    fn default() -> Self {
        Timing {
            long_ms: Self::default_long(),
            double_ms: Self::default_double(),
            debounce_ms: Self::default_debounce(),
        }
    }
}

/// The kind of press a binding answers to.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum Press {
    #[default]
    Short,
    Long,
    Double,
}

impl fmt::Display for Press {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Press::Short => "short",
            Press::Long => "long",
            Press::Double => "double",
        })
    }
}

/// One key, one kind of press, one command for the shell.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Binding {
    pub key: String,
    #[serde(default)]
    pub press: Press,
    pub command: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Config {
    #[serde(default)]
    pub devices: Vec<DeviceId>,
    #[serde(default)]
    pub timing: Timing,
    #[serde(default)]
    pub bindings: Vec<Binding>,
}

/// A configuration read, with the bindings it had to leave out.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Loaded {
    pub config: Config,
    pub warnings: Vec<String>,
}

impl Config {
    pub fn load(path: &Path) -> Result<Loaded, String> {
        let text = std::fs::read_to_string(path)
            .map_err(|e| format!("cannot read {}: {e}", path.display()))?;
        Self::parse(&text)
    }

    pub fn parse(text: &str) -> Result<Loaded, String> {
        let mut config: Config =
            serde_json::from_str(text).map_err(|e| format!("bad JSON: {e}"))?;
        let t = config.timing;
        if !(100..=5000).contains(&t.long_ms) {
            return Err(format!("long_ms {} is outside 100..=5000", t.long_ms));
        }
        if !(50..=2000).contains(&t.double_ms) {
            return Err(format!("double_ms {} is outside 50..=2000", t.double_ms));
        }
        if t.debounce_ms > 500 {
            return Err(format!("debounce_ms {} is above 500", t.debounce_ms));
        }
        for d in &config.devices {
            if d.name.trim().is_empty() {
                return Err("a device entry has no name".to_string());
            }
        }
        let mut warnings = Vec::new();
        config.bindings.retain(|b| match Self::fault(b) {
            None => true,
            Some(why) => {
                warnings.push(why);
                false
            }
        });
        Ok(Loaded { config, warnings })
    }

    /// Why a binding cannot run, if it cannot.
    fn fault(b: &Binding) -> Option<String> {
        if evdev::KeyCode::from_str(&b.key).is_err() {
            return Some(format!("unknown key name {}", b.key));
        }
        if b.command.trim().is_empty() {
            return Some(format!("{} {} has no command", b.key, b.press));
        }
        if b.command.contains('\n') || b.command.contains('\r') {
            return Some(format!("{} {} spans more than one line", b.key, b.press));
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_full_config() {
        let loaded = Config::parse(
            r#"{
              "devices": [{"name": "2.4G Composite Devic"}],
              "timing": {"long_ms": 500, "double_ms": 250, "debounce_ms": 20},
              "bindings": [
                {"key": "KEY_PLAYPAUSE", "press": "short", "command": "/usr/local/bin/volumio toggle"},
                {"key": "KEY_PLAYPAUSE", "press": "long", "command": "/usr/local/bin/volumio stop"},
                {"key": "KEY_NEXTSONG", "command": "/usr/local/bin/volumio next"}
              ]
            }"#,
        )
        .unwrap();
        let c = loaded.config;
        assert!(loaded.warnings.is_empty());
        assert_eq!(c.devices.len(), 1);
        assert_eq!(c.timing.long_ms, 500);
        assert_eq!(c.bindings[1].press, Press::Long);
        assert_eq!(c.bindings[2].press, Press::Short);
    }

    #[test]
    fn defaults_fill_an_empty_config() {
        let c = Config::parse("{}").unwrap().config;
        assert!(c.devices.is_empty());
        assert_eq!(c.timing, Timing::default());
        assert!(c.bindings.is_empty());
    }

    #[test]
    fn drops_bindings_that_cannot_run_and_keeps_the_rest() {
        let loaded = Config::parse(
            r#"{"bindings": [
              {"key": "KEY_NOPE", "command": "x"},
              {"key": "KEY_PLAY", "command": "a\nb"},
              {"key": "KEY_STOP", "command": "  "},
              {"key": "KEY_NEXTSONG", "command": "/usr/local/bin/volumio next"}
            ]}"#,
        )
        .unwrap();
        assert_eq!(loaded.config.bindings.len(), 1);
        assert_eq!(loaded.config.bindings[0].key, "KEY_NEXTSONG");
        assert_eq!(
            loaded.warnings,
            vec![
                "unknown key name KEY_NOPE".to_string(),
                "KEY_PLAY short spans more than one line".to_string(),
                "KEY_STOP short has no command".to_string(),
            ]
        );
    }

    #[test]
    fn refuses_timing_out_of_range_and_a_nameless_device() {
        assert!(Config::parse(r#"{"timing": {"long_ms": 10}}"#).is_err());
        assert!(Config::parse(r#"{"timing": {"double_ms": 9000}}"#).is_err());
        assert!(Config::parse(r#"{"timing": {"debounce_ms": 900}}"#).is_err());
        assert!(Config::parse(r#"{"devices": [{"name": " "}]}"#).is_err());
        assert!(Config::parse("nonsense").is_err());
    }

    #[test]
    fn device_identity_matches_by_name_then_optional_fields() {
        let by_name = DeviceId {
            name: "Remote".into(),
            ..Default::default()
        };
        assert!(by_name.matches("Remote", "usb-1/input0", ""));
        assert!(!by_name.matches("Other", "usb-1/input0", ""));
        let pinned = DeviceId {
            name: "Remote".into(),
            phys: "usb-1/input0".into(),
            uniq: String::new(),
        };
        assert!(pinned.matches("Remote", "usb-1/input0", "abc"));
        assert!(!pinned.matches("Remote", "usb-2/input0", "abc"));
    }
}
