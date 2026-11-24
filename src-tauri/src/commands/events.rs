use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::calendar::{is_mmdd_in_active_window, moon_phase_name_ja};
use crate::engine::catalog::CatalogStore;
use crate::engine::coords::{Equatorial, angular_distance_deg, equatorial_to_horizontal, wrap_deg_360};
use crate::engine::ephemeris::{
    moon_apparent_ecliptic_lon_deg, moon_ephemeris, sun_apparent_ecliptic_lon_deg,
};
use crate::engine::phenomena::{
    LunarEclipseSample, PlanetaryTransitEvent, SolarEclipseSample, TransitChordSample,
    search_lunar_eclipses, search_lunar_occultations, search_planetary_transits,
    search_solar_eclipses,
};
use crate::engine::rise_set::ObserverLocation;
use crate::engine::time::{
    calendar_to_jd, find_solar_longitude_jd_tt, jd_to_ymd_hms, last_deg, tt_to_ut_jd, ut_to_tt_jd,
};

const TROPICAL_YEAR_DAYS: f64 = 365.242_189;

#[derive(Debug, Clone, Deserialize)]
pub struct MeteorShowersRequest {
    pub year: i32,
    pub current_jd_ut: f64,
    pub lat_deg: f64,
    pub lon_deg: f64,
    pub alt_m: f64,
    pub tz_offset_min: i32,
}

#[derive(Debug, Clone, Serialize)]
pub struct MeteorShowerYearInfo {
    pub code: String,
    pub iau_no: u32,
    pub name_ja: String,
    pub name_en: String,
    pub constellation: String,
    pub constellation_ja: String,
    pub active_start: String,
    pub active_end: String,
    pub peak_date_ref: String,
    pub peak_jd_ut: f64,
    pub peak_local_str: String,
    pub best_observe_jd_ut: f64,
    pub peak_solar_lon_deg: f64,
    pub ra_deg: f64,
    pub dec_deg: f64,
    pub current_ra_deg: f64,
    pub current_dec_deg: f64,
    pub current_az_deg: f64,
    pub current_alt_deg: f64,
    pub drift_ra_deg: f64,
    pub drift_dec_deg: f64,
    pub velocity_km_s: f64,
    pub zhr: u32,
    pub parent_body: String,
    pub description_ja: String,
    pub is_major_three: bool,
    pub is_active_now: bool,
    pub days_to_peak: f64,
    pub peak_moon_age_days: f64,
    pub peak_moon_illumination: f64,
    pub peak_moon_phase_ja: String,
    pub peak_radiant_max_alt_deg: f64,
    pub condition_score: u8,
    pub condition_grade: String,
    pub condition_note_ja: String,
}

fn parse_mmdd(mmdd: &str) -> (u8, u8) {
    if let Some((m, d)) = mmdd.split_once('-') {
        let mo = m.trim().parse::<u8>().unwrap_or(6).clamp(1, 12);
        let da = d.trim().parse::<u8>().unwrap_or(15).clamp(1, 31);
        (mo, da)
    } else {
        (6, 15)
    }
}

fn find_peak_jd_ut_in_year(year: i32, peak_mmdd: &str, peak_solar_lon_deg: f64, tz_offset_min: i32) -> f64 {
    let (pm, pd) = parse_mmdd(peak_mmdd);
    let approx_ut = calendar_to_jd(year, pm, f64::from(pd)) + 0.5 - f64::from(tz_offset_min) / 1440.0;
    let mut peak_tt = find_solar_longitude_jd_tt(peak_solar_lon_deg, ut_to_tt_jd(approx_ut));
    let mut peak_ut = tt_to_ut_jd(peak_tt);

    let (found_y, _, _, _, _, _) = jd_to_ymd_hms(peak_ut + f64::from(tz_offset_min) / 1440.0);
    if found_y < year {
        peak_tt = find_solar_longitude_jd_tt(peak_solar_lon_deg, peak_tt + TROPICAL_YEAR_DAYS);
        peak_ut = tt_to_ut_jd(peak_tt);
    } else if found_y > year {
        peak_tt = find_solar_longitude_jd_tt(peak_solar_lon_deg, peak_tt - TROPICAL_YEAR_DAYS);
        peak_ut = tt_to_ut_jd(peak_tt);
    }
    peak_ut
}

