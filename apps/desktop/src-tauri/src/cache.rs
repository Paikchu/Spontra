//! Responses on disk: one file per URL, a length-prefixed JSON header followed by the body.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::fs;

/// How long a stored response may still be shown while a fresher one is fetched.
pub const STALE_WINDOW_SECS: u64 = 7 * 24 * 60 * 60;
/// A company's opening reads are a few hundred kilobytes; this holds several hundred companies.
pub const SIZE_LIMIT_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Meta {
    pub etag: Option<String>,
    pub content_type: Option<String>,
    pub stored_at: u64,
    pub max_age: u64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub meta: Meta,
    pub body: Vec<u8>,
}

#[derive(Debug, PartialEq)]
pub enum Freshness {
    Fresh,
    Stale,
    Expired,
}

pub fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or(Duration::ZERO).as_secs()
}

pub fn freshness(meta: &Meta, now: u64) -> Freshness {
    let age = now.saturating_sub(meta.stored_at);
    if age < meta.max_age {
        Freshness::Fresh
    } else if age < meta.max_age.saturating_add(STALE_WINDOW_SECS) {
        Freshness::Stale
    } else {
        Freshness::Expired
    }
}

fn encode(entry: &Entry) -> serde_json::Result<Vec<u8>> {
    let meta = serde_json::to_vec(&entry.meta)?;
    let mut out = Vec::with_capacity(4 + meta.len() + entry.body.len());
    out.extend_from_slice(&(meta.len() as u32).to_le_bytes());
    out.extend_from_slice(&meta);
    out.extend_from_slice(&entry.body);
    Ok(out)
}

fn decode(mut bytes: Vec<u8>) -> Option<Entry> {
    let length = u32::from_le_bytes(bytes.get(..4)?.try_into().ok()?) as usize;
    let meta = serde_json::from_slice(bytes.get(4..4 + length)?).ok()?;
    Some(Entry { meta, body: bytes.split_off(4 + length) })
}

#[derive(Clone)]
pub struct Cache {
    dir: PathBuf,
}

impl Cache {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    fn path(&self, key: &str) -> PathBuf {
        let hash = Sha256::digest(key.as_bytes());
        let name: String = hash.iter().map(|byte| format!("{byte:02x}")).collect();
        self.dir.join(name)
    }

    pub async fn read(&self, key: &str) -> Option<Entry> {
        decode(fs::read(self.path(key)).await.ok()?)
    }

    /// Written beside the destination and renamed, so a reader never sees half a response.
    pub async fn write(&self, key: &str, entry: &Entry) -> std::io::Result<()> {
        fs::create_dir_all(&self.dir).await?;
        let path = self.path(key);
        let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
        fs::write(&temporary, encode(entry)?).await?;
        fs::rename(&temporary, &path).await
    }

    /// Removes the least recently written files until the directory fits the limit.
    pub async fn sweep(&self, limit: u64) -> std::io::Result<()> {
        let mut files = list(&self.dir).await?;
        let mut total: u64 = files.iter().map(|file| file.1).sum();
        files.sort_by_key(|file| file.2);
        for (path, size, _) in files {
            if total <= limit {
                break;
            }
            fs::remove_file(&path).await?;
            total -= size;
        }
        Ok(())
    }
}

async fn list(dir: &Path) -> std::io::Result<Vec<(PathBuf, u64, SystemTime)>> {
    let mut files = Vec::new();
    let mut entries = match fs::read_dir(dir).await {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(files),
        Err(error) => return Err(error),
    };
    while let Some(entry) = entries.next_entry().await? {
        let meta = entry.metadata().await?;
        files.push((entry.path(), meta.len(), meta.modified()?));
    }
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(body: &[u8]) -> Entry {
        Entry { meta: Meta { etag: Some("W/\"a\"".into()), content_type: Some("application/json".into()), stored_at: 100, max_age: 60 }, body: body.to_vec() }
    }

    fn directory(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("spontra-cache-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn freshness_moves_from_fresh_to_stale_to_expired() {
        let meta = entry(b"").meta;
        assert_eq!(freshness(&meta, 159), Freshness::Fresh);
        assert_eq!(freshness(&meta, 160), Freshness::Stale);
        assert_eq!(freshness(&meta, 160 + STALE_WINDOW_SECS), Freshness::Expired);
    }

    #[test]
    fn a_truncated_file_reads_as_nothing() {
        assert_eq!(decode(vec![200, 0, 0, 0, 1, 2]), None);
        assert_eq!(decode(vec![1]), None);
    }

    #[tokio::test]
    async fn an_entry_survives_the_disk() {
        let cache = Cache::new(directory("roundtrip"));
        let stored = entry(b"{\"a\":1}");
        cache.write("https://x/a", &stored).await.unwrap();
        assert_eq!(cache.read("https://x/a").await, Some(stored));
        assert_eq!(cache.read("https://x/b").await, None);
    }

    #[tokio::test]
    async fn a_sweep_removes_the_oldest_first() {
        let cache = Cache::new(directory("sweep"));
        cache.write("old", &entry(&[0; 1000])).await.unwrap();
        tokio::time::sleep(Duration::from_millis(20)).await;
        cache.write("new", &entry(&[0; 1000])).await.unwrap();
        cache.sweep(1500).await.unwrap();
        assert!(cache.read("old").await.is_none());
        assert!(cache.read("new").await.is_some());
    }
}
