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
// We use a localhost listener instead of a justnotes:// custom scheme
// because macOS only registers custom schemes for bundled .app
// installs — dev iteration with `tauri:dev` would otherwise need a
// full bundle + drag-to-Applications cycle every time we change Rust.

use tauri::{AppHandle, Emitter};
#[cfg(any(target_os = "windows", target_os = "linux"))]
use tauri::Manager;

const KEYCHAIN_SERVICE: &str = "com.kreativekorna.justnotes";
const KEYCHAIN_ACCOUNT: &str = "bearer";
const OAUTH_CALLBACK_EVENT: &str = "oauth://callback";

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
        .invoke_handler(tauri::generate_handler![
            store_bearer_token,
            get_bearer_token,
            clear_bearer_token,
            start_oauth_listener,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
