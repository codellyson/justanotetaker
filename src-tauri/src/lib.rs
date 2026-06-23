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
// We use a localhost listener instead of a justnotetaking:// custom scheme
// because macOS only registers custom schemes for bundled .app
// installs — dev iteration with `tauri:dev` would otherwise need a
// full bundle + drag-to-Applications cycle every time we change Rust.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

const KEYCHAIN_SERVICE: &str = "com.kreativekorna.justnotetaking";
const KEYCHAIN_ACCOUNT: &str = "bearer";
const OAUTH_CALLBACK_EVENT: &str = "oauth://callback";

const CLIPBOARD_EVENT: &str = "clipboard://text";
const CLIPBOARD_POLL_MS: u64 = 800;
const CLIPBOARD_MAX_LEN: usize = 100_000;

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
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }));
    }

    builder
        .setup(|app| {
            let capture = Arc::new(ClipboardCapture::default());
            app.manage(capture.clone());
            let handle = app.handle().clone();
            thread::spawn(move || clipboard_monitor(handle, capture));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            store_bearer_token,
            get_bearer_token,
            clear_bearer_token,
            start_oauth_listener,
            set_clipboard_capture,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
