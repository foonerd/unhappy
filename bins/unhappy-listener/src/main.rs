//! unhappy-listener: the input listener of the Unhappy TriggerHappy plugin.
//!
//! It takes over the remotes the plugin names, reads their keys with the
//! kernel's timestamps, and runs a command on a short, long, or double
//! press. Everything else on the player keeps its input devices: a device
//! is grabbed only when the configuration names it. A control socket
//! answers the plugin's questions and captures the next key for its wizard.

mod config;
mod control;
mod devices;
mod engine;

use config::Config;
use control::{Request, Server};
use devices::Open;
use engine::{Action, Engine, Ms};
use evdev::{EventSummary, EventType};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Instant, SystemTime};

const VERSION: &str = env!("CARGO_PKG_VERSION");

/// How often the configuration file and the device list are looked at.
const CONFIG_POLL_MS: Ms = 1000;
const RESCAN_MS: Ms = 2000;

static STOP: AtomicBool = AtomicBool::new(false);

pub fn log(message: &str) {
    eprintln!("unhappy-listener: {message}");
}

extern "C" fn on_stop_signal(_: libc::c_int) {
    STOP.store(true, Ordering::SeqCst);
}

struct Args {
    config: PathBuf,
    socket: PathBuf,
}

fn parse_args() -> Result<Args, String> {
    let mut args = Args {
        config: PathBuf::from(config::DEFAULT_PATH),
        socket: PathBuf::from(control::DEFAULT_PATH),
    };
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--config" => args.config = PathBuf::from(it.next().ok_or("--config needs a path")?),
            "--socket" => args.socket = PathBuf::from(it.next().ok_or("--socket needs a path")?),
            "--version" => {
                println!("unhappy-listener {VERSION}");
                std::process::exit(0);
            }
            "--help" => {
                println!(
                    "unhappy-listener [--config {}] [--socket {}]",
                    config::DEFAULT_PATH,
                    control::DEFAULT_PATH
                );
                std::process::exit(0);
            }
            other => return Err(format!("unknown argument {other}")),
        }
    }
    Ok(args)
}

/// A capture in flight: who asked, and until when.
struct Capture {
    client: UnixStream,
    deadline: Ms,
}

struct Daemon {
    started: Instant,
    config_path: PathBuf,
    config: Config,
    config_error: Option<String>,
    config_seen: Option<SystemTime>,
    engine: Engine,
    opens: Vec<Open>,
    next_id: u32,
    rescan_at: Ms,
    config_check_at: Ms,
    captures: Vec<Capture>,
}

impl Daemon {
    fn now(&self) -> Ms {
        self.started.elapsed().as_millis() as Ms
    }

    fn load_config(&mut self) {
        self.config_seen = std::fs::metadata(&self.config_path)
            .and_then(|m| m.modified())
            .ok();
        match Config::load(&self.config_path) {
            Ok(config) => {
                log(&format!(
                    "configuration: {} device(s), {} binding(s), long {} ms, double {} ms, debounce {} ms",
                    config.devices.len(),
                    config.bindings.len(),
                    config.timing.long_ms,
                    config.timing.double_ms,
                    config.timing.debounce_ms
                ));
                self.engine = Engine::new(config.timing, &config.bindings);
                self.config = config;
                self.config_error = None;
            }
            Err(e) => {
                log(&format!("configuration not applied: {e}"));
                self.config_error = Some(e);
                if self.config_seen.is_none() {
                    // No file yet: nothing to take over, nothing to run.
                    self.config = Config::default();
                    self.engine = Engine::new(self.config.timing, &[]);
                }
            }
        }
        // Devices no longer named are released; named ones are picked up by the rescan.
        let config = &self.config;
        self.opens.retain(|o| {
            !o.taken
                || config
                    .devices
                    .iter()
                    .any(|d| d.matches(&o.identity.name, &o.identity.phys, &o.identity.uniq))
        });
        self.rescan_at = 0;
    }

    fn config_changed(&self) -> bool {
        let seen = std::fs::metadata(&self.config_path)
            .and_then(|m| m.modified())
            .ok();
        seen != self.config_seen
    }

    /// Open every named device that is present and not yet held.
    fn rescan(&mut self) {
        for present in devices::present() {
            let id = present.identity.clone();
            if self.opens.iter().any(|o| o.identity.path == id.path) {
                continue;
            }
            let named = self
                .config
                .devices
                .iter()
                .any(|d| d.matches(&id.name, &id.phys, &id.uniq));
            if !named {
                continue;
            }
            match Open::new(self.next_id, present, true) {
                Ok(open) => {
                    log(&format!(
                        "took over {} ({}){}",
                        open.identity.name,
                        open.identity.path.display(),
                        if open.grabbed { "" } else { ", not grabbed" }
                    ));
                    self.opens.push(open);
                    self.next_id += 1;
                }
                Err(e) => log(&format!(
                    "cannot open {} ({}): {e}",
                    id.name,
                    id.path.display()
                )),
            }
        }
        self.rescan_at = self.now() + RESCAN_MS;
    }

