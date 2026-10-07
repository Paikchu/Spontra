use keyring::Entry;
use reqwest::{redirect::Policy, Client, Method};
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
    time::Duration,
};
use tauri::State;
use tokio_util::sync::CancellationToken;

pub const ORIGIN: &str = "https://spontra-app.max-zhangyuchen.workers.dev";
#[cfg(not(debug_assertions))]
const SERVICE: &str = "com.paikchu.spontra.desktop";
#[cfg(debug_assertions)]
const SERVICE: &str = "com.paikchu.spontra.desktop.debug";
fn api_origin() -> String {
    #[cfg(debug_assertions)]
    if let Some(value) = std::env::var("SPONTRA_DESKTOP_DEV_ORIGIN")
        .ok()
        .or_else(|| option_env!("SPONTRA_DESKTOP_DEV_ORIGIN").map(String::from))
    {
        if let Ok(url) = url::Url::parse(&value) {
            if url.scheme() == "http"
                && url.host_str() == Some("127.0.0.1")
                && url.username().is_empty()
                && url.password().is_none()
                && url.path() == "/"
                && url.query().is_none()
                && url.fragment().is_none()
            {
                return value.trim_end_matches('/').into();
            }
        }
    }
    ORIGIN.into()
}
const MAX_BODY: usize = 64 * 1024;
const MAX_RESPONSE: usize = 16 * 1024 * 1024;
#[derive(Default)]
pub struct Requests(pub Mutex<HashMap<String, CancellationToken>>);
#[derive(Serialize)]
pub struct ApiResponse {
    pub status: u16,
    pub body: String,
}
fn entry() -> Result<Entry, String> {
    Entry::new(SERVICE, "desktop-access-token").map_err(|_| "CREDENTIAL_STORE_UNAVAILABLE".into())
}
fn credential() -> Result<String, String> {
    entry()?.get_password().map_err(|e| match e {
        keyring::Error::NoEntry => "AUTH_REQUIRED".into(),
        _ => "CREDENTIAL_STORE_UNAVAILABLE".into(),
    })
}
pub fn allowed_path(path: &str, method: &str) -> bool {
    if path.len() > 8192 || path.contains('\\') || path.contains('#') {
        return false;
    }
    let route = path.split('?').next().unwrap_or("");
    static TICKER: OnceLock<regex::Regex> = OnceLock::new();
    let ticker =
        TICKER.get_or_init(|| regex::Regex::new(r"^[A-Za-z][A-Za-z0-9.-]{0,14}$").unwrap());
    let parts: Vec<_> = route.split('/').skip(1).collect();
    if !route.starts_with('/')
        || parts
            .iter()
            .any(|p| p.is_empty() || *p == "." || *p == ".." || p.contains('%'))
    {
        return false;
    }
    if method == "PUT" {
        return parts.len() == 2 && parts[0] == "plans" && ticker.is_match(parts[1]);
    }
    if method != "GET" {
        return false;
    }
    if [
        "/connection",
        "/portfolio",
        "/plans",
        "/quotes",
        "/earnings",
        "/symbols",
        "/research/feed",
        "/analysis/v1/search",
    ]
    .contains(&route)
    {
        return true;
    }
    if parts.len() == 2 && ["plans", "stocks"].contains(&parts[0]) {
        return ticker.is_match(parts[1]);
    }
    if (parts.len() == 5 || parts.len() == 6)
        && parts[..3] == ["analysis", "v1", "companies"]
        && ticker.is_match(parts[3])
    {
        if parts.len() == 5 {
            return ["filings", "analysis", "fundamentals"].contains(&parts[4]);
        }
        return parts[4] == "filings"
            && parts[5].len() == 20
            && parts[5].bytes().all(|c| c.is_ascii_digit() || c == b'-');
    }
    false
}
async fn send(
    path: &str,
    method: &str,
    body: Option<String>,
    token: &str,
) -> Result<ApiResponse, String> {
    if !allowed_path(path, method) {
        return Err("REQUEST_NOT_ALLOWED".into());
    }
    if body.as_ref().is_some_and(|b| b.len() > MAX_BODY) || (method == "GET" && body.is_some()) {
        return Err("INVALID_BODY".into());
    }
    let client = Client::builder()
        .redirect(Policy::none())
        .timeout(Duration::from_secs(25))
        .build()
        .map_err(|_| "NETWORK_UNAVAILABLE")?;
    let url = format!("{}/api/desktop/v1{path}", api_origin());
    let mut request = client
        .request(
            Method::from_bytes(method.as_bytes()).map_err(|_| "REQUEST_NOT_ALLOWED")?,
            url,
        )
        .bearer_auth(token)
        .header("accept", "application/json");
    if let Some(body) = body {
        request = request
            .header("content-type", "application/json")
            .body(body);
    }
    let mut response = request.send().await.map_err(|_| "NETWORK_UNAVAILABLE")?;
    let status = response.status().as_u16();
    if response.status().is_redirection() {
        return Err("REDIRECT_REFUSED".into());
    }
    if !response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.contains("application/json"))
    {
        return Err("INVALID_RESPONSE".into());
    }
    if response
        .content_length()
        .is_some_and(|n| n > MAX_RESPONSE as u64)
    {
        return Err("RESPONSE_TOO_LARGE".into());
    }
    let mut data = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "NETWORK_UNAVAILABLE")? {
        if data.len() + chunk.len() > MAX_RESPONSE {
            return Err("RESPONSE_TOO_LARGE".into());
        }
        data.extend_from_slice(&chunk);
    }
    let body = String::from_utf8(data).map_err(|_| "INVALID_RESPONSE")?;
    Ok(ApiResponse { status, body })
}
#[tauri::command]
pub async fn connect(token: String) -> Result<(), String> {
    if token.len() < 32 || token.len() > 512 || !token.bytes().all(|b| b.is_ascii_graphic()) {
        return Err("INVALID_TOKEN".into());
    }
    let response = send("/connection", "GET", None, &token).await?;
    if response.status != 200 {
        return Err("CONNECTION_REFUSED".into());
    }
    entry()?
        .set_password(&token)
        .map_err(|_| "CREDENTIAL_SAVE_FAILED".into())
}
#[tauri::command]
pub async fn connection_status() -> Result<bool, String> {
    match credential() {
        Ok(_) => Ok(true),
        Err(e) if e == "AUTH_REQUIRED" => Ok(false),
        Err(e) => Err(e),
    }
}
#[tauri::command]
pub async fn disconnect(state: State<'_, Requests>) -> Result<(), String> {
    if let Ok(requests) = state.0.lock() {
        for request in requests.values() {
            request.cancel();
        }
    }
    match entry()?.delete_credential() {
        Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("CREDENTIAL_DELETE_FAILED".into()),
    }
}
#[tauri::command]
pub async fn api_request(
    id: String,
    path: String,
    method: String,
    body: Option<String>,
    state: State<'_, Requests>,
) -> Result<ApiResponse, String> {
    if id.len() != 36 || !allowed_path(&path, &method) {
        return Err("REQUEST_NOT_ALLOWED".into());
    }
    let token = credential()?;
    let cancel = CancellationToken::new();
    {
        let mut requests = state.0.lock().map_err(|_| "REQUEST_STATE_UNAVAILABLE")?;
        if requests.len() >= 64 || requests.contains_key(&id) {
            return Err("TOO_MANY_REQUESTS".into());
        }
        requests.insert(id.clone(), cancel.clone());
    }
    let result = tokio::select! {
        _ = cancel.cancelled() => Err("REQUEST_CANCELED".into()),
        result = send(&path, &method, body, &token) => result,
    };
    state
        .0
        .lock()
        .map_err(|_| "REQUEST_STATE_UNAVAILABLE")?
        .remove(&id);
    result
}
#[tauri::command]
pub fn cancel_request(id: String, state: State<'_, Requests>) {
    if let Ok(requests) = state.0.lock() {
        if let Some(token) = requests.get(&id) {
            token.cancel();
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restricts_host_path_and_method() {
        for path in [
            "https://evil.test/portfolio",
            "//evil.test",
            "/../internal",
            "/plans/%2e%2e",
            "/plans/..",
            "/internal/portfolio/sync",
            "/quotes#x",
            "/plans/AAPL/extra",
        ] {
            assert!(!allowed_path(path, "GET"), "{path}");
        }
        assert!(allowed_path("/plans/AAPL", "PUT"));
        assert!(allowed_path("/analysis/v1/companies/BRK.B/filings/0000320193-24-000123?reportDate=2024-01-01&reportVersion=v1", "GET"));
        assert!(allowed_path("/quotes?symbols=AAPL%2CMSFT", "GET"));
        assert!(!allowed_path("/portfolio", "PUT"));
        assert!(!allowed_path("/plans/AAPL", "DELETE"));
    }
}
