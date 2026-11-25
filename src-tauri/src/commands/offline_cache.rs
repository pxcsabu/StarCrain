//! Strictly whitelisted offline image cache (HiPS tiles + SkyView object cutouts)
//! and local celestial observation snapshot storage.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::Manager;

const ALLOWED_IMAGE_HOSTS: [&str; 3] = [
    "alasky.cds.unistra.fr",
    "alaskybis.cds.unistra.fr",
    "skyview.gsfc.nasa.gov",
];

const MAX_IMAGE_BYTES: usize = 2 * 1024 * 1024;
const MAX_HIPS_ORDER: u8 = 8;
const MAX_PREFETCH_BATCH: usize = 300;
const MAX_SNAPSHOT_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SurveyCacheStat {
    pub survey_id: String,
    pub tile_count: usize,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OfflineCacheStats {
    pub hips_tile_count: usize,
    pub hips_bytes: u64,
    pub photo_count: usize,
    pub photo_bytes: u64,
    pub snapshot_count: usize,
    pub snapshot_bytes: u64,
    pub total_bytes: u64,
    pub surveys: Vec<SurveyCacheStat>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrefetchHipsResult {
    pub survey_id: String,
    pub requested: usize,
    pub already_cached: usize,
    pub downloaded: usize,
    pub failed: usize,
    pub bytes_added: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SnapshotBodyEntry {
    pub id: String,
    pub kind: String,
    pub name_ja: String,
    pub name_en: String,
    pub ra_deg: f64,
    pub dec_deg: f64,
    pub az_deg: f64,
    pub alt_deg: f64,
    pub mag: Option<f64>,
    pub extra: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SnapshotBookmark {
    pub id: String,
    pub kind: String,
    pub name_ja: String,
    pub ra_deg: f64,
    pub dec_deg: f64,
    pub mag: Option<f64>,
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OfflineObservationSnapshot {
    pub id: String,
    pub title: String,
    pub created_at_iso: String,
    pub note: String,
    pub jd_ut: f64,
    pub location: serde_json::Value,
    pub view: serde_json::Value,
    pub bodies: Vec<SnapshotBodyEntry>,
    pub bookmarks: Vec<SnapshotBookmark>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OfflineSnapshotMeta {
    pub id: String,
    pub title: String,
    pub created_at_iso: String,
    pub note: String,
    pub jd_ut: f64,
    pub location_name: String,
    pub body_count: usize,
    pub bookmark_count: usize,
}

fn cache_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("アプリデータ保存先を取得できませんでした: {e}"))?;
    Ok(dir.join("offline_cache"))
}

pub fn sanitize_key(raw: &str) -> Result<String, String> {
    let cleaned: String = raw
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .take(80)
        .collect();
    let trimmed = cleaned.trim_matches('_');
    if trimmed.is_empty() {
        return Err("キャッシュキーが空または無効です".into());
    }
    Ok(trimmed.to_owned())
}

pub fn normalize_hips_survey_id(raw: &str) -> Result<&'static str, String> {
    match raw.trim() {
        "dss2_color" => Ok("dss2_color"),
        "dss2_red" => Ok("dss2_red"),
        "2mass_color" => Ok("2mass_color"),
        other => Err(format!("許可されていない HiPS サーベイIDです: {other}")),
    }
}

pub fn resolve_hips_urls(survey_id: &str, order: u8, npix: u64) -> Result<[String; 2], String> {
    let norm = normalize_hips_survey_id(survey_id)?;
    if order > MAX_HIPS_ORDER {
        return Err(format!("HiPS 次数が上限 ({MAX_HIPS_ORDER}) を超えています: {order}"));
    }
    let max_tiles = 12u64 << (2 * u32::from(order));
    if npix >= max_tiles {
        return Err(format!("HEALPix インデックス範囲外: order={order}, npix={npix}"));
    }
    let path_prefix = match norm {
        "dss2_color" => "DSS/DSSColor",
        "dss2_red" => "DSS/DSS2Merged",
        "2mass_color" => "2MASS/Color",
        _ => unreachable!(),
    };
    let dir = (npix / 10_000) * 10_000;
    let rel = format!("{path_prefix}/Norder{order}/Dir{dir}/Npix{npix}.jpg");
    Ok([
        format!("https://alasky.cds.unistra.fr/{rel}"),
        format!("https://alaskybis.cds.unistra.fr/{rel}"),
    ])
}

pub fn validate_whitelisted_image_url(raw: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(raw).map_err(|e| format!("URL解析失敗: {e}"))?;
    if url.scheme() != "https" {
        return Err(format!("HTTPS以外のスキームは禁止されています: {}", url.scheme()));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("認証情報付きURLは禁止されています".into());
    }
    if let Some(port) = url.port()
        && port != 443
    {
        return Err(format!("非標準ポート ({port}) は禁止されています"));
    }
    let host = url
        .host_str()
        .ok_or_else(|| "ホスト名が空です".to_owned())?;
    let allowed = ALLOWED_IMAGE_HOSTS
        .iter()
        .any(|h| host.eq_ignore_ascii_case(h));
    if !allowed {
        return Err(format!("ホワイトリスト外の画像ホストはブロックされました: {host}"));
    }
    Ok(url)
}

pub fn validate_skyview_url(raw: &str) -> Result<reqwest::Url, String> {
    let url = validate_whitelisted_image_url(raw)?;
    let host = url.host_str().unwrap_or("");
    if !host.eq_ignore_ascii_case("skyview.gsfc.nasa.gov") {
        return Err(format!("SkyView 以外のホストは許可されていません: {host}"));
    }
    if !url.path().starts_with("/current/cgi/runquery.pl") {
        return Err("許可された SkyView パスではありません".into());
    }
    Ok(url)
}

pub fn is_valid_raster_image(bytes: &[u8]) -> bool {
    if bytes.len() < 16 || bytes.len() > MAX_IMAGE_BYTES {
        return false;
    }
    // JPEG magic bytes
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return true;
    }
    // PNG magic bytes
    if bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) {
        return true;
    }
    false
}

fn shared_image_http_client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
    let res = CLIENT.get_or_init(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let redirect_policy = reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 3 {
                return attempt.error("リダイレクト回数が上限(3)を超えました");
            }
            match validate_whitelisted_image_url(attempt.url().as_str()) {
                Ok(_) => attempt.follow(),
                Err(reason) => attempt.error(reason),
            }
        });
        let builder = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .user_agent("StarCrane/0.1 (Astronomy Suite)")
            .redirect(redirect_policy);
        #[cfg(target_os = "android")]
        let builder = {
            let root_certs = webpki_root_certs::TLS_SERVER_ROOT_CERTS
                .iter()
                .map(|der| reqwest::Certificate::from_der(der.as_ref()))
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| format!("TLSルート証明書初期化失敗: {e}"))?;
            builder.tls_certs_only(root_certs)
        };
        builder
            .build()
            .map_err(|e| format!("HTTPクライアント初期化失敗: {e}"))
    });
    match res {
        Ok(client) => Ok(client),
        Err(msg) => Err(msg.clone()),
    }
}

