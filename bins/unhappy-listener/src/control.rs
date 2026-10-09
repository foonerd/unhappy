//! The control socket: one JSON object in, one JSON object out, per
//! connection. The plugin asks for status, the device list, a config
//! reload, or the next key press (the capture wizard).

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Where the daemon listens.
pub const DEFAULT_PATH: &str = "/tmp/unhappy-listener.sock";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Request {
    Status,
    List,
    Reload,
    Capture { timeout_ms: u64 },
}

impl Request {
    pub fn parse(line: &str) -> Result<Request, String> {
        let v: serde_json::Value =
            serde_json::from_str(line.trim()).map_err(|e| format!("bad JSON: {e}"))?;
        let cmd = v.get("cmd").and_then(|c| c.as_str()).ok_or("no cmd")?;
        match cmd {
            "status" => Ok(Request::Status),
            "list" => Ok(Request::List),
            "reload" => Ok(Request::Reload),
            "capture" => {
                let timeout_ms = v
                    .get("timeout_ms")
                    .and_then(|t| t.as_u64())
                    .unwrap_or(10_000);
                Ok(Request::Capture {
                    timeout_ms: timeout_ms.clamp(500, 60_000),
                })
            }
            other => Err(format!("unknown cmd {other}")),
        }
    }
}

pub struct Server {
    listener: UnixListener,
    path: PathBuf,
}

impl Server {
    pub fn bind(path: &Path) -> std::io::Result<Server> {
        // A socket file left by an earlier run would refuse the bind.
        if path.exists() {
            std::fs::remove_file(path)?;
        }
        let listener = UnixListener::bind(path)?;
        listener.set_nonblocking(true)?;
        Ok(Server {
            listener,
            path: path.to_path_buf(),
        })
    }

    pub fn fd(&self) -> i32 {
        use std::os::fd::AsRawFd;
        self.listener.as_raw_fd()
    }

    /// The next waiting connection with its request read, or nothing. A
    /// client that sends nothing within half a second is dropped; a request
    /// that does not parse is answered with the error and dropped.
    pub fn accept(&self) -> Option<(UnixStream, Request)> {
        let (stream, _) = self.listener.accept().ok()?;
        if stream.set_nonblocking(false).is_err()
            || stream
                .set_read_timeout(Some(Duration::from_millis(500)))
                .is_err()
        {
            return None;
        }
        let mut line = String::new();
        let mut reader = BufReader::new(stream.try_clone().ok()?);
        if reader.read_line(&mut line).is_err() {
            return None;
        }
        match Request::parse(&line) {
            Ok(request) => Some((stream, request)),
            Err(e) => {
                respond(stream, &serde_json::json!({"ok": false, "error": e}));
                None
            }
        }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// One JSON line back, then the connection closes with the stream.
pub fn respond(mut stream: UnixStream, body: &serde_json::Value) {
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
    let _ = writeln!(stream, "{body}");
    let _ = stream.flush();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_requests() {
        assert_eq!(Request::parse(r#"{"cmd":"status"}"#), Ok(Request::Status));
        assert_eq!(Request::parse(r#"{"cmd":"list"}"#), Ok(Request::List));
        assert_eq!(Request::parse(r#"{"cmd":"reload"}"#), Ok(Request::Reload));
        assert_eq!(
            Request::parse(r#"{"cmd":"capture","timeout_ms":5000}"#),
            Ok(Request::Capture { timeout_ms: 5000 })
        );
        assert_eq!(
            Request::parse(r#"{"cmd":"capture"}"#),
            Ok(Request::Capture { timeout_ms: 10_000 })
        );
        assert_eq!(
            Request::parse(r#"{"cmd":"capture","timeout_ms":1}"#),
            Ok(Request::Capture { timeout_ms: 500 })
        );
    }

    #[test]
    fn refuses_what_it_does_not_know() {
        assert!(Request::parse("not json").is_err());
        assert!(Request::parse(r#"{"cmd":"quit"}"#).is_err());
        assert!(Request::parse(r#"{"x":1}"#).is_err());
    }

    #[test]
    fn binds_answers_and_cleans_up() {
        let dir =
            std::env::temp_dir().join(format!("unhappy-listener-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("control.sock");
        {
            let server = Server::bind(&path).unwrap();
            assert!(path.exists());
            let mut client = UnixStream::connect(&path).unwrap();
            writeln!(client, r#"{{"cmd":"status"}}"#).unwrap();
            let (stream, request) = server.accept().expect("a request");
            assert_eq!(request, Request::Status);
            respond(stream, &serde_json::json!({"ok": true}));
            let mut answer = String::new();
            BufReader::new(client).read_line(&mut answer).unwrap();
            assert_eq!(answer.trim(), r#"{"ok":true}"#);
        }
        assert!(!path.exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