/// Find local 02:00 JD nearest to `peak_jd_ut` (best dark-sky radiant hour for most meteor showers).
fn nearest_02h_local_jd_ut(peak_jd_ut: f64, tz_offset_min: i32) -> f64 {
    let tz_days = f64::from(tz_offset_min) / 1440.0;
    let local_jd = peak_jd_ut + tz_days;
    let (y, m, d, hour, _, _) = jd_to_ymd_hms(local_jd);
    let day_02h = calendar_to_jd(y, m, f64::from(d)) + 2.0 / 24.0 - tz_days;
    if hour >= 14 {
        day_02h + 1.0
    } else {
        day_02h
    }
}

pub fn get_meteor_showers_for_year_impl(
    req: &MeteorShowersRequest,
    store: &CatalogStore,
) -> Vec<MeteorShowerYearInfo> {
    let tz_days = f64::from(req.tz_offset_min) / 1440.0;
    let (_, cur_month, cur_day, _, _, _) = jd_to_ymd_hms(req.current_jd_ut + tz_days);
    let cur_last = last_deg(req.current_jd_ut, req.lon_deg);

    let mut out: Vec<MeteorShowerYearInfo> = store
        .meteor_showers
        .iter()
        .map(|sh| {
            let peak_jd_ut =
                find_peak_jd_ut_in_year(req.year, &sh.peak_date, sh.peak_solar_lon_deg, req.tz_offset_min);
            let best_observe_jd_ut = nearest_02h_local_jd_ut(peak_jd_ut, req.tz_offset_min);
            let (_, pm, pd, ph, pmin, _) = jd_to_ymd_hms(peak_jd_ut + tz_days);
            let peak_local_str = format!("{pm:02}/{pd:02} {ph:02}:{pmin:02}");

            let peak_tt = ut_to_tt_jd(peak_jd_ut);
            let moon_peak = moon_ephemeris(peak_tt);
            let lon_diff =
                wrap_deg_360(moon_apparent_ecliptic_lon_deg(peak_tt) - sun_apparent_ecliptic_lon_deg(peak_tt));
            let peak_moon_phase_ja = moon_phase_name_ja(lon_diff, moon_peak.age_days).to_owned();

            // Check moon altitude around 02:00 on best observing night
            let obs_tt = ut_to_tt_jd(best_observe_jd_ut);
            let moon_obs = moon_ephemeris(obs_tt);
            let lst_obs = last_deg(best_observe_jd_ut, req.lon_deg);
            let moon_alt_obs = equatorial_to_horizontal(moon_obs.eq_apparent, req.lat_deg, lst_obs).alt_deg;
            let moon_rad_sep = angular_distance_deg(
                moon_obs.eq_apparent,
                Equatorial {
                    ra_deg: sh.ra_deg,
                    dec_deg: sh.dec_deg,
                },
            );

            // Drift radiant toward current time if reasonably close
            let days_from_peak = req.current_jd_ut - peak_jd_ut;
            let drift_days = days_from_peak.clamp(-14.0, 14.0);
            let cur_ra = wrap_deg_360(sh.ra_deg + sh.drift_ra_deg * drift_days);
            let cur_dec = (sh.dec_deg + sh.drift_dec_deg * drift_days).clamp(-89.9, 89.9);
            let cur_hor = equatorial_to_horizontal(
                Equatorial {
                    ra_deg: cur_ra,
                    dec_deg: cur_dec,
                },
                req.lat_deg,
                cur_last,
            );

            let peak_radiant_max_alt_deg = (90.0 - (req.lat_deg - sh.dec_deg).abs()).clamp(0.0, 90.0);

            // Observation condition scoring (0..100)
            let moon_penalty = if moon_alt_obs <= -3.0 {
                0.0
            } else {
                let sep_factor = if moon_rad_sep < 35.0 { 1.15 } else { 1.0 };
                moon_peak.illuminated_fraction * 60.0 * sep_factor
            };
            let alt_score = if peak_radiant_max_alt_deg >= 50.0 {
                25.0
            } else if peak_radiant_max_alt_deg <= 0.0 {
                0.0
            } else {
                (peak_radiant_max_alt_deg / 50.0) * 25.0
            };
            let zhr_bonus = (f64::from(sh.zhr).ln_1p() / 5.0 * 15.0).min(15.0);
            let raw_score = (60.0 - moon_penalty + alt_score + zhr_bonus).round().clamp(0.0, 100.0);
            let condition_score = raw_score as u8;

            let (condition_grade, condition_note_ja) = if peak_radiant_max_alt_deg < 8.0 {
                ("観察困難".to_owned(), "この緯度では放射点が低く観測に不向き".to_owned())
            } else if condition_score >= 80 {
                let note = if moon_alt_obs <= -3.0 {
                    "深夜帯は月明かりなし・最良の観測条件"
                } else {
                    "月明かり少なく好条件"
                };
                ("最良 (A)".to_owned(), note.to_owned())
            } else if condition_score >= 60 {
                ("良好 (B)".to_owned(), "月明かりの影響は比較的小さく観測向き".to_owned())
            } else if condition_score >= 40 {
                ("普通 (C)".to_owned(), "月明かりがややあるが明るい群流星を狙える".to_owned())
            } else {
                ("悪条件 (D)".to_owned(), "月明かりが強く暗い流星は見づらい".to_owned())
            };

            let constellation_ja = store
                .constellations
                .iter()
                .find(|c| c.id.eq_ignore_ascii_case(&sh.constellation))
                .map(|c| c.name_ja.clone())
                .unwrap_or_else(|| sh.constellation.clone());

            let is_major_three = matches!(sh.code.as_str(), "QUA" | "PER" | "GEM");
            let is_active_now = is_mmdd_in_active_window(cur_month, cur_day, &sh.active_start, &sh.active_end);

            MeteorShowerYearInfo {
                code: sh.code.clone(),
                iau_no: sh.iau_no,
                name_ja: sh.name_ja.clone(),
                name_en: sh.name_en.clone(),
                constellation: sh.constellation.clone(),
                constellation_ja,
                active_start: sh.active_start.clone(),
                active_end: sh.active_end.clone(),
                peak_date_ref: sh.peak_date.clone(),
                peak_jd_ut,
                peak_local_str,
                best_observe_jd_ut,
                peak_solar_lon_deg: sh.peak_solar_lon_deg,
                ra_deg: sh.ra_deg,
                dec_deg: sh.dec_deg,
                current_ra_deg: cur_ra,
                current_dec_deg: cur_dec,
                current_az_deg: cur_hor.az_deg,
                current_alt_deg: cur_hor.alt_deg,
                drift_ra_deg: sh.drift_ra_deg,
                drift_dec_deg: sh.drift_dec_deg,
                velocity_km_s: sh.velocity_km_s,
                zhr: sh.zhr,
                parent_body: sh.parent_body.clone(),
                description_ja: sh.description_ja.clone(),
                is_major_three,
                is_active_now,
                days_to_peak: peak_jd_ut - req.current_jd_ut,
                peak_moon_age_days: moon_peak.age_days,
                peak_moon_illumination: moon_peak.illuminated_fraction,
                peak_moon_phase_ja,
                peak_radiant_max_alt_deg,
                condition_score,
                condition_grade,
                condition_note_ja,
            }
        })
        .collect();

    out.sort_by(|a, b| a.peak_jd_ut.total_cmp(&b.peak_jd_ut));
    out
}

