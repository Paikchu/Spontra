//! `spontra://` addresses, translated to pages of the app.

use url::Url;

const QUERY_KEYS: [&str; 9] = ["view", "p", "business", "finding", "check", "event", "report", "metric", "detail"];

fn valid_ticker(ticker: &str) -> bool {
    let mut bytes = ticker.bytes();
    (1..=12).contains(&ticker.len())
        && bytes.next().is_some_and(|first| first.is_ascii_uppercase())
        && bytes.all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'.' || byte == b'-')
}

/// The page a deep link opens, or nothing when the address is not one of the app's.
pub fn page_of(url: &Url) -> Option<String> {
    if url.scheme() != "spontra" {
        return None;
    }
    match (url.host_str(), url.path().trim_matches('/')) {
        (Some("home"), "") => Some("/".into()),
        (Some("companies"), ticker) if valid_ticker(ticker) => {
            let query: Vec<String> = url
                .query_pairs()
                .filter(|(key, _)| QUERY_KEYS.contains(&key.as_ref()))
                .map(|(key, value)| format!("{key}={}", url::form_urlencoded::byte_serialize(value.as_bytes()).collect::<String>()))
                .collect();
            Some(if query.is_empty() { format!("/companies/{ticker}") } else { format!("/companies/{ticker}?{}", query.join("&")) })
        }
        _ => None,
    }
}