    /// For the wizard: read every key device not already held, without grabbing.
    fn open_for_capture(&mut self) {
        for present in devices::present() {
            if self
                .opens
                .iter()
                .any(|o| o.identity.path == present.identity.path)
            {
                continue;
            }
            if let Ok(open) = Open::new(self.next_id, present, false) {
                self.opens.push(open);
                self.next_id += 1;
            }
        }
    }

    fn close_capture_devices(&mut self) {
        let mut dropped = Vec::new();
        self.opens.retain(|o| {
            if o.taken {
                true
            } else {
                dropped.push(o.id);
                false
            }
        });
        for id in dropped {
            self.engine.forget_device(id);
        }
    }

    fn drop_device(&mut self, index: usize, why: &str) {
        let open = self.opens.remove(index);
        log(&format!(
            "{} ({}) {why}",
            open.identity.name,
            open.identity.path.display()
        ));
        self.engine.forget_device(open.id);
        self.rescan_at = self.now() + RESCAN_MS;
    }

    fn status(&self) -> serde_json::Value {
        serde_json::json!({
            "ok": true,
            "version": VERSION,
            "config": self.config_path.to_string_lossy(),
            "config_error": self.config_error,
            "devices": self.opens.iter().filter(|o| o.taken).map(Open::json).collect::<Vec<_>>(),
            "wanted": self.config.devices.len(),
            "bindings": self.config.bindings.len(),
            "timing": self.config.timing,
            "capturing": !self.captures.is_empty(),
        })
    }

    fn list(&self) -> serde_json::Value {
        let devices: Vec<serde_json::Value> = devices::present()
            .into_iter()
            .map(|p| {
                let mut v = p.identity.json();
                v["keys"] = serde_json::Value::from(p.keys);
                v["touch"] = serde_json::Value::Bool(p.touch);
                v["taken"] = serde_json::Value::Bool(
                    self.opens
                        .iter()
                        .any(|o| o.taken && o.identity.path == p.identity.path),
                );
                v
            })
            .collect();
        serde_json::json!({"ok": true, "devices": devices})
    }

    fn handle(&mut self, client: UnixStream, request: Request) {
        match request {
            Request::Status => control::respond(client, &self.status()),
            Request::List => control::respond(client, &self.list()),
            Request::Reload => {
                self.load_config();
                let body = match &self.config_error {
                    None => serde_json::json!({"ok": true}),
                    Some(e) => serde_json::json!({"ok": false, "error": e}),
                };
                control::respond(client, &body);
            }
            Request::Capture { timeout_ms } => {
                self.open_for_capture();
                self.captures.push(Capture {
                    client,
                    deadline: self.now() + timeout_ms,
                });
                log(&format!("capturing the next key for up to {timeout_ms} ms"));
            }
        }
    }

    /// A key press reached the wizard: every waiting client gets it.
    fn captured(&mut self, key: &str, identity: &devices::Identity) {
        let body = serde_json::json!({"ok": true, "key": key, "device": identity.json()});
        for capture in self.captures.drain(..) {
            control::respond(capture.client, &body);
        }
        log(&format!(
            "captured {key} from {} ({})",
            identity.name,
            identity.path.display()
        ));
        self.close_capture_devices();
    }

    fn expire_captures(&mut self, now: Ms) {
        if self.captures.is_empty() {
            return;
        }
        let (due, waiting): (Vec<Capture>, Vec<Capture>) =
            self.captures.drain(..).partition(|c| now >= c.deadline);
        self.captures = waiting;
        for capture in due {
            control::respond(
                capture.client,
                &serde_json::json!({"ok": false, "error": "timeout"}),
            );
        }
        if self.captures.is_empty() {
            self.close_capture_devices();
        }
    }

    /// Events from one held device; `Err` means the device is gone.
    fn read_device(&mut self, index: usize, now: Ms) -> Result<Vec<Action>, std::io::Error> {
        let mut actions = Vec::new();
        let mut captured: Option<(String, devices::Identity)> = None;
        let capturing = !self.captures.is_empty();
        let open = &mut self.opens[index];
        let events = match open.dev.fetch_events() {
            Ok(events) => events,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => return Ok(actions),
            Err(e) => return Err(e),
        };
        for event in events {
            if event.event_type() != EventType::KEY {
                continue;
            }
            let EventSummary::Key(_, code, value) = event.destructure() else {
                continue;
            };
            let key = format!("{code:?}");
            // A key pressed for the wizard is an answer, not a command: the
            // engine never sees that press, so its release ends nothing.
            if capturing {
                if value == 1 && captured.is_none() {
                    captured = Some((key, open.identity.clone()));
                }
                continue;
            }
            if open.taken && self.engine.is_bound(&key) {
                actions.extend(self.engine.on_key(open.id, &key, value, now));
            }
        }
        if let Some((key, identity)) = captured {
            self.captured(&key, &identity);
        }
        Ok(actions)
    }

