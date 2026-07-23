// JustNotes desktop shell.
//
// Exposes:
//   - {store,get,clear}_bearer_token — OS keychain access for the Better
//     Auth bearer token, so the webview can persist its session without
//     a cookie store (Tauri's custom-protocol context doesn't cleanly
//     share cookies with the Workers API).
//   - start_oauth_listener — spins up an ephemeral localhost HTTP server
//     used as the OAuth bounce-back target. The system browser is sent
//     to /api/desktop-oauth-start, completes the Google dance, and the
//     server redirects to http://localhost:<port>/?token=…  The plugin
//     emits an "oauth://callback" event with the full URL; the JS side
//     extracts the token, stores it in keychain, and reloads.
//
// We use a localhost listener instead of a justanotetaker:// custom scheme
// because macOS only registers custom schemes for bundled .app
// installs — dev iteration with `tauri:dev` would otherwise need a
// full bundle + drag-to-Applications cycle every time we change Rust.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

const KEYCHAIN_SERVICE: &str = "com.kreativekorna.justanotetaker";
const KEYCHAIN_ACCOUNT: &str = "bearer";
const OAUTH_CALLBACK_EVENT: &str = "oauth://callback";

const CLIPBOARD_EVENT: &str = "clipboard://text";
const CLIPBOARD_POLL_MS: u64 = 800;
const CLIPBOARD_MAX_LEN: usize = 100_000;

// File-open integration: the OS launches (or focuses) the app with one or more
// text/markdown files ("Open with" / double-click, per fileAssociations in
// tauri.conf.json). We read them in Rust and buffer their text; the webview
// drains the buffer on mount and on the OPEN_FILE_EVENT ping, turning each into
// a note. Buffering (rather than emitting content) covers the cold-start race
// where the file arrives before the webview's listener exists.
const OPEN_FILE_EVENT: &str = "open-file://pending";
const OPEN_FILE_MAX_LEN: u64 = 5_000_000;

#[derive(Default)]
struct OpenedFiles(Mutex<Vec<String>>);

fn is_text_file(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_ascii_lowercase())
            .as_deref(),
        Some("md") | Some("markdown") | Some("txt") | Some("text")
    )
}

fn ingest_opened_paths(app: &AppHandle, paths: Vec<PathBuf>) {
    let mut contents: Vec<String> = Vec::new();
    for p in paths {
        if !is_text_file(&p) {
            continue;
        }
        if std::fs::metadata(&p).map(|m| m.len() > OPEN_FILE_MAX_LEN).unwrap_or(true) {
            continue;
        }
        if let Ok(text) = std::fs::read_to_string(&p) {
            if !text.trim().is_empty() {
                contents.push(text);
            }
        }
    }
    if contents.is_empty() {
        return;
    }
    if let Some(state) = app.try_state::<OpenedFiles>() {
        state.0.lock().unwrap().extend(contents);
        let _ = app.emit(OPEN_FILE_EVENT, ());
    }
}

// argv from a cold start / second instance: skip argv[0] (the exe) and keep
// existing file paths.
fn opened_paths_from_args<I: IntoIterator<Item = String>>(args: I) -> Vec<PathBuf> {
    args.into_iter()
        .skip(1)
        .map(PathBuf::from)
        .filter(|p| p.is_file())
        .collect()
}

#[tauri::command]
fn take_opened_files(state: tauri::State<'_, OpenedFiles>) -> Vec<String> {
    std::mem::take(&mut *state.0.lock().unwrap())
}

