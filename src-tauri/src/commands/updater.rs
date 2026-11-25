//! Android in-app updater backend commands.
//! Fetches latest GitHub Release metadata and downloads verified APK artifacts from `pxcsabu/StarCrain`.

use std::fs::{self, File};
use std::io::Write;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

const GITHUB_LATEST_RELEASE_API: &str =
    "https://api.github.com/repos/pxcsabu/StarCrain/releases/latest";
const EXPECTED_RELEASE_DOWNLOAD_PREFIX: &str = "/pxcsabu/StarCrain/releases/download/";
const REDIRECT_ALLOWED_HOSTS: [&str; 4] = [
    "github.com",
    "release-assets.githubusercontent.com",
    "objects.githubusercontent.com",
    "github-releases.githubusercontent.com",
];
const MAX_APK_BYTES: u64 = 256 * 1024 * 1024;
const APK_ZIP_MAGIC: [u8; 4] = [0x50, 0x4B, 0x03, 0x04];

#[derive(Debug, Clone, Deserialize)]
pub struct GitHubAsset {
    pub name: String,
    pub browser_download_url: String,
    pub size: u64,
}

#[derive(Debug, Clone, Deserialize)]
struct GitHubLatestRelease {
    tag_name: String,
    body: Option<String>,
    html_url: Option<String>,
    #[serde(default)]
    assets: Vec<GitHubAsset>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AndroidUpdateCheckResult {
    pub has_update: bool,
    pub current_version: String,
    pub latest_version: Option<String>,
    pub release_notes: Option<String>,
    pub release_url: Option<String>,
    pub apk_name: Option<String>,
    pub apk_url: Option<String>,
    pub apk_size: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AndroidDownloadedApk {
    pub file_path: String,
    pub file_name: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
struct AndroidDownloadProgress {
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    percent: Option<u8>,
}

fn validate_common_https_url(raw: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(raw).map_err(|e| format!("URL解析失敗: {e}"))?;
    if url.scheme() != "https" {
        return Err(format!("HTTPS以外のURLは許可されていません: {}", url.scheme()));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("認証情報付きURLは許可されていません".into());
    }
    if let Some(port) = url.port()
        && port != 443
    {
        return Err(format!("非標準ポート ({port}) は許可されていません"));
    }
    Ok(url)
}

/// Validate initial APK download URL strictly against `https://github.com/pxcsabu/StarCrain/releases/download/.../*.apk`.
pub fn validate_android_apk_initial_url(raw: &str) -> Result<reqwest::Url, String> {
    let url = validate_common_https_url(raw)?;
    let host = url
        .host_str()
        .ok_or_else(|| "URLにホスト名がありません".to_owned())?;
    if !host.eq_ignore_ascii_case("github.com") {
        return Err(format!("不正なAPK配布ホスト: {host}"));
    }
    let path = url.path();
    if !path.starts_with(EXPECTED_RELEASE_DOWNLOAD_PREFIX)
        || !path.to_ascii_lowercase().ends_with(".apk")
    {
        return Err("許可されたリリースのAPKパスではありません".into());
    }
    Ok(url)
}

/// Validate redirect targets for GitHub API & release asset CDNs.
pub fn validate_github_release_redirect_url(raw: &str) -> Result<reqwest::Url, String> {
    let url = validate_common_https_url(raw)?;
    let host = url
        .host_str()
        .ok_or_else(|| "URLにホスト名がありません".to_owned())?;
    let allowed = REDIRECT_ALLOWED_HOSTS
        .iter()
        .any(|h| host.eq_ignore_ascii_case(h));
    if !allowed {
        return Err(format!("ホワイトリスト外のホストへのリダイレクトを拒否しました: {host}"));
    }
    Ok(url)
}

fn parse_semver_tuple(raw: &str) -> Option<(u64, u64, u64)> {
    let trimmed = raw.trim().trim_start_matches(['v', 'V']);
    let core = trimmed.split(['-', '+']).next()?.trim();
    if core.is_empty() {
        return None;
    }
    let mut parts = core.split('.');
    let major = parts.next()?.parse::<u64>().ok()?;
    let minor = parts.next().unwrap_or("0").parse::<u64>().ok()?;
    let patch = parts.next().unwrap_or("0").parse::<u64>().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, patch))
}

pub fn is_newer_version(current: &str, latest: &str) -> bool {
    match (parse_semver_tuple(current), parse_semver_tuple(latest)) {
        (Some(cur), Some(lat)) => lat > cur,
        _ => false,
    }
}

pub fn select_best_apk_asset(assets: &[GitHubAsset]) -> Option<&GitHubAsset> {
    let valid: Vec<&GitHubAsset> = assets
        .iter()
        .filter(|a| {
            a.name.to_ascii_lowercase().ends_with(".apk")
                && validate_android_apk_initial_url(&a.browser_download_url).is_ok()
        })
        .collect();
    if let Some(arm64) = valid
        .iter()
        .copied()
        .find(|a| a.name.to_ascii_lowercase().contains("arm64"))
    {
        return Some(arm64);
    }
    if let Some(univ) = valid
        .iter()
        .copied()
        .find(|a| a.name.to_ascii_lowercase().contains("universal"))
    {
        return Some(univ);
    }
    valid.into_iter().next()
}

pub fn sanitize_apk_filename(raw: &str) -> String {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '_' || *c == '-')
        .collect();
    let trimmed = cleaned.trim_start_matches('.');
    if trimmed.is_empty() {
        return "StarCrane-update.apk".to_owned();
    }
    if trimmed.to_ascii_lowercase().ends_with(".apk") {
        trimmed.to_owned()
    } else {
        format!("{trimmed}.apk")
    }
}

