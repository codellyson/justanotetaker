// JustNotes desktop shell.
//
// Phase 0 scope: open a window pointing at the Vite frontend, expose
// commands for storing/reading the Better Auth bearer token in the
// OS keychain. The keychain commands let the React app persist its
// session without a cookie store (Tauri's custom-protocol context
// doesn't cleanly share cookies with the Workers API).

const KEYCHAIN_SERVICE: &str = "com.kreativekorna.justnotes";
const KEYCHAIN_ACCOUNT: &str = "bearer";

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init());

    #[cfg(any(target_os = "windows", target_os = "linux"))]
    {
        // Forward justnotes:// URLs from a would-be second instance into
        // the running first instance so the deep-link plugin sees them.
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            use tauri_plugin_deep_link::DeepLinkExt;
            let _ = app.deep_link().handle_cli_arguments(argv);
        }));
    }

    builder
        .invoke_handler(tauri::generate_handler![
            store_bearer_token,
            get_bearer_token,
            clear_bearer_token,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
