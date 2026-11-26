//! Tauri IPC commands for comet management (SQLite) and astronomical calculator (Phase 7).

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::calendar::format_local_hm;
use crate::engine::catalog::CatalogStore;
use crate::engine::comet::comet_ephemeris;
use crate::engine::comet_db::{CometDb, CometRecord, ObservationLogRecord};
use crate::engine::coords::{
    Equatorial, angular_distance_deg, apply_standard_refraction, equatorial_j2000_to_galactic,
    equatorial_to_ecliptic, equatorial_to_horizontal, wrap_deg_180, wrap_deg_360,
};
use crate::engine::ephemeris::{
    Planet, geocentric_to_topocentric, planet_ephemeris, sun_ephemeris,
};
use crate::engine::precession::{
    B1950_JD, J2000_JD, OBLIQUITY_J2000_DEG, apply_nutation_to_equatorial, b1950_to_j2000,
    j2000_to_b1950, nutation, precess_between_epochs, precess_j2000_to_date,
};
use crate::engine::rise_set::{
    ObserverLocation, altitude_crossing_times, equatorial_j2000_rise_set, planet_rise_set,
};
use crate::engine::satellite::{
    SatellitePass, SatelliteSkyPos, parse_tle_text, predict_satellite_passes,
    propagate_satellite_at,
};
use crate::engine::time::{
    calendar_to_jd, delta_t_seconds, equation_of_time_min, gast_deg, gmst_deg, jd_to_mjd,
    jd_to_ymd_hms, last_deg, lst_deg, mjd_to_jd, ut_to_tt_jd, ymd_hms_to_jd,
};

fn format_hms_angle(deg: f64, signed: bool) -> String {
    let wrapped = if signed {
        wrap_deg_180(deg)
    } else {
        wrap_deg_360(deg)
    };
    let sign = if signed {
        if wrapped < 0.0 { "-" } else { "+" }
    } else {
        ""
    };
    let total_sec = (wrapped.abs() / 15.0) * 3600.0;
    let h = (total_sec / 3600.0).floor() as u32;
    let rem = total_sec - f64::from(h) * 3600.0;
    let m = (rem / 60.0).floor() as u32;
    let s = rem - f64::from(m) * 60.0;
    format!("{sign}{h:02}h {m:02}m {s:05.2}s")
}

fn format_dms_angle(deg: f64, signed: bool) -> String {
    let sign = if signed {
        if deg < 0.0 { "-" } else { "+" }
    } else {
        ""
    };
    let total_arcsec = deg.abs() * 3600.0;
    let d = (total_arcsec / 3600.0).floor() as u32;
    let rem = total_arcsec - f64::from(d) * 3600.0;
    let m = (rem / 60.0).floor() as u32;
    let s = rem - f64::from(m) * 60.0;
    format!("{sign}{d:02}° {m:02}' {s:05.2}\"")
}

fn format_utc_datetime(jd_ut: f64) -> String {
    let (y, m, d, hh, mm, ss) = jd_to_ymd_hms(jd_ut);
    let mut s_round = ss.round() as i32;
    let mut min = i32::from(mm);
    let mut hr = i32::from(hh);
    if s_round >= 60 {
        s_round -= 60;
        min += 1;
    }
    if min >= 60 {
        min -= 60;
        hr += 1;
    }
    if hr >= 24 {
        let (y2, m2, d2, hh2, mm2, ss2) = jd_to_ymd_hms(jd_ut + 0.5 / 86400.0);
        return format!("{y2:04}-{m2:02}-{d2:02} {hh2:02}:{mm2:02}:{:02}", ss2.floor() as u32);
    }
    format!("{y:04}-{m:02}-{d:02} {hr:02}:{min:02}:{s_round:02}")
}

fn format_local_datetime_sec(jd_ut: f64, tz_offset_min: i32) -> String {
    format_utc_datetime(jd_ut + f64::from(tz_offset_min) / 1440.0)
}

fn weekday_ja_for_jd(local_jd: f64) -> String {
    let day_num = (local_jd + 0.5).floor() as i64;
    let idx = day_num.rem_euclid(7) as usize;
    const DAYS: [&str; 7] = [
        "月曜日",
        "火曜日",
        "水曜日",
        "木曜日",
        "金曜日",
        "土曜日",
        "日曜日",
    ];
    DAYS[idx].to_owned()
}

// =========================================================================
// 1. Comet SQLite CRUD & Import/Export Commands
// =========================================================================

