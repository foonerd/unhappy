//! The press state machine. It sees key edges with a clock reading and says
//! which commands to run; it never touches a device or a process, so it is
//! tested on a table of timings.
//!
//! Rules, per key on each device:
//! - A press closer than the debounce window to the previous press is bounce.
//! - Autorepeat events (value 2) are ignored; the clock decides what is long.
//! - A key held for the long threshold fires its long binding once, and the
//!   release that follows fires nothing.
//! - With a double binding on the key, a release starts a gap: a second press
//!   inside it fires the double binding at once, and the release of that
//!   press fires nothing; a gap that runs out fires the short binding, if any.
//! - Without a double binding, a release before the long threshold fires the
//!   short binding at once.

use crate::config::{Binding, Press, Timing};
use std::collections::HashMap;

/// Milliseconds on a monotonic clock.
pub type Ms = u64;

/// A command to run, with what caused it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Action {
    pub key: String,
    pub press: Press,
    pub command: String,
}

#[derive(Debug, Clone, Default)]
struct KeyBindings {
    short: Option<String>,
    long: Option<String>,
    double: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct KeyState {
    down_since: Option<Ms>,
    last_press: Option<Ms>,
    long_fired: bool,
    /// The release of a double's second press, or of a long press, is spent.
    swallow_release: bool,
    /// A release waiting out the double gap; the deadline at which it is a short.
    pending: Option<Ms>,
}

pub struct Engine {
    timing: Timing,
    bindings: HashMap<String, KeyBindings>,
    states: HashMap<(u32, String), KeyState>,
}

impl Engine {
    pub fn new(timing: Timing, bindings: &[Binding]) -> Engine {
        let mut map: HashMap<String, KeyBindings> = HashMap::new();
        for b in bindings {
            let slot = map.entry(b.key.clone()).or_default();
            let target = match b.press {
                Press::Short => &mut slot.short,
                Press::Long => &mut slot.long,
                Press::Double => &mut slot.double,
            };
            // The last binding written for a key and press wins, as in a config file.
            *target = Some(b.command.clone());
        }
        Engine {
            timing,
            bindings: map,
            states: HashMap::new(),
        }
    }

    /// Whether any binding names this key; unbound keys cost nothing.
    pub fn is_bound(&self, key: &str) -> bool {
        self.bindings.contains_key(key)
    }

    /// A key edge from a device: 1 pressed, 0 released, 2 autorepeat.
    pub fn on_key(&mut self, device: u32, key: &str, value: i32, now: Ms) -> Vec<Action> {
        let mut out = Vec::new();
        let Some(b) = self.bindings.get(key).cloned() else {
            return out;
        };
        let st = self.states.entry((device, key.to_string())).or_default();
        match value {
            1 => {
                if st
                    .last_press
                    .is_some_and(|t| now.saturating_sub(t) < self.timing.debounce_ms)
                {
                    return out;
                }
                st.last_press = Some(now);
                st.down_since = Some(now);
                st.long_fired = false;
                if st.pending.take().is_some() {
                    if let Some(cmd) = b.double.clone() {
                        st.swallow_release = true;
                        out.push(Action {
                            key: key.to_string(),
                            press: Press::Double,
                            command: cmd,
                        });
                        return out;
                    }
                }
                st.swallow_release = false;
            }
            0 => {
                let Some(down) = st.down_since.take() else {
                    return out;
                };
                if std::mem::take(&mut st.swallow_release) {
                    return out;
                }
                if std::mem::take(&mut st.long_fired) {
                    return out;
                }
                if let Some(cmd) = b.long.clone() {
                    if now.saturating_sub(down) >= self.timing.long_ms {
                        out.push(Action {
                            key: key.to_string(),
                            press: Press::Long,
                            command: cmd,
                        });
                        return out;
                    }
                }
                if b.double.is_some() {
                    st.pending = Some(now + self.timing.double_ms);
                } else if let Some(cmd) = b.short.clone() {
                    out.push(Action {
                        key: key.to_string(),
                        press: Press::Short,
                        command: cmd,
                    });
                }
            }
            _ => {}
        }
        out
    }

    /// The clock moved: long presses that reached their threshold and single
    /// presses whose double gap ran out.
    pub fn tick(&mut self, now: Ms) -> Vec<Action> {
        let mut out = Vec::new();
        for ((_, key), st) in self.states.iter_mut() {
            let Some(b) = self.bindings.get(key) else {
                continue;
            };
            if let (Some(down), Some(cmd)) = (st.down_since, b.long.as_ref()) {
                if !st.long_fired
                    && !st.swallow_release
                    && now.saturating_sub(down) >= self.timing.long_ms
                {
                    st.long_fired = true;
                    out.push(Action {
                        key: key.clone(),
                        press: Press::Long,
                        command: cmd.clone(),
                    });
                }
            }
            if let Some(deadline) = st.pending {
                if now >= deadline {
                    st.pending = None;
                    if let Some(cmd) = b.short.as_ref() {
                        out.push(Action {
                            key: key.clone(),
                            press: Press::Short,
                            command: cmd.clone(),
                        });
                    }
                }
            }
        }
        out
    }

