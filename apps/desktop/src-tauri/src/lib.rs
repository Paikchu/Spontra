mod transport;
use tauri::{
    menu::{Menu, MenuItem, Submenu},
    Emitter, Manager,
};
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
fn open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let parsed = url::Url::parse(&url).map_err(|_| "INVALID_URL")?;
    if !["https", "http"].contains(&parsed.scheme())
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err("URL_NOT_ALLOWED".into());
    }
    app.opener()
        .open_url(parsed.as_str(), None::<&str>)
        .map_err(|_| "OPEN_FAILED".into())
}

pub fn run() {
    tauri::Builder::default()
        .manage(transport::Requests::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            transport::api_request,
            transport::cancel_request,
            transport::connect,
            transport::disconnect,
            transport::connection_status,
            open_external
        ])
        .setup(|app| {
            let menu = Menu::default(app.handle())?;
            let back = MenuItem::with_id(app, "back", "后退", true, None::<&str>)?;
            let forward = MenuItem::with_id(app, "forward", "前进", true, None::<&str>)?;
            let today = MenuItem::with_id(app, "/", "今日", true, None::<&str>)?;
            let ledger = MenuItem::with_id(app, "/ledger", "投资账本", true, None::<&str>)?;
            let analysis = MenuItem::with_id(app, "/analysis", "公司研究", true, None::<&str>)?;
            let settings = MenuItem::with_id(app, "/settings", "设置", true, None::<&str>)?;
            let refresh = MenuItem::with_id(app, "refresh", "刷新数据", true, None::<&str>)?;
            menu.append(&Submenu::with_items(
                app,
                "工作台",
                true,
                &[
                    &back, &forward, &today, &ledger, &analysis, &settings, &refresh,
                ],
            )?)?;
            app.set_menu(menu)?;
            if let Some(window) = app.get_webview_window("main") {
                // Saved geometry may refer to a disconnected display. Keep a usable title bar visible.
                let position = window.outer_position()?;
                let visible = window.available_monitors()?.iter().any(|monitor| {
                    let origin = monitor.position();
                    let size = monitor.size();
                    position.x >= origin.x
                        && position.y >= origin.y
                        && position.x + 120 < origin.x + size.width as i32
                        && position.y + 40 < origin.y + size.height as i32
                });
                if !visible {
                    window.center()?;
                }
                window.show()?;
            }
            Ok(())
        })
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if [
                "back",
                "forward",
                "/",
                "/ledger",
                "/analysis",
                "/settings",
                "refresh",
            ]
            .contains(&id)
            {
                let _ = app.emit("desktop-menu", id);
            }
        })
        .run(tauri::generate_context!())
        .expect("Failed to start Spontra");
}