fn build_github_http_client(timeout_secs: u64, allow_api_redirects: bool) -> Result<reqwest::Client, String> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let redirect_policy = reqwest::redirect::Policy::custom(move |attempt| {
        if attempt.previous().len() >= 5 {
            return attempt.error("リダイレクト回数が上限(5)を超えました");
        }
        let target = attempt.url().as_str();
        let ok = if allow_api_redirects {
            validate_common_https_url(target).and_then(|u| {
                let h = u.host_str().unwrap_or("");
                if h.eq_ignore_ascii_case("api.github.com")
                    || REDIRECT_ALLOWED_HOSTS.iter().any(|ah| h.eq_ignore_ascii_case(ah))
                {
                    Ok(())
                } else {
                    Err(format!("許可されないリダイレクト先: {h}"))
                }
            })
        } else {
            validate_github_release_redirect_url(target).map(|_| ())
        };
        match ok {
            Ok(()) => attempt.follow(),
            Err(reason) => attempt.error(reason),
        }
    });

    let builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout_secs))
        .user_agent("StarCrane/0.1 (Android Updater)")
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
}

#[tauri::command]
pub async fn check_android_update_cmd(
    app: AppHandle,
    offline_mode: bool,
) -> Result<AndroidUpdateCheckResult, String> {
    if offline_mode {
        return Err("オフラインモードが有効なためアップデート確認はスキップされました".into());
    }

    let current_version = app.package_info().version.to_string();
    let client = build_github_http_client(15, true)?;
    let resp = client
        .get(GITHUB_LATEST_RELEASE_API)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("更新確認通信エラー: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("GitHub Release取得失敗 (HTTP {})", resp.status()));
    }

    let release: GitHubLatestRelease = resp
        .json()
        .await
        .map_err(|e| format!("リリース情報の解析に失敗: {e}"))?;

    let latest_clean = release.tag_name.trim().trim_start_matches(['v', 'V']).to_owned();
    let newer = is_newer_version(&current_version, &latest_clean);
    let apk_asset = select_best_apk_asset(&release.assets);

    Ok(AndroidUpdateCheckResult {
        has_update: newer && apk_asset.is_some(),
        current_version,
        latest_version: Some(latest_clean),
        release_notes: release.body,
        release_url: release.html_url,
        apk_name: apk_asset.map(|a| a.name.clone()),
        apk_url: apk_asset.map(|a| a.browser_download_url.clone()),
        apk_size: apk_asset.map(|a| a.size),
    })
}