    /// When `tick` next has something to do, if anything is in flight.
    pub fn next_deadline(&self) -> Option<Ms> {
        let mut next: Option<Ms> = None;
        let mut consider = |t: Ms| next = Some(next.map_or(t, |n| n.min(t)));
        for ((_, key), st) in &self.states {
            let Some(b) = self.bindings.get(key) else {
                continue;
            };
            if let Some(down) = st.down_since {
                if b.long.is_some() && !st.long_fired && !st.swallow_release {
                    consider(down + self.timing.long_ms);
                }
            }
            if let Some(deadline) = st.pending {
                consider(deadline);
            }
        }
        next
    }

    /// Forget every key on a device that went away.
    pub fn forget_device(&mut self, device: u32) {
        self.states.retain(|(d, _), _| *d != device);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn binding(key: &str, press: Press, command: &str) -> Binding {
        Binding {
            key: key.into(),
            press,
            command: command.into(),
        }
    }

    fn timing() -> Timing {
        Timing {
            long_ms: 400,
            double_ms: 300,
            debounce_ms: 30,
        }
    }

    fn names(actions: &[Action]) -> Vec<String> {
        actions
            .iter()
            .map(|a| format!("{} {}", a.press, a.command))
            .collect()
    }

    /// Drive an engine with (time, value) edges on one key, ticking at each
    /// step and once at `until`, and collect what fired with its time.
    fn run(engine: &mut Engine, key: &str, edges: &[(Ms, i32)], until: Ms) -> Vec<(Ms, String)> {
        let mut fired = Vec::new();
        let mut t = 0;
        for &(at, value) in edges {
            while t < at {
                t += 1;
                for a in engine.tick(t) {
                    fired.push((t, format!("{} {}", a.press, a.command)));
                }
            }
            for a in engine.on_key(0, key, value, at) {
                fired.push((at, format!("{} {}", a.press, a.command)));
            }
        }
        while t < until {
            t += 1;
            for a in engine.tick(t) {
                fired.push((t, format!("{} {}", a.press, a.command)));
            }
        }
        fired
    }

    #[test]
    fn short_fires_on_release_when_only_short_is_bound() {
        let mut e = Engine::new(timing(), &[binding("KEY_PLAY", Press::Short, "play")]);
        let fired = run(&mut e, "KEY_PLAY", &[(100, 1), (180, 0)], 1000);
        assert_eq!(fired, vec![(180, "short play".to_string())]);
    }

    #[test]
    fn unbound_keys_are_ignored() {
        let mut e = Engine::new(timing(), &[binding("KEY_PLAY", Press::Short, "play")]);
        assert!(!e.is_bound("KEY_STOP"));
        assert!(e.on_key(0, "KEY_STOP", 1, 10).is_empty());
        assert!(e.on_key(0, "KEY_STOP", 0, 80).is_empty());
        assert_eq!(e.next_deadline(), None);
    }

    #[test]
    fn long_fires_once_at_the_threshold_and_the_release_is_silent() {
        let mut e = Engine::new(
            timing(),
            &[
                binding("KEY_PLAY", Press::Short, "play"),
                binding("KEY_PLAY", Press::Long, "stop"),
            ],
        );
        let fired = run(
            &mut e,
            "KEY_PLAY",
            &[(100, 1), (100 + 33, 2), (100 + 66, 2), (900, 0)],
            1500,
        );
        assert_eq!(fired, vec![(500, "long stop".to_string())]);
    }

    #[test]
    fn a_press_released_before_the_threshold_is_short() {
        let mut e = Engine::new(
            timing(),
            &[
                binding("KEY_PLAY", Press::Short, "play"),
                binding("KEY_PLAY", Press::Long, "stop"),
            ],
        );
        let fired = run(&mut e, "KEY_PLAY", &[(100, 1), (399, 0)], 1000);
        assert_eq!(fired, vec![(399, "short play".to_string())]);
    }

    #[test]
    fn double_fires_on_the_second_press_and_swallows_its_release() {
        let mut e = Engine::new(
            timing(),
            &[
                binding("KEY_PLAY", Press::Short, "play"),
                binding("KEY_PLAY", Press::Double, "next"),
            ],
        );
        let fired = run(
            &mut e,
            "KEY_PLAY",
            &[(100, 1), (160, 0), (300, 1), (360, 0)],
            1000,
        );
        assert_eq!(fired, vec![(300, "double next".to_string())]);
    }

    #[test]
    fn a_single_press_with_double_bound_is_short_after_the_gap() {
        let mut e = Engine::new(
            timing(),
            &[
                binding("KEY_PLAY", Press::Short, "play"),
                binding("KEY_PLAY", Press::Double, "next"),
            ],
        );
        let fired = run(&mut e, "KEY_PLAY", &[(100, 1), (160, 0)], 1000);
        assert_eq!(fired, vec![(460, "short play".to_string())]);
        assert_eq!(e.next_deadline(), None);
    }

    #[test]
    fn two_presses_outside_the_gap_are_two_shorts() {
        let mut e = Engine::new(
            timing(),
            &[
                binding("KEY_PLAY", Press::Short, "play"),
                binding("KEY_PLAY", Press::Double, "next"),
            ],
        );
        let fired = run(
            &mut e,
            "KEY_PLAY",
            &[(100, 1), (160, 0), (600, 1), (660, 0)],
            1500,
        );
        assert_eq!(
            fired,
            vec![
                (460, "short play".to_string()),
                (960, "short play".to_string())
            ]
        );
    }

    #[test]
    fn double_only_binding_never_fires_a_short() {
        let mut e = Engine::new(timing(), &[binding("KEY_PLAY", Press::Double, "next")]);
        let fired = run(&mut e, "KEY_PLAY", &[(100, 1), (160, 0)], 1000);
        assert!(fired.is_empty());
    }

    #[test]
    fn all_three_on_one_key() {
        let mut e = Engine::new(
            timing(),
            &[
                binding("KEY_PLAY", Press::Short, "play"),
                binding("KEY_PLAY", Press::Long, "stop"),
                binding("KEY_PLAY", Press::Double, "next"),
            ],
        );
        let edges = &[
            (100, 1),
            (160, 0), // single: short after the gap at 460
            (1000, 1),
            (1060, 0),
            (1200, 1), // double at 1200
            (1260, 0),
            (2000, 1), // long at 2400
            (2800, 0),
        ];
        let fired = run(&mut e, "KEY_PLAY", edges, 3500);
        assert_eq!(
            names(
                &fired
                    .iter()
                    .map(|(_, s)| s)
                    .map(|s| Action {
                        key: String::new(),
                        press: if s.starts_with("short") {
                            Press::Short
                        } else if s.starts_with("long") {
                            Press::Long
                        } else {
                            Press::Double
                        },
                        command: s.split(' ').nth(1).unwrap().to_string(),
                    })
                    .collect::<Vec<_>>()
            ),
            vec!["short play", "double next", "long stop"]
        );
        assert_eq!(
            fired.iter().map(|(t, _)| *t).collect::<Vec<_>>(),
            vec![460, 1200, 2400]
        );
    }

    #[test]
    fn bounce_counted_exactly() {
        let mut e = Engine::new(timing(), &[binding("KEY_PLAY", Press::Short, "play")]);
        let fired = run(
            &mut e,
            "KEY_PLAY",
            &[(100, 1), (105, 0), (110, 1), (200, 0)],
            500,
        );
        // The 105 release ends the first press (a 5 ms press is not filtered on the
        // release side), the 110 press is bounce and ignored, so the 200 release has
        // no press to end: exactly one short fires.
        assert_eq!(fired, vec![(105, "short play".to_string())]);
    }

    #[test]
    fn keys_on_different_devices_do_not_share_state() {
        let mut e = Engine::new(
            timing(),
            &[
                binding("KEY_PLAY", Press::Short, "play"),
                binding("KEY_PLAY", Press::Double, "next"),
            ],
        );
        e.on_key(0, "KEY_PLAY", 1, 100);
        e.on_key(0, "KEY_PLAY", 0, 160);
        // A press on another device inside the gap is not the second press of a double.
        let fired = e.on_key(1, "KEY_PLAY", 1, 200);
        assert!(fired.is_empty());
        e.forget_device(0);
        assert_eq!(e.next_deadline(), None);
    }

    #[test]
    fn next_deadline_names_the_long_threshold_then_nothing() {
        let mut e = Engine::new(timing(), &[binding("KEY_PLAY", Press::Long, "stop")]);
        e.on_key(0, "KEY_PLAY", 1, 100);
        assert_eq!(e.next_deadline(), Some(500));
        assert_eq!(e.tick(500).len(), 1);
        assert_eq!(e.next_deadline(), None);
        assert!(e.on_key(0, "KEY_PLAY", 0, 700).is_empty());
    }
}