#[tauri::command]
fn store_bearer_token(token: String) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
        .map_err(|e| e.to_string())?;
    entry.set_password(&token).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_bearer_token() -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
        .map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(t) => Ok(Some(t)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn clear_bearer_token() -> Result<(), String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
        .map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
async fn start_oauth_listener(app: AppHandle) -> Result<u16, String> {
    let handle = app.clone();
    tauri_plugin_oauth::start(move |url| {
        // Forward the full callback URL into the webview. JS parses
        // `?token=…` and persists. The listener stops after the first
        // request via the plugin's default behavior.
        let _ = handle.emit(OAUTH_CALLBACK_EVENT, url);
    })
    .map_err(|e| e.to_string())
}

// Background clipboard auto-capture. A polling thread reads the OS clipboard
// and emits new text to the webview, which classifies + turns it into a note.
// Disabled by default; the webview flips it via set_clipboard_capture once the
// user enables the setting. `last` dedupes against the previous value so a
// single copy emits once, not on every poll tick.
#[derive(Default)]
struct ClipboardCapture {
    enabled: AtomicBool,
    last: Mutex<String>,
}

fn read_clipboard() -> Result<String, arboard::Error> {
    arboard::Clipboard::new()?.get_text()
}

#[tauri::command]
fn set_clipboard_capture(state: tauri::State<'_, Arc<ClipboardCapture>>, enabled: bool) {
    if enabled {
        // Baseline the current clipboard so flipping capture on doesn't
        // immediately ingest whatever was already there — only new copies.
        if let Ok(text) = read_clipboard() {
            *state.last.lock().unwrap() = text;
        }
    }
    state.enabled.store(enabled, Ordering::Relaxed);
}

fn clipboard_monitor(handle: AppHandle, capture: Arc<ClipboardCapture>) {
    loop {
        thread::sleep(Duration::from_millis(CLIPBOARD_POLL_MS));
        if !capture.enabled.load(Ordering::Relaxed) {
            continue;
        }
        let text = match read_clipboard() {
            Ok(t) => t,
            Err(_) => continue, // empty, non-text, or clipboard momentarily busy
        };
        if text.trim().is_empty() || text.len() > CLIPBOARD_MAX_LEN {
            continue;
        }
        {
            let mut last = capture.last.lock().unwrap();
            if *last == text {
                continue;
            }
            *last = text.clone();
        }
        let _ = handle.emit(CLIPBOARD_EVENT, text);
    }
}

// ── Agent-session watcher ───────────────────────────────────────────────────
// A board the user marks "live" becomes a two-way agent session: this polls the
// API for a new unanswered turn and drives the local `claude` CLI headless to
// write a reply, posting it back as an assistant note. Fully self-contained —
// it reuses the keychain session token the webview already stored, so there's
// no API key to mint and no external script to bundle.
const AGENT_REPLIED_EVENT: &str = "agent-sessions://replied";
const AGENT_ERROR_EVENT: &str = "agent-sessions://error";
const AGENT_POLL_MS: u64 = 2500;

#[derive(Default)]
struct AgentSessions {
    running: AtomicBool,
    api_url: Mutex<String>,
    boards: Mutex<Vec<String>>,
}

#[derive(serde::Deserialize)]
struct BoardsResp {
    boards: Vec<BoardInfo>,
}

#[derive(serde::Deserialize)]
struct BoardInfo {
    id: String,
    name: String,
}

#[derive(serde::Deserialize)]
struct NotesResp {
    notes: Vec<ApiNote>,
}

#[derive(serde::Deserialize)]
struct ApiNote {
    #[serde(default)]
    x: f64,
    #[serde(default)]
    y: f64,
    t: i64,
    text: String,
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    kind: Option<String>,
}

// A board holds more than conversation now (frames, images, task cards); only
// card/page notes are turns. Without this filter, dropping a frame on a live
// board would read as an unanswered message and trigger a spurious reply.
fn is_conversational(n: &ApiNote) -> bool {
    matches!(n.kind.as_deref(), None | Some("card") | Some("page"))
}

fn keychain_token() -> Option<String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).ok()?;
    entry.get_password().ok().filter(|t| !t.is_empty())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// The CLI is a real executable, not a shell command: resolve a full path so it
// runs without a shell. Honors JUSTNOTE_CLAUDE_BIN, else the Windows default
// install location, else a bare "claude" (PATH-resolved on POSIX).
fn resolve_claude() -> String {
    if let Ok(p) = std::env::var("JUSTNOTE_CLAUDE_BIN") {
        if !p.is_empty() {
            return p;
        }
    }
    #[cfg(windows)]
    {
        if let Some(home) = std::env::var_os("USERPROFILE") {
            let candidate = PathBuf::from(home)
                .join(".local")
                .join("bin")
                .join("claude.exe");
            if candidate.is_file() {
                return candidate.to_string_lossy().into_owned();
            }
        }
    }
    "claude".to_string()
}

fn build_prompt(board: &str, notes: &[ApiNote]) -> String {
    let mut s = String::new();
    s.push_str(&format!(
        "You are replying inside \"{board}\", a spatial note board someone is using as a chat with you.\n"
    ));
    s.push_str("The conversation so far is below, oldest first. Write a helpful reply to their most recent message.\n");
    s.push_str("Respond in GitHub-flavored markdown. Output only your reply — no preamble, no sign-off.\n\n");
    for n in notes {
        let who = if n.role.as_deref() == Some("assistant") {
            "you"
        } else {
            "them"
        };
        s.push_str(&format!("[{who}]: {}\n\n", n.text));
    }
    s
}