#[tauri::command]
pub fn get_meteor_showers_for_year(
    req: MeteorShowersRequest,
    store: State<'_, CatalogStore>,
) -> Vec<MeteorShowerYearInfo> {
    get_meteor_showers_for_year_impl(&req, &store)
}

// =========================================================================
// Phase 6: Solar Eclipses, Lunar Eclipses, Planetary Transits, Occultations
// =========================================================================

fn format_local_dt(jd_ut: f64, tz_offset_min: i32) -> String {
    let local_jd = jd_ut + f64::from(tz_offset_min) / 1440.0 + (0.5 / 1440.0);
    let (y, m, d, h, min, _) = jd_to_ymd_hms(local_jd);
    format!("{y:04}-{m:02}-{d:02} {h:02}:{min:02}")
}

fn format_local_hm_opt(jd_opt: Option<f64>, tz_offset_min: i32) -> Option<String> {
    jd_opt.map(|jd| {
        let local_jd = jd + f64::from(tz_offset_min) / 1440.0 + (0.5 / 1440.0);
        let (_, _, _, h, min, _) = jd_to_ymd_hms(local_jd);
        format!("{h:02}:{min:02}")
    })
}

#[derive(Debug, Clone, Deserialize)]
pub struct YearRangeLocationRequest {
    pub start_year: i32,
    pub end_year: i32,
    pub lat_deg: f64,
    pub lon_deg: f64,
    pub alt_m: f64,
    pub tz_offset_min: i32,
}

