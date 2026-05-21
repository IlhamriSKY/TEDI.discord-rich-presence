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
    activity::{Activity, Assets, Button, Timestamps},
    DiscordIpc, DiscordIpcClient,
};
use serde::Deserialize;
use tiny_http::{Header, Method, Response, Server, StatusCode};

/// Self-terminate if no request lands within this window. Belt-and-
/// suspenders backstop for the parent-PID watchdog below. 4 h is
/// generous: the extension fires a request whenever the workspace
/// context changes, so any active TEDI session is well under this
/// threshold.
const IDLE_TIMEOUT: Duration = Duration::from_secs(4 * 60 * 60);
/// How often the receive loop wakes up to check the idle + parent
/// watchdog timers. Short enough that "TEDI just crashed" cleanup
/// happens within a few seconds, long enough that we don't spin.
const RECV_TICK: Duration = Duration::from_secs(2);
/// How often the parent watchdog re-checks whether TEDI is still
/// running. Tied to RECV_TICK below; if you bump RECV_TICK make sure
/// this stays an integer multiple.
const PARENT_CHECK_EVERY_TICKS: u32 = 5;

const DISCORD_APP_ID: &str = "1506303762418110505";
const LARGE_IMAGE_KEY: &str = "tedi_logo";
const LARGE_IMAGE_TEXT: &str = "TEDI - Terminal Environment & Development Infrastructure";
// Persistent button shown to other users viewing the presence card.
// Discord renders buttons only on profiles of OTHER viewers, not on the
// owner's own card — known platform behavior, not a bug.
const BUTTON_LABEL: &str = "Visit TEDI";
const BUTTON_URL: &str = "https://tedi.ilhamriski.com";

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
    /// Asset key for the small badge overlay (uploaded to the Discord
    /// Developer Portal under app id `1506303762418110505`). Empty string
    /// means "no badge" and the helper falls back to the large image alone.
    #[serde(default)]
    small_image: String,
    /// Hover text for the small badge. Discord caps at 128 code points;
    /// `truncate_chars` clamps both fields server-side.
    #[serde(default)]
    small_text: String,
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

    // Snapshot the original parent PID at startup. On Unix the parent
    // can be reparented to init when TEDI dies, so we can't rely on
    // `getppid()` returning a fresh value later - we have to track the
    // PID we saw at boot. On Windows we open a process handle via the
    // PID and probe it with `WaitForSingleObject(0)`.
    let parent_pid = current_parent_pid();
    if let Some(pid) = parent_pid {
        eprintln!("sidecar: parent pid {pid}");
    }

    let state = State::new();
    let mut last_seen = Instant::now();
    let mut tick_count: u32 = 0;
    // Poll-based receive so we can run the idle / parent-alive checks
    // periodically. `incoming_requests()` is a blocking iterator that
    // would block forever on a quiet client; that's exactly the orphan
    // case we want to defuse.
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
                // Parent-alive watchdog: if TEDI is gone (SIGKILL,
                // crash, taskmgr force-end) we exit on our own so
                // Discord doesn't keep showing a phantom presence.
                tick_count = tick_count.wrapping_add(1);
                if tick_count.is_multiple_of(PARENT_CHECK_EVERY_TICKS) {
                    if let Some(pid) = parent_pid {
                        if !is_process_alive(pid) {
                            eprintln!("sidecar: parent {pid} gone, exiting");
                            let _ = disconnect(&state);
                            return;
                        }
                    }
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

// ============================== Parent watchdog ==============================
//
// Cross-platform "is the process that launched us still running?" check.
// Used to disconnect Discord IPC the moment TEDI dies, even if it dies
// in a way that doesn't get to run our `shell_bg_kill` cleanup (SIGKILL,
// taskmgr, OS shutdown).

#[cfg(unix)]
fn current_parent_pid() -> Option<u32> {
    // SAFETY: getppid is always safe; no preconditions.
    let raw = unsafe { libc::getppid() };
    if raw <= 1 {
        // PID 1 (init / launchd) or 0 (orphaned at boot) means we have
        // no meaningful "real parent" to watch.
        return None;
    }
    Some(raw as u32)
}

#[cfg(unix)]
fn is_process_alive(pid: u32) -> bool {
    // `kill(pid, 0)` returns 0 on success, -1 with ESRCH when the
    // process is gone. EPERM also means the process exists (we just
    // lack permission to signal it). Only ESRCH proves the process
    // is gone. Using `last_os_error()` keeps this portable across
    // glibc / musl / macOS (libc::__errno_location is glibc-only).
    let rc = unsafe { libc::kill(pid as i32, 0) };
    if rc == 0 {
        return true;
    }
    let errno = std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
    errno != libc::ESRCH
}

#[cfg(windows)]
fn current_parent_pid() -> Option<u32> {
    use std::mem::size_of;
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcessId;

    // SAFETY: ToolHelp APIs operate on opaque handles that we close on
    // every exit path. PROCESSENTRY32W is zero-initialised with the
    // required `dwSize` field set, per MSDN.
    unsafe {
        let self_pid = GetCurrentProcessId();
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return None;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
        let mut found = if Process32FirstW(snap, &mut entry) != 0 {
            true
        } else {
            CloseHandle(snap);
            return None;
        };
        let mut parent: u32 = 0;
        while found {
            if entry.th32ProcessID == self_pid {
                parent = entry.th32ParentProcessID;
                break;
            }
            found = Process32NextW(snap, &mut entry) != 0;
        }
        CloseHandle(snap);
        if parent == 0 {
            None
        } else {
            Some(parent)
        }
    }
}

#[cfg(windows)]
fn is_process_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE, WAIT_TIMEOUT};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_SYNCHRONIZE,
    };

    // SAFETY: OpenProcess + WaitForSingleObject + GetExitCodeProcess
    // are all safe given valid handles, which we close before return.
    unsafe {
        let handle = OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
            0,
            pid,
        );
        if handle.is_null() {
            return false;
        }
        // Wait 0 ms: if the process has exited the wait returns
        // immediately (WAIT_OBJECT_0). If still running we get
        // WAIT_TIMEOUT.
        let wait = WaitForSingleObject(handle, 0);
        let alive = if wait == WAIT_TIMEOUT {
            true
        } else {
            let mut code: u32 = 0;
            // Belt-and-suspenders: a STILL_ACTIVE exit code means the
            // wait raced and we should consider the process alive.
            if GetExitCodeProcess(handle, &mut code) != 0 {
                code as i32 == STILL_ACTIVE
            } else {
                false
            }
        };
        CloseHandle(handle);
        alive
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