fn run_claude(bin: &str, prompt: &str) -> Result<String, String> {
    let mut cmd = Command::new(bin);
    cmd.args(["-p", "--output-format", "text", "--strict-mcp-config"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW — no console flash per reply
    }
    let mut child = cmd.spawn().map_err(|e| format!("spawn {bin}: {e}"))?;
    child
        .stdin
        .take()
        .ok_or_else(|| "no stdin".to_string())?
        .write_all(prompt.as_bytes())
        .map_err(|e| e.to_string())?;
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!(
            "claude exited {:?}: {}",
            out.status.code(),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn agent_tick(
    client: &reqwest::blocking::Client,
    api_url: &str,
    watched: &[String],
    claude: &str,
    app: &AppHandle,
    handled: &mut HashMap<String, i64>,
) -> Result<(), String> {
    let token = match keychain_token() {
        Some(t) => t,
        None => return Ok(()), // signed out — nothing to answer
    };
    let boards: BoardsResp = client
        .get(format!("{api_url}/api/boards"))
        .bearer_auth(&token)
        .send()
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .map_err(|e| e.to_string())?;
    for b in boards.boards {
        if !watched.iter().any(|id| id == &b.id) {
            continue;
        }
        let mut resp: NotesResp = client
            .get(format!("{api_url}/api/notes?board={}", b.id))
            .bearer_auth(&token)
            .send()
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?
            .json()
            .map_err(|e| e.to_string())?;
        resp.notes.retain(is_conversational);
        resp.notes.sort_by_key(|n| n.t);
        let last = match resp.notes.last() {
            Some(n) => n,
            None => continue,
        };
        if last.role.as_deref() == Some("assistant") {
            continue; // already answered
        }
        if handled.get(&b.id) == Some(&last.t) {
            continue; // claimed this turn already (reply may be in flight)
        }
        handled.insert(b.id.clone(), last.t);
        let prompt = build_prompt(&b.name, &resp.notes);
        let reply = run_claude(claude, &prompt)?;
        if reply.is_empty() {
            continue;
        }
        let body = serde_json::json!({
            "boardId": b.id,
            "x": last.x,
            "y": last.y + 320.0,
            "t": now_ms(),
            "text": reply,
            "role": "assistant",
        });
        client
            .post(format!("{api_url}/api/notes"))
            .bearer_auth(&token)
            .json(&body)
            .send()
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?;
        let _ = app.emit(AGENT_REPLIED_EVENT, b.id.clone());
    }
    Ok(())
}

fn agent_monitor(app: AppHandle, sessions: Arc<AgentSessions>) {
    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(600))
        .build()
    {
        Ok(c) => c,
        Err(_) => {
            sessions.running.store(false, Ordering::SeqCst);
            return;
        }
    };
    let claude = resolve_claude();
    let mut handled: HashMap<String, i64> = HashMap::new();
    while sessions.running.load(Ordering::Relaxed) {
        let api_url = sessions.api_url.lock().unwrap().clone();
        let watched = sessions.boards.lock().unwrap().clone();
        if !api_url.is_empty() && !watched.is_empty() {
            if let Err(e) = agent_tick(&client, &api_url, &watched, &claude, &app, &mut handled) {
                let _ = app.emit(AGENT_ERROR_EVENT, e);
            }
        }
        // Sleep in slices so a stop is picked up quickly, not one poll later.
        let mut slept = 0u64;
        while slept < AGENT_POLL_MS && sessions.running.load(Ordering::Relaxed) {
            thread::sleep(Duration::from_millis(200));
            slept += 200;
        }
    }
}

#[tauri::command]
fn agent_sessions_start(
    app: AppHandle,
    state: tauri::State<'_, Arc<AgentSessions>>,
    url: String,
    boards: Vec<String>,
) {
    *state.api_url.lock().unwrap() = url;
    *state.boards.lock().unwrap() = boards;
    // swap returns the prior value: only spawn a monitor if one wasn't running.
    if !state.running.swap(true, Ordering::SeqCst) {
        let sessions = state.inner().clone();
        let handle = app.clone();
        thread::spawn(move || agent_monitor(handle, sessions));
    }
}

#[tauri::command]
fn agent_sessions_stop(state: tauri::State<'_, Arc<AgentSessions>>) {
    state.running.store(false, Ordering::SeqCst);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_oauth::init());

    #[cfg(any(target_os = "windows", target_os = "linux"))]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            // A second launch (e.g. "Open with" while running) passes the file
            // path as an argument — turn it into a note in the running window.
            ingest_opened_paths(app, opened_paths_from_args(argv));
        }));
    }

    let app = builder
        .setup(|app| {
            // Files the app was cold-launched with (double-click on Windows/Linux).
            app.manage(OpenedFiles::default());
            ingest_opened_paths(app.handle(), opened_paths_from_args(std::env::args()));

            let capture = Arc::new(ClipboardCapture::default());
            app.manage(capture.clone());
            let handle = app.handle().clone();
            thread::spawn(move || clipboard_monitor(handle, capture));

            app.manage(Arc::new(AgentSessions::default()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            store_bearer_token,
            get_bearer_token,
            clear_bearer_token,
            start_oauth_listener,
            set_clipboard_capture,
            take_opened_files,
            agent_sessions_start,
            agent_sessions_stop,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // macOS delivers file-opens as an Apple event, not argv — catch it here.
    app.run(|_app_handle, _event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = &_event {
            let paths: Vec<PathBuf> = urls.iter().filter_map(|u| u.to_file_path().ok()).collect();
            ingest_opened_paths(_app_handle, paths);
        }
    });
}
