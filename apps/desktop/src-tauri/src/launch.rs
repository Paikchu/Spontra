//! How long the launch took. Timings stay in a local file.

use serde_json::json;
use std::io::Write;
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const MAX_SAMPLE_BYTES: usize = 2048;

pub struct Launch {
    started: Instant,
    log: std::sync::Mutex<Option<PathBuf>>,
}

fn unix_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or(Duration::ZERO).as_millis()
}

impl Launch {
    pub fn begin() -> Self {
        Self { started: Instant::now(), log: std::sync::Mutex::new(None) }
    }

    pub fn set_log(&self, path: PathBuf) {
        *self.log.lock().unwrap() = Some(path);
    }

    fn append(&self, line: serde_json::Value) {
        let Some(path) = self.log.lock().unwrap().clone() else { return };
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(file, "{line}");
        }
    }

    pub fn record_content(&self, content_ms: f64, page: &str) {
        self.append(json!({
            "kind": "launch", "at": unix_ms(), "page": page,
            "processToContentMs": self.started.elapsed().as_secs_f64() * 1000.0, "webviewContentMs": content_ms,
        }));
    }

    pub fn record_vitals(&self, sample: &str) {
        if sample.len() <= MAX_SAMPLE_BYTES {
            self.append(json!({ "kind": "vitals", "at": unix_ms(), "sample": sample }));
        }
    }
}
