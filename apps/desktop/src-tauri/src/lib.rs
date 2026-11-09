mod cache;
mod launch;
mod links;
mod proxy;

use launch::Launch;
use proxy::Proxy;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_window_state::StateFlags;

const SITE_ORIGIN: &str = match option_env!("SPONTRA_SITE_ORIGIN") {
    Some(origin) => origin,
    None => "https://spontra-business-map.max-zhangyuchen.workers.dev",
};
/// The site is sized for a browser at arm's length; a desktop window reads better a step smaller.
const PAGE_ZOOM: f64 = 0.9;
/// The update check waits until the launch has finished with the disk and the network.
#[cfg(not(debug_assertions))]
const UPDATE_CHECK_DELAY: Duration = Duration::from_secs(10);

#[derive(Default)]
struct PendingLink(Mutex<Option<String>>);

#[cfg(not(debug_assertions))]
#[derive(Default)]
struct DownloadedUpdate(Mutex<Option<(tauri_plugin_updater::Update, Vec<u8>)>>);

fn deliver_links(app: &AppHandle, urls: &[url::Url]) {
    let Some(page) = urls.iter().find_map(links::page_of) else { return };
    *app.state::<PendingLink>().0.lock().unwrap() = Some(page.clone());
    let _ = app.emit("deep-link", page);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[tauri::command]
fn content_ready(app: AppHandle, launch: State<'_, Arc<Launch>>, content_ms: f64, page: String) {
    launch.record_content(content_ms, &page);
    if let Some(hold) = std::env::var("SPONTRA_PERF_EXIT_AFTER_MS").ok().and_then(|value| value.parse().ok()) {
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(hold)).await;
            app.exit(0);
        });
    }
}

#[tauri::command]
fn record_vitals(launch: State<'_, Arc<Launch>>, sample: String) {
    launch.record_vitals(&sample);
}

#[tauri::command]
fn reader_token(proxy: State<'_, Arc<Proxy>>) -> Option<String> {
    proxy.reader_token()
}

#[tauri::command]
fn take_deep_link(pending: State<'_, PendingLink>) -> Option<String> {
    pending.0.lock().unwrap().take()
}

#[tauri::command]
fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("unsupported address".into());
    }
    #[cfg(feature = "selftest")]
    {
        selftest_report(serde_json::json!({ "name": "external-link-reaches-the-shell", "ok": true, "detail": url }).to_string());
        return Ok(());
    }
    #[cfg(not(feature = "selftest"))]
    app.opener().open_url(url, None::<&str>).map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn install_menu(app: AppHandle, locale: String) -> Result<(), String> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem as Native, Submenu};
    let chinese = locale == "zh-CN";
    let say = |en: &'static str, zh: &'static str| if chinese { zh } else { en };
    let build = || -> tauri::Result<Menu<tauri::Wry>> {
        let item = |id: &str, label: &str, keys: &str| MenuItem::with_id(&app, id, label, true, Some(keys));
        let separator = Native::separator(&app)?;
        let application = Submenu::with_items(&app, "Spontra", true, &[
            &Native::about(&app, None, None)?, &separator, &Native::hide(&app, None)?, &Native::hide_others(&app, None)?, &Native::show_all(&app, None)?, &separator, &Native::quit(&app, None)?,
        ])?;
        let edit = Submenu::with_items(&app, say("Edit", "编辑"), true, &[
            &Native::undo(&app, None)?, &Native::redo(&app, None)?, &separator, &Native::cut(&app, None)?, &Native::copy(&app, None)?, &Native::paste(&app, None)?, &Native::select_all(&app, None)?,
        ])?;
        let view = Submenu::with_items(&app, say("View", "显示"), true, &[
            &item("home", say("Home", "首页"), "CmdOrCtrl+Shift+H")?,
            &item("search", say("Search Companies", "搜索公司"), "CmdOrCtrl+K")?,
            &separator,
            &item("1", say("Valuation", "估值"), "CmdOrCtrl+1")?,
            &item("2", say("Income Statement", "利润表"), "CmdOrCtrl+2")?,
            &item("3", say("Cash Flow", "现金流量表"), "CmdOrCtrl+3")?,
            &item("4", say("Balance Sheet", "资产负债表"), "CmdOrCtrl+4")?,
            &separator,
            &item("reload", say("Reload", "重新加载"), "CmdOrCtrl+R")?,
            &Native::fullscreen(&app, None)?,
        ])?;
        let window = Submenu::with_items(&app, say("Window", "窗口"), true, &[&Native::minimize(&app, None)?, &Native::maximize(&app, None)?, &separator, &Native::close_window(&app, None)?])?;
        Menu::with_items(&app, &[&application, &edit, &view, &window])
    };
    app.set_menu(build().map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;
    Ok(())
}