#[derive(Debug, Clone, Serialize)]
pub struct SolarEclipseView {
    pub global_type: String,
    pub global_type_ja: String,
    pub local_type: String,
    pub local_type_ja: String,
    pub visible_locally: bool,
    pub global_max_jd_ut: f64,
    pub local_max_jd_ut: f64,
    pub date_local_str: String,
    pub max_time_str: String,
    pub start_time_str: Option<String>,
    pub end_time_str: Option<String>,
    pub local_magnitude: f64,
    pub max_obscuration_pct: f64,
    pub max_sun_alt_deg: f64,
    pub max_sun_az_deg: f64,
    pub first_contact_pa_deg: Option<f64>,
    pub ra_deg: f64,
    pub dec_deg: f64,
    pub path_samples: Vec<SolarEclipseSample>,
}

pub fn search_solar_eclipses_cmd_impl(req: &YearRangeLocationRequest) -> Vec<SolarEclipseView> {
    let sy = req.start_year.clamp(1800, 2300);
    let ey = req.end_year.max(sy).min(sy + 120);
    let start_jd = calendar_to_jd(sy, 1, 1.0);
    let end_jd = calendar_to_jd(ey + 1, 1, 1.0);
    let loc = ObserverLocation {
        lat_deg: req.lat_deg,
        lon_deg: req.lon_deg,
        alt_m: req.alt_m,
        tz_offset_min: req.tz_offset_min,
    };
    search_solar_eclipses(start_jd, end_jd, &loc)
        .into_iter()
        .map(|e| SolarEclipseView {
            global_type: e.global_type,
            global_type_ja: e.global_type_ja,
            local_type: e.local_type,
            local_type_ja: e.local_type_ja,
            visible_locally: e.visible_locally,
            global_max_jd_ut: e.global_max_jd_ut,
            local_max_jd_ut: e.local_max_jd_ut,
            date_local_str: format_local_dt(e.local_max_jd_ut, req.tz_offset_min),
            max_time_str: format_local_hm_opt(Some(e.local_max_jd_ut), req.tz_offset_min)
                .unwrap_or_default(),
            start_time_str: format_local_hm_opt(e.start_jd_ut, req.tz_offset_min),
            end_time_str: format_local_hm_opt(e.end_jd_ut, req.tz_offset_min),
            local_magnitude: e.local_magnitude,
            max_obscuration_pct: e.max_obscuration_pct,
            max_sun_alt_deg: e.max_sun_alt_deg,
            max_sun_az_deg: e.max_sun_az_deg,
            first_contact_pa_deg: e.first_contact_pa_deg,
            ra_deg: e.ra_deg,
            dec_deg: e.dec_deg,
            path_samples: e.path_samples,
        })
        .collect()
}

