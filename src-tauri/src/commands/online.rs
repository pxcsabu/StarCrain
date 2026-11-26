//! Whitelisted online sync IPC commands (Phase 8).
//! Only HTTPS requests to hardcoded official astronomy/weather hosts are allowed.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::engine::comet_db::{CometDb, CometRecord};
use crate::engine::satellite::parse_tle_text;
use crate::engine::time::calendar_to_jd;

const ALLOWED_HOSTS: [&str; 4] = [
    "minorplanetcenter.net",
    "celestrak.org",
    "api.open-meteo.com",
    "services.swpc.noaa.gov",
];

const MPC_COMETS_URL: &str = "https://minorplanetcenter.net/iau/MPCORB/Soft00Cmt.txt";
const MAX_COMET_BYTES: usize = 4 * 1024 * 1024;
const MAX_TLE_BYTES: usize = 2 * 1024 * 1024;
const MAX_WEATHER_BYTES: usize = 1024 * 1024;
const MAX_SPACE_WEATHER_BYTES: usize = 512 * 1024;

#[derive(Debug, Clone, Serialize)]
pub struct OnlineSyncResult {
    pub source_url: String,
    pub synced_count: usize,
    pub skipped_count: usize,
    pub summary_ja: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeatherCurrent {
    pub temp_c: f64,
    pub apparent_temp_c: f64,
    pub humidity_pct: f64,
    pub cloud_cover_pct: f64,
    pub wind_kmh: f64,
    pub wind_dir_deg: f64,
    pub pressure_hpa: f64,
    pub weather_code: u16,
    pub weather_label_ja: String,
    pub is_day: bool,
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
    pub weather_code: u16,
    pub weather_label_ja: String,
    pub precip_prob_pct: f64,
    pub precip_mm: f64,
    pub dew_point_c: f64,
    pub visibility_km: f64,
    pub wind_dir_deg: f64,
    pub stargazing_score: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeatherDailyPoint {
    pub date: String,
    pub weather_code: u16,
    pub weather_label_ja: String,
    pub temp_max_c: f64,
    pub temp_min_c: f64,
    pub precip_prob_max_pct: f64,
    pub precip_sum_mm: f64,
    pub wind_max_kmh: f64,
    pub night_avg_cloud_pct: f64,
    pub stargazing_score: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NightWeatherForecast {
    pub source_url: String,
    pub lat_deg: f64,
    pub lon_deg: f64,
    pub tonight_avg_cloud_pct: f64,
    pub rating_ja: String,
    pub hours: Vec<WeatherHourPoint>,
    pub current: Option<WeatherCurrent>,
    pub daily: Vec<WeatherDailyPoint>,
    pub tonight_stargazing_score: u8,
    pub best_stargazing_window: Option<String>,
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
struct OpenMeteoCurrent {
    temperature_2m: Option<f64>,
    apparent_temperature: Option<f64>,
    relative_humidity_2m: Option<f64>,
    cloud_cover: Option<f64>,
    wind_speed_10m: Option<f64>,
    wind_direction_10m: Option<f64>,
    surface_pressure: Option<f64>,
    weather_code: Option<u16>,
    is_day: Option<u8>,
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
    dew_point_2m: Option<Vec<Option<f64>>>,
    precipitation_probability: Option<Vec<Option<f64>>>,
    precipitation: Option<Vec<Option<f64>>>,
    visibility: Option<Vec<Option<f64>>>,
    wind_speed_10m: Option<Vec<Option<f64>>>,
    wind_direction_10m: Option<Vec<Option<f64>>>,
    weather_code: Option<Vec<Option<u16>>>,
}

#[derive(Debug, Deserialize)]
struct OpenMeteoDaily {
    time: Vec<String>,
    weather_code: Option<Vec<Option<u16>>>,
    temperature_2m_max: Option<Vec<Option<f64>>>,
    temperature_2m_min: Option<Vec<Option<f64>>>,
    precipitation_probability_max: Option<Vec<Option<f64>>>,
    precipitation_sum: Option<Vec<Option<f64>>>,
    wind_speed_10m_max: Option<Vec<Option<f64>>>,
}

#[derive(Debug, Deserialize)]
struct OpenMeteoResp {
    current: Option<OpenMeteoCurrent>,
    hourly: OpenMeteoHourly,
    daily: Option<OpenMeteoDaily>,
}

pub fn wmo_code_to_ja(code: u16) -> &'static str {
    match code {
        0 => "快晴",
        1 => "ほぼ晴れ",
        2 => "一部曇り",
        3 => "曇り",
        45 | 48 => "霧",
        51 | 53 | 55 => "霧雨",
        56 | 57 => "着氷性霧雨",
        61 | 63 => "雨",
        65 => "強い雨",
        66 | 67 => "凍雨",
        71 | 73 => "雪",
        75 => "大雪",
        77 => "霧雪",
        80..=82 => "にわか雨",
        85 | 86 => "にわか雪",
        95 => "雷雨",
        96 | 99 => "雹を伴う雷雨",
        _ => "曇り",
    }
}

pub fn compute_stargazing_score(
    cloud_pct: f64,
    precip_mm: f64,
    precip_prob: f64,
    wind_kmh: f64,
    temp_c: f64,
    dew_point_c: f64,
) -> u8 {
    let mut score = 100.0 - cloud_pct.clamp(0.0, 100.0) * 0.88;
    if precip_mm > 0.05 || precip_prob > 25.0 {
        score -= (precip_prob * 0.25 + precip_mm * 10.0).min(35.0);
    }
    if wind_kmh > 15.0 {
        score -= ((wind_kmh - 15.0) * 0.55).min(15.0);
    }
    let dew_spread = temp_c - dew_point_c;
    if dew_spread < 3.0 {
        score -= ((3.0 - dew_spread) * 3.0).clamp(0.0, 12.0);
    }
    score.round().clamp(0.0, 100.0) as u8
}

#[inline]
fn hourly_f64(opt: &Option<Vec<Option<f64>>>, idx: usize, default: f64) -> f64 {
    opt.as_ref()
        .and_then(|v| v.get(idx))
        .and_then(|v| *v)
        .unwrap_or(default)
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
        "https://api.open-meteo.com/v1/forecast?latitude={lat:.4}&longitude={lon:.4}&current=temperature_2m,apparent_temperature,relative_humidity_2m,cloud_cover,wind_speed_10m,wind_direction_10m,surface_pressure,weather_code,is_day&hourly=cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,temperature_2m,relative_humidity_2m,dew_point_2m,precipitation_probability,precipitation,visibility,wind_speed_10m,wind_direction_10m,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max&forecast_days=7&timezone=auto"
    );

    let (text, url) = fetch_whitelisted_text(&url_str, MAX_WEATHER_BYTES, offline_mode).await?;
    let parsed: OpenMeteoResp =
        serde_json::from_str(&text).map_err(|e| format!("Open-Meteo JSON解析失敗: {e}"))?;

    let current = parsed.current.map(|c| {
        let code = c.weather_code.unwrap_or(if c.cloud_cover.unwrap_or(50.0) < 25.0 { 0 } else { 2 });
        WeatherCurrent {
            temp_c: c.temperature_2m.unwrap_or(0.0),
            apparent_temp_c: c.apparent_temperature.unwrap_or(c.temperature_2m.unwrap_or(0.0)),
            humidity_pct: c.relative_humidity_2m.unwrap_or(0.0),
            cloud_cover_pct: c.cloud_cover.unwrap_or(0.0),
            wind_kmh: c.wind_speed_10m.unwrap_or(0.0),
            wind_dir_deg: c.wind_direction_10m.unwrap_or(0.0),
            pressure_hpa: c.surface_pressure.unwrap_or(1013.0),
            weather_code: code,
            weather_label_ja: wmo_code_to_ja(code).into(),
            is_day: c.is_day.unwrap_or(1) != 0,
        }
    });

    let all_count = parsed.hourly.time.len();
    let mut all_hours = Vec::with_capacity(all_count);
    for i in 0..all_count {
        let iso = &parsed.hourly.time[i];
        let label = iso.split('T').nth(1).unwrap_or(iso).to_owned();
        let cc = parsed.hourly.cloud_cover.get(i).and_then(|v| *v).unwrap_or(0.0);
        let low = hourly_f64(&parsed.hourly.cloud_cover_low, i, 0.0);
        let mid = hourly_f64(&parsed.hourly.cloud_cover_mid, i, 0.0);
        let high = hourly_f64(&parsed.hourly.cloud_cover_high, i, 0.0);
        let temp = hourly_f64(&parsed.hourly.temperature_2m, i, 0.0);
        let hum = hourly_f64(&parsed.hourly.relative_humidity_2m, i, 0.0);
        let dew = hourly_f64(&parsed.hourly.dew_point_2m, i, temp - 4.0);
        let precip_prob = hourly_f64(&parsed.hourly.precipitation_probability, i, 0.0);
        let precip_mm = hourly_f64(&parsed.hourly.precipitation, i, 0.0);
        let vis_km = (hourly_f64(&parsed.hourly.visibility, i, 24000.0) / 1000.0).max(0.0);
        let wind = hourly_f64(&parsed.hourly.wind_speed_10m, i, 0.0);
        let wind_dir = hourly_f64(&parsed.hourly.wind_direction_10m, i, 0.0);
        let code = parsed
            .hourly
            .weather_code
            .as_ref()
            .and_then(|v| v.get(i))
            .and_then(|v| *v)
            .unwrap_or(if cc < 20.0 { 0 } else if cc < 55.0 { 2 } else { 3 });
        let score = compute_stargazing_score(cc, precip_mm, precip_prob, wind, temp, dew);

        all_hours.push(WeatherHourPoint {
            time_iso: iso.clone(),
            label,
            cloud_cover_pct: cc,
            cloud_low_pct: low,
            cloud_mid_pct: mid,
            cloud_high_pct: high,
            temp_c: temp,
            humidity_pct: hum,
            wind_kmh: wind,
            weather_code: code,
            weather_label_ja: wmo_code_to_ja(code).into(),
            precip_prob_pct: precip_prob,
            precip_mm,
            dew_point_c: dew,
            visibility_km: vis_km,
            wind_dir_deg: wind_dir,
            stargazing_score: score,
        });
    }

    let hours: Vec<WeatherHourPoint> = all_hours.iter().take(48).cloned().collect();

    let night_samples: Vec<&WeatherHourPoint> = all_hours
        .iter()
        .take(36)
        .filter(|h| {
            let hr = h
                .label
                .split(':')
                .next()
                .and_then(|s| s.parse::<u8>().ok())
                .unwrap_or(12);
            hr >= 18 || hr <= 5
        })
        .collect();

    let avg = if night_samples.is_empty() {
        hours.iter().map(|h| h.cloud_cover_pct).sum::<f64>() / (hours.len().max(1) as f64)
    } else {
        night_samples.iter().map(|h| h.cloud_cover_pct).sum::<f64>() / (night_samples.len() as f64)
    };

    let tonight_stargazing_score = if night_samples.is_empty() {
        hours
            .first()
            .map(|h| h.stargazing_score)
            .unwrap_or(50)
    } else {
        let sum_s: u32 = night_samples.iter().map(|h| u32::from(h.stargazing_score)).sum();
        (sum_s / (night_samples.len() as u32)).min(100) as u8
    };

    // Find best contiguous night window with cloud cover <= 45% (or highest peak night hour)
    let mut best_window: Option<String> = None;
    let mut best_run_score: f64 = -1.0;
    let mut idx = 0usize;
    while idx < night_samples.len() {
        if night_samples[idx].cloud_cover_pct <= 45.0 {
            let start = idx;
            while idx + 1 < night_samples.len() && night_samples[idx + 1].cloud_cover_pct <= 45.0 {
                idx += 1;
            }
            let len = idx - start + 1;
            let avg_s = night_samples[start..=idx]
                .iter()
                .map(|h| f64::from(h.stargazing_score))
                .sum::<f64>()
                / (len as f64);
            let run_rank = avg_s + (len as f64) * 3.0;
            if run_rank > best_run_score {
                best_run_score = run_rank;
                let s_lbl = &night_samples[start].label;
                let e_lbl = &night_samples[idx].label;
                best_window = Some(if start == idx {
                    format!("{s_lbl} 頃 (平均スコア {:.0}点)", avg_s)
                } else {
                    format!("{s_lbl}〜{e_lbl} (平均スコア {:.0}点)", avg_s)
                });
            }
        }
        idx += 1;
    }

    let mut daily = Vec::new();
    if let Some(d) = parsed.daily {
        for i in 0..d.time.len().min(7) {
            let date_str = &d.time[i];
            let code = d
                .weather_code
                .as_ref()
                .and_then(|v| v.get(i))
                .and_then(|v| *v)
                .unwrap_or(2);
            let t_max = hourly_f64(&d.temperature_2m_max, i, 0.0);
            let t_min = hourly_f64(&d.temperature_2m_min, i, 0.0);
            let p_prob = hourly_f64(&d.precipitation_probability_max, i, 0.0);
            let p_sum = hourly_f64(&d.precipitation_sum, i, 0.0);
            let w_max = hourly_f64(&d.wind_speed_10m_max, i, 0.0);

            // Compute night cloud average around this day's evening..early morning
            let day_hrs: Vec<&WeatherHourPoint> = all_hours
                .iter()
                .filter(|h| h.time_iso.starts_with(date_str))
                .collect();
            let day_night: Vec<&WeatherHourPoint> = day_hrs
                .iter()
                .copied()
                .filter(|h| {
                    let hr = h.label.split(':').next().and_then(|s| s.parse::<u8>().ok()).unwrap_or(12);
                    hr >= 18 || hr <= 4
                })
                .collect();
            let used = if day_night.is_empty() { &day_hrs } else { &day_night };
            let n_cloud = if used.is_empty() {
                if code <= 1 { 15.0 } else if code == 2 { 45.0 } else { 80.0 }
            } else {
                used.iter().map(|h| h.cloud_cover_pct).sum::<f64>() / (used.len() as f64)
            };
            let n_score = if used.is_empty() {
                compute_stargazing_score(n_cloud, p_sum, p_prob, w_max, t_min, t_min - 3.0)
            } else {
                let s: u32 = used.iter().map(|h| u32::from(h.stargazing_score)).sum();
                (s / (used.len() as u32)).min(100) as u8
            };

            daily.push(WeatherDailyPoint {
                date: date_str.clone(),
                weather_code: code,
                weather_label_ja: wmo_code_to_ja(code).into(),
                temp_max_c: t_max,
                temp_min_c: t_min,
                precip_prob_max_pct: p_prob,
                precip_sum_mm: p_sum,
                wind_max_kmh: w_max,
                night_avg_cloud_pct: n_cloud,
                stargazing_score: n_score,
            });
        }
    }

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
        current,
        daily,
        tonight_stargazing_score,
        best_stargazing_window: best_window,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KpSample {
    pub time_tag: String,
    pub kp: f64,
    pub a_running: Option<f64>,
    pub station_count: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpaceWeatherSnapshot {
    pub source_url: String,
    pub current_kp: f64,
    pub max_kp_24h: f64,
    pub storm_level_ja: String,
    pub solar_wind_km_s: Option<f64>,
    pub bz_nt: Option<f64>,
    pub f107_flux: Option<f64>,
    pub geomagnetic_lat_deg: f64,
    pub aurora_visibility_pct: u8,
    pub aurora_summary_ja: String,
    pub kp_series: Vec<KpSample>,
}

/// Centered geomagnetic dipole latitude (°) from geographic `(lat_deg, lon_deg)`.
pub fn geomagnetic_dipole_lat_deg(lat_deg: f64, lon_deg: f64) -> f64 {
    let phi = lat_deg.to_radians();
    let lam = lon_deg.to_radians();
    // IGRF-13 north geomagnetic pole ≈ 80.7°N, -72.7°W
    let phi_p = 80.7_f64.to_radians();
    let lam_p = (-72.7_f64).to_radians();
    let sin_m = phi.sin() * phi_p.sin() + phi.cos() * phi_p.cos() * (lam - lam_p).cos();
    sin_m.clamp(-1.0, 1.0).asin().to_degrees()
}

/// Estimate aurora visibility likelihood (0..100%) from geomagnetic dipole latitude, Kp index, and IMF Bz.
pub fn compute_aurora_visibility(geomag_lat_deg: f64, kp: f64, bz_nt: Option<f64>) -> (u8, String) {
    let abs_lat = geomag_lat_deg.abs();
    let bz_boost = bz_nt
        .map(|b| if b < -4.0 { ((-b - 4.0) * 0.28).min(3.5) } else { 0.0 })
        .unwrap_or(0.0);
    // Equatorward aurora oval edge moves from ~67° at Kp=0 down toward ~44° during extreme G5 storms
    let equatoward_edge = (66.5 - (kp + bz_boost * 0.45) * 2.35).max(34.0);
    let diff = abs_lat - equatoward_edge;
    let pct = if diff >= 6.0 {
        95.0
    } else if diff >= 0.0 {
        55.0 + (diff / 6.0) * 40.0
    } else if diff >= -4.5 {
        ((diff + 4.5) / 4.5) * 52.0
    } else {
        0.0
    }
    .round()
    .clamp(0.0, 100.0) as u8;

    let summary = if pct >= 70 {
        "頭上〜北空でオーロラ観測の好機"
    } else if pct >= 35 {
        "北側の暗い地平線低空でオーロラ・低緯度光が期待可能"
    } else if pct >= 8 {
        "太陽活動が非常に活発な時のみ北低空に可能性"
    } else {
        "現在地（磁気緯度）でのオーロラ観測は困難"
    };
    (pct, summary.into())
}

/// Parse both NOAA SWPC `[[header], [row], ...]` and object-array `[{"time_tag":..., "Kp":...}]` JSON schemas.
pub fn parse_noaa_kp_json(raw: &str) -> Result<Vec<KpSample>, String> {
    let v: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| format!("NOAA Kp JSON解析失敗: {e}"))?;
    let arr = v
        .as_array()
        .ok_or_else(|| "NOAA Kp JSONが配列ではありません".to_owned())?;
    let mut samples = Vec::new();
    let as_f64 = |val: Option<&serde_json::Value>| -> Option<f64> {
        let val = val?;
        if let Some(n) = val.as_f64() {
            Some(n)
        } else {
            val.as_str().and_then(|s| s.trim().parse::<f64>().ok())
        }
    };
    let as_u32 = |val: Option<&serde_json::Value>| -> Option<u32> {
        let val = val?;
        if let Some(n) = val.as_u64() {
            Some(n as u32)
        } else {
            val.as_str().and_then(|s| s.trim().parse::<u32>().ok())
        }
    };

    for item in arr {
        if let Some(row) = item.as_array() {
            let tag = row.first().and_then(|x| x.as_str()).unwrap_or("");
            if tag.is_empty() || tag == "time_tag" {
                continue;
            }
            if let Some(kp) = as_f64(row.get(1)) {
                samples.push(KpSample {
                    time_tag: tag.to_owned(),
                    kp,
                    a_running: as_f64(row.get(2)),
                    station_count: as_u32(row.get(3)),
                });
            }
        } else if let Some(obj) = item.as_object() {
            let tag = obj.get("time_tag").and_then(|x| x.as_str()).unwrap_or("");
            if tag.is_empty() {
                continue;
            }
            if let Some(kp) = as_f64(obj.get("Kp").or_else(|| obj.get("kp_index"))) {
                samples.push(KpSample {
                    time_tag: tag.to_owned(),
                    kp,
                    a_running: as_f64(obj.get("a_running")),
                    station_count: as_u32(obj.get("station_count")),
                });
            }
        }
    }
    Ok(samples)
}

fn kp_storm_level_ja(kp: f64) -> &'static str {
    if kp >= 8.6 {
        "G5 極めて激しい磁気嵐"
    } else if kp >= 7.6 {
        "G4 激しい磁気嵐"
    } else if kp >= 6.6 {
        "G3 強い磁気嵐"
    } else if kp >= 5.6 {
        "G2 中程度の磁気嵐"
    } else if kp >= 4.6 {
        "G1 弱い磁気嵐"
    } else if kp >= 3.5 {
        "やや活発 (Unsettled)"
    } else {
        "静穏 (G0 Quiet)"
    }
}

fn parse_summary_number(raw: &str, keys: &[&str]) -> Option<f64> {
    let val: serde_json::Value = serde_json::from_str(raw).ok()?;
    let obj = val.as_object()?;
    for k in keys {
        if let Some(v) = obj.get(*k) {
            if let Some(n) = v.as_f64() {
                return Some(n);
            }
            if let Some(s) = v.as_str() {
                if let Ok(n) = s.trim().parse::<f64>() {
                    return Some(n);
                }
            }
        }
    }
    None
}

#[tauri::command]
pub async fn fetch_space_weather_cmd(
    offline_mode: bool,
    lat_deg: f64,
    lon_deg: f64,
) -> Result<SpaceWeatherSnapshot, String> {
    let kp_url = "https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json";
    let (kp_raw, final_url) =
        fetch_whitelisted_text(kp_url, MAX_SPACE_WEATHER_BYTES, offline_mode).await?;
    let mut series = parse_noaa_kp_json(&kp_raw)?;
    if series.len() > 24 {
        series = series.split_off(series.len() - 24);
    }

    let current_kp = series.last().map(|s| s.kp).unwrap_or(1.0);
    let tail_8 = series.iter().rev().take(8);
    let max_kp_24h = tail_8.map(|s| s.kp).fold(current_kp, f64::max);

    let solar_wind_km_s = fetch_whitelisted_text(
        "https://services.swpc.noaa.gov/products/summary/solar-wind-speed.json",
        64 * 1024,
        offline_mode,
    )
    .await
    .ok()
    .and_then(|(raw, _)| parse_summary_number(&raw, &["WindSpeed", "wind_speed"]));

    let bz_nt = fetch_whitelisted_text(
        "https://services.swpc.noaa.gov/products/summary/solar-wind-mag-field.json",
        64 * 1024,
        offline_mode,
    )
    .await
    .ok()
    .and_then(|(raw, _)| parse_summary_number(&raw, &["Bz", "bz"]));

    let f107_flux = fetch_whitelisted_text(
        "https://services.swpc.noaa.gov/products/summary/10cm-flux.json",
        64 * 1024,
        offline_mode,
    )
    .await
    .ok()
    .and_then(|(raw, _)| parse_summary_number(&raw, &["Flux", "flux"]));

    let geomagnetic_lat_deg = geomagnetic_dipole_lat_deg(lat_deg, lon_deg);
    let (aurora_visibility_pct, aurora_summary_ja) =
        compute_aurora_visibility(geomagnetic_lat_deg, max_kp_24h, bz_nt);

    Ok(SpaceWeatherSnapshot {
        source_url: final_url.to_string(),
        current_kp,
        max_kp_24h,
        storm_level_ja: kp_storm_level_ja(current_kp).into(),
        solar_wind_km_s,
        bz_nt,
        f107_flux,
        geomagnetic_lat_deg,
        aurora_visibility_pct,
        aurora_summary_ja,
        kp_series: series,
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
                "https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json"
            )
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

    #[test]
    fn weather_wmo_labels_and_stargazing_score_work() {
        assert_eq!(wmo_code_to_ja(0), "快晴");
        assert_eq!(wmo_code_to_ja(63), "雨");
        assert_eq!(wmo_code_to_ja(95), "雷雨");

        let ideal = compute_stargazing_score(5.0, 0.0, 0.0, 6.0, 12.0, 4.0);
        let cloudy_wet = compute_stargazing_score(92.0, 2.5, 85.0, 28.0, 8.0, 7.5);
        assert!(ideal >= 90);
        assert!(cloudy_wet <= 10);
    }

    #[test]
    fn noaa_kp_parsing_and_aurora_visibility_work() {
        let raw = r#"[
            ["time_tag", "Kp", "a_running", "station_count"],
            ["2026-11-26 09:00:00.000", "2.67", "12", "8"],
            ["2026-11-26 12:00:00.000", "5.33", "56", "8"]
        ]"#;
        let samples = parse_noaa_kp_json(raw).expect("parse kp");
        assert_eq!(samples.len(), 2);
        assert!((samples[1].kp - 5.33).abs() < 1e-6);

        let high_lat = geomagnetic_dipole_lat_deg(64.8, -147.7); // Fairbanks
        let low_lat = geomagnetic_dipole_lat_deg(34.6, 135.0);   // Akashi
        assert!(high_lat > 60.0);
        assert!(low_lat < 30.0);
        let (p_hi, _) = compute_aurora_visibility(high_lat, 4.0, Some(-6.0));
        let (p_lo, _) = compute_aurora_visibility(low_lat, 2.0, Some(1.0));
        assert!(p_hi >= 75);
        assert_eq!(p_lo, 0);
    }
}