/// Windows and Linux keep their windows free of a menu bar; the shortcuts live in the page.
#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn install_menu(_locale: String) {}

/// Downloads a new version in the background; it is installed when the app quits.
#[cfg(not(debug_assertions))]
fn fetch_update(app: AppHandle) {
    use tauri_plugin_updater::UpdaterExt;
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(UPDATE_CHECK_DELAY).await;
        let Ok(updater) = app.updater() else { return };
        let Ok(Some(update)) = updater.check().await else { return };
        if let Ok(bytes) = update.download(|_, _| {}, || {}).await {
            *app.state::<DownloadedUpdate>().0.lock().unwrap() = Some((update, bytes));
        }
    });
}

/// One line of a test build's findings, appended to the file the test runner reads.
#[cfg(feature = "selftest")]
#[tauri::command]
fn selftest_report(line: String) {
    use std::io::Write;
    let Some(path) = std::env::var_os("SPONTRA_SELFTEST_OUT") else { return };
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{line}");
    }
}

/// The test build's script, loaded into the page before anything else on it runs.
#[cfg(feature = "selftest")]
fn selftest_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    let script = std::env::var("SPONTRA_SELFTEST_SCRIPT").ok().and_then(|path| std::fs::read_to_string(path).ok()).unwrap_or_default();
    tauri::plugin::Builder::new("selftest").js_init_script(script).build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let launch = Arc::new(Launch::begin());
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::new().with_state_flags(StateFlags::all() & !StateFlags::VISIBLE).build());
    #[cfg(not(debug_assertions))]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build()).manage(DownloadedUpdate::default());
    #[cfg(feature = "selftest")]
    let builder = builder.plugin(selftest_plugin());
    #[cfg(feature = "selftest")]
    let builder = builder.invoke_handler(tauri::generate_handler![content_ready, record_vitals, reader_token, take_deep_link, open_external, install_menu, selftest_report]);
    #[cfg(not(feature = "selftest"))]
    let builder = builder.invoke_handler(tauri::generate_handler![content_ready, record_vitals, reader_token, take_deep_link, open_external, install_menu]);
    let app = builder
        .manage(launch.clone())
        .manage(PendingLink::default())
        .register_asynchronous_uri_scheme_protocol("spontra-api", |context, request, responder| {
            let proxy = context.app_handle().state::<Arc<Proxy>>().inner().clone();
            tauri::async_runtime::spawn(async move { responder.respond(proxy.handle(request).await) });
        })
        .setup(move |app| {
            let cache_dir = std::env::var_os("SPONTRA_CACHE_DIR").map(Into::into).unwrap_or(app.path().app_cache_dir()?.join("reads"));
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let site = std::env::var("SPONTRA_SITE_ORIGIN").unwrap_or_else(|_| SITE_ORIGIN.to_string());
            let proxy = Proxy::new(site, cache_dir, data_dir.join("reader"));
            proxy.warm_up();
            app.manage(proxy);

            launch.set_log(std::env::var_os("SPONTRA_PERF_LOG").map(Into::into).unwrap_or(app.path().app_log_dir()?.join("perf.log")));
            // WKWebView stops animation frames for a hidden window, so the page must load in a visible one. It opens on the
            // background of the system theme, which the page then paints over.
            if let Some(window) = app.get_webview_window("main") {
                window.set_zoom(PAGE_ZOOM)?;
                if window.theme().is_ok_and(|theme| theme == tauri::Theme::Light) {
                    let _ = window.set_background_color(Some(tauri::window::Color(255, 255, 255, 255)));
                }
                window.show()?;
                window.set_focus()?;
            }

            let handle = app.handle().clone();
            app.on_menu_event(move |_, event| {
                let _ = handle.emit("menu", event.id().as_ref());
            });

            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| deliver_links(&handle, &event.urls()));
            if let Some(urls) = app.deep_link().get_current()? {
                deliver_links(app.handle(), &urls);
            }

            #[cfg(not(debug_assertions))]
            if std::env::var_os("SPONTRA_NO_UPDATE").is_none() {
                fetch_update(app.handle().clone());
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("the app's configuration is valid");
    app.run(|_app, event| {
        #[cfg(not(debug_assertions))]
        if let RunEvent::Exit = event {
            if let Some((update, bytes)) = _app.state::<DownloadedUpdate>().0.lock().unwrap().take() {
                let _ = update.install(bytes);
            }
        }
        #[cfg(debug_assertions)]
        let _: RunEvent = event;
    });
}