async fn download_whitelisted_image(url: reqwest::Url) -> Result<Vec<u8>, String> {
    let client = shared_image_http_client()?;
    let resp = client
        .get(url.clone())
        .send()
        .await
        .map_err(|e| format!("通信エラー ({}): {e}", url.host_str().unwrap_or("")))?;

    if !resp.status().is_success() {
        return Err(format!("サーバーエラー HTTP {}", resp.status().as_u16()));
    }
    if let Some(cl) = resp.content_length()
        && cl > MAX_IMAGE_BYTES as u64
    {
        return Err(format!("画像サイズ ({cl} B) が上限 ({MAX_IMAGE_BYTES} B) を超えています"));
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("画像データ受信失敗: {e}"))?;
    if !is_valid_raster_image(&bytes) {
        return Err("有効な JPEG / PNG 画像ではありません（HTMLエラーまたはサイズ超過）".into());
    }
    Ok(bytes.to_vec())
}

fn write_file_atomic(dest: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("フォルダ作成失敗: {e}"))?;
    }
    let tmp_name = format!(
        ".{}.tmp",
        dest.file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("cache")
    );
    let tmp_path = dest.with_file_name(tmp_name);
    fs::write(&tmp_path, bytes).map_err(|e| format!("一時ファイル書込失敗: {e}"))?;
    if fs::rename(&tmp_path, dest).is_err() {
        let _ = fs::remove_file(dest);
        fs::rename(&tmp_path, dest).map_err(|e| {
            let _ = fs::remove_file(&tmp_path);
            format!("キャッシュファイル置換失敗: {e}")
        })?;
    }
    Ok(())
}

