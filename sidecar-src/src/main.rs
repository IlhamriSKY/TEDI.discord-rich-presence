//! tedi-discord-helper: localhost HTTP sidecar for the
//! `tedi.discord-rich-presence` TEDI extension.
//!
//! The webview-hosted extension can't open Discord's named pipe / Unix
//! socket directly, so this helper binary holds the IPC connection and
//! exposes it over a loopback HTTP server. The extension JS layer
//! invokes:
//!
//!   POST /connect             -> "" (200) or error (4xx/5xx)
//!   POST /update  {details,state} -> "" (200) or error
//!   POST /disconnect          -> "" (200)
//!   POST /shutdown            -> "" (200) then process exits
//!
//! Lifecycle:
//!   1. Helper binds 127.0.0.1:0 (kernel-assigned ephemeral port).
//!   2. Prints `PORT=<n>` to stdout so the extension can read it via
//!      `shell_bg_logs`.
//!   3. Serves requests until /shutdown or parent dies.
//!   4. On any disconnect, the cached `DiscordIpcClient` is dropped.
//!
//! Security: 127.0.0.1 only (no IP wildcard). Treat the port as
//! authorisation-by-obscurity scoped to the local machine. Other
//! local users on the same machine could in theory poke the port -
//! acceptable for a personal-presence helper. Don't host sensitive
//! commands behind this protocol.

use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use discord_rich_presence::{
    activity::{Activity, Assets, Timestamps},
    DiscordIpc, DiscordIpcClient,
};
use serde::Deserialize;
use tiny_http::{Header, Method, Response, Server, StatusCode};

/// Self-terminate if no request lands within this window. Catches the
/// "TEDI parent SIGKILL'd, helper orphaned" case without leaving a stray
/// process on the user's machine for days. 4 h is generous: the
/// extension fires a request whenever the workspace context changes, so
/// any active TEDI session is well under this threshold.
const IDLE_TIMEOUT: Duration = Duration::from_secs(4 * 60 * 60);
/// How often the receive loop wakes up to check the idle timer.
const RECV_TICK: Duration = Duration::from_secs(60);

const DISCORD_APP_ID: &str = "1506303762418110505";
const LARGE_IMAGE_KEY: &str = "tedi_logo";
const LARGE_IMAGE_TEXT: &str = "TEDI - Terminal Environment & Development Infrastructure";

struct State {
    client: Mutex<Option<DiscordIpcClient>>,
    started_at_ms: Mutex<Option<i64>>,
}

impl State {
    fn new() -> Self {
        Self {
            client: Mutex::new(None),
            started_at_ms: Mutex::new(None),
        }
    }
}

#[derive(Deserialize, Default)]
struct UpdatePayload {
    #[serde(default)]
    details: String,
    #[serde(default)]
    state: String,
}

fn main() {
    // Bind to localhost on an ephemeral port. tiny_http accepts a host
    // string; "127.0.0.1:0" instructs the OS to pick any free port.
    // We immediately query the bound address to learn which one.
    let server = match Server::http("127.0.0.1:0") {
        Ok(s) => s,
        Err(e) => {
            eprintln!("sidecar: bind 127.0.0.1:0 failed: {e}");
            std::process::exit(2);
        }
    };
    let port = match server.server_addr().to_ip().map(|sa| sa.port()) {
        Some(p) if p != 0 => p,
        _ => {
            eprintln!("sidecar: could not resolve bound TCP port");
            std::process::exit(3);
        }
    };

    // Stdout protocol: the extension JS reads `PORT=<n>` from logs.
    // Flushing is important because shell_bg_spawn's ring buffer is
    // line-oriented and a unflushed line would race the first request.
    println!("PORT={port}");
    use std::io::Write as _;
    let _ = std::io::stdout().flush();

    let state = State::new();
    let mut last_seen = Instant::now();
    // Poll-based receive so we can run the idle check every minute.
    // `incoming_requests()` is a blocking iterator that would block
    // forever on a quiet client; that's exactly the orphan case we want
    // to defuse.
    loop {
        match server.recv_timeout(RECV_TICK) {
            Ok(Some(mut request)) => {
                last_seen = Instant::now();

                // CORS preflight: webview origin (e.g. http://localhost:1420
                // in TEDI dev mode, or tauri://localhost in production)
                // differs from our http://127.0.0.1:<port> sidecar origin,
                // so the browser fires an OPTIONS preflight on every
                // POST. Answer it before the method dispatch.
                if request.method() == &Method::Options {
                    let _ = request.respond(with_cors(Response::empty(StatusCode(204))));
                    continue;
                }

                let response = match (request.method(), request.url()) {
                    (Method::Post, "/connect") => connect(&state),
                    (Method::Post, "/update") => {
                        let mut body = String::new();
                        if let Err(e) = request.as_reader().read_to_string(&mut body) {
                            Err(format!("read body: {e}"))
                        } else {
                            update(&state, &body)
                        }
                    }
                    (Method::Post, "/disconnect") => disconnect(&state),
                    (Method::Post, "/shutdown") => {
                        let _ = request.respond(with_cors(Response::empty(StatusCode(200))));
                        let _ = disconnect(&state);
                        return;
                    }
                    (Method::Get, "/health") => Ok(String::from("ok")),
                    _ => Err(format!(
                        "unsupported {} {}",
                        request.method(),
                        request.url()
                    )),
                };
                let (status, body) = match response {
                    Ok(body) => (StatusCode(200), body),
                    Err(message) => (StatusCode(500), format!("{{\"error\":{message:?}}}")),
                };
                let resp = Response::from_string(body).with_status_code(status);
                let _ = request.respond(with_cors(resp));
            }
            Ok(None) => {
                // Idle tick. Exit if nobody has spoken to us for a while.
                if last_seen.elapsed() >= IDLE_TIMEOUT {
                    eprintln!("sidecar: idle for {:?}, exiting", IDLE_TIMEOUT);
                    let _ = disconnect(&state);
                    return;
                }
            }
            Err(e) => {
                eprintln!("sidecar: recv error, shutting down: {e}");
                let _ = disconnect(&state);
                return;
            }
        }
    }
}

