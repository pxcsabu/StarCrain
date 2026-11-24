use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::engine::catalog::CatalogStore;
use crate::engine::coords::{
    angular_distance_deg, apply_standard_refraction, equatorial_to_horizontal, wrap_deg_180,
    wrap_deg_360,
};
use crate::engine::ephemeris::{
    Planet, geocentric_to_topocentric, moon_apparent_ecliptic_lon_deg, moon_ephemeris,
    planet_ephemeris, sun_apparent_ecliptic_lon_deg, sun_ephemeris,
};
use crate::engine::rise_set::{
    ObserverLocation, RiseSetStatus, moon_rise_set, planet_rise_set, sun_rise_set, sun_twilight,
};
use crate::engine::time::{
    SOLAR_TERMS, calendar_to_jd, equation_of_time_min, find_solar_term_jd_ut,
    gregorian_to_kyureki, japanese_holiday, jd_to_ymd_hms, last_deg, solar_term_on_jst_date,
    ut_to_tt_jd,
};

#[derive(Debug, Clone, Deserialize)]
pub struct ObservationDashboardRequest {
    pub year: i32,
    pub month: u8,
    pub day: u8,
    pub lat_deg: f64,
    pub lon_deg: f64,
    pub alt_m: f64,
    pub tz_offset_min: i32,
}