fn hips_tile_path(root: &Path, survey_id: &str, order: u8, npix: u64) -> PathBuf {
    root.join("hips")
        .join(survey_id)
        .join(format!("Norder{order}"))
        .join(format!("Npix{npix}.jpg"))
}

fn object_photo_path(root: &Path, key: &str) -> PathBuf {
    root.join("photos").join(format!("{key}.jpg"))
}

fn snapshot_path(root: &Path, id: &str) -> PathBuf {
    root.join("snapshots").join(format!("{id}.json"))
}

async fn ensure_hips_tile_bytes(
    root: &Path,
    survey_id: &str,
    order: u8,
    npix: u64,
    offline_mode: bool,
) -> Result<(Vec<u8>, bool), String> {
    let urls = resolve_hips_urls(survey_id, order, npix)?;
    let norm = normalize_hips_survey_id(survey_id)?;
    let path = hips_tile_path(root, norm, order, npix);

    if let Ok(cached) = fs::read(&path)
        && is_valid_raster_image(&cached)
    {
        return Ok((cached, true));
    }

    if offline_mode {
        return Err("OFFLINE_CACHE_MISS".into());
    }

    let mut last_err = String::new();
    for raw_url in urls {
        let url = validate_whitelisted_image_url(&raw_url)?;
        match download_whitelisted_image(url).await {
            Ok(bytes) => {
                let _ = write_file_atomic(&path, &bytes);
                return Ok((bytes, false));
            }
            Err(err) => {
                last_err = err;
            }
        }
    }
    Err(if last_err.is_empty() {
        "HiPS タイルの取得に失敗しました".into()
    } else {
        last_err
    })
}

