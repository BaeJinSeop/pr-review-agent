use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};

/// Keychain(macOS) / Credential Manager(Windows) service name.
const SECRET_SERVICE: &str = "com.intocns.prreviewagent";
/// Only these secret names may be read/written from the UI.
const ALLOWED_SECRETS: [&str; 2] = ["github_token", "anthropic_api_key"];

fn entry(key: &str) -> Result<keyring::Entry, String> {
    if !ALLOWED_SECRETS.contains(&key) {
        return Err(format!("unknown secret key: {key}"));
    }
    keyring::Entry::new(SECRET_SERVICE, key).map_err(|e| e.to_string())
}

#[tauri::command]
fn secret_get(key: String) -> Result<Option<String>, String> {
    match entry(&key)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn secret_set(key: String, value: String) -> Result<(), String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("empty value".into());
    }
    entry(&key)?.set_password(value).map_err(|e| e.to_string())
}

#[tauri::command]
fn secret_delete(key: String) -> Result<(), String> {
    match entry(&key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Poll interval in seconds, shared with the ticker thread.
struct PollInterval(Arc<AtomicU64>);

#[tauri::command]
fn set_poll_interval(state: State<PollInterval>, minutes: u64) {
    state.0.store(minutes.clamp(1, 1440) * 60, Ordering::SeqCst);
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let interval = Arc::new(AtomicU64::new(10 * 60));

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .manage(PollInterval(interval.clone()))
        .invoke_handler(tauri::generate_handler![
            secret_get,
            secret_set,
            secret_delete,
            set_poll_interval
        ])
        .setup(move |app| {
            // Tray menu
            let open = MenuItem::with_id(app, "open", "열기", true, None::<&str>)?;
            let check = MenuItem::with_id(app, "check", "지금 확인", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let quit = MenuItem::with_id(app, "quit", "종료", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &check, &sep, &quit])?;
            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().cloned().expect("app icon"))
                .tooltip("PR Review Agent")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main(app),
                    "check" => {
                        let _ = app.emit("poll-tick", ());
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            // Ticker: the UI does the actual work when it receives "poll-tick".
            // Driven from Rust so polling keeps running while the window is hidden.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let mut elapsed = 0u64;
                loop {
                    std::thread::sleep(Duration::from_secs(5));
                    elapsed += 5;
                    if elapsed >= interval.load(Ordering::SeqCst) {
                        elapsed = 0;
                        let _ = handle.emit("poll-tick", ());
                    }
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window keeps the agent running in the tray.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_app, _event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = _event {
            show_main(_app);
        }
    });
}