/// Stamp every outbound response with CORS headers permissive enough to
/// satisfy any TEDI webview origin (`http://localhost:1420` in dev,
/// `tauri://localhost` / `http://tauri.localhost` in production). The
/// server is bound to 127.0.0.1 only - no remote host can reach it -
/// so the wildcard is fine and avoids hard-coding an origin string
/// that changes between TEDI builds.
fn with_cors<R>(resp: Response<R>) -> Response<R>
where
    R: std::io::Read,
{
    resp.with_header(Header::from_bytes(b"Access-Control-Allow-Origin", b"*").unwrap())
        .with_header(
            Header::from_bytes(b"Access-Control-Allow-Methods", b"GET, POST, OPTIONS").unwrap(),
        )
        .with_header(Header::from_bytes(b"Access-Control-Allow-Headers", b"Content-Type").unwrap())
        .with_header(Header::from_bytes(b"Access-Control-Max-Age", b"86400").unwrap())
}

fn unpoison<'a, T>(
    result: Result<MutexGuard<'a, T>, PoisonError<MutexGuard<'a, T>>>,
) -> MutexGuard<'a, T> {
    result.unwrap_or_else(|p| p.into_inner())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn truncate_chars(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        return s.to_string();
    }
    s.chars().take(max_chars).collect()
}

fn connect(state: &State) -> Result<String, String> {
    let mut guard = unpoison(state.client.lock());
    if guard.is_some() {
        return Ok(String::new());
    }
    let mut client = DiscordIpcClient::new(DISCORD_APP_ID).map_err(|e| e.to_string())?;
    client.connect().map_err(|e| e.to_string())?;
    *guard = Some(client);
    let mut started = unpoison(state.started_at_ms.lock());
    if started.is_none() {
        *started = Some(now_ms());
    }
    Ok(String::new())
}

fn update(state: &State, body: &str) -> Result<String, String> {
    let payload: UpdatePayload = if body.trim().is_empty() {
        UpdatePayload::default()
    } else {
        serde_json::from_str(body).map_err(|e| format!("parse body: {e}"))?
    };

    let mut guard = unpoison(state.client.lock());
    let Some(client) = guard.as_mut() else {
        return Err("not_connected".to_string());
    };
    let started = unpoison(state.started_at_ms.lock()).unwrap_or_else(now_ms);

    let details_text = truncate_chars(&payload.details, 128);
    let state_text = truncate_chars(&payload.state, 128);

    let mut activity = Activity::new();
    if details_text.chars().count() >= 2 {
        activity = activity.details(&details_text);
    }
    if state_text.chars().count() >= 2 {
        activity = activity.state(&state_text);
    }
    activity = activity.timestamps(Timestamps::new().start(started / 1000));
    activity = activity.assets(
        Assets::new()
            .large_image(LARGE_IMAGE_KEY)
            .large_text(LARGE_IMAGE_TEXT),
    );

    client.set_activity(activity).map_err(|e| e.to_string())?;
    Ok(String::new())
}

fn disconnect(state: &State) -> Result<String, String> {
    let mut guard = unpoison(state.client.lock());
    if let Some(mut client) = guard.take() {
        let _ = client.clear_activity();
        let _ = client.close();
    }
    Ok(String::new())
}