#[tauri::command]
pub async fn fetch_cached_survey_tile_cmd(
    app: tauri::AppHandle,
    survey_id: String,
    order: u8,
    npix: u64,
    offline_mode: bool,
) -> Result<tauri::ipc::Response, String> {
    let root = cache_root(&app)?;
    let (bytes, _cached) =
        ensure_hips_tile_bytes(&root, &survey_id, order, npix, offline_mode).await?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn fetch_cached_object_photo_cmd(
    app: tauri::AppHandle,
    cache_key: String,
    url: String,
    offline_mode: bool,
) -> Result<tauri::ipc::Response, String> {
    let root = cache_root(&app)?;
    let clean_key = sanitize_key(&cache_key)?;
    let path = object_photo_path(&root, &clean_key);

    if let Ok(cached) = fs::read(&path)
        && is_valid_raster_image(&cached)
    {
        return Ok(tauri::ipc::Response::new(cached));
    }

    if offline_mode {
        return Err("OFFLINE_CACHE_MISS".into());
    }

    let parsed = validate_skyview_url(&url)?;
    let bytes = download_whitelisted_image(parsed).await?;
    let _ = write_file_atomic(&path, &bytes);
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn prefetch_hips_tiles_cmd(
    app: tauri::AppHandle,
    survey_id: String,
    tiles: Vec<(u8, u64)>,
    offline_mode: bool,
) -> Result<PrefetchHipsResult, String> {
    if offline_mode {
        return Err("オフラインモード中は事前ダウンロードを実行できません".into());
    }
    let norm = normalize_hips_survey_id(&survey_id)?.to_owned();
    let root = cache_root(&app)?;

    let batch: Vec<(u8, u64)> = tiles.into_iter().take(MAX_PREFETCH_BATCH).collect();
    let requested = batch.len();
    let mut already_cached = 0usize;
    let mut missing = Vec::new();

    for (order, npix) in batch {
        resolve_hips_urls(&norm, order, npix)?;
        let p = hips_tile_path(&root, &norm, order, npix);
        if p.exists() && fs::metadata(&p).map(|m| m.len() > 16).unwrap_or(false) {
            already_cached += 1;
        } else {
            missing.push((order, npix));
        }
    }

    let mut downloaded = 0usize;
    let mut failed = 0usize;
    let mut bytes_added = 0u64;

    for chunk in missing.chunks(6) {
        let mut handles = Vec::with_capacity(chunk.len());
        for &(order, npix) in chunk {
            let root_c = root.clone();
            let norm_c = norm.clone();
            handles.push(tauri::async_runtime::spawn(async move {
                ensure_hips_tile_bytes(&root_c, &norm_c, order, npix, false).await
            }));
        }
        for handle in handles {
            match handle.await {
                Ok(Ok((bytes, was_cached))) => {
                    if was_cached {
                        already_cached += 1;
                    } else {
                        downloaded += 1;
                        bytes_added += bytes.len() as u64;
                    }
                }
                _ => {
                    failed += 1;
                }
            }
        }
    }

    Ok(PrefetchHipsResult {
        survey_id: norm,
        requested,
        already_cached,
        downloaded,
        failed,
        bytes_added,
    })
}

fn dir_file_stats(dir: &Path, ext_filter: Option<&str>) -> (usize, u64) {
    let mut count = 0usize;
    let mut total_bytes = 0u64;
    let Ok(entries) = fs::read_dir(dir) else {
        return (0, 0);
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let (c, b) = dir_file_stats(&path, ext_filter);
            count += c;
            total_bytes += b;
        } else if path.is_file() {
            let matches = match ext_filter {
                Some(ext) => path
                    .extension()
                    .and_then(|s| s.to_str())
                    .map(|e| e.eq_ignore_ascii_case(ext))
                    .unwrap_or(false),
                None => true,
            };
            if matches {
                count += 1;
                total_bytes += entry.metadata().map(|m| m.len()).unwrap_or(0);
            }
        }
    }
    (count, total_bytes)
}

pub fn stats_in_dir(root: &Path) -> OfflineCacheStats {
    let mut surveys = Vec::new();
    let mut hips_tile_count = 0usize;
    let mut hips_bytes = 0u64;

    let hips_dir = root.join("hips");
    if let Ok(entries) = fs::read_dir(&hips_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let survey_id = entry.file_name().to_string_lossy().into_owned();
                let (c, b) = dir_file_stats(&path, Some("jpg"));
                hips_tile_count += c;
                hips_bytes += b;
                surveys.push(SurveyCacheStat {
                    survey_id,
                    tile_count: c,
                    bytes: b,
                });
            }
        }
    }
    surveys.sort_by(|a, b| a.survey_id.cmp(&b.survey_id));

    let (photo_count, photo_bytes) = dir_file_stats(&root.join("photos"), None);
    let (snapshot_count, snapshot_bytes) = dir_file_stats(&root.join("snapshots"), Some("json"));

    OfflineCacheStats {
        hips_tile_count,
        hips_bytes,
        photo_count,
        photo_bytes,
        snapshot_count,
        snapshot_bytes,
        total_bytes: hips_bytes + photo_bytes + snapshot_bytes,
        surveys,
    }
}

pub fn clear_cache_in_dir(root: &Path, target: &str) -> Result<OfflineCacheStats, String> {
    let rm_if_exists = |dir: PathBuf| -> Result<(), String> {
        if dir.exists() {
            fs::remove_dir_all(&dir).map_err(|e| format!("キャッシュ削除失敗: {e}"))?;
        }
        Ok(())
    };
    match target.trim() {
        "hips" => rm_if_exists(root.join("hips"))?,
        "photos" => rm_if_exists(root.join("photos"))?,
        "all_images" => {
            rm_if_exists(root.join("hips"))?;
            rm_if_exists(root.join("photos"))?;
        }
        "snapshots" => rm_if_exists(root.join("snapshots"))?,
        other => return Err(format!("不明な削除対象: {other}")),
    }
    Ok(stats_in_dir(root))
}

#[tauri::command]
pub fn get_offline_cache_stats_cmd(app: tauri::AppHandle) -> Result<OfflineCacheStats, String> {
    let root = cache_root(&app)?;
    Ok(stats_in_dir(&root))
}

#[tauri::command]
pub fn clear_offline_cache_cmd(
    app: tauri::AppHandle,
    target: String,
) -> Result<OfflineCacheStats, String> {
    let root = cache_root(&app)?;
    clear_cache_in_dir(&root, &target)
}