#[tauri::command]
pub async fn download_android_update_apk_cmd(
    app: AppHandle,
    apk_url: String,
    apk_name: String,
    offline_mode: bool,
) -> Result<AndroidDownloadedApk, String> {
    if offline_mode {
        return Err("オフラインモードが有効なためダウンロードできません".into());
    }
    let validated_url = validate_android_apk_initial_url(&apk_url)?;

    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("キャッシュディレクトリ取得失敗: {e}"))?;
    let updates_dir = cache_dir.join("updates");
    fs::create_dir_all(&updates_dir)
        .map_err(|e| format!("更新キャッシュディレクトリ作成失敗: {e}"))?;

    // Remove previous update files so cache stays tidy
    if let Ok(entries) = fs::read_dir(&updates_dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_file() {
                let name = p
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("")
                    .to_ascii_lowercase();
                if name.ends_with(".apk") || name.ends_with(".part") {
                    let _ = fs::remove_file(p);
                }
            }
        }
    }

    let file_name = sanitize_apk_filename(&apk_name);
    let part_path = updates_dir.join(format!("{file_name}.part"));
    let final_path = updates_dir.join(&file_name);

    let client = build_github_http_client(180, false)?;
    let mut resp = client
        .get(validated_url)
        .send()
        .await
        .map_err(|e| format!("APKダウンロード接続エラー: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("APKダウンロード失敗 (HTTP {})", resp.status()));
    }

    let total_bytes = resp.content_length();
    if let Some(total) = total_bytes
        && total > MAX_APK_BYTES
    {
        return Err(format!("APKサイズ({total} bytes)が上限(256 MiB)を超えています"));
    }

    let mut out_file = File::create(&part_path)
        .map_err(|e| format!("一時ファイル作成失敗: {e}"))?;

    let mut downloaded: u64 = 0;
    let mut header_buf = [0u8; 4];
    let mut header_filled: usize = 0;
    let mut last_emit = Instant::now();
    let mut last_pct: Option<u8> = None;

    let _ = app.emit(
        "android-update-progress",
        AndroidDownloadProgress {
            downloaded_bytes: 0,
            total_bytes,
            percent: total_bytes.map(|_| 0),
        },
    );

    let download_res: Result<(), String> = async {
        while let Some(chunk) = resp
            .chunk()
            .await
            .map_err(|e| format!("APK受信中にエラーが発生しました: {e}"))?
        {
            let next_total = downloaded.saturating_add(chunk.len() as u64);
            if next_total > MAX_APK_BYTES {
                return Err("APKサイズが上限(256 MiB)を超えました".into());
            }

            if header_filled < 4 {
                let copy_n = (4 - header_filled).min(chunk.len());
                header_buf[header_filled..header_filled + copy_n]
                    .copy_from_slice(&chunk[..copy_n]);
                header_filled += copy_n;
                if header_filled == 4 && header_buf != APK_ZIP_MAGIC {
                    return Err("ダウンロードしたファイルは有効なAPK(ZIP)形式ではありません".into());
                }
            }

            out_file
                .write_all(&chunk)
                .map_err(|e| format!("APK書き込みエラー: {e}"))?;
            downloaded = next_total;

            let pct = total_bytes.map(|t| {
                if t == 0 {
                    0
                } else {
                    ((downloaded.saturating_mul(100)) / t).min(99) as u8
                }
            });
            let pct_changed = pct.is_some() && pct != last_pct;
            if pct_changed || last_emit.elapsed() >= Duration::from_millis(120) {
                last_pct = pct;
                last_emit = Instant::now();
                let _ = app.emit(
                    "android-update-progress",
                    AndroidDownloadProgress {
                        downloaded_bytes: downloaded,
                        total_bytes,
                        percent: pct,
                    },
                );
            }
        }
        if header_filled < 4 || header_buf != APK_ZIP_MAGIC {
            return Err("APKファイルが不完全または破損しています".into());
        }
        out_file
            .flush()
            .map_err(|e| format!("APKフラッシュ失敗: {e}"))?;
        out_file
            .sync_all()
            .map_err(|e| format!("APK同期書き込み失敗: {e}"))?;
        Ok(())
    }
    .await;

    drop(out_file);

    if let Err(err) = download_res {
        let _ = fs::remove_file(&part_path);
        return Err(err);
    }

    fs::rename(&part_path, &final_path).map_err(|e| {
        let _ = fs::remove_file(&part_path);
        format!("APKファイル確定エラー: {e}")
    })?;

    let _ = app.emit(
        "android-update-progress",
        AndroidDownloadProgress {
            downloaded_bytes: downloaded,
            total_bytes: total_bytes.or(Some(downloaded)),
            percent: Some(100),
        },
    );

    let canonical = final_path.canonicalize().unwrap_or(final_path);
    Ok(AndroidDownloadedApk {
        file_path: canonical.to_string_lossy().into_owned(),
        file_name,
        size_bytes: downloaded,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn semver_comparison_works() {
        assert!(is_newer_version("0.1.0", "0.1.1"));
        assert!(is_newer_version("0.1.0", "v0.2.0"));
        assert!(is_newer_version("0.1.9", "1.0.0"));
        assert!(!is_newer_version("0.1.0", "0.1.0"));
        assert!(!is_newer_version("0.2.0", "v0.1.9"));
        assert!(!is_newer_version("0.1.0", "invalid"));
    }

    #[test]
    fn android_apk_url_validation_enforces_github_repo_and_https() {
        assert!(
            validate_android_apk_initial_url(
                "https://github.com/pxcsabu/StarCrain/releases/download/v0.2.0/StarCrane-universal.apk"
            )
            .is_ok()
        );
        assert!(
            validate_android_apk_initial_url(
                "http://github.com/pxcsabu/StarCrain/releases/download/v0.2.0/StarCrane.apk"
            )
            .is_err()
        );
        assert!(
            validate_android_apk_initial_url(
                "https://evil.example.com/pxcsabu/StarCrain/releases/download/v0.2.0/StarCrane.apk"
            )
            .is_err()
        );
        assert!(
            validate_android_apk_initial_url(
                "https://github.com/other/repo/releases/download/v0.2.0/StarCrane.apk"
            )
            .is_err()
        );
        assert!(
            validate_android_apk_initial_url(
                "https://github.com/pxcsabu/StarCrain/releases/download/v0.2.0/StarCrane.exe"
            )
            .is_err()
        );
    }

    #[test]
    fn select_best_apk_asset_prefers_arm64_and_universal() {
        let base = "https://github.com/pxcsabu/StarCrain/releases/download/v0.2.0";
        let assets = vec![
            GitHubAsset {
                name: "StarCrane_0.2.0_x64-setup.exe".into(),
                browser_download_url: format!("{base}/StarCrane_0.2.0_x64-setup.exe"),
                size: 100,
            },
            GitHubAsset {
                name: "StarCrane_0.2.0_armeabi-v7a.apk".into(),
                browser_download_url: format!("{base}/StarCrane_0.2.0_armeabi-v7a.apk"),
                size: 200,
            },
            GitHubAsset {
                name: "StarCrane_0.2.0_universal.apk".into(),
                browser_download_url: format!("{base}/StarCrane_0.2.0_universal.apk"),
                size: 300,
            },
            GitHubAsset {
                name: "StarCrane_0.2.0_arm64-v8a.apk".into(),
                browser_download_url: format!("{base}/StarCrane_0.2.0_arm64-v8a.apk"),
                size: 250,
            },
        ];
        assert_eq!(
            select_best_apk_asset(&assets).map(|a| a.name.as_str()),
            Some("StarCrane_0.2.0_arm64-v8a.apk")
        );
    }

    #[test]
    fn sanitize_apk_filename_blocks_traversal() {
        assert_eq!(
            sanitize_apk_filename("../../etc/evil.apk"),
            "evil.apk"
        );
        assert_eq!(
            sanitize_apk_filename("StarCrane v0.2.apk"),
            "StarCranev0.2.apk"
        );
        assert_eq!(sanitize_apk_filename(".."), "StarCrane-update.apk");
    }
}