#[tauri::command]
pub fn search_solar_eclipses_cmd(req: YearRangeLocationRequest) -> Vec<SolarEclipseView> {
    search_solar_eclipses_cmd_impl(&req)
}

#[derive(Debug, Clone, Serialize)]
pub struct LunarEclipseView {
    pub eclipse_type: String,
    pub eclipse_type_ja: String,
    pub visible_locally: bool,
    pub max_jd_ut: f64,
    pub date_local_str: String,
    pub p1_str: Option<String>,
    pub u1_str: Option<String>,
    pub u2_str: Option<String>,
    pub max_str: String,
    pub u3_str: Option<String>,
    pub u4_str: Option<String>,
    pub p4_str: Option<String>,
    pub umbral_magnitude: f64,
    pub penumbral_magnitude: f64,
    pub umbra_radius_arcmin: f64,
    pub penumbra_radius_arcmin: f64,
    pub moon_radius_arcmin: f64,
    pub max_moon_alt_deg: f64,
    pub max_moon_az_deg: f64,
    pub ra_deg: f64,
    pub dec_deg: f64,
    pub path_samples: Vec<LunarEclipseSample>,
}

pub fn search_lunar_eclipses_cmd_impl(req: &YearRangeLocationRequest) -> Vec<LunarEclipseView> {
    let sy = req.start_year.clamp(1800, 2300);
    let ey = req.end_year.max(sy).min(sy + 120);
    let start_jd = calendar_to_jd(sy, 1, 1.0);
    let end_jd = calendar_to_jd(ey + 1, 1, 1.0);
    let loc = ObserverLocation {
        lat_deg: req.lat_deg,
        lon_deg: req.lon_deg,
        alt_m: req.alt_m,
        tz_offset_min: req.tz_offset_min,
    };
    search_lunar_eclipses(start_jd, end_jd, &loc)
        .into_iter()
        .map(|e| LunarEclipseView {
            eclipse_type: e.eclipse_type,
            eclipse_type_ja: e.eclipse_type_ja,
            visible_locally: e.visible_locally,
            max_jd_ut: e.max_jd_ut,
            date_local_str: format_local_dt(e.max_jd_ut, req.tz_offset_min),
            p1_str: format_local_hm_opt(e.p1_jd_ut, req.tz_offset_min),
            u1_str: format_local_hm_opt(e.u1_jd_ut, req.tz_offset_min),
            u2_str: format_local_hm_opt(e.u2_jd_ut, req.tz_offset_min),
            max_str: format_local_hm_opt(Some(e.max_jd_ut), req.tz_offset_min).unwrap_or_default(),
            u3_str: format_local_hm_opt(e.u3_jd_ut, req.tz_offset_min),
            u4_str: format_local_hm_opt(e.u4_jd_ut, req.tz_offset_min),
            p4_str: format_local_hm_opt(e.p4_jd_ut, req.tz_offset_min),
            umbral_magnitude: e.umbral_magnitude,
            penumbral_magnitude: e.penumbral_magnitude,
            umbra_radius_arcmin: e.umbra_radius_arcmin,
            penumbra_radius_arcmin: e.penumbra_radius_arcmin,
            moon_radius_arcmin: e.moon_radius_arcmin,
            max_moon_alt_deg: e.max_moon_alt_deg,
            max_moon_az_deg: e.max_moon_az_deg,
            ra_deg: e.ra_deg,
            dec_deg: e.dec_deg,
            path_samples: e.path_samples,
        })
        .collect()
}