fn snapshot_to_meta(snap: &OfflineObservationSnapshot) -> OfflineSnapshotMeta {
    let location_name = snap
        .location
        .get("name_ja")
        .and_then(|v| v.as_str())
        .or_else(|| snap.location.get("name_en").and_then(|v| v.as_str()))
        .unwrap_or("観測地")
        .to_owned();
    OfflineSnapshotMeta {
        id: snap.id.clone(),
        title: snap.title.clone(),
        created_at_iso: snap.created_at_iso.clone(),
        note: snap.note.clone(),
        jd_ut: snap.jd_ut,
        location_name,
        body_count: snap.bodies.len(),
        bookmark_count: snap.bookmarks.len(),
    }
}

pub fn save_snapshot_in_dir(
    root: &Path,
    mut snapshot: OfflineObservationSnapshot,
) -> Result<OfflineSnapshotMeta, String> {
    snapshot.id = sanitize_key(&snapshot.id)?;
    let bytes = serde_json::to_vec_pretty(&snapshot)
        .map_err(|e| format!("スナップショット変換失敗: {e}"))?;
    if bytes.len() > MAX_SNAPSHOT_BYTES {
        return Err("スナップショットサイズが上限を超えています".into());
    }
    let path = snapshot_path(root, &snapshot.id);
    write_file_atomic(&path, &bytes)?;
    Ok(snapshot_to_meta(&snapshot))
}

pub fn list_snapshots_in_dir(root: &Path) -> Result<Vec<OfflineSnapshotMeta>, String> {
    let dir = root.join("snapshots");
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let entries = fs::read_dir(&dir).map_err(|e| format!("スナップショット一覧取得失敗: {e}"))?;
    let mut items = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file()
            || !path
                .extension()
                .and_then(|s| s.to_str())
                .map(|e| e.eq_ignore_ascii_case("json"))
                .unwrap_or(false)
        {
            continue;
        }
        if let Ok(raw) = fs::read_to_string(&path)
            && let Ok(snap) = serde_json::from_str::<OfflineObservationSnapshot>(&raw)
        {
            items.push(snapshot_to_meta(&snap));
        }
    }
    items.sort_by(|a, b| b.created_at_iso.cmp(&a.created_at_iso));
    Ok(items)
}