#[derive(Debug, Clone, Serialize)]
pub struct KyurekiSummary {
    pub year: i32,
    pub month: u8,
    pub is_leap: bool,
    pub day: u8,
    pub label_ja: String,
    pub rokuyo_ja: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SunDaySummary {
    pub rise_jd_ut: Option<f64>,
    pub rise_str: Option<String>,
    pub transit_jd_ut: Option<f64>,
    pub transit_str: Option<String>,
    pub set_jd_ut: Option<f64>,
    pub set_str: Option<String>,
    pub max_alt_deg: f64,
    pub status: String,
    pub daylight_hours: f64,
    pub civil_dawn_str: Option<String>,
    pub civil_dusk_str: Option<String>,
    pub nautical_dawn_str: Option<String>,
    pub nautical_dusk_str: Option<String>,
    pub astro_dawn_jd_ut: Option<f64>,
    pub astro_dawn_str: Option<String>,
    pub astro_dusk_jd_ut: Option<f64>,
    pub astro_dusk_str: Option<String>,
    pub dark_night_hours: f64,
    pub equation_of_time_min: f64,
    pub solar_lon_deg: f64,
    pub ra_deg: f64,
    pub dec_deg: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct MoonDaySummary {
    pub rise_jd_ut: Option<f64>,
    pub rise_str: Option<String>,
    pub transit_jd_ut: Option<f64>,
    pub transit_str: Option<String>,
    pub set_jd_ut: Option<f64>,
    pub set_str: Option<String>,
    pub max_alt_deg: f64,
    pub status: String,
    pub moon_age_21h: f64,
    pub moon_age_noon: f64,
    pub illuminated_fraction: f64,
    pub phase_angle_deg: f64,
    pub waxing: bool,
    pub bright_limb_pa_deg: f64,
    pub distance_km: f64,
    pub angular_diameter_arcmin: f64,
    pub phase_name_ja: String,
    pub ra_deg: f64,
    pub dec_deg: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct PlanetDaySummary {
    pub id: String,
    pub name_ja: String,
    pub mag: f64,
    pub elongation_deg: f64,
    pub rise_jd_ut: Option<f64>,
    pub rise_str: Option<String>,
    pub transit_jd_ut: Option<f64>,
    pub transit_str: Option<String>,
    pub set_jd_ut: Option<f64>,
    pub set_str: Option<String>,
    pub alt_21h_deg: f64,
    pub az_21h_deg: f64,
    pub ra_deg: f64,
    pub dec_deg: f64,
    pub visibility_ja: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DailyPhenomenon {
    pub kind: String,
    pub title_ja: String,
    pub detail_ja: String,
    pub time_str: Option<String>,
    pub jd_ut: f64,
    pub target_ra_deg: Option<f64>,
    pub target_dec_deg: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ObservationDashboard {
    pub year: i32,
    pub month: u8,
    pub day: u8,
    pub date_str: String,
    pub weekday: u8,
    pub weekday_ja: String,
    pub holiday_ja: Option<String>,
    pub solar_term_ja: Option<String>,
    pub next_solar_term_ja: String,
    pub next_solar_term_date: String,
    pub kyureki: KyurekiSummary,
    pub sun: SunDaySummary,
    pub moon: MoonDaySummary,
    pub planets: Vec<PlanetDaySummary>,
    pub phenomena: Vec<DailyPhenomenon>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MoonCalendarRequest {
    pub year: i32,
    pub month: u8,
    pub ref_hour: u8,
    pub ref_minute: u8,
    pub lat_deg: f64,
    pub lon_deg: f64,
    pub alt_m: f64,
    pub tz_offset_min: i32,
}

#[derive(Debug, Clone, Serialize)]
pub struct MoonCalendarDay {
    pub day: u8,
    pub date_str: String,
    pub weekday: u8,
    pub jd_ut: f64,
    pub moon_age_days: f64,
    pub illuminated_fraction: f64,
    pub phase_angle_deg: f64,
    pub waxing: bool,
    pub bright_limb_pa_deg: f64,
    pub phase_event_ja: Option<String>,
    pub phase_event_time: Option<String>,
    pub kyureki_label: String,
    pub kyureki_day: u8,
    pub rokuyo_ja: String,
    pub solar_term_ja: Option<String>,
    pub holiday_ja: Option<String>,
    pub moonrise_str: Option<String>,
    pub moonset_str: Option<String>,
    pub distance_km: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct MoonCalendarMonth {
    pub year: i32,
    pub month: u8,
    pub days_in_month: u8,
    pub first_weekday: u8,
    pub ref_time_str: String,
    pub days: Vec<MoonCalendarDay>,
}

const WEEKDAYS_JA: [&str; 7] = ["日", "月", "火", "水", "木", "金", "土"];

pub(crate) fn days_in_gregorian_month(year: i32, month: u8) -> u8 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            let leap = (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0);
            if leap { 29 } else { 28 }
        }
        _ => 30,
    }
}

#[inline]
pub(crate) fn weekday_sunday_zero(year: i32, month: u8, day: u8) -> u8 {
    let dow = ((calendar_to_jd(year, month, f64::from(day)) + 1.5).round() as i64).rem_euclid(7);
    dow as u8
}

pub(crate) fn format_local_hm(jd_ut: Option<f64>, tz_offset_min: i32) -> Option<String> {
    jd_ut.map(|jd| {
        let local_jd = jd + f64::from(tz_offset_min) / 1440.0 + (0.5 / 1440.0);
        let (_, _, _, h, m, _) = jd_to_ymd_hms(local_jd);
        format!("{h:02}:{m:02}")
    })
}

fn status_label_ja(status: RiseSetStatus) -> &'static str {
    match status {
        RiseSetStatus::Normal => "出没あり",
        RiseSetStatus::Circumpolar => "沈まない",
        RiseSetStatus::NeverRises => "昇らない",
    }
}

pub(crate) fn moon_phase_name_ja(lon_diff_deg: f64, age_days: f64) -> &'static str {
    if !(1.2..28.3).contains(&age_days) {
        "新月"
    } else if lon_diff_deg < 45.0 {
        "三日月・繊月"
    } else if lon_diff_deg < 82.0 {
        "上弦前"
    } else if lon_diff_deg <= 98.0 {
        "上弦の月"
    } else if lon_diff_deg < 135.0 {
        "十三夜頃"
    } else if lon_diff_deg < 172.0 {
        "小望月"
    } else if lon_diff_deg <= 188.0 {
        "満月"
    } else if lon_diff_deg < 225.0 {
        "寝待月"
    } else if lon_diff_deg < 262.0 {
        "更待月"
    } else if lon_diff_deg <= 278.0 {
        "下弦の月"
    } else {
        "有明月"
    }
}

fn planet_id(p: Planet) -> &'static str {
    match p {
        Planet::Mercury => "mercury",
        Planet::Venus => "venus",
        Planet::Mars => "mars",
        Planet::Jupiter => "jupiter",
        Planet::Saturn => "saturn",
        Planet::Uranus => "uranus",
        Planet::Neptune => "neptune",
    }
}

/// Detect whether the Moon–Sun ecliptic elongation crosses 0/90/180/270 deg during `[start_jd_ut, start_jd_ut + 1.0]`.
fn detect_lunar_phase_event_on_day(
    start_jd_ut: f64,
    tz_offset_min: i32,
) -> Option<(&'static str, f64, String)> {
    let elongation_at = |jd_ut: f64| -> f64 {
        let jd_tt = ut_to_tt_jd(jd_ut);
        wrap_deg_360(moon_apparent_ecliptic_lon_deg(jd_tt) - sun_apparent_ecliptic_lon_deg(jd_tt))
    };

    let d0 = elongation_at(start_jd_ut);
    let d1 = elongation_at(start_jd_ut + 1.0);
    let targets = [
        (0.0_f64, "新月"),
        (90.0, "上弦"),
        (180.0, "満月"),
        (270.0, "下弦"),
    ];

    for (target, label) in targets {
        let off0 = wrap_deg_180(d0 - target);
        let off1 = wrap_deg_180(d1 - target);
        if off0 <= 0.0 && off1 > 0.0 && (off1 - off0) < 30.0 {
            let mut a = start_jd_ut;
            let mut b = start_jd_ut + 1.0;
            for _ in 0..28 {
                let mid = 0.5 * (a + b);
                if wrap_deg_180(elongation_at(mid) - target) < 0.0 {
                    a = mid;
                } else {
                    b = mid;
                }
            }
            let exact_jd = 0.5 * (a + b);
            let time_str = format_local_hm(Some(exact_jd), tz_offset_min).unwrap_or_default();
            return Some((label, exact_jd, time_str));
        }
    }
    None
}

pub(crate) fn is_mmdd_in_active_window(month: u8, day: u8, start: &str, end: &str) -> bool {
    let parse_mmdd = |s: &str| -> Option<u16> {
        let (m_str, d_str) = s.split_once('-')?;
        let m: u16 = m_str.trim().parse().ok()?;
        let d: u16 = d_str.trim().parse().ok()?;
        Some(m * 100 + d)
    };
    let Some(s_val) = parse_mmdd(start) else {
        return false;
    };
    let Some(e_val) = parse_mmdd(end) else {
        return false;
    };
    let cur = u16::from(month) * 100 + u16::from(day);
    if s_val <= e_val {
        cur >= s_val && cur <= e_val
    } else {
        cur >= s_val || cur <= e_val
    }
}

fn find_next_solar_term(start_jd_ut: f64, year: i32, tz_offset_min: i32) -> (String, String) {
    let mut candidates: Vec<(f64, &'static str)> = Vec::with_capacity(48);
    for y in [year, year + 1] {
        for term in SOLAR_TERMS {
            let jd = find_solar_term_jd_ut(y, term.index);
            if jd >= start_jd_ut {
                candidates.push((jd, term.name_ja));
            }
        }
    }
    candidates.sort_by(|a, b| a.0.total_cmp(&b.0));
    if let Some((jd, name)) = candidates.first() {
        let local_jd = *jd + f64::from(tz_offset_min) / 1440.0;
        let (_, m, d, h, min, _) = jd_to_ymd_hms(local_jd);
        (
            (*name).to_owned(),
            format!("{m:02}/{d:02} {h:02}:{min:02}"),
        )
    } else {
        ("---".to_owned(), "---".to_owned())
    }
}

pub fn get_observation_dashboard_impl(
    req: &ObservationDashboardRequest,
    store: &CatalogStore,
) -> ObservationDashboard {
    let loc = ObserverLocation {
        lat_deg: req.lat_deg,
        lon_deg: req.lon_deg,
        alt_m: req.alt_m,
        tz_offset_min: req.tz_offset_min,
    };
    let tz_days = f64::from(req.tz_offset_min) / 1440.0;
    let midnight_jd_ut = calendar_to_jd(req.year, req.month, f64::from(req.day)) - tz_days;
    let noon_jd_ut = midnight_jd_ut + 0.5;
    let eve_21h_jd_ut = midnight_jd_ut + 21.0 / 24.0;
    let eve_21h_tt = ut_to_tt_jd(eve_21h_jd_ut);
    let noon_tt = ut_to_tt_jd(noon_jd_ut);

    let weekday = weekday_sunday_zero(req.year, req.month, req.day);
    let weekday_ja = WEEKDAYS_JA[usize::from(weekday)].to_owned();
    let date_str = format!("{:04}-{:02}-{:02}", req.year, req.month, req.day);
    let holiday_ja = japanese_holiday(req.year, req.month, req.day).map(str::to_owned);
    let solar_term_ja = solar_term_on_jst_date(req.year, req.month, req.day).map(str::to_owned);
    let (next_solar_term_ja, next_solar_term_date) =
        find_next_solar_term(midnight_jd_ut, req.year, req.tz_offset_min);

    let ky = gregorian_to_kyureki(req.year, req.month, req.day);
    let leap_prefix = if ky.is_leap { "閏" } else { "" };
    let kyureki = KyurekiSummary {
        year: ky.year,
        month: ky.month,
        is_leap: ky.is_leap,
        day: ky.day,
        label_ja: format!("旧暦 {}{}月{}日", leap_prefix, ky.month, ky.day),
        rokuyo_ja: ky.rokuyo.name_ja().to_owned(),
    };

    // Sun & twilight
    let sun_rs = sun_rise_set(&loc, req.year, req.month, req.day);
    let twi = sun_twilight(&loc, req.year, req.month, req.day);
    let daylight_hours = match (sun_rs.rise_jd_ut, sun_rs.set_jd_ut) {
        (Some(r), Some(s)) if s >= r => (s - r) * 24.0,
        _ => match sun_rs.status {
            RiseSetStatus::Circumpolar => 24.0,
            _ => 0.0,
        },
    };
    let dark_night_hours = match (twi.astro_dawn_jd_ut, twi.astro_dusk_jd_ut) {
        (Some(dawn), Some(dusk)) => ((dawn + 1.0 - dusk).clamp(0.0, 1.0)) * 24.0,
        _ => 0.0,
    };
    let sun_noon = sun_ephemeris(noon_tt);
    let sun_21h = sun_ephemeris(eve_21h_tt);
    let sun = SunDaySummary {
        rise_jd_ut: sun_rs.rise_jd_ut,
        rise_str: format_local_hm(sun_rs.rise_jd_ut, req.tz_offset_min),
        transit_jd_ut: sun_rs.transit_jd_ut,
        transit_str: format_local_hm(sun_rs.transit_jd_ut, req.tz_offset_min),
        set_jd_ut: sun_rs.set_jd_ut,
        set_str: format_local_hm(sun_rs.set_jd_ut, req.tz_offset_min),
        max_alt_deg: sun_rs.max_alt_deg,
        status: status_label_ja(sun_rs.status).to_owned(),
        daylight_hours,
        civil_dawn_str: format_local_hm(twi.civil_dawn_jd_ut, req.tz_offset_min),
        civil_dusk_str: format_local_hm(twi.civil_dusk_jd_ut, req.tz_offset_min),
        nautical_dawn_str: format_local_hm(twi.nautical_dawn_jd_ut, req.tz_offset_min),
        nautical_dusk_str: format_local_hm(twi.nautical_dusk_jd_ut, req.tz_offset_min),
        astro_dawn_jd_ut: twi.astro_dawn_jd_ut,
        astro_dawn_str: format_local_hm(twi.astro_dawn_jd_ut, req.tz_offset_min),
        astro_dusk_jd_ut: twi.astro_dusk_jd_ut,
        astro_dusk_str: format_local_hm(twi.astro_dusk_jd_ut, req.tz_offset_min),
        dark_night_hours,
        equation_of_time_min: equation_of_time_min(noon_tt),
        solar_lon_deg: sun_apparent_ecliptic_lon_deg(noon_tt),
        ra_deg: sun_noon.eq_apparent.ra_deg,
        dec_deg: sun_noon.eq_apparent.dec_deg,
    };

    // Moon
    let moon_rs = moon_rise_set(&loc, req.year, req.month, req.day);
    let moon_21h = moon_ephemeris(eve_21h_tt);
    let moon_noon = moon_ephemeris(noon_tt);
    let lon_diff_21h =
        wrap_deg_360(moon_apparent_ecliptic_lon_deg(eve_21h_tt) - sun_apparent_ecliptic_lon_deg(eve_21h_tt));
    let moon = MoonDaySummary {
        rise_jd_ut: moon_rs.rise_jd_ut,
        rise_str: format_local_hm(moon_rs.rise_jd_ut, req.tz_offset_min),
        transit_jd_ut: moon_rs.transit_jd_ut,
        transit_str: format_local_hm(moon_rs.transit_jd_ut, req.tz_offset_min),
        set_jd_ut: moon_rs.set_jd_ut,
        set_str: format_local_hm(moon_rs.set_jd_ut, req.tz_offset_min),
        max_alt_deg: moon_rs.max_alt_deg,
        status: status_label_ja(moon_rs.status).to_owned(),
        moon_age_21h: moon_21h.age_days,
        moon_age_noon: moon_noon.age_days,
        illuminated_fraction: moon_21h.illuminated_fraction,
        phase_angle_deg: moon_21h.phase_angle_deg,
        waxing: lon_diff_21h < 180.0,
        bright_limb_pa_deg: moon_21h.position_angle_bright_limb_deg,
        distance_km: moon_21h.distance_km,
        angular_diameter_arcmin: moon_21h.angular_diameter_arcsec / 60.0,
        phase_name_ja: moon_phase_name_ja(lon_diff_21h, moon_21h.age_days).to_owned(),
        ra_deg: moon_21h.eq_apparent.ra_deg,
        dec_deg: moon_21h.eq_apparent.dec_deg,
    };

    // Planets tonight at 21:00 local
    let lst_21h = last_deg(eve_21h_jd_ut, req.lon_deg);
    let planets: Vec<PlanetDaySummary> = Planet::ALL
        .iter()
        .map(|&p| {
            let eph = planet_ephemeris(p, eve_21h_tt);
            let rs = planet_rise_set(p, &loc, req.year, req.month, req.day);
            let topo =
                geocentric_to_topocentric(eph.eq_apparent, eph.geo_au, req.lat_deg, req.alt_m, lst_21h);
            let mut hor = equatorial_to_horizontal(topo, req.lat_deg, lst_21h);
            hor.alt_deg = apply_standard_refraction(hor.alt_deg);

            let visibility_ja = if hor.alt_deg > 10.0 {
                "21時 観測好機"
            } else if eph.elongation_deg < 12.0 {
                "太陽至近（観測困難）"
            } else if hor.alt_deg > 0.0 {
                "21時 低空"
            } else {
                match (rs.rise_jd_ut, rs.set_jd_ut) {
                    (Some(r), _) if r > eve_21h_jd_ut => "深夜〜明け方",
                    (_, Some(s)) if s < eve_21h_jd_ut => "夕方の西空",
                    _ => "夜半〜未明",
                }
            };

            PlanetDaySummary {
                id: planet_id(p).to_owned(),
                name_ja: p.name_ja().to_owned(),
                mag: eph.visual_magnitude,
                elongation_deg: eph.elongation_deg,
                rise_jd_ut: rs.rise_jd_ut,
                rise_str: format_local_hm(rs.rise_jd_ut, req.tz_offset_min),
                transit_jd_ut: rs.transit_jd_ut,
                transit_str: format_local_hm(rs.transit_jd_ut, req.tz_offset_min),
                set_jd_ut: rs.set_jd_ut,
                set_str: format_local_hm(rs.set_jd_ut, req.tz_offset_min),
                alt_21h_deg: hor.alt_deg,
                az_21h_deg: hor.az_deg,
                ra_deg: eph.eq_apparent.ra_deg,
                dec_deg: eph.eq_apparent.dec_deg,
                visibility_ja: visibility_ja.to_owned(),
            }
        })
        .collect();

    // Daily Phenomena
    let mut phenomena: Vec<DailyPhenomenon> = Vec::new();
    if let Some((phase_label, jd_exact, hm)) =
        detect_lunar_phase_event_on_day(midnight_jd_ut, req.tz_offset_min)
    {
        let me = moon_ephemeris(ut_to_tt_jd(jd_exact));
        phenomena.push(DailyPhenomenon {
            kind: "moon_phase".to_owned(),
            title_ja: format!("{phase_label}（{hm}）"),
            detail_ja: format!("月・太陽黄経差が到達 / 月距離 {:.0} km", me.distance_km),
            time_str: Some(hm),
            jd_ut: jd_exact,
            target_ra_deg: Some(me.eq_apparent.ra_deg),
            target_dec_deg: Some(me.eq_apparent.dec_deg),
        });
    }

    if let Some(ref st_name) = solar_term_ja {
        phenomena.push(DailyPhenomenon {
            kind: "solar_term".to_owned(),
            title_ja: format!("二十四節気: {st_name}"),
            detail_ja: format!("太陽黄経 {:.1}°", sun_21h.ecliptic_apparent.lon_deg),
            time_str: None,
            jd_ut: noon_jd_ut,
            target_ra_deg: Some(sun_noon.eq_apparent.ra_deg),
            target_dec_deg: Some(sun_noon.eq_apparent.dec_deg),
        });
    }

    // Active or peak meteor showers today
    let sun_lon_noon = sun_apparent_ecliptic_lon_deg(noon_tt);
    for sh in &store.meteor_showers {
        let lon_diff = wrap_deg_180(sun_lon_noon - sh.peak_solar_lon_deg).abs();
        if lon_diff <= 1.2 {
            phenomena.push(DailyPhenomenon {
                kind: "meteor".to_owned(),
                title_ja: format!("{} 極大期", sh.name_ja),
                detail_ja: format!("ZHR {} / 放射点: {}座 / 速度 {} km/s", sh.zhr, sh.constellation, sh.velocity_km_s),
                time_str: Some("02:00".to_owned()),
                jd_ut: midnight_jd_ut + 2.0 / 24.0,
                target_ra_deg: Some(sh.ra_deg),
                target_dec_deg: Some(sh.dec_deg),
            });
        } else if is_mmdd_in_active_window(req.month, req.day, &sh.active_start, &sh.active_end) {
            phenomena.push(DailyPhenomenon {
                kind: "meteor".to_owned(),
                title_ja: format!("{} 活動期間中", sh.name_ja),
                detail_ja: format!("極大 {} 頃 (ZHR {})", sh.peak_date, sh.zhr),
                time_str: None,
                jd_ut: eve_21h_jd_ut,
                target_ra_deg: Some(sh.ra_deg),
                target_dec_deg: Some(sh.dec_deg),
            });
        }
    }

    // Moon–Planet close approaches (< 6.0 deg at 21:00)
    for pl in &planets {
        let sep = angular_distance_deg(moon_21h.eq_apparent, crate::engine::coords::Equatorial {
            ra_deg: pl.ra_deg,
            dec_deg: pl.dec_deg,
        });
        if sep <= 6.0 {
            phenomena.push(DailyPhenomenon {
                kind: "conjunction".to_owned(),
                title_ja: format!("月と{}が接近（{sep:.1}°）", pl.name_ja),
                detail_ja: format!("21:00時点の角距離 {sep:.2}° / {} {:.1}等", pl.name_ja, pl.mag),
                time_str: Some("21:00".to_owned()),
                jd_ut: eve_21h_jd_ut,
                target_ra_deg: Some(pl.ra_deg),
                target_dec_deg: Some(pl.dec_deg),
            });
        }
    }

    // Planet–Planet close approaches (< 3.5 deg)
    for i in 0..planets.len() {
        for j in (i + 1)..planets.len() {
            let p1 = &planets[i];
            let p2 = &planets[j];
            let sep = angular_distance_deg(
                crate::engine::coords::Equatorial { ra_deg: p1.ra_deg, dec_deg: p1.dec_deg },
                crate::engine::coords::Equatorial { ra_deg: p2.ra_deg, dec_deg: p2.dec_deg },
            );
            if sep <= 3.5 {
                phenomena.push(DailyPhenomenon {
                    kind: "conjunction".to_owned(),
                    title_ja: format!("{}と{}が接近（{sep:.1}°）", p1.name_ja, p2.name_ja),
                    detail_ja: format!("21:00時点の角距離 {sep:.2}°"),
                    time_str: Some("21:00".to_owned()),
                    jd_ut: eve_21h_jd_ut,
                    target_ra_deg: Some(p1.ra_deg),
                    target_dec_deg: Some(p1.dec_deg),
                });
            }
        }
    }

    ObservationDashboard {
        year: req.year,
        month: req.month,
        day: req.day,
        date_str,
        weekday,
        weekday_ja,
        holiday_ja,
        solar_term_ja,
        next_solar_term_ja,
        next_solar_term_date,
        kyureki,
        sun,
        moon,
        planets,
        phenomena,
    }
}

#[tauri::command]
pub fn get_observation_dashboard(
    req: ObservationDashboardRequest,
    store: State<'_, CatalogStore>,
) -> ObservationDashboard {
    get_observation_dashboard_impl(&req, &store)
}

pub fn get_moon_calendar_impl(req: &MoonCalendarRequest) -> MoonCalendarMonth {
    let days_in_month = days_in_gregorian_month(req.year, req.month);
    let first_weekday = weekday_sunday_zero(req.year, req.month, 1);
    let tz_days = f64::from(req.tz_offset_min) / 1440.0;
    let ref_frac =
        (f64::from(req.ref_hour.min(23)) + f64::from(req.ref_minute.min(59)) / 60.0) / 24.0;
    let loc = ObserverLocation {
        lat_deg: req.lat_deg,
        lon_deg: req.lon_deg,
        alt_m: req.alt_m,
        tz_offset_min: req.tz_offset_min,
    };

    let days: Vec<MoonCalendarDay> = (1..=days_in_month)
        .into_par_iter()
        .map(|day| {
            let midnight_jd_ut = calendar_to_jd(req.year, req.month, f64::from(day)) - tz_days;
            let jd_ut = midnight_jd_ut + ref_frac;
            let jd_tt = ut_to_tt_jd(jd_ut);
            let me = moon_ephemeris(jd_tt);
            let lon_diff =
                wrap_deg_360(moon_apparent_ecliptic_lon_deg(jd_tt) - sun_apparent_ecliptic_lon_deg(jd_tt));
            let rs = moon_rise_set(&loc, req.year, req.month, day);
            let phase_event = detect_lunar_phase_event_on_day(midnight_jd_ut, req.tz_offset_min);
            let ky = gregorian_to_kyureki(req.year, req.month, day);
            let leap_p = if ky.is_leap { "閏" } else { "" };

            MoonCalendarDay {
                day,
                date_str: format!("{:04}-{:02}-{:02}", req.year, req.month, day),
                weekday: weekday_sunday_zero(req.year, req.month, day),
                jd_ut,
                moon_age_days: me.age_days,
                illuminated_fraction: me.illuminated_fraction,
                phase_angle_deg: me.phase_angle_deg,
                waxing: lon_diff < 180.0,
                bright_limb_pa_deg: me.position_angle_bright_limb_deg,
                phase_event_ja: phase_event.as_ref().map(|x| x.0.to_owned()),
                phase_event_time: phase_event.map(|x| x.2),
                kyureki_label: format!("{}{}月{}日", leap_p, ky.month, ky.day),
                kyureki_day: ky.day,
                rokuyo_ja: ky.rokuyo.name_ja().to_owned(),
                solar_term_ja: solar_term_on_jst_date(req.year, req.month, day).map(str::to_owned),
                holiday_ja: japanese_holiday(req.year, req.month, day).map(str::to_owned),
                moonrise_str: format_local_hm(rs.rise_jd_ut, req.tz_offset_min),
                moonset_str: format_local_hm(rs.set_jd_ut, req.tz_offset_min),
                distance_km: me.distance_km,
            }
        })
        .collect();

    MoonCalendarMonth {
        year: req.year,
        month: req.month,
        days_in_month,
        first_weekday,
        ref_time_str: format!("{:02}:{:02}", req.ref_hour.min(23), req.ref_minute.min(59)),
        days,
    }
}

#[tauri::command]
pub fn get_moon_calendar(req: MoonCalendarRequest) -> MoonCalendarMonth {
    get_moon_calendar_impl(&req)
}

#[cfg(test)]
mod tests {
    use crate::engine::catalog::resolve_assets_dir;

    use super::*;

    #[test]
    fn observation_dashboard_2026_new_year_akashi() {
        let dir = resolve_assets_dir(None).expect("assets directory should exist");
        let store = CatalogStore::load_from_dir(&dir).expect("CatalogStore should load assets");
        let dash = get_observation_dashboard_impl(
            &ObservationDashboardRequest {
                year: 2026,
                month: 1,
                day: 1,
                lat_deg: 34.6431,
                lon_deg: 134.9972,
                alt_m: 10.0,
                tz_offset_min: 540,
            },
            &store,
        );

        assert_eq!(dash.holiday_ja.as_deref(), Some("元日"));
        assert_eq!(dash.sun.rise_str.as_deref(), Some("07:07"));
        assert_eq!(dash.planets.len(), 7);
        assert!(dash.moon.moon_age_21h > 10.0 && dash.moon.moon_age_21h < 15.0);
        assert!(!dash.kyureki.label_ja.is_empty());
        assert!(!dash.kyureki.rokuyo_ja.is_empty());
        assert!(
            dash.phenomena.iter().any(|p| p.kind == "meteor" && p.title_ja.contains("しぶんぎ座")),
            "Quadrantids should be active on Jan 1"
        );
    }

    #[test]
    fn moon_calendar_2026_sep_holidays_and_phases() {
        let cal = get_moon_calendar_impl(&MoonCalendarRequest {
            year: 2026,
            month: 9,
            ref_hour: 21,
            ref_minute: 0,
            lat_deg: 34.6431,
            lon_deg: 134.9972,
            alt_m: 10.0,
            tz_offset_min: 540,
        });
        assert_eq!(cal.days_in_month, 30);
        assert_eq!(cal.days.len(), 30);
        assert_eq!(cal.days[20].holiday_ja.as_deref(), Some("敬老の日"));
        assert_eq!(cal.days[21].holiday_ja.as_deref(), Some("国民の休日"));
        assert_eq!(cal.days[22].holiday_ja.as_deref(), Some("秋分の日"));
        assert_eq!(cal.days[22].solar_term_ja.as_deref(), Some("秋分"));
        assert!(cal.days.iter().any(|d| d.phase_event_ja.is_some()));
        for d in &cal.days {
            assert!(d.moon_age_days >= 0.0 && d.moon_age_days < 30.0);
            assert!(d.illuminated_fraction >= 0.0 && d.illuminated_fraction <= 1.0);
        }
    }
}
