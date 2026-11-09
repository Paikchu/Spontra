//! The `spontra-api` scheme: the webview's only road to the network. Reads answer from disk when they can and refresh
//! behind the page; the stage's HTTP calls pass through with the reader's cookie, which the webview never holds.

use crate::cache::{Cache, Entry, Freshness, Meta, SIZE_LIMIT_BYTES, freshness, now_secs};
use http::{Method, Request, Response, StatusCode, header};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

const READER_COOKIE: &str = "spontra_reader";
const LOGO_ORIGIN: &str = "https://images.financialmodelingprep.com/symbol";
const LOGO_MAX_AGE_SECS: u64 = 30 * 24 * 60 * 60;
const JUST_STORED_SECS: u64 = 5;
const APP_ORIGINS: [&str; 3] = ["tauri://localhost", "http://tauri.localhost", "http://127.0.0.1:4188"];

#[derive(Debug, PartialEq)]
enum Route {
    Read { upstream: String },
    Opening { upstream: String },
    Revision { upstream: String },
    Logo { upstream: String },
    Stage { upstream: String },
}

fn route(site: &str, method: &Method, target: &str) -> Option<Route> {
    let path = target.split('?').next().unwrap_or(target);
    if target.contains("..") || target.contains('#') {
        return None;
    }
    if let Some(file) = path.strip_prefix("/logo/") {
        let valid = file.len() <= 28 && file.ends_with(".png") && file.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b"./%-png".contains(&b));
        return (method == Method::GET && valid).then(|| Route::Logo { upstream: format!("{LOGO_ORIGIN}/{file}") });
    }
    let upstream = format!("{site}{target}");
    if path.starts_with("/agents/") {
        return (method == Method::GET || method == Method::POST).then_some(Route::Stage { upstream });
    }
    if !path.starts_with("/api/business/v1/") || method != Method::GET || path.ends_with("/telemetry") {
        return None;
    }
    Some(if path.ends_with("/revision") {
        Route::Revision { upstream }
    } else if path.ends_with("/opening") {
        Route::Opening { upstream }
    } else {
        Route::Read { upstream }
    })
}

fn max_age(cache_control: &str) -> u64 {
    cache_control.split(',').find_map(|part| part.trim().strip_prefix("max-age=")?.parse().ok()).unwrap_or(0)
}

fn forbids_storing(cache_control: &str) -> bool {
    cache_control.split(',').any(|part| part.trim().eq_ignore_ascii_case("no-store"))
}

/// The opening is marked no-store because it bundles resources with their own revisions. On disk it is the page's first
/// paint and the page still checks the revisions, so it is kept whenever every resource in it was answered.
fn opening_is_whole(body: &[u8]) -> bool {
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(body) else { return false };
    value.get("resources").and_then(|resources| resources.as_object()).is_some_and(|resources| {
        !resources.is_empty() && resources.values().all(|resource| resource.get("status").and_then(|status| status.as_u64()).is_some_and(|status| status < 429))
    })
}

fn reader_from_cookie(set_cookie: &str) -> Option<String> {
    let value = set_cookie.split(';').next()?.trim().strip_prefix(READER_COOKIE)?.strip_prefix('=')?;
    (!value.is_empty()).then(|| value.to_string())
}

struct Answer {
    status: StatusCode,
    content_type: Option<String>,
    retry_after: Option<String>,
    exhausted: bool,
    source: &'static str,
    body: Vec<u8>,
}

impl Answer {
    fn stored(entry: Entry, source: &'static str) -> Self {
        Self { status: StatusCode::OK, content_type: entry.meta.content_type, retry_after: None, exhausted: false, source, body: entry.body }
    }

    fn failed(status: StatusCode) -> Self {
        Self { status, content_type: Some("application/json".into()), retry_after: None, exhausted: false, source: "none", body: br#"{"error":"unavailable"}"#.to_vec() }
    }
}

struct Upstream {
    status: StatusCode,
    etag: Option<String>,
    content_type: Option<String>,
    cache_control: String,
    retry_after: Option<String>,
    exhausted: bool,
    set_cookie: Option<String>,
    body: Vec<u8>,
}

pub struct Proxy {
    client: reqwest::Client,
    site: String,
    cache: Cache,
    reader_file: PathBuf,
    reader: Mutex<Option<String>>,
    locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    refreshing: Mutex<HashSet<String>>,
}

impl Proxy {
    pub fn new(site: String, cache_dir: PathBuf, reader_file: PathBuf) -> Arc<Self> {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let client = reqwest::Client::builder()
            .user_agent(concat!("SpontraDesktop/", env!("CARGO_PKG_VERSION")))
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(40))
            .pool_idle_timeout(Duration::from_secs(90))
            .tcp_nodelay(true)
            .build()
            .expect("the HTTP client's configuration is fixed");
        let reader = std::fs::read_to_string(&reader_file).ok().map(|token| token.trim().to_string()).filter(|token| !token.is_empty());
        Arc::new(Self { client, site, cache: Cache::new(cache_dir), reader_file, reader: Mutex::new(reader), locks: Mutex::default(), refreshing: Mutex::default() })
    }