#[tauri::command]
pub fn search_lunar_eclipses_cmd(req: YearRangeLocationRequest) -> Vec<LunarEclipseView> {
    search_lunar_eclipses_cmd_impl(&req)
}

#[derive(Debug, Clone, Serialize)]
pub struct PlanetaryTransitView {
    pub planet_id: String,
    pub planet_name_ja: String,
    pub visible_locally: bool,
    pub max_jd_ut: f64,
    pub date_local_str: String,
    pub c1_str: Option<String>,
    pub max_str: String,
    pub c4_str: Option<String>,
    pub min_sep_arcmin: f64,
    pub sun_radius_arcmin: f64,
    pub planet_radius_arcsec: f64,
    pub max_sun_alt_deg: f64,
    pub ra_deg: f64,
    pub dec_deg: f64,
    pub path_samples: Vec<TransitChordSample>,
}

pub fn search_planetary_transits_cmd_impl(
    req: &YearRangeLocationRequest,
) -> Vec<PlanetaryTransitView> {
    let sy = req.start_year.clamp(1800, 2300);
    let ey = req.end_year.max(sy).min(sy + 140);
    let start_jd = calendar_to_jd(sy, 1, 1.0);
    let end_jd = calendar_to_jd(ey + 1, 1, 1.0);
    let loc = ObserverLocation {
        lat_deg: req.lat_deg,
        lon_deg: req.lon_deg,
        alt_m: req.alt_m,
        tz_offset_min: req.tz_offset_min,
    };
    search_planetary_transits(start_jd, end_jd, &loc)
        .into_iter()
        .map(|t: PlanetaryTransitEvent| PlanetaryTransitView {
            planet_id: t.planet_id,
            planet_name_ja: t.planet_name_ja,
            visible_locally: t.visible_locally,
            max_jd_ut: t.max_jd_ut,
            date_local_str: format_local_dt(t.max_jd_ut, req.tz_offset_min),
            c1_str: format_local_hm_opt(t.c1_jd_ut, req.tz_offset_min),
            max_str: format_local_hm_opt(Some(t.max_jd_ut), req.tz_offset_min).unwrap_or_default(),
            c4_str: format_local_hm_opt(t.c4_jd_ut, req.tz_offset_min),
            min_sep_arcmin: t.min_sep_arcmin,
            sun_radius_arcmin: t.sun_radius_arcmin,
            planet_radius_arcsec: t.planet_radius_arcsec,
            max_sun_alt_deg: t.max_sun_alt_deg,
            ra_deg: t.ra_deg,
            dec_deg: t.dec_deg,
            path_samples: t.path_samples,
        })
        .collect()
}

#[tauri::command]
pub fn search_planetary_transits_cmd(req: YearRangeLocationRequest) -> Vec<PlanetaryTransitView> {
    search_planetary_transits_cmd_impl(&req)
}

#[derive(Debug, Clone, Deserialize)]
pub struct OccultationSearchRequest {
    pub start_jd_ut: f64,
    pub days: f64,
    pub mag_limit: f64,
    pub lat_deg: f64,
    pub lon_deg: f64,
    pub alt_m: f64,
    pub tz_offset_min: i32,
}

#[derive(Debug, Clone, Serialize)]
pub struct LunarOccultationView {
    pub target_kind: String,
    pub target_id: String,
    pub target_name_ja: String,
    pub mag: f64,
    pub immersion_jd_ut: f64,
    pub max_jd_ut: f64,
    pub emersion_jd_ut: f64,
    pub date_local_str: String,
    pub immersion_str: String,
    pub emersion_str: String,
    pub min_sep_arcmin: f64,
    pub moon_alt_deg: f64,
    pub moon_az_deg: f64,
    pub moon_illum_pct: f64,
    pub sun_alt_deg: f64,
    pub dark_limb_immersion: bool,
    pub ra_deg: f64,
    pub dec_deg: f64,
}

