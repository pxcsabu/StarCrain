//! Whitelisted online sync IPC commands (Phase 8).
//! Only HTTPS requests to hardcoded official astronomy/weather hosts are allowed.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::engine::comet_db::{CometDb, CometRecord};
use crate::engine::satellite::parse_tle_text;
use crate::engine::time::calendar_to_jd;

const ALLOWED_HOSTS: [&str; 3] = [
    "minorplanetcenter.net",
    "celestrak.org",
    "api.open-meteo.com",
];

const MPC_COMETS_URL: &str = "https://minorplanetcenter.net/iau/MPCORB/Soft00Cmt.txt";
const MAX_COMET_BYTES: usize = 4 * 1024 * 1024;
const MAX_TLE_BYTES: usize = 2 * 1024 * 1024;
const MAX_WEATHER_BYTES: usize = 512 * 1024;

#[derive(Debug, Clone, Serialize)]
pub struct OnlineSyncResult {
    pub source_url: String,
    pub synced_count: usize,
    pub skipped_count: usize,
    pub summary_ja: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeatherHourPoint {
    pub time_iso: String,
    pub label: String,
    pub cloud_cover_pct: f64,
    pub cloud_low_pct: f64,
    pub cloud_mid_pct: f64,
    pub cloud_high_pct: f64,
    pub temp_c: f64,
    pub humidity_pct: f64,
    pub wind_kmh: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NightWeatherForecast {
    pub source_url: String,
    pub lat_deg: f64,
    pub lon_deg: f64,
    pub tonight_avg_cloud_pct: f64,
    pub rating_ja: String,
    pub hours: Vec<WeatherHourPoint>,
}

/// Strictly validate that a URL is plain HTTPS targeting one of the 3 hardcoded official domains,
/// with no embedded credentials or non-standard ports.
pub fn validate_whitelisted_https_url(raw: &str) -> Result<reqwest::Url, String> {
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
        return Err(format!("非標準ポート ({port}) への接続は禁止されています"));
    }
    let host = url
        .host_str()
        .ok_or_else(|| "ホスト名が空です".to_owned())?;
    let allowed = ALLOWED_HOSTS
        .iter()
        .any(|h| host.eq_ignore_ascii_case(h));
    if !allowed {
        return Err(format!(
            "ホワイトリスト外のホストへの通信はブロックされました: {host}"
        ));
    }
    Ok(url)
}

async fn fetch_whitelisted_text(
    url_str: &str,
    max_bytes: usize,
    offline_mode: bool,
) -> Result<(String, reqwest::Url), String> {
    if offline_mode {
        return Err("オフラインモードが有効なため外部通信はブロックされました".into());
    }
    let url = validate_whitelisted_https_url(url_str)?;

    let redirect_policy = reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= 3 {
            return attempt.error("リダイレクト回数が上限(3)を超えました");
        }
        match validate_whitelisted_https_url(attempt.url().as_str()) {
            Ok(_) => attempt.follow(),
            Err(reason) => attempt.error(reason),
        }
    });

    let _ = rustls::crypto::ring::default_provider().install_default();
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
    let client = builder
        .build()
        .map_err(|e| format!("HTTPクライアント初期化失敗: {e}"))?;

    let resp = client
        .get(url.clone())
        .send()
        .await
        .map_err(|e| format!("通信エラー ({}): {e}", url.host_str().unwrap_or("")))?;

    if !resp.status().is_success() {
        return Err(format!("サーバーエラー HTTP {}", resp.status().as_u16()));
    }

    if let Some(cl) = resp.content_length()
        && cl > max_bytes as u64
    {
        return Err(format!(
            "レスポンスサイズ ({cl} B) が上限 ({max_bytes} B) を超えています"
        ));
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("レスポンス受信失敗: {e}"))?;
    if bytes.len() > max_bytes {
        return Err(format!(
            "レスポンスサイズ ({} B) が上限 ({max_bytes} B) を超えています",
            bytes.len()
        ));
    }
    if bytes.contains(&0) {
        return Err("テキスト以外のバイナリデータ（NULバイト）が検出されました".into());
    }

    let text = String::from_utf8(bytes.to_vec())
        .map_err(|e| format!("UTF-8テキストデコード失敗: {e}"))?;
    Ok((text, url))
}

/// Extract `(start_byte, end_byte, slice)` whitespace-delimited tokens from a line.
fn token_spans(line: &str) -> Vec<(usize, usize, &str)> {
    let mut spans = Vec::new();
    let mut start: Option<usize> = None;
    for (idx, ch) in line.char_indices() {
        if ch.is_whitespace() {
            if let Some(s) = start.take() {
                spans.push((s, idx, &line[s..idx]));
            }
        } else if start.is_none() {
            start = Some(idx);
        }
    }
    if let Some(s) = start {
        spans.push((s, line.len(), &line[s..]));
    }
    spans
}