    fn run_actions(&self, actions: Vec<Action>) {
        // While the wizard waits for a key, a press is an answer, not a command.
        if !self.captures.is_empty() {
            return;
        }
        for action in actions {
            log(&format!(
                "{} {}: {}",
                action.key, action.press, action.command
            ));
            let spawned = Command::new("/bin/sh")
                .arg("-c")
                .arg(&action.command)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::inherit())
                .spawn();
            if let Err(e) = spawned {
                log(&format!("cannot run {}: {e}", action.command));
            }
        }
    }

    /// Sleep until a descriptor is readable or the next deadline, then do
    /// what is due. Returns the devices to read, by index.
    fn wait(&mut self, server: &Server) -> Vec<usize> {
        let now = self.now();
        let mut deadline = now + CONFIG_POLL_MS;
        let mut consider = |t: Ms| deadline = deadline.min(t);
        if let Some(t) = self.engine.next_deadline() {
            consider(t);
        }
        consider(self.rescan_at);
        consider(self.config_check_at);
        for c in &self.captures {
            consider(c.deadline);
        }
        let timeout = deadline.saturating_sub(now).min(i32::MAX as Ms) as libc::c_int;

        let mut fds: Vec<libc::pollfd> = Vec::with_capacity(self.opens.len() + 1);
        fds.push(libc::pollfd {
            fd: server.fd(),
            events: libc::POLLIN,
            revents: 0,
        });
        for open in &self.opens {
            fds.push(libc::pollfd {
                fd: open.fd(),
                events: libc::POLLIN,
                revents: 0,
            });
        }
        // SAFETY: fds is a live, correctly sized array of pollfd for the call's duration.
        let ready = unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, timeout) };
        if ready < 0 {
            let e = std::io::Error::last_os_error();
            if e.kind() != std::io::ErrorKind::Interrupted {
                log(&format!("poll failed: {e}"));
            }
            return Vec::new();
        }
        let mut readable = Vec::new();
        if fds[0].revents & libc::POLLIN != 0 {
            while let Some((client, request)) = server.accept() {
                self.handle(client, request);
            }
        }
        for (i, fd) in fds.iter().enumerate().skip(1) {
            if fd.revents & (libc::POLLIN | libc::POLLERR | libc::POLLHUP) != 0 {
                readable.push(i - 1);
            }
        }
        readable
    }
}

fn main() {
    let args = match parse_args() {
        Ok(args) => args,
        Err(e) => {
            log(&e);
            std::process::exit(2);
        }
    };
    // Children are the commands bindings run; the kernel reaps them.
    // SAFETY: setting a disposition for signals this process owns.
    unsafe {
        libc::signal(libc::SIGCHLD, libc::SIG_IGN);
        let stop = on_stop_signal as extern "C" fn(libc::c_int) as libc::sighandler_t;
        libc::signal(libc::SIGTERM, stop);
        libc::signal(libc::SIGINT, stop);
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
    }
    let server = match Server::bind(&args.socket) {
        Ok(server) => server,
        Err(e) => {
            log(&format!("cannot listen on {}: {e}", args.socket.display()));
            std::process::exit(1);
        }
    };
    log(&format!("{VERSION} listening on {}", args.socket.display()));
    let mut daemon = Daemon {
        started: Instant::now(),
        config_path: args.config,
        config: Config::default(),
        config_error: None,
        config_seen: None,
        engine: Engine::new(config::Timing::default(), &[]),
        opens: Vec::new(),
        next_id: 1,
        rescan_at: 0,
        config_check_at: 0,
        captures: Vec::new(),
    };
    daemon.load_config();

    while !STOP.load(Ordering::SeqCst) {
        let readable = daemon.wait(&server);
        let now = daemon.now();
        // Highest index first, so a removal does not shift the ones still to read.
        for index in readable.into_iter().rev() {
            if index >= daemon.opens.len() {
                continue;
            }
            match daemon.read_device(index, now) {
                Ok(actions) => daemon.run_actions(actions),
                Err(e) => daemon.drop_device(index, &format!("is gone: {e}")),
            }
        }
        let due = daemon.engine.tick(now);
        daemon.run_actions(due);
        daemon.expire_captures(now);
        if now >= daemon.config_check_at {
            daemon.config_check_at = now + CONFIG_POLL_MS;
            if daemon.config_changed() {
                log("configuration file changed");
                daemon.load_config();
            }
        }
        if now >= daemon.rescan_at {
            daemon.rescan();
        }
    }
    log("stopping");
    daemon.opens.clear();
    drop(server);
}