pub fn search_lunar_occultations_cmd_impl(
    req: &OccultationSearchRequest,
    store: &CatalogStore,
) -> Vec<LunarOccultationView> {
    let span = req.days.clamp(7.0, 400.0);
    let mag_limit = req.mag_limit.clamp(0.0, 6.5);
    let loc = ObserverLocation {
        lat_deg: req.lat_deg,
        lon_deg: req.lon_deg,
        alt_m: req.alt_m,
        tz_offset_min: req.tz_offset_min,
    };
    search_lunar_occultations(req.start_jd_ut, req.start_jd_ut + span, mag_limit, &loc, store)
        .into_iter()
        .map(|o| LunarOccultationView {
            target_kind: o.target_kind,
            target_id: o.target_id,
            target_name_ja: o.target_name_ja,
            mag: o.mag,
            immersion_jd_ut: o.immersion_jd_ut,
            max_jd_ut: o.max_jd_ut,
            emersion_jd_ut: o.emersion_jd_ut,
            date_local_str: format_local_dt(o.max_jd_ut, req.tz_offset_min),
            immersion_str: format_local_hm_opt(Some(o.immersion_jd_ut), req.tz_offset_min)
                .unwrap_or_default(),
            emersion_str: format_local_hm_opt(Some(o.emersion_jd_ut), req.tz_offset_min)
                .unwrap_or_default(),
            min_sep_arcmin: o.min_sep_arcmin,
            moon_alt_deg: o.moon_alt_deg,
            moon_az_deg: o.moon_az_deg,
            moon_illum_pct: o.moon_illum_pct,
            sun_alt_deg: o.sun_alt_deg,
            dark_limb_immersion: o.dark_limb_immersion,
            ra_deg: o.ra_deg,
            dec_deg: o.dec_deg,
        })
        .collect()
}

#[tauri::command]
pub fn search_lunar_occultations_cmd(
    req: OccultationSearchRequest,
    store: State<'_, CatalogStore>,
) -> Vec<LunarOccultationView> {
    search_lunar_occultations_cmd_impl(&req, &store)
}

#[cfg(test)]
mod tests {
    use crate::engine::catalog::resolve_assets_dir;
    use crate::engine::time::ymd_hms_to_jd;

    use super::*;

    #[test]
    fn meteor_showers_2026_contains_21_plus_sorted_with_scores() {
        let dir = resolve_assets_dir(None).expect("assets directory should exist");
        let store = CatalogStore::load_from_dir(&dir).expect("CatalogStore should load assets");
        let jd = ymd_hms_to_jd(2026, 8, 12, 17, 0, 0.0);
        let list = get_meteor_showers_for_year_impl(
            &MeteorShowersRequest {
                year: 2026,
                current_jd_ut: jd,
                lat_deg: 34.6431,
                lon_deg: 134.9972,
                alt_m: 10.0,
                tz_offset_min: 540,
            },
            &store,
        );

        assert!(list.len() >= 21, "expected >= 21 showers, got {}", list.len());
        for w in list.windows(2) {
            assert!(w[0].peak_jd_ut <= w[1].peak_jd_ut);
        }
        let qua = list.iter().find(|s| s.code == "QUA").expect("QUA present");
        let per = list.iter().find(|s| s.code == "PER").expect("PER present");
        let gem = list.iter().find(|s| s.code == "GEM").expect("GEM present");
        assert!(qua.is_major_three && per.is_major_three && gem.is_major_three);
        assert!(qua.peak_local_str.starts_with("01/"));
        assert!(per.peak_local_str.starts_with("08/"));
        assert!(gem.peak_local_str.starts_with("12/"));
        assert!(per.is_active_now);
        assert!(per.condition_score <= 100);
    }
}