pub fn load_snapshot_in_dir(root: &Path, id: &str) -> Result<OfflineObservationSnapshot, String> {
    let clean = sanitize_key(id)?;
    let path = snapshot_path(root, &clean);
    let raw = fs::read_to_string(&path)
        .map_err(|e| format!("スナップショットが見つかりません: {e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("スナップショット解析失敗: {e}"))
}

pub fn delete_snapshot_in_dir(root: &Path, id: &str) -> Result<(), String> {
    let clean = sanitize_key(id)?;
    let path = snapshot_path(root, &clean);
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("スナップショット削除失敗: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn save_offline_snapshot_cmd(
    app: tauri::AppHandle,
    snapshot: OfflineObservationSnapshot,
) -> Result<OfflineSnapshotMeta, String> {
    let root = cache_root(&app)?;
    save_snapshot_in_dir(&root, snapshot)
}

#[tauri::command]
pub fn list_offline_snapshots_cmd(app: tauri::AppHandle) -> Result<Vec<OfflineSnapshotMeta>, String> {
    let root = cache_root(&app)?;
    list_snapshots_in_dir(&root)
}

#[tauri::command]
pub fn load_offline_snapshot_cmd(
    app: tauri::AppHandle,
    id: String,
) -> Result<OfflineObservationSnapshot, String> {
    let root = cache_root(&app)?;
    load_snapshot_in_dir(&root, &id)
}

#[tauri::command]
pub fn delete_offline_snapshot_cmd(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let root = cache_root(&app)?;
    delete_snapshot_in_dir(&root, &id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hips_url_and_bounds_check() {
        let urls = resolve_hips_urls("dss2_color", 2, 123).unwrap();
        assert_eq!(
            urls[0],
            "https://alasky.cds.unistra.fr/DSS/DSSColor/Norder2/Dir0/Npix123.jpg"
        );
        assert_eq!(
            urls[1],
            "https://alaskybis.cds.unistra.fr/DSS/DSSColor/Norder2/Dir0/Npix123.jpg"
        );

        let dir_urls = resolve_hips_urls("2mass_color", 6, 25432).unwrap();
        assert!(dir_urls[0].contains("2MASS/Color/Norder6/Dir20000/Npix25432.jpg"));

        assert!(resolve_hips_urls("unknown_survey", 0, 0).is_err());
        assert!(resolve_hips_urls("dss2_color", 0, 12).is_err());
        assert!(resolve_hips_urls("dss2_color", 9, 0).is_err());
    }

    #[test]
    fn skyview_whitelist_rejects_untrusted_urls() {
        assert!(validate_skyview_url(
            "https://skyview.gsfc.nasa.gov/current/cgi/runquery.pl?Position=10,41&Survey=DSS2%20Color&Return=JPEG"
        )
        .is_ok());
        assert!(validate_skyview_url("http://skyview.gsfc.nasa.gov/current/cgi/runquery.pl").is_err());
        assert!(validate_skyview_url("https://example.com/current/cgi/runquery.pl").is_err());
        assert!(validate_skyview_url("https://skyview.gsfc.nasa.gov:8443/current/cgi/runquery.pl").is_err());
        assert!(validate_skyview_url("https://user:pass@skyview.gsfc.nasa.gov/current/cgi/runquery.pl").is_err());
        assert!(validate_skyview_url("https://skyview.gsfc.nasa.gov/other/path").is_err());
    }

    #[test]
    fn raster_magic_validation() {
        let mut jpeg = vec![0xFF, 0xD8, 0xFF, 0xE0];
        jpeg.resize(64, 0x00);
        assert!(is_valid_raster_image(&jpeg));

        let mut png = vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        png.resize(64, 0x00);
        assert!(is_valid_raster_image(&png));

        assert!(!is_valid_raster_image(b"<html><body>404</body></html>"));
        assert!(!is_valid_raster_image(&[0xFF, 0xD8, 0xFF]));
    }

    #[test]
    fn snapshot_crud_and_cache_stats_roundtrip() {
        let root = std::env::temp_dir().join(format!(
            "starcrane_offline_test_{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);

        let snap = OfflineObservationSnapshot {
            id: "../evil/../snap_01".into(),
            title: "明石 春の星空".into(),
            created_at_iso: "2026-04-01T21:00:00+09:00".into(),
            note: "火星・木星観察メモ".into(),
            jd_ut: 2461132.0,
            location: serde_json::json!({ "name_ja": "明石市", "lat_deg": 34.6431, "lon_deg": 134.9972 }),
            view: serde_json::json!({ "az_deg": 180.0, "alt_deg": 45.0, "fov_deg": 60.0 }),
            bodies: vec![SnapshotBodyEntry {
                id: "mars".into(),
                kind: "planet".into(),
                name_ja: "火星".into(),
                name_en: "Mars".into(),
                ra_deg: 92.5,
                dec_deg: 24.1,
                az_deg: 215.2,
                alt_deg: 41.8,
                mag: Some(-0.4),
                extra: "視直径 11.2″".into(),
            }],
            bookmarks: vec![SnapshotBookmark {
                id: "dso:M42".into(),
                kind: "dso".into(),
                name_ja: "オリオン大星雲".into(),
                ra_deg: 83.8221,
                dec_deg: -5.3911,
                mag: Some(4.0),
                note: "".into(),
            }],
        };

        let meta = save_snapshot_in_dir(&root, snap).unwrap();
        assert_eq!(meta.id, "evil____snap_01");
        assert_eq!(meta.location_name, "明石市");
        assert_eq!(meta.body_count, 1);

        let list = list_snapshots_in_dir(&root).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].title, "明石 春の星空");

        let loaded = load_snapshot_in_dir(&root, &meta.id).unwrap();
        assert_eq!(loaded.bodies[0].name_ja, "火星");

        let st = stats_in_dir(&root);
        assert_eq!(st.snapshot_count, 1);
        assert!(st.snapshot_bytes > 0);

        delete_snapshot_in_dir(&root, &meta.id).unwrap();
        assert!(list_snapshots_in_dir(&root).unwrap().is_empty());

        let _ = fs::remove_dir_all(&root);
    }
}