    pub fn reader_token(&self) -> Option<String> {
        self.reader.lock().unwrap().clone()
    }

    /// Opens the connection before the first read needs it, and keeps the disk within its limit.
    pub fn warm_up(self: &Arc<Self>) {
        let proxy = self.clone();
        tauri::async_runtime::spawn(async move {
            let _ = proxy.client.head(&proxy.site).send().await;
            let _ = proxy.cache.sweep(SIZE_LIMIT_BYTES).await;
        });
    }

    pub async fn handle(self: Arc<Self>, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
        let origin = request.headers().get(header::ORIGIN).and_then(|value| value.to_str().ok()).map(str::to_string);
        #[cfg(feature = "selftest")]
        eprintln!("selftest-origin={}", origin.as_deref().unwrap_or("none"));
        if origin.as_deref().is_some_and(|origin| !APP_ORIGINS.contains(&origin)) {
            return reply(None, Answer::failed(StatusCode::FORBIDDEN));
        }
        if request.method() == Method::OPTIONS {
            return preflight(origin.as_deref());
        }
        let target = request.uri().path_and_query().map(|value| value.as_str()).unwrap_or("/").to_string();
        let Some(route) = route(&self.site, request.method(), &target) else {
            return reply(origin.as_deref(), Answer::failed(StatusCode::NOT_FOUND));
        };
        let answer = match route {
            Route::Read { upstream } => self.read(upstream, ReadKind::Standard).await,
            Route::Opening { upstream } => self.read(upstream, ReadKind::Opening).await,
            Route::Logo { upstream } => self.read(upstream, ReadKind::Logo).await,
            Route::Revision { upstream } => self.pass(upstream).await,
            Route::Stage { upstream } => self.stage(upstream, request).await,
        };
        reply(origin.as_deref(), answer)
    }

    async fn read(self: &Arc<Self>, url: String, kind: ReadKind) -> Answer {
        let stored = self.cache.read(&url).await;
        match stored.as_ref().map(|entry| freshness(&entry.meta, now_secs())) {
            Some(Freshness::Fresh) => return Answer::stored(stored.unwrap(), "hit"),
            Some(Freshness::Stale) => {
                self.refresh_behind(url, kind);
                return Answer::stored(stored.unwrap(), "stale");
            }
            _ => {}
        }
        // A second page asking for the same address waits for the first answer instead of asking again.
        let lock = self.locks.lock().unwrap().entry(url.clone()).or_default().clone();
        let guard = lock.lock().await;
        let answer = match self.cache.read(&url).await {
            Some(entry) if now_secs().saturating_sub(entry.meta.stored_at) < JUST_STORED_SECS => Answer::stored(entry, "hit"),
            _ => self.fetch_and_store(&url, kind, stored).await,
        };
        drop(guard);
        self.release(&url, lock);
        answer
    }

    fn release(&self, url: &str, lock: Arc<tokio::sync::Mutex<()>>) {
        let mut locks = self.locks.lock().unwrap();
        drop(lock);
        if locks.get(url).is_some_and(|held| Arc::strong_count(held) == 1) {
            locks.remove(url);
        }
    }

    fn refresh_behind(self: &Arc<Self>, url: String, kind: ReadKind) {
        if !self.refreshing.lock().unwrap().insert(url.clone()) {
            return;
        }
        let proxy = self.clone();
        tauri::async_runtime::spawn(async move {
            let stored = proxy.cache.read(&url).await;
            let _ = proxy.fetch_and_store(&url, kind, stored).await;
            proxy.refreshing.lock().unwrap().remove(&url);
        });
    }

    async fn fetch_and_store(&self, url: &str, kind: ReadKind, stored: Option<Entry>) -> Answer {
        let etag = stored.as_ref().and_then(|entry| entry.meta.etag.clone());
        let upstream = match self.get(url, etag.as_deref()).await {
            Ok(upstream) => upstream,
            Err(_) => return stored.map_or_else(|| Answer::failed(StatusCode::BAD_GATEWAY), |entry| Answer::stored(entry, "offline")),
        };
        if upstream.status == StatusCode::NOT_MODIFIED
            && let Some(mut entry) = stored {
                entry.meta.stored_at = now_secs();
                let _ = self.cache.write(url, &entry).await;
                return Answer::stored(entry, "revalidated");
            }
        if !upstream.status.is_success() {
            if (upstream.status.is_server_error() || upstream.status == StatusCode::TOO_MANY_REQUESTS)
                && let Some(entry) = stored {
                    return Answer::stored(entry, "offline");
                }
            return passed(upstream);
        }
        if kind.keeps(&upstream) {
            let entry = Entry {
                meta: Meta { etag: upstream.etag.clone(), content_type: upstream.content_type.clone(), stored_at: now_secs(), max_age: kind.max_age(&upstream.cache_control) },
                body: upstream.body.clone(),
            };
            let _ = self.cache.write(url, &entry).await;
        }
        passed(upstream)
    }

