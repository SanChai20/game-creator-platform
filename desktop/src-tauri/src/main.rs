// HearthCade for Windows, macOS and Linux: one window that opens https://hearthcade.com.
//
// The shell holds no copy of the web app. Every web deploy (pages, API, games) reaches it the next time a page loads,
// exactly as it reaches a browser tab, and the site's service worker (web/public/sw.js) covers being offline. The shell
// itself changes only for something the web cannot do, and those builds are installed by the Tauri updater: it checks
// in the background, downloads, and installs when the player quits, so the next launch is the new shell. Nobody
// downloads the app again. See docs/apps.md.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;
use std::time::Duration;

use tauri::{Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::{Update, UpdaterExt};

/// Where the window opens. Everything else the player sees comes from here.
const HOME: &str = "https://hearthcade.com/";
/// How often a running shell looks for a new shell build (it also looks at every launch).
const UPDATE_EVERY: Duration = Duration::from_secs(6 * 3600);

/// Pages that open inside the window: the platform, its game hosts, and Stripe's checkout (which returns to the
/// platform). Anything else (a creator's link, mail, the operator's site) opens in the player's own browser.
fn stays_inside(url: &Url) -> bool {
    match url.scheme() {
        "about" | "blob" | "data" | "tauri" => return true,
        "https" => {}
        _ => return false,
    }
    let host = url.host_str().unwrap_or_default();
    let under = |d: &str| host == d || host.ends_with(&format!(".{d}"));
    under("hearthcade.com") || under("hearthcade.app") || under("stripe.com") || under("stripe.network")
}

/// What the page can see of the shell. The web feature-detects `window.hearthcadeShell` and works without it.
fn shell_script() -> String {
    let os = if cfg!(target_os = "windows") { "windows" } else if cfg!(target_os = "macos") { "macos" } else { "linux" };
    format!(
        r#"(() => {{
  if (location.hostname !== 'hearthcade.com' && !location.hostname.endsWith('.hearthcade.com')) return;
  Object.defineProperty(window, 'hearthcadeShell', {{ value: Object.freeze({{ kind: 'desktop', os: '{os}', version: '{ver}' }}) }});
  // Windows: a game's element fullscreen fills only the window, so the window follows it into full screen.
  if ('{os}' === 'windows') document.addEventListener('fullscreenchange', () => {{
    try {{ window.__TAURI_INTERNALS__.invoke('set_fullscreen', {{ on: !!document.fullscreenElement }}); }} catch (e) {{}}
  }});
}})();"#,
        ver = env!("CARGO_PKG_VERSION")
    )
}

/// The window follows a game into and out of full screen (asked for by the page's fullscreenchange, Windows only).
#[tauri::command]
fn set_fullscreen(window: tauri::WebviewWindow, on: bool) {
    let _ = window.set_fullscreen(on);
}

/// A downloaded shell update, installed when the player quits.
#[derive(Default)]
struct Pending(Mutex<Option<(Update, Vec<u8>)>>);

fn look_for_updates(app: tauri::AppHandle) {
    std::thread::spawn(move || loop {
        let ready = app.state::<Pending>().0.lock().map(|p| p.is_some()).unwrap_or(true);
        if !ready {
            tauri::async_runtime::block_on(async {
                let Ok(updater) = app.updater() else { return };
                let Ok(Some(update)) = updater.check().await else { return };
                if let Ok(bytes) = update.download(|_, _| {}, || {}).await {
                    if let Ok(mut p) = app.state::<Pending>().0.lock() {
                        *p = Some((update, bytes));
                    }
                }
            });
        }
        std::thread::sleep(UPDATE_EVERY);
    });
}

fn main() {
    let app = tauri::Builder::default()
        // a second launch brings the open window forward instead of opening another
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Pending::default())
        .invoke_handler(tauri::generate_handler![set_fullscreen])
        .setup(|app| {
            let nav = app.handle().clone();
            let popup = app.handle().clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(HOME.parse().expect("home url")))
                .title("HearthCade")
                .inner_size(1280.0, 800.0)
                .min_inner_size(400.0, 560.0)
                .center()
                .initialization_script(&shell_script())
                .on_navigation(move |url| {
                    if stays_inside(url) {
                        return true;
                    }
                    let _ = nav.opener().open_url(url.as_str(), None::<&str>);
                    false
                })
                // links that open a new tab (target=_blank, window.open) go to the player's browser
                .on_new_window(move |url, _features| {
                    let _ = popup.opener().open_url(url.as_str(), None::<&str>);
                    tauri::webview::NewWindowResponse::Deny
                })
                .build()?;
            look_for_updates(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("HearthCade could not start");

    app.run(|app, event| {
        if let RunEvent::Exit = event {
            let pending = app.state::<Pending>().0.lock().ok().and_then(|mut p| p.take());
            if let Some((update, bytes)) = pending {
                // the player quit: install now, and the next launch is the new shell
                let _ = update.restart_after_install(false).install(bytes);
            }
        }
    });
}