#[derive(Debug, Clone, Deserialize)]
pub struct CometListRequest {
    pub jd_ut: f64,
    pub lat_deg: f64,
    pub lon_deg: f64,
    pub alt_m: f64,
    pub refraction: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct CometWithEphemeris {
    pub record: CometRecord,
    pub ra_deg: f64,
    pub dec_deg: f64,
    pub az_deg: f64,
    pub alt_deg: f64,
    pub helio_au: f64,
    pub geo_au: f64,
    pub visual_magnitude: f64,
    pub elongation_deg: f64,
    pub phase_angle_deg: f64,
    pub perihelion_date_str: String,
    pub orbit_type_ja: String,
}

#[derive(Debug, Deserialize)]
struct CometExportBundle {
    #[allow(dead_code)]
    format: Option<String>,
    comets: Vec<CometRecord>,
}

#[derive(Debug, Serialize)]
struct CometExportBundleOut {
    format: String,
    comets: Vec<CometRecord>,
}

fn orbit_type_label(q_au: f64, e: f64) -> String {
    if (e - 1.0).abs() <= 1e-4 {
        "放物線軌道".into()
    } else if e < 1.0 {
        let a = q_au / (1.0 - e).max(1e-6);
        let period_y = a.powf(1.5);
        format!("楕円軌道 (周期 約{period_y:.1}年)")
    } else {
        "双曲線軌道".into()
    }
}

pub fn list_comets_impl(
    req: &CometListRequest,
    db: &CometDb,
) -> Result<Vec<CometWithEphemeris>, String> {
    let records = db.list_all()?;
    let jd_tt = ut_to_tt_jd(req.jd_ut);
    let last = last_deg(req.jd_ut, req.lon_deg);

    let mut out = Vec::with_capacity(records.len());
    for rec in records {
        let el = rec.to_elements();
        let eph = comet_ephemeris(&el, jd_tt);
        let topo = geocentric_to_topocentric(
            eph.eq_apparent,
            eph.geo_au,
            req.lat_deg,
            req.alt_m,
            last,
        );
        let mut hor = equatorial_to_horizontal(topo, req.lat_deg, last);
        if req.refraction {
            hor.alt_deg = apply_standard_refraction(hor.alt_deg);
        }
        let (py, pm, pd, ph, pmin, _) = jd_to_ymd_hms(rec.epoch_perihelion_jd);
        let peri_str = format!("{py:04}-{pm:02}-{pd:02} {ph:02}:{pmin:02} UTC");
        let orbit_type_ja = orbit_type_label(rec.perihelion_dist_au, rec.eccentricity);
        out.push(CometWithEphemeris {
            record: rec,
            ra_deg: eph.eq_apparent.ra_deg,
            dec_deg: eph.eq_apparent.dec_deg,
            az_deg: hor.az_deg,
            alt_deg: hor.alt_deg,
            helio_au: eph.helio_au,
            geo_au: eph.geo_au,
            visual_magnitude: eph.visual_magnitude,
            elongation_deg: eph.elongation_deg,
            phase_angle_deg: eph.phase_angle_deg,
            perihelion_date_str: peri_str,
            orbit_type_ja,
        });
    }
    Ok(out)
}

#[tauri::command]
pub fn list_comets_cmd(
    req: CometListRequest,
    db: State<'_, CometDb>,
) -> Result<Vec<CometWithEphemeris>, String> {
    list_comets_impl(&req, &db)
}

#[tauri::command]
pub fn upsert_comet_cmd(
    record: CometRecord,
    db: State<'_, CometDb>,
) -> Result<CometRecord, String> {
    db.upsert(record)
}

#[tauri::command]
pub fn set_comet_enabled_cmd(
    id: String,
    enabled: bool,
    db: State<'_, CometDb>,
) -> Result<(), String> {
    db.set_enabled(&id, enabled)
}

#[tauri::command]
pub fn delete_comet_cmd(id: String, db: State<'_, CometDb>) -> Result<bool, String> {
    db.delete(&id)
}

pub fn import_comets_json_impl(
    json_text: &str,
    replace_all: bool,
    db: &CometDb,
) -> Result<usize, String> {
    let trimmed = json_text.trim();
    if trimmed.is_empty() {
        return Err("JSONデータが空です".into());
    }
    let records: Vec<CometRecord> = if trimmed.starts_with('[') {
        serde_json::from_str(trimmed)
            .map_err(|e| format!("JSON配列の解析に失敗しました: {e}"))?
    } else {
        let bundle: CometExportBundle = serde_json::from_str(trimmed)
            .map_err(|e| format!("JSONオブジェクトの解析に失敗しました: {e}"))?;
        bundle.comets
    };
    if records.is_empty() {
        return Err("インポートする彗星レコードが含まれていません".into());
    }
    db.import_records(records, replace_all)
}

#[tauri::command]
pub fn import_comets_json_cmd(
    json_text: String,
    replace_all: bool,
    db: State<'_, CometDb>,
) -> Result<usize, String> {
    import_comets_json_impl(&json_text, replace_all, &db)
}

pub fn export_comets_json_impl(db: &CometDb) -> Result<String, String> {
    let comets = db.list_all()?;
    let bundle = CometExportBundleOut {
        format: "starcrane-comets-v1".into(),
        comets,
    };
    serde_json::to_string_pretty(&bundle).map_err(|e| format!("JSON出力に失敗しました: {e}"))
}

#[tauri::command]
pub fn export_comets_json_cmd(db: State<'_, CometDb>) -> Result<String, String> {
    export_comets_json_impl(&db)
}

#[tauri::command]
pub fn reset_default_comets_cmd(
    replace_all: bool,
    db: State<'_, CometDb>,
) -> Result<usize, String> {
    db.restore_defaults(replace_all)
}

// =========================================================================
// 2. Astronomical Calculator Commands (All 9 Functions)
// =========================================================================

#[derive(Debug, Clone, Deserialize)]
pub struct CalcJdRequest {
    pub mode: String, // "from_calendar" | "from_jd" | "from_mjd"
    pub year: i32,
    pub month: u8,
    pub day: u8,
    pub hour: u8,
    pub minute: u8,
    pub second: f64,
    pub tz_offset_min: i32,
    pub jd_ut: f64,
    pub mjd_ut: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct CalcJdResult {
    pub jd_ut: f64,
    pub mjd_ut: f64,
    pub jd_tt: f64,
    pub delta_t_sec: f64,
    pub utc_str: String,
    pub local_str: String,
    pub weekday_ja: String,
    pub julian_centuries_j2000: f64,
    pub equation_of_time_min: f64,
}

pub fn calc_julian_day_impl(req: &CalcJdRequest) -> CalcJdResult {
    let jd_ut = match req.mode.trim().to_ascii_lowercase().as_str() {
        "from_jd" => req.jd_ut,
        "from_mjd" => mjd_to_jd(req.mjd_ut),
        _ => {
            let local_jd = ymd_hms_to_jd(
                req.year,
                req.month.clamp(1, 12),
                req.day.clamp(1, 31),
                req.hour.min(23),
                req.minute.min(59),
                req.second.clamp(0.0, 59.999),
            );
            local_jd - f64::from(req.tz_offset_min) / 1440.0
        }
    };

    let mjd_ut = jd_to_mjd(jd_ut);
    let jd_tt = ut_to_tt_jd(jd_ut);
    let dec_year = 2000.0 + (jd_ut - J2000_JD) / 365.25;
    let delta_t_sec = delta_t_seconds(dec_year);
    let local_jd = jd_ut + f64::from(req.tz_offset_min) / 1440.0;

    CalcJdResult {
        jd_ut,
        mjd_ut,
        jd_tt,
        delta_t_sec,
        utc_str: format_utc_datetime(jd_ut),
        local_str: format_local_datetime_sec(jd_ut, req.tz_offset_min),
        weekday_ja: weekday_ja_for_jd(local_jd),
        julian_centuries_j2000: (jd_tt - J2000_JD) / 36525.0,
        equation_of_time_min: equation_of_time_min(jd_tt),
    }
}

#[tauri::command]
pub fn calc_julian_day_cmd(req: CalcJdRequest) -> CalcJdResult {
    calc_julian_day_impl(&req)
}

#[derive(Debug, Clone, Deserialize)]
pub struct CalcSiderealRequest {
    pub jd_ut: f64,
    pub lon_deg: f64,
    pub ra_deg: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct CalcSiderealResult {
    pub gmst_deg: f64,
    pub gmst_hms: String,
    pub gast_deg: f64,
    pub gast_hms: String,
    pub lst_deg: f64,
    pub lst_hms: String,
    pub last_deg: f64,
    pub last_hms: String,
    pub hour_angle_deg: f64,
    pub hour_angle_hms: String,
    pub hours_to_transit: f64,
}

pub fn calc_sidereal_ha_impl(req: &CalcSiderealRequest) -> CalcSiderealResult {
    let gmst = gmst_deg(req.jd_ut);
    let gast = gast_deg(req.jd_ut);
    let lst = lst_deg(req.jd_ut, req.lon_deg);
    let last = last_deg(req.jd_ut, req.lon_deg);
    let ha_signed = wrap_deg_180(last - req.ra_deg);
    // Sidereal day / solar day = 1.00273790935
    let hours_to_transit = -ha_signed / (15.0 * 1.002_737_909_35);

    CalcSiderealResult {
        gmst_deg: gmst,
        gmst_hms: format_hms_angle(gmst, false),
        gast_deg: gast,
        gast_hms: format_hms_angle(gast, false),
        lst_deg: lst,
        lst_hms: format_hms_angle(lst, false),
        last_deg: last,
        last_hms: format_hms_angle(last, false),
        hour_angle_deg: ha_signed,
        hour_angle_hms: format_hms_angle(ha_signed, true),
        hours_to_transit,
    }
}

#[tauri::command]
pub fn calc_sidereal_ha_cmd(req: CalcSiderealRequest) -> CalcSiderealResult {
    calc_sidereal_ha_impl(&req)
}

#[derive(Debug, Clone, Deserialize)]
pub struct CalcElapsedRequest {
    pub jd_start_ut: f64,
    pub jd_end_ut: f64,
    pub offset_days: f64,
    pub tz_offset_min: i32,
}

#[derive(Debug, Clone, Serialize)]
pub struct CalcElapsedResult {
    pub diff_days: f64,
    pub diff_hours: f64,
    pub diff_minutes: f64,
    pub diff_seconds: f64,
    pub diff_julian_years: f64,
    pub diff_weeks: f64,
    pub diff_sidereal_hours: f64,
    pub breakdown_text: String,
    pub shifted_jd_ut: f64,
    pub shifted_local_str: String,
    pub shifted_utc_str: String,
}

pub fn calc_elapsed_time_impl(req: &CalcElapsedRequest) -> CalcElapsedResult {
    let diff_days = req.jd_end_ut - req.jd_start_ut;
    let diff_hours = diff_days * 24.0;
    let diff_minutes = diff_days * 1440.0;
    let diff_seconds = diff_days * 86400.0;

    let sign = if diff_days < 0.0 { "-" } else { "+" };
    let abs_sec = diff_seconds.abs();
    let d = (abs_sec / 86400.0).floor() as i64;
    let rem1 = abs_sec - (d as f64) * 86400.0;
    let h = (rem1 / 3600.0).floor() as i64;
    let rem2 = rem1 - (h as f64) * 3600.0;
    let m = (rem2 / 60.0).floor() as i64;
    let s = rem2 - (m as f64) * 60.0;
    let breakdown_text = format!("{sign}{d}日 {h:02}時間 {m:02}分 {s:04.1}秒");

    let shifted_jd_ut = req.jd_start_ut + req.offset_days;
    CalcElapsedResult {
        diff_days,
        diff_hours,
        diff_minutes,
        diff_seconds,
        diff_julian_years: diff_days / 365.25,
        diff_weeks: diff_days / 7.0,
        diff_sidereal_hours: diff_hours * 1.002_737_909_35,
        breakdown_text,
        shifted_jd_ut,
        shifted_local_str: format_local_datetime_sec(shifted_jd_ut, req.tz_offset_min),
        shifted_utc_str: format_utc_datetime(shifted_jd_ut),
    }
}

#[tauri::command]
pub fn calc_elapsed_time_cmd(req: CalcElapsedRequest) -> CalcElapsedResult {
    calc_elapsed_time_impl(&req)
}

#[derive(Debug, Clone, Deserialize)]
pub struct CalcAngDistRequest {
    pub ra1_deg: f64,
    pub dec1_deg: f64,
    pub ra2_deg: f64,
    pub dec2_deg: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct CalcAngDistResult {
    pub distance_deg: f64,
    pub distance_arcmin: f64,
    pub distance_arcsec: f64,
    pub distance_dms: String,
    pub position_angle_deg: f64,
}

pub fn calc_angular_distance_impl(req: &CalcAngDistRequest) -> CalcAngDistResult {
    let eq1 = Equatorial {
        ra_deg: req.ra1_deg,
        dec_deg: req.dec1_deg,
    };
    let eq2 = Equatorial {
        ra_deg: req.ra2_deg,
        dec_deg: req.dec2_deg,
    };
    let distance_deg = angular_distance_deg(eq1, eq2);

    let a1 = req.ra1_deg.to_radians();
    let d1 = req.dec1_deg.to_radians();
    let a2 = req.ra2_deg.to_radians();
    let d2 = req.dec2_deg.to_radians();
    let y = d2.cos() * (a2 - a1).sin();
    let x = d1.cos() * d2.sin() - d1.sin() * d2.cos() * (a2 - a1).cos();
    let position_angle_deg = wrap_deg_360(y.atan2(x).to_degrees());

    CalcAngDistResult {
        distance_deg,
        distance_arcmin: distance_deg * 60.0,
        distance_arcsec: distance_deg * 3600.0,
        distance_dms: format_dms_angle(distance_deg, false),
        position_angle_deg,
    }
}

#[tauri::command]
pub fn calc_angular_distance_cmd(req: CalcAngDistRequest) -> CalcAngDistResult {
    calc_angular_distance_impl(&req)
}

#[derive(Debug, Clone, Deserialize)]
pub struct CalcAltTimeRequest {
    pub ra_j2000_deg: f64,
    pub dec_j2000_deg: f64,
    pub target_alt_deg: f64,
    pub lat_deg: f64,
    pub lon_deg: f64,
    pub alt_m: f64,
    pub tz_offset_min: i32,
    pub year: i32,
    pub month: u8,
    pub day: u8,
}

#[derive(Debug, Clone, Serialize)]
pub struct CalcAltTimeResult {
    pub rising_jd_ut: Option<f64>,
    pub rising_local_str: Option<String>,
    pub setting_jd_ut: Option<f64>,
    pub setting_local_str: Option<String>,
    pub transit_jd_ut: Option<f64>,
    pub transit_local_str: Option<String>,
    pub max_alt_deg: f64,
    pub min_alt_deg: f64,
    pub status_ja: String,
}

pub fn calc_altitude_times_impl(req: &CalcAltTimeRequest) -> CalcAltTimeResult {
    let eq_j2000 = Equatorial {
        ra_deg: req.ra_j2000_deg,
        dec_deg: req.dec_j2000_deg,
    };
    let loc = ObserverLocation {
        lat_deg: req.lat_deg,
        lon_deg: req.lon_deg,
        alt_m: req.alt_m,
        tz_offset_min: req.tz_offset_min,
    };
    let rs = equatorial_j2000_rise_set(eq_j2000, &loc, req.year, req.month, req.day);
    let (rising, setting) = altitude_crossing_times(
        eq_j2000,
        req.target_alt_deg,
        &loc,
        req.year,
        req.month,
        req.day,
    );

    let max_app = apply_standard_refraction(rs.max_alt_deg);
    let min_app = apply_standard_refraction(rs.min_alt_deg);

    let status_ja = if rising.is_some() || setting.is_some() {
        "到達あり".into()
    } else if min_app >= req.target_alt_deg {
        "一日中指定高度以上".into()
    } else {
        "指定高度に到達しない".into()
    };

    CalcAltTimeResult {
        rising_jd_ut: rising,
        rising_local_str: format_local_hm(rising, req.tz_offset_min),
        setting_jd_ut: setting,
        setting_local_str: format_local_hm(setting, req.tz_offset_min),
        transit_jd_ut: rs.transit_jd_ut,
        transit_local_str: format_local_hm(rs.transit_jd_ut, req.tz_offset_min),
        max_alt_deg: max_app,
        min_alt_deg: min_app,
        status_ja,
    }
}

#[tauri::command]
pub fn calc_altitude_times_cmd(req: CalcAltTimeRequest) -> CalcAltTimeResult {
    calc_altitude_times_impl(&req)
}

#[derive(Debug, Clone, Deserialize)]
pub struct CalcEpochConvertRequest {
    pub ra_deg: f64,
    pub dec_deg: f64,
    pub mode: String, // "b1950_to_j2000" | "j2000_to_b1950" | "custom"
    pub from_epoch_year: Option<f64>,
    pub to_epoch_year: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CalcEpochConvertResult {
    pub out_ra_deg: f64,
    pub out_dec_deg: f64,
    pub out_ra_hms: String,
    pub out_dec_dms: String,
    pub delta_ra_arcsec: f64,
    pub delta_dec_arcsec: f64,
    pub ecl_lon_deg: f64,
    pub ecl_lat_deg: f64,
    pub gal_l_deg: f64,
    pub gal_b_deg: f64,
}

fn epoch_year_to_jd(year: f64) -> f64 {
    if (year - 1950.0).abs() < 1e-6 {
        B1950_JD
    } else if (year - 2000.0).abs() < 1e-6 {
        J2000_JD
    } else {
        J2000_JD + (year - 2000.0) * 365.25
    }
}

pub fn calc_epoch_convert_impl(req: &CalcEpochConvertRequest) -> CalcEpochConvertResult {
    let input = Equatorial {
        ra_deg: wrap_deg_360(req.ra_deg),
        dec_deg: req.dec_deg.clamp(-89.999_9, 89.999_9),
    };
    let (converted, j2000_eq) = match req.mode.trim().to_ascii_lowercase().as_str() {
        "b1950_to_j2000" => {
            let out = b1950_to_j2000(input);
            (out, out)
        }
        "j2000_to_b1950" => {
            let out = j2000_to_b1950(input);
            (out, input)
        }
        _ => {
            let from_jd = epoch_year_to_jd(req.from_epoch_year.unwrap_or(2000.0));
            let to_jd = epoch_year_to_jd(req.to_epoch_year.unwrap_or(2050.0));
            let out = precess_between_epochs(input, from_jd, to_jd);
            let j2k = precess_between_epochs(input, from_jd, J2000_JD);
            (out, j2k)
        }
    };

    let ecl = equatorial_to_ecliptic(j2000_eq, OBLIQUITY_J2000_DEG);
    let gal = equatorial_j2000_to_galactic(j2000_eq);

    CalcEpochConvertResult {
        out_ra_deg: converted.ra_deg,
        out_dec_deg: converted.dec_deg,
        out_ra_hms: format_hms_angle(converted.ra_deg, false),
        out_dec_dms: format_dms_angle(converted.dec_deg, true),
        delta_ra_arcsec: wrap_deg_180(converted.ra_deg - input.ra_deg) * 3600.0,
        delta_dec_arcsec: (converted.dec_deg - input.dec_deg) * 3600.0,
        ecl_lon_deg: ecl.lon_deg,
        ecl_lat_deg: ecl.lat_deg,
        gal_l_deg: gal.l_deg,
        gal_b_deg: gal.b_deg,
    }
}

#[tauri::command]
pub fn calc_epoch_convert_cmd(req: CalcEpochConvertRequest) -> CalcEpochConvertResult {
    calc_epoch_convert_impl(&req)
}

// =========================================================================
// 3. Artificial Satellite & ISS SGP4 Commands (Phase 8)
// =========================================================================

#[derive(Debug, Clone, Deserialize)]
pub struct SatListRequest {
    pub jd_ut: f64,
    pub lat_deg: f64,
    pub lon_deg: f64,
    pub alt_m: f64,
    pub tz_offset_min: i32,
    pub refraction: bool,
}

#[tauri::command]
pub fn list_satellites_positions_cmd(
    req: SatListRequest,
    db: State<'_, CometDb>,
) -> Result<Vec<SatelliteSkyPos>, String> {
    let sats = db.list_satellites()?;
    let loc = ObserverLocation {
        lat_deg: req.lat_deg,
        lon_deg: req.lon_deg,
        alt_m: req.alt_m,
        tz_offset_min: req.tz_offset_min,
    };
    let mut out = Vec::with_capacity(sats.len());
    for s in sats {
        if let Ok(pos) = propagate_satellite_at(&s, req.jd_ut, &loc, req.refraction) {
            out.push(pos);
        }
    }
    out.sort_by(|a, b| {
        b.enabled
            .cmp(&a.enabled)
            .then_with(|| b.alt_deg.total_cmp(&a.alt_deg))
    });
    Ok(out)
}

#[derive(Debug, Clone, Deserialize)]
pub struct SatPassRequest {
    pub sat_id: String,
    pub start_jd_ut: f64,
    pub hours: f64,
    pub min_max_alt_deg: f64,
    pub visible_only: bool,
    pub lat_deg: f64,
    pub lon_deg: f64,
    pub alt_m: f64,
    pub tz_offset_min: i32,
}

#[tauri::command]
pub fn predict_satellite_passes_cmd(
    req: SatPassRequest,
    db: State<'_, CometDb>,
) -> Result<Vec<SatellitePass>, String> {
    let sats = db.list_satellites()?;
    let target = sats
        .into_iter()
        .find(|s| s.id.eq_ignore_ascii_case(&req.sat_id))
        .ok_or_else(|| format!("衛星ID {} が見つかりません", req.sat_id))?;
    let loc = ObserverLocation {
        lat_deg: req.lat_deg,
        lon_deg: req.lon_deg,
        alt_m: req.alt_m,
        tz_offset_min: req.tz_offset_min,
    };
    predict_satellite_passes(
        &target,
        req.start_jd_ut,
        req.hours,
        req.min_max_alt_deg,
        req.visible_only,
        &loc,
    )
}

#[tauri::command]
pub fn import_tle_text_cmd(
    tle_text: String,
    category: String,
    db: State<'_, CometDb>,
) -> Result<usize, String> {
    let cat = if category.trim().is_empty() {
        "custom"
    } else {
        category.trim()
    };
    let recs = parse_tle_text(&tle_text, cat);
    if recs.is_empty() {
        return Err("有効なTLEデータ（2行または3行形式）が見つかりませんでした".into());
    }
    db.upsert_satellites_batch(recs, None)
}

#[tauri::command]
pub fn set_satellite_enabled_cmd(
    id: String,
    enabled: bool,
    db: State<'_, CometDb>,
) -> Result<(), String> {
    db.set_satellite_enabled(&id, enabled)
}

#[tauri::command]
pub fn delete_satellite_cmd(id: String, db: State<'_, CometDb>) -> Result<bool, String> {
    db.delete_satellite(&id)
}

#[tauri::command]
pub fn reset_default_satellites_cmd(db: State<'_, CometDb>) -> Result<usize, String> {
    db.restore_default_satellites()
}

#[derive(Debug, Clone, Serialize)]
pub struct IssTrackSample {
    pub jd_ut: f64,
    pub lat_deg: f64,
    pub lon_deg: f64,
    pub altitude_km: f64,
    pub velocity_km_s: f64,
    pub is_sunlit: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct IssEarthViewData {
    pub jd_ut: f64,
    pub name: String,
    pub norad_id: u32,
    pub current: SatelliteSkyPos,
    pub subsolar_lat_deg: f64,
    pub subsolar_lon_deg: f64,
    pub epoch_age_days: f64,
    pub track: Vec<IssTrackSample>,
}

pub fn get_iss_earth_view_impl(
    req: &SatListRequest,
    db: &CometDb,
) -> Result<IssEarthViewData, String> {
    let sats = db.list_satellites()?;
    let iss = sats
        .iter()
        .find(|s| s.norad_id == 25544 || s.name.to_ascii_uppercase().contains("ISS"))
        .or_else(|| sats.first())
        .cloned()
        .ok_or_else(|| "ISS のTLEデータが見つかりません".to_owned())?;

    let loc = ObserverLocation {
        lat_deg: req.lat_deg,
        lon_deg: req.lon_deg,
        alt_m: req.alt_m,
        tz_offset_min: req.tz_offset_min,
    };

    let current = propagate_satellite_at(&iss, req.jd_ut, &loc, req.refraction)?;
    let sun = sun_ephemeris(ut_to_tt_jd(req.jd_ut));
    let subsolar_lat_deg = sun.eq_apparent.dec_deg;
    let subsolar_lon_deg = wrap_deg_180(sun.eq_apparent.ra_deg - gast_deg(req.jd_ut));

    let sample_count = 97usize;
    let mut track = Vec::with_capacity(sample_count);
    for i in 0..sample_count {
        let offset_min = -15.0 + (i as f64 / (sample_count - 1) as f64) * 110.0;
        let t_jd = req.jd_ut + offset_min / 1440.0;
        if let Ok(sample) = propagate_satellite_at(&iss, t_jd, &loc, false) {
            track.push(IssTrackSample {
                jd_ut: t_jd,
                lat_deg: sample.subpoint_lat_deg,
                lon_deg: sample.subpoint_lon_deg,
                altitude_km: sample.altitude_km,
                velocity_km_s: sample.velocity_km_s,
                is_sunlit: sample.is_sunlit,
            });
        }
    }

    Ok(IssEarthViewData {
        jd_ut: req.jd_ut,
        name: iss.name,
        norad_id: iss.norad_id,
        epoch_age_days: current.epoch_age_days,
        current,
        subsolar_lat_deg,
        subsolar_lon_deg,
        track,
    })
}

#[tauri::command]
pub fn get_iss_earth_view_cmd(
    req: SatListRequest,
    db: State<'_, CometDb>,
) -> Result<IssEarthViewData, String> {
    get_iss_earth_view_impl(&req, &db)
}

// =========================================================================
// 4. Tonight's Best Objects Guide, Observation Logbook & Polar Alignment
// =========================================================================

#[derive(Debug, Clone, Deserialize)]
pub struct TonightBestRequest {
    pub jd_ut: f64,
    pub lat_deg: f64,
    pub lon_deg: f64,
    pub alt_m: f64,
    pub tz_offset_min: i32,
    pub gear: String, // "naked_eye" | "binoculars" | "telescope"
}

#[derive(Debug, Clone, Serialize)]
pub struct TonightBestObject {
    pub id: String,
    pub name_ja: String,
    pub name_en: String,
    pub kind: String,
    pub constellation: Option<String>,
    pub mag: f64,
    pub ra_deg: f64,
    pub dec_deg: f64,
    pub az_deg: f64,
    pub alt_deg: f64,
    pub max_alt_deg: f64,
    pub transit_str: Option<String>,
    pub score: u8,
    pub reason_ja: String,
    pub recommended_gear: String,
}

pub fn get_tonight_best_objects_impl(
    req: &TonightBestRequest,
    store: &CatalogStore,
) -> Vec<TonightBestObject> {
    let loc = ObserverLocation {
        lat_deg: req.lat_deg,
        lon_deg: req.lon_deg,
        alt_m: req.alt_m,
        tz_offset_min: req.tz_offset_min,
    };
    let local_ms = (req.jd_ut - 2_440_587.5) * 86_400_000.0 + f64::from(req.tz_offset_min) * 60_000.0;
    let approx_utc_jd = 2_440_587.5 + local_ms / 86_400_000.0;
    let (year, month, day, _, _, _) = jd_to_ymd_hms(approx_utc_jd);

    let jd_tt = ut_to_tt_jd(req.jd_ut);
    let lst = last_deg(req.jd_ut, req.lon_deg);
    let nut = nutation(jd_tt);

    let sun_eph = sun_ephemeris(jd_tt);
    let sun_hor = equatorial_to_horizontal(sun_eph.eq_apparent, req.lat_deg, lst);
    // If querying during daytime, preview positions as of local 21:00 evening for tonight's planning
    let eval_jd = if sun_hor.alt_deg > -6.0 {
        calendar_to_jd(year, month, f64::from(day)) + (21.0 / 24.0) - f64::from(req.tz_offset_min) / 1440.0
    } else {
        req.jd_ut
    };
    let eval_tt = ut_to_tt_jd(eval_jd);
    let eval_lst = last_deg(eval_jd, req.lon_deg);
    let eval_nut = nutation(eval_tt);

    let gear = req.gear.as_str();
    let mag_cutoff: f64 = match gear {
        "naked_eye" => 4.2,
        "binoculars" => 7.6,
        _ => 11.2,
    };

    let mut items: Vec<TonightBestObject> = Vec::with_capacity(64);

    // 1. Bright Planets (skip Venus/Mercury if too low? Still include if max_alt > 8°)
    for p in Planet::ALL {
        let eph = planet_ephemeris(p, eval_tt);
        let rs = planet_rise_set(p, &loc, year, month, day);
        let topo = geocentric_to_topocentric(eph.eq_apparent, eph.geo_au, loc.lat_deg, loc.alt_m, eval_lst);
        let hor = equatorial_to_horizontal(topo, loc.lat_deg, eval_lst);
        if rs.max_alt_deg < 10.0 || eph.elongation_deg < 12.0 {
            continue;
        }
        let alt_use = hor.alt_deg.max(rs.max_alt_deg * 0.65);
        let mut score = 58.0 + (alt_use.clamp(0.0, 80.0) * 0.45) - eph.visual_magnitude * 3.5;
        if gear == "telescope" && matches!(p, Planet::Jupiter | Planet::Saturn | Planet::Mars) {
            score += 12.0;
        }
        if hor.alt_deg < 5.0 {
            score -= 18.0;
        }
        let reason = match p {
            Planet::Jupiter => "縞模様と4大ガリレオ衛星が見頃",
            Planet::Saturn => "土星の環とタイタンを観察する絶好機",
            Planet::Venus => "圧倒的な輝き（宵/明けの明星）",
            Planet::Mars => "赤く輝く火星・表面模様に注目",
            _ => "高倍率望遠鏡で狙う外惑星",
        };
        items.push(TonightBestObject {
            id: format!("{p:?}").to_lowercase(),
            name_ja: p.name_ja().into(),
            name_en: format!("{p:?}"),
            kind: "planet".into(),
            constellation: None,
            mag: eph.visual_magnitude,
            ra_deg: eph.eq_j2000.ra_deg,
            dec_deg: eph.eq_j2000.dec_deg,
            az_deg: hor.az_deg,
            alt_deg: hor.alt_deg,
            max_alt_deg: rs.max_alt_deg,
            transit_str: format_local_hm(rs.transit_jd_ut, req.tz_offset_min),
            score: score.round().clamp(10.0, 100.0) as u8,
            reason_ja: reason.into(),
            recommended_gear: if matches!(p, Planet::Uranus | Planet::Neptune) {
                "双眼鏡〜望遠鏡".into()
            } else {
                "肉眼〜望遠鏡".into()
            },
        });
    }

    // 2. Messier & Iconic DSOs
    for dso in &store.dsos {
        let Some(m_num) = dso.messier else {
            continue;
        };
        let mag = f64::from(dso.mag.unwrap_or(9.5));
        if mag > mag_cutoff {
            continue;
        }
        let eq_j2k = Equatorial {
            ra_deg: dso.ra_deg,
            dec_deg: dso.dec_deg,
        };
        let rs = equatorial_j2000_rise_set(eq_j2k, &loc, year, month, day);
        if rs.max_alt_deg < 14.0 {
            continue;
        }
        let eq_app = apply_nutation_to_equatorial(precess_j2000_to_date(eq_j2k, eval_tt), &eval_nut);
        let hor = equatorial_to_horizontal(eq_app, loc.lat_deg, eval_lst);

        let is_showcase = matches!(m_num, 31 | 42 | 45 | 8 | 13 | 27 | 57 | 51 | 81 | 44 | 7 | 6 | 20);
        let mut score = 45.0 + (hor.alt_deg.max(rs.max_alt_deg * 0.6).clamp(0.0, 80.0) * 0.42) + (10.5 - mag) * 4.0;
        if is_showcase {
            score += 14.0;
        }
        if hor.alt_deg < 6.0 {
            score -= 22.0;
        }
        if gear == "naked_eye" && !matches!(m_num, 31 | 42 | 45 | 44 | 7) {
            score -= 20.0;
        } else if gear == "binoculars" && mag <= 7.2 {
            score += 8.0;
        } else if gear == "telescope" && matches!(dso.obj_type.as_str(), "GX" | "PN" | "GC" | "NB") {
            score += 6.0;
        }

        let name_ja = dso
            .name_ja
            .as_deref()
            .filter(|s| !s.is_empty())
            .map(|s| format!("M{m_num} {s}"))
            .unwrap_or_else(|| format!("M{m_num} {}", dso.name_en));

        let reason_ja = match dso.obj_type.as_str() {
            "NB" => "華やかな星雲・星形成領域の定番ターゲット",
            "GX" => "銀河の渦や広がりを狙う人気対象",
            "GC" => "多数の星が密集した美しい球状星団",
            "OC" => "双眼鏡・低倍率で映える散開星団",
            "PN" => "望遠鏡で環や中心構造を狙う惑星状星雲",
            _ => "メシエ天体の注目ターゲット",
        };

        items.push(TonightBestObject {
            id: format!("M{m_num}"),
            name_ja,
            name_en: dso.name_en.clone(),
            kind: "dso".into(),
            constellation: Some(dso.constellation.clone()),
            mag,
            ra_deg: dso.ra_deg,
            dec_deg: dso.dec_deg,
            az_deg: hor.az_deg,
            alt_deg: hor.alt_deg,
            max_alt_deg: rs.max_alt_deg,
            transit_str: format_local_hm(rs.transit_jd_ut, req.tz_offset_min),
            score: score.round().clamp(10.0, 100.0) as u8,
            reason_ja: reason_ja.into(),
            recommended_gear: if mag <= 5.0 {
                "肉眼〜双眼鏡".into()
            } else if mag <= 7.4 {
                "双眼鏡〜小口径".into()
            } else {
                "天体望遠鏡".into()
            },
        });
    }

    // 3. First-magnitude showcase stars (especially helpful for naked_eye / quick alignment)
    for g in store.star_guides.iter().take(24) {
        if f64::from(g.mag) > 2.2 {
            continue;
        }
        let Some(star) = store.stars.find_by_hip(g.hip) else {
            continue;
        };
        let eq_j2k = Equatorial {
            ra_deg: f64::from(star.ra_rad).to_degrees(),
            dec_deg: f64::from(star.dec_rad).to_degrees(),
        };
        let rs = equatorial_j2000_rise_set(eq_j2k, &loc, year, month, day);
        if rs.max_alt_deg < 15.0 {
            continue;
        }
        let eq_app = apply_nutation_to_equatorial(precess_j2000_to_date(eq_j2k, eval_tt), &eval_nut);
        let hor = equatorial_to_horizontal(eq_app, loc.lat_deg, eval_lst);
        let mut score = 46.0 + hor.alt_deg.clamp(0.0, 80.0) * 0.4 + (2.5 - f64::from(g.mag)) * 5.0;
        if gear == "naked_eye" {
            score += 18.0;
        }
        if hor.alt_deg < 8.0 {
            score -= 22.0;
        }
        items.push(TonightBestObject {
            id: format!("HIP{}", g.hip),
            name_ja: g.name_ja.clone(),
            name_en: g.name_en.clone(),
            kind: "star".into(),
            constellation: Some(g.constellation.clone()),
            mag: f64::from(g.mag),
            ra_deg: eq_j2k.ra_deg,
            dec_deg: eq_j2k.dec_deg,
            az_deg: hor.az_deg,
            alt_deg: hor.alt_deg,
            max_alt_deg: rs.max_alt_deg,
            transit_str: format_local_hm(rs.transit_jd_ut, req.tz_offset_min),
            score: score.round().clamp(10.0, 100.0) as u8,
            reason_ja: g.summary_ja.clone(),
            recommended_gear: "肉眼OK".into(),
        });
    }

    let _ = (nut, lst);
    items.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.mag.total_cmp(&b.mag)));
    items.truncate(12);
    items
}

#[tauri::command]
pub fn get_tonight_best_objects_cmd(
    req: TonightBestRequest,
    store: State<'_, CatalogStore>,
) -> Vec<TonightBestObject> {
    get_tonight_best_objects_impl(&req, &store)
}

#[tauri::command]
pub fn list_observation_logs_cmd(db: State<'_, CometDb>) -> Result<Vec<ObservationLogRecord>, String> {
    db.list_observation_logs()
}

#[tauri::command]
pub fn upsert_observation_log_cmd(
    record: ObservationLogRecord,
    db: State<'_, CometDb>,
) -> Result<ObservationLogRecord, String> {
    db.upsert_observation_log(record)
}

#[tauri::command]
pub fn delete_observation_log_cmd(id: String, db: State<'_, CometDb>) -> Result<bool, String> {
    db.delete_observation_log(&id)
}

#[derive(Debug, Clone, Deserialize)]
pub struct PolarAlignRequest {
    pub jd_ut: f64,
    pub lat_deg: f64,
    pub lon_deg: f64,
    pub tz_offset_min: i32,
}

#[derive(Debug, Clone, Serialize)]
pub struct PolarAlignmentInfo {
    pub jd_ut: f64,
    pub hemisphere: String,
    pub pole_star_name_ja: String,
    pub ra_app_deg: f64,
    pub dec_app_deg: f64,
    pub last_deg: f64,
    pub ha_deg: f64,
    pub ha_hours: f64,
    pub polar_dist_arcmin: f64,
    pub clock_hour_erect: f64,
    pub clock_hour_inverted: f64,
    pub clock_str_erect: String,
    pub clock_str_inverted: String,
    pub next_transit_str: String,
}

fn format_clock_hour_ja(h12: f64) -> String {
    let wrapped = ((h12 % 12.0) + 12.0) % 12.0;
    let total_min = (wrapped * 60.0).round() as i32 % 720;
    let hh = total_min / 60;
    let mm = total_min % 60;
    let disp_h = if hh == 0 { 12 } else { hh };
    format!("{disp_h}時{mm:02}分")
}

pub fn get_polar_alignment_impl(req: &PolarAlignRequest) -> PolarAlignmentInfo {
    let is_north = req.lat_deg >= 0.0;
    // Polaris J2000 (HIP 11767) vs Sigma Octantis J2000 (HIP 100511)
    let (pole_name_ja, eq_j2k) = if is_north {
        (
            "ポラリス (北極星 · α UMi)".to_owned(),
            Equatorial {
                ra_deg: 37.954_56,
                dec_deg: 89.264_11,
            },
        )
    } else {
        (
            "はちぶんぎ座 σ星 (南極星)".to_owned(),
            Equatorial {
                ra_deg: 317.195_17,
                dec_deg: -88.956_51,
            },
        )
    };

    let jd_tt = ut_to_tt_jd(req.jd_ut);
    let nut = nutation(jd_tt);
    let eq_app = apply_nutation_to_equatorial(precess_j2000_to_date(eq_j2k, jd_tt), &nut);
    let lst = last_deg(req.jd_ut, req.lon_deg);
    let ha_deg = wrap_deg_180(lst - eq_app.ra_deg);
    let ha_hours = ha_deg / 15.0;
    let polar_dist_arcmin = (90.0 - eq_app.dec_deg.abs()).max(0.0) * 60.0;

    // Facing North in NH: celestial sphere turns CCW; before transit (HA<0), Polaris is East (Right = 3 o'clock).
    // Facing South in SH: celestial sphere turns CW; before transit (HA<0), σ Oct is East (Left = 9 o'clock).
    let raw_erect = if is_north {
        -ha_hours / 2.0
    } else {
        ha_hours / 2.0
    };
    let clock_hour_erect = ((raw_erect % 12.0) + 12.0) % 12.0;
    let clock_hour_inverted = (clock_hour_erect + 6.0) % 12.0;

    // Next upper culmination (HA = 0°)
    let ha_ahead_deg = wrap_deg_360(eq_app.ra_deg - lst);
    let dt_days = (ha_ahead_deg / 360.0) * 0.997_269_57;
    let next_transit_str =
        format_local_hm(Some(req.jd_ut + dt_days), req.tz_offset_min).unwrap_or_default();

    PolarAlignmentInfo {
        jd_ut: req.jd_ut,
        hemisphere: if is_north { "north" } else { "south" }.into(),
        pole_star_name_ja: pole_name_ja,
        ra_app_deg: eq_app.ra_deg,
        dec_app_deg: eq_app.dec_deg,
        last_deg: lst,
        ha_deg,
        ha_hours,
        polar_dist_arcmin,
        clock_hour_erect,
        clock_hour_inverted,
        clock_str_erect: format_clock_hour_ja(clock_hour_erect),
        clock_str_inverted: format_clock_hour_ja(clock_hour_inverted),
        next_transit_str,
    }
}

#[tauri::command]
pub fn get_polar_alignment_cmd(req: PolarAlignRequest) -> PolarAlignmentInfo {
    get_polar_alignment_impl(&req)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::time::calendar_to_jd;

    #[test]
    fn astro_calculator_commands_accuracy() {
        // 1. JD / MJD round-trip at J2000.0 (2000-01-01 12:00:00 UTC)
        let jd_res = calc_julian_day_impl(&CalcJdRequest {
            mode: "from_calendar".into(),
            year: 2000,
            month: 1,
            day: 1,
            hour: 12,
            minute: 0,
            second: 0.0,
            tz_offset_min: 0,
            jd_ut: 0.0,
            mjd_ut: 0.0,
        });
        assert!((jd_res.jd_ut - 2_451_545.0).abs() < 1e-9);
        assert!((jd_res.mjd_ut - 51_544.5).abs() < 1e-9);
        assert_eq!(jd_res.weekday_ja, "土曜日");

        let from_mjd = calc_julian_day_impl(&CalcJdRequest {
            mode: "from_mjd".into(),
            year: 2000,
            month: 1,
            day: 1,
            hour: 0,
            minute: 0,
            second: 0.0,
            tz_offset_min: 540,
            jd_ut: 0.0,
            mjd_ut: 51_544.5,
        });
        assert!((from_mjd.jd_ut - 2_451_545.0).abs() < 1e-9);

        // 2. LST / Hour angle sanity
        let sid = calc_sidereal_ha_impl(&CalcSiderealRequest {
            jd_ut: 2_451_545.0,
            lon_deg: 135.0,
            ra_deg: 0.0,
        });
        assert!((sid.lst_deg - wrap_deg_360(sid.gmst_deg + 135.0)).abs() < 1e-6);
        assert!(sid.hours_to_transit >= -12.1 && sid.hours_to_transit <= 12.1);

        // 3. Elapsed time
        let elapsed = calc_elapsed_time_impl(&CalcElapsedRequest {
            jd_start_ut: calendar_to_jd(2026, 1, 1.0),
            jd_end_ut: calendar_to_jd(2026, 1, 11.5),
            offset_days: 30.0,
            tz_offset_min: 540,
        });
        assert!((elapsed.diff_days - 10.5).abs() < 1e-9);
        assert!((elapsed.diff_hours - 252.0).abs() < 1e-9);
        assert!(elapsed.diff_sidereal_hours > elapsed.diff_hours);

        // 4. Angular distance & PA
        let ang = calc_angular_distance_impl(&CalcAngDistRequest {
            ra1_deg: 0.0,
            dec1_deg: 0.0,
            ra2_deg: 0.0,
            dec2_deg: 10.0,
        });
        assert!((ang.distance_deg - 10.0).abs() < 1e-9);
        assert!(ang.position_angle_deg.abs() < 1e-6);

        // 5. Target altitude crossing times (Sirius at Akashi 2026-01-01 reaching 20 deg)
        let alt_res = calc_altitude_times_impl(&CalcAltTimeRequest {
            ra_j2000_deg: 101.287_155,
            dec_j2000_deg: -16.716_116,
            target_alt_deg: 20.0,
            lat_deg: 34.6431,
            lon_deg: 134.9972,
            alt_m: 10.0,
            tz_offset_min: 540,
            year: 2026,
            month: 1,
            day: 1,
        });
        assert!(alt_res.rising_jd_ut.is_some());
        assert!(alt_res.setting_jd_ut.is_some());
        assert!(alt_res.max_alt_deg > 35.0);

        // 6. B1950 <-> J2000 round-trip
        let to_j2k = calc_epoch_convert_impl(&CalcEpochConvertRequest {
            ra_deg: 150.0,
            dec_deg: 25.0,
            mode: "b1950_to_j2000".into(),
            from_epoch_year: None,
            to_epoch_year: None,
        });
        let back_b1950 = calc_epoch_convert_impl(&CalcEpochConvertRequest {
            ra_deg: to_j2k.out_ra_deg,
            dec_deg: to_j2k.out_dec_deg,
            mode: "j2000_to_b1950".into(),
            from_epoch_year: None,
            to_epoch_year: None,
        });
        assert!((wrap_deg_180(back_b1950.out_ra_deg - 150.0)).abs() < 1e-6);
        assert!((back_b1950.out_dec_deg - 25.0).abs() < 1e-6);
    }

    #[test]
    fn comet_json_import_export_and_ephemeris_work() {
        let db = CometDb::open_in_memory().expect("db");
        let list = list_comets_impl(
            &CometListRequest {
                jd_ut: calendar_to_jd(2026, 6, 1.0),
                lat_deg: 34.6431,
                lon_deg: 134.9972,
                alt_m: 10.0,
                refraction: true,
            },
            &db,
        )
        .expect("list comets");
        assert_eq!(list.len(), 5);

        let exported = export_comets_json_impl(&db).expect("export");
        assert!(exported.contains("starcrane-comets-v1"));

        let imported = import_comets_json_impl(&exported, false, &db).expect("reimport");
        assert_eq!(imported, 5);

        // Check invalid JSON rejection
        assert!(import_comets_json_impl("{invalid", false, &db).is_err());
    }

    #[test]
    fn iss_earth_view_propagates_orbit_and_subsolar() {
        let db = CometDb::open_in_memory().expect("db");
        let view = get_iss_earth_view_impl(
            &SatListRequest {
                jd_ut: calendar_to_jd(2026, 11, 23.25),
                lat_deg: 34.6431,
                lon_deg: 134.9972,
                alt_m: 10.0,
                tz_offset_min: 540,
                refraction: true,
            },
            &db,
        )
        .expect("iss earth view");
        assert_eq!(view.norad_id, 25544);
        assert_eq!(view.track.len(), 97);
        assert!(view.current.altitude_km > 300.0 && view.current.altitude_km < 600.0);
        assert!(view.current.velocity_km_s > 6.5 && view.current.velocity_km_s < 8.5);
        assert!(view.subsolar_lat_deg.abs() <= 24.0);
        assert!(view.subsolar_lon_deg.abs() <= 180.0);
    }

    #[test]
    fn polar_alignment_and_tonight_best_work() {
        let pol = get_polar_alignment_impl(&PolarAlignRequest {
            jd_ut: calendar_to_jd(2026, 11, 26.5),
            lat_deg: 34.6431,
            lon_deg: 134.9972,
            tz_offset_min: 540,
        });
        assert_eq!(pol.hemisphere, "north");
        assert!(pol.polar_dist_arcmin > 30.0 && pol.polar_dist_arcmin < 45.0);
        assert!(((pol.clock_hour_erect + 6.0) % 12.0 - pol.clock_hour_inverted).abs() < 1e-6);

        let store = CatalogStore::load_embedded().expect("embedded catalog");
        let list = get_tonight_best_objects_impl(
            &TonightBestRequest {
                jd_ut: calendar_to_jd(2026, 11, 26.5),
                lat_deg: 34.6431,
                lon_deg: 134.9972,
                alt_m: 10.0,
                tz_offset_min: 540,
                gear: "telescope".into(),
            },
            &store,
        );
        assert_eq!(list.len(), 12);
        assert!(list.iter().all(|o| o.max_alt_deg >= 10.0));
    }
}