/// Parse MPC official `Soft00Cmt.txt` 1-line comet orbital elements.
pub fn parse_mpc_soft00_comets(text: &str, limit: usize) -> (Vec<CometRecord>, usize) {
    let mut records = Vec::new();
    let mut skipped = 0usize;

    for raw_line in text.lines() {
        if raw_line.chars().any(|c| c.is_control() && c != '\t') {
            skipped += 1;
            continue;
        }
        let line = raw_line.trim_end();
        if line.trim().len() < 60 || line.trim_start().starts_with('#') {
            continue;
        }

        let spans = token_spans(line);
        let Some(yr_idx) = (0..spans.len().min(3)).find(|&idx| {
            let tok = spans[idx].2;
            tok.len() == 4
                && tok.chars().all(|c| c.is_ascii_digit())
                && tok.parse::<i32>().is_ok_and(|y| (1600..=2200).contains(&y))
        }) else {
            skipped += 1;
            continue;
        };

        if spans.len() < yr_idx + 10 {
            skipped += 1;
            continue;
        }

        let desig_raw = if yr_idx > 0 { spans[0].2 } else { "" };

        let year = match spans[yr_idx].2.parse::<i32>() {
            Ok(v) => v,
            Err(_) => {
                skipped += 1;
                continue;
            }
        };
        let month = match spans[yr_idx + 1].2.parse::<u8>() {
            Ok(v) if (1..=12).contains(&v) => v,
            _ => {
                skipped += 1;
                continue;
            }
        };
        let day = match spans[yr_idx + 2].2.parse::<f64>() {
            Ok(v) if (1.0..=32.0).contains(&v) => v,
            _ => {
                skipped += 1;
                continue;
            }
        };
        let q_au = match spans[yr_idx + 3].2.parse::<f64>() {
            Ok(v) => v,
            Err(_) => {
                skipped += 1;
                continue;
            }
        };
        let ecc = match spans[yr_idx + 4].2.parse::<f64>() {
            Ok(v) => v,
            Err(_) => {
                skipped += 1;
                continue;
            }
        };
        let arg_peri = match spans[yr_idx + 5].2.parse::<f64>() {
            Ok(v) => v,
            Err(_) => {
                skipped += 1;
                continue;
            }
        };
        let node = match spans[yr_idx + 6].2.parse::<f64>() {
            Ok(v) => v,
            Err(_) => {
                skipped += 1;
                continue;
            }
        };
        let inc = match spans[yr_idx + 7].2.parse::<f64>() {
            Ok(v) => v,
            Err(_) => {
                skipped += 1;
                continue;
            }
        };

        // Optional 8-digit perturbed epoch `YYYYMMDD` may sit at `yr_idx + 8`
        let has_epoch_col = spans.len() >= yr_idx + 11
            && spans[yr_idx + 8].2.len() == 8
            && spans[yr_idx + 8].2.chars().all(|c| c.is_ascii_digit());
        let h_idx = yr_idx + if has_epoch_col { 9 } else { 8 };
        let k_idx = h_idx + 1;
        if spans.len() <= k_idx {
            skipped += 1;
            continue;
        }

        let abs_mag_h = match spans[h_idx].2.parse::<f64>() {
            Ok(v) => v,
            Err(_) => {
                skipped += 1;
                continue;
            }
        };
        let mpc_slope = match spans[k_idx].2.parse::<f64>() {
            Ok(v) => v,
            Err(_) => {
                skipped += 1;
                continue;
            }
        };

        let name = line
            .get(spans[k_idx].1..)
            .unwrap_or("")
            .trim()
            .to_owned();
        let display_name = if name.is_empty() {
            desig_raw.to_owned()
        } else {
            name
        };

        let slug: String = desig_raw
            .chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .collect();
        let id = if slug.is_empty() {
            format!("comet:mpc_{}", records.len())
        } else {
            format!("comet:mpc_{slug}")
        };

        let rec = CometRecord {
            id,
            name: display_name,
            epoch_perihelion_jd: calendar_to_jd(year, month, day),
            perihelion_dist_au: q_au,
            eccentricity: ecc,
            inclination_deg: inc,
            arg_periapsis_deg: arg_peri,
            ascending_node_deg: node,
            abs_mag_h,
            slope_param_k: (mpc_slope * 2.5).clamp(0.0, 30.0),
            enabled: records.len() < 40,
            notes: "MPC Soft00Cmt 同期".into(),
        };

        if rec.validate().is_ok() {
            records.push(rec);
            if records.len() >= limit {
                break;
            }
        } else {
            skipped += 1;
        }
    }

    (records, skipped)
}