/// Discord asset keys are lowercase letters / digits / underscores, max 32
/// chars (matches the Developer Portal validation). Anything else is
/// rejected: malformed payloads should drop the badge silently rather than
/// fail the whole `set_activity` call. Empty string is rejected too so
/// callers can use `""` as "no badge".
fn is_valid_asset_key(s: &str) -> bool {
    if s.is_empty() || s.len() > 32 {
        return false;
    }
    s.bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
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
    let small_image_key = truncate_chars(&payload.small_image, 32);
    let small_image_text = truncate_chars(&payload.small_text, 128);

    let mut activity = Activity::new();
    if details_text.chars().count() >= 2 {
        activity = activity.details(&details_text);
    }
    if state_text.chars().count() >= 2 {
        activity = activity.state(&state_text);
    }
    activity = activity.timestamps(Timestamps::new().start(started / 1000));
    let mut assets = Assets::new()
        .large_image(LARGE_IMAGE_KEY)
        .large_text(LARGE_IMAGE_TEXT);
    // Only attach the small badge if the key passes Discord's asset-key
    // format (lowercase alphanumeric + underscore, ≤32 chars). An invalid
    // key would otherwise cause `set_activity` to fail and clear the
    // entire presence — we'd rather drop just the badge.
    if is_valid_asset_key(&small_image_key) {
        assets = assets.small_image(&small_image_key);
        if !small_image_text.is_empty() {
            assets = assets.small_text(&small_image_text);
        }
    } else if !small_image_key.is_empty() {
        eprintln!(
            "sidecar: dropping invalid small_image key {:?}",
            small_image_key
        );
    }
    activity = activity.assets(assets);
    activity = activity.buttons(vec![Button::new(BUTTON_LABEL, BUTTON_URL)]);

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