    async fn get(&self, url: &str, etag: Option<&str>) -> reqwest::Result<Upstream> {
        let mut request = self.client.get(url).header(header::ACCEPT, "*/*");
        if let Some(etag) = etag {
            request = request.header(header::IF_NONE_MATCH, etag);
        }
        collect(request.send().await?).await
    }

    async fn pass(&self, url: String) -> Answer {
        match self.get(&url, None).await {
            Ok(upstream) => passed(upstream),
            Err(_) => Answer::failed(StatusCode::BAD_GATEWAY),
        }
    }

    /// The site's door admits its own origin and identifies the reader by cookie; the proxy presents both.
    async fn stage(&self, url: String, request: Request<Vec<u8>>) -> Answer {
        let (parts, body) = request.into_parts();
        let mut outgoing = self.client.request(parts.method.clone(), &url).header(header::ORIGIN, self.site.as_str());
        for name in [header::ACCEPT, header::CONTENT_TYPE] {
            if let Some(value) = parts.headers.get(&name) {
                outgoing = outgoing.header(name, value);
            }
        }
        if let Some(token) = self.reader_token() {
            outgoing = outgoing.header(header::COOKIE, format!("{READER_COOKIE}={token}"));
        }
        if parts.method == Method::POST {
            outgoing = outgoing.body(body);
        }
        let Ok(Ok(upstream)) = (match outgoing.send().await {
            Ok(response) => Ok(collect(response).await),
            Err(error) => Err(error),
        }) else {
            return Answer::failed(StatusCode::BAD_GATEWAY);
        };
        if let Some(token) = upstream.set_cookie.as_deref().and_then(reader_from_cookie) {
            let _ = tokio::fs::write(&self.reader_file, &token).await;
            *self.reader.lock().unwrap() = Some(token);
        }
        passed(upstream)
    }
}

#[derive(Clone, Copy)]
enum ReadKind {
    Standard,
    Opening,
    Logo,
}

impl ReadKind {
    fn keeps(self, upstream: &Upstream) -> bool {
        match self {
            ReadKind::Standard => !forbids_storing(&upstream.cache_control),
            ReadKind::Opening => opening_is_whole(&upstream.body),
            ReadKind::Logo => upstream.content_type.as_deref().is_some_and(|value| value.starts_with("image/")),
        }
    }

    fn max_age(self, cache_control: &str) -> u64 {
        match self {
            ReadKind::Logo => LOGO_MAX_AGE_SECS,
            _ => max_age(cache_control),
        }
    }
}

async fn collect(response: reqwest::Response) -> reqwest::Result<Upstream> {
    let status = response.status();
    let text = |name: header::HeaderName| response.headers().get(name).and_then(|value| value.to_str().ok()).map(str::to_string);
    let etag = text(header::ETAG);
    let content_type = text(header::CONTENT_TYPE);
    let cache_control = text(header::CACHE_CONTROL).unwrap_or_default();
    let retry_after = text(header::RETRY_AFTER);
    let set_cookie = text(header::SET_COOKIE);
    let exhausted = response.headers().contains_key("x-retry-exhausted");
    let body = response.bytes().await?.to_vec();
    Ok(Upstream { status, etag, content_type, cache_control, retry_after, exhausted, set_cookie, body })
}

fn passed(upstream: Upstream) -> Answer {
    Answer { status: upstream.status, content_type: upstream.content_type, retry_after: upstream.retry_after, exhausted: upstream.exhausted, source: "network", body: upstream.body }
}

fn cors(builder: http::response::Builder, origin: Option<&str>) -> http::response::Builder {
    builder.header(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin.unwrap_or("*")).header(header::VARY, "Origin")
}

fn preflight(origin: Option<&str>) -> Response<Vec<u8>> {
    cors(Response::builder(), origin)
        .status(StatusCode::NO_CONTENT)
        .header(header::ACCESS_CONTROL_ALLOW_METHODS, "GET, POST")
        .header(header::ACCESS_CONTROL_ALLOW_HEADERS, "accept, content-type")
        .header(header::ACCESS_CONTROL_MAX_AGE, "600")
        .body(Vec::new())
        .expect("preflight headers are fixed")
}

fn reply(origin: Option<&str>, answer: Answer) -> Response<Vec<u8>> {
    let mut builder = cors(Response::builder(), origin)
        .status(answer.status)
        .header(header::ACCESS_CONTROL_EXPOSE_HEADERS, "retry-after, x-retry-exhausted, x-spontra-cache")
        .header(header::CACHE_CONTROL, "no-store")
        .header("x-spontra-cache", answer.source);
    if let Some(value) = answer.content_type {
        builder = builder.header(header::CONTENT_TYPE, value);
    }
    if let Some(value) = answer.retry_after {
        builder = builder.header(header::RETRY_AFTER, value);
    }
    if answer.exhausted {
        builder = builder.header("x-retry-exhausted", "true");
    }
    builder.body(answer.body).unwrap_or_else(|_| Response::builder().status(StatusCode::BAD_GATEWAY).body(Vec::new()).expect("an empty response is valid"))
}