#[tauri::command]
pub async fn sync_mpc_comets_cmd(
    offline_mode: bool,
    replace_all: bool,
    max_count: Option<usize>,
    db: State<'_, CometDb>,
) -> Result<OnlineSyncResult, String> {
    let (text, url) = fetch_whitelisted_text(MPC_COMETS_URL, MAX_COMET_BYTES, offline_mode).await?;
    let cap = max_count.unwrap_or(150).clamp(1, 500);
    let (records, skipped) = parse_mpc_soft00_comets(&text, cap);
    if records.is_empty() {
        return Err("MPCテキストから有効な彗星軌道要素を抽出できませんでした".into());
    }
    let count = db.import_records(records, replace_all)?;
    Ok(OnlineSyncResult {
        source_url: url.to_string(),
        synced_count: count,
        skipped_count: skipped,
        summary_ja: format!(
            "MPC公式 ({}) から {count} 件の彗星軌道要素を同期しました（上位40件を星図・3D表示ON）。",
            MPC_COMETS_URL
        ),
    })
}

#[tauri::command]
pub async fn sync_celestrak_tle_cmd(
    offline_mode: bool,
    group: String,
    db: State<'_, CometDb>,
) -> Result<OnlineSyncResult, String> {
    let (norm_group, url_str) = match group.trim().to_ascii_lowercase().as_str() {
        "visual" => (
            "visual",
            "https://celestrak.org/NORAD/elements/gp.php?GROUP=visual&FORMAT=tle",
        ),
        "weather" => (
            "weather",
            "https://celestrak.org/NORAD/elements/gp.php?GROUP=weather&FORMAT=tle",
        ),
        _ => (
            "stations",
            "https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=tle",
        ),
    };

    let (text, url) = fetch_whitelisted_text(url_str, MAX_TLE_BYTES, offline_mode).await?;
    let mut recs = parse_tle_text(&text, norm_group);
    if recs.is_empty() {
        return Err("CelesTrak TLEから有効な衛星データを解析できませんでした".into());
    }
    recs.truncate(120);
    for (idx, r) in recs.iter_mut().enumerate() {
        r.enabled = r.norad_id == 25544 || r.norad_id == 48274 || idx < 15;
    }

    let count = db.upsert_satellites_batch(recs, Some(norm_group))?;
    Ok(OnlineSyncResult {
        source_url: url.to_string(),
        synced_count: count,
        skipped_count: 0,
        summary_ja: format!(
            "CelesTrak ({norm_group}) から {count} 機の最新TLEを同期しました。"
        ),
    })
}

#[derive(Debug, Deserialize)]
struct OpenMeteoResp {
    hourly: OpenMeteoHourly,
}

#[derive(Debug, Deserialize)]
struct OpenMeteoHourly {
    time: Vec<String>,
    cloud_cover: Vec<Option<f64>>,
    cloud_cover_low: Option<Vec<Option<f64>>>,
    cloud_cover_mid: Option<Vec<Option<f64>>>,
    cloud_cover_high: Option<Vec<Option<f64>>>,
    temperature_2m: Option<Vec<Option<f64>>>,
    relative_humidity_2m: Option<Vec<Option<f64>>>,
    wind_speed_10m: Option<Vec<Option<f64>>>,
}

