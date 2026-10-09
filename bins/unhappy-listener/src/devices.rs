//! Input devices: what is present, what identifies one across reconnects,
//! and the ones held open.

use evdev::Device;
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};

/// What names a device when its event node changes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Identity {
    pub name: String,
    pub phys: String,
    pub uniq: String,
    pub path: PathBuf,
}

impl Identity {
    pub fn of(path: &Path, dev: &Device) -> Identity {
        Identity {
            name: dev.name().unwrap_or("").to_string(),
            phys: dev.physical_path().unwrap_or("").to_string(),
            uniq: dev.unique_name().unwrap_or("").to_string(),
            path: path.to_path_buf(),
        }
    }

    pub fn json(&self) -> serde_json::Value {
        serde_json::json!({
            "name": self.name,
            "phys": self.phys,
            "uniq": self.uniq,
            "path": self.path.to_string_lossy(),
        })
    }
}

/// How many keys a device reports; a device with none is not a remote.
pub fn key_count(dev: &Device) -> usize {
    dev.supported_keys().map_or(0, |keys| keys.iter().count())
}

/// Touchscreens and tablets report absolute axes; they are not remotes and
/// another process may be reading them.
pub fn has_absolute_axes(dev: &Device) -> bool {
    dev.supported_absolute_axes()
        .is_some_and(|axes| axes.iter().next().is_some())
}

/// A device present now, as the control socket lists it.
pub struct Present {
    pub identity: Identity,
    pub dev: Device,
    pub keys: usize,
    pub touch: bool,
}

/// Every event device with at least one key, in path order.
pub fn present() -> Vec<Present> {
    let mut found: Vec<Present> = evdev::enumerate()
        .filter_map(|(path, dev)| {
            let keys = key_count(&dev);
            if keys == 0 {
                return None;
            }
            let touch = has_absolute_axes(&dev);
            Some(Present {
                identity: Identity::of(&path, &dev),
                dev,
                keys,
                touch,
            })
        })
        .collect();
    found.sort_by(|a, b| a.identity.path.cmp(&b.identity.path));
    found
}

/// A device the daemon reads.
pub struct Open {
    /// A number the engine keys state by; never reused while the daemon runs.
    pub id: u32,
    pub identity: Identity,
    pub dev: Device,
    /// Taken over: grabbed, and its presses run bindings.
    pub taken: bool,
    pub grabbed: bool,
}

impl Open {
    /// Open a present device for reading without blocking; take it over
    /// (grab it) when asked. A grab that fails leaves the device readable.
    pub fn new(id: u32, mut present: Present, take: bool) -> std::io::Result<Open> {
        present.dev.set_nonblocking(true)?;
        let mut grabbed = false;
        if take {
            match present.dev.grab() {
                Ok(()) => grabbed = true,
                Err(e) => crate::log(&format!(
                    "cannot grab {} ({}): {e}",
                    present.identity.name,
                    present.identity.path.display()
                )),
            }
        }
        Ok(Open {
            id,
            identity: present.identity,
            dev: present.dev,
            taken: take,
            grabbed,
        })
    }

    pub fn fd(&self) -> i32 {
        self.dev.as_raw_fd()
    }

    pub fn json(&self) -> serde_json::Value {
        let mut v = self.identity.json();
        v["taken"] = serde_json::Value::Bool(self.taken);
        v["grabbed"] = serde_json::Value::Bool(self.grabbed);
        v
    }
}

impl Drop for Open {
    fn drop(&mut self) {
        if self.grabbed {
            // The kernel releases a grab with the descriptor; this only keeps
            // the release explicit while the device is still there.
            let _ = self.dev.ungrab();
        }
    }
}