#[tauri::command]
pub async fn fetch_open_meteo_weather_cmd(
    offline_mode: bool,
    lat_deg: f64,
    lon_deg: f64,
    _tz_offset_min: i32,
) -> Result<NightWeatherForecast, String> {
    let lat = lat_deg.clamp(-89.9, 89.9);
    let lon = lon_deg.clamp(-180.0, 180.0);
    let url_str = format!(
        "https://api.open-meteo.com/v1/forecast?latitude={lat:.4}&longitude={lon:.4}&hourly=cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,temperature_2m,relative_humidity_2m,wind_speed_10m&forecast_days=2&timezone=auto"
    );

    let (text, url) = fetch_whitelisted_text(&url_str, MAX_WEATHER_BYTES, offline_mode).await?;
    let parsed: OpenMeteoResp =
        serde_json::from_str(&text).map_err(|e| format!("Open-Meteo JSON解析失敗: {e}"))?;

    let mut hours = Vec::new();
    let total = parsed.hourly.time.len().min(30);
    for i in 0..total {
        let iso = &parsed.hourly.time[i];
        let label = iso.split('T').nth(1).unwrap_or(iso).to_owned();
        let cc = parsed
            .hourly
            .cloud_cover
            .get(i)
            .and_then(|v| *v)
            .unwrap_or(0.0);
        let low = parsed
            .hourly
            .cloud_cover_low
            .as_ref()
            .and_then(|v| v.get(i))
            .and_then(|v| *v)
            .unwrap_or(0.0);
        let mid = parsed
            .hourly
            .cloud_cover_mid
            .as_ref()
            .and_then(|v| v.get(i))
            .and_then(|v| *v)
            .unwrap_or(0.0);
        let high = parsed
            .hourly
            .cloud_cover_high
            .as_ref()
            .and_then(|v| v.get(i))
            .and_then(|v| *v)
            .unwrap_or(0.0);
        let temp = parsed
            .hourly
            .temperature_2m
            .as_ref()
            .and_then(|v| v.get(i))
            .and_then(|v| *v)
            .unwrap_or(0.0);
        let hum = parsed
            .hourly
            .relative_humidity_2m
            .as_ref()
            .and_then(|v| v.get(i))
            .and_then(|v| *v)
            .unwrap_or(0.0);
        let wind = parsed
            .hourly
            .wind_speed_10m
            .as_ref()
            .and_then(|v| v.get(i))
            .and_then(|v| *v)
            .unwrap_or(0.0);

        hours.push(WeatherHourPoint {
            time_iso: iso.clone(),
            label,
            cloud_cover_pct: cc,
            cloud_low_pct: low,
            cloud_mid_pct: mid,
            cloud_high_pct: high,
            temp_c: temp,
            humidity_pct: hum,
            wind_kmh: wind,
        });
    }

    let night_samples: Vec<f64> = hours
        .iter()
        .filter(|h| {
            let hr = h
                .label
                .split(':')
                .next()
                .and_then(|s| s.parse::<u8>().ok())
                .unwrap_or(12);
            hr >= 18 || hr <= 5
        })
        .map(|h| h.cloud_cover_pct)
        .collect();

    let avg = if night_samples.is_empty() {
        hours
            .iter()
            .map(|h| h.cloud_cover_pct)
            .sum::<f64>()
            / (hours.len().max(1) as f64)
    } else {
        night_samples.iter().sum::<f64>() / (night_samples.len() as f64)
    };

    let rating_ja = if avg < 20.0 {
        "快晴・絶好の星空コンディション"
    } else if avg < 45.0 {
        "晴れ・おおむね観望に適す"
    } else if avg < 75.0 {
        "薄曇り・雲間に晴れ間あり"
    } else {
        "曇天・観望不適"
    };

    Ok(NightWeatherForecast {
        source_url: url.to_string(),
        lat_deg: lat,
        lon_deg: lon,
        tonight_avg_cloud_pct: avg,
        rating_ja: rating_ja.into(),
        hours,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn whitelist_rejects_non_official_and_http_urls() {
        assert!(
            validate_whitelisted_https_url(
                "https://minorplanetcenter.net/iau/MPCORB/Soft00Cmt.txt"
            )
            .is_ok()
        );
        assert!(
            validate_whitelisted_https_url(
                "https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=tle"
            )
            .is_ok()
        );
        assert!(
            validate_whitelisted_https_url("https://api.open-meteo.com/v1/forecast?latitude=34.6")
                .is_ok()
        );

        assert!(
            validate_whitelisted_https_url(
                "http://minorplanetcenter.net/iau/MPCORB/Soft00Cmt.txt"
            )
            .is_err()
        );
        assert!(validate_whitelisted_https_url("https://evil.com/data.txt").is_err());
        assert!(
            validate_whitelisted_https_url("https://minorplanetcenter.net.evil.com/Soft00Cmt.txt")
                .is_err()
        );
        assert!(validate_whitelisted_https_url("https://127.0.0.1/test").is_err());
        assert!(validate_whitelisted_https_url("https://user@celestrak.org/gp.php").is_err());
        assert!(validate_whitelisted_https_url("https://celestrak.org:8443/gp.php").is_err());
    }

    #[test]
    fn parses_mpc_soft00_comet_lines() {
        let sample = concat!(
            "    CK23A030  2024 09 27.7400  0.391400 1.000100 308.4900  21.5600 139.1100  20240927   4.5  3.4  C/2023 A3 (Tsuchinshan-ATLAS)\n",
            "    0012P     2024 04 21.1400  0.780800 0.954700 199.0300 255.8900  74.1900             4.2  3.6  12P/Pons-Brooks\n",
            "    INVALID LINE\n",
        );
        let (recs, skipped) = parse_mpc_soft00_comets(sample, 100);
        assert_eq!(recs.len(), 2);
        assert_eq!(skipped, 0);
        assert!(recs[0].id.starts_with("comet:mpc_"));
        assert_eq!(recs[0].name, "C/2023 A3 (Tsuchinshan-ATLAS)");
        assert_eq!(recs[1].name, "12P/Pons-Brooks");
        assert!((recs[0].perihelion_dist_au - 0.3914).abs() < 1e-6);
        assert!((recs[1].eccentricity - 0.9547).abs() < 1e-6);
    }
}
