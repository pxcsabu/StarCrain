//! SGP4 satellite and ISS propagation + pass prediction calculations (Phase 8).

use chrono::{Datelike, Timelike};
use serde::{Deserialize, Serialize};
use sgp4::{Constants, Elements, MinutesSinceEpoch};

use crate::commands::calendar::format_local_hm;
use crate::engine::comet_db::SatelliteRecord;
use crate::engine::coords::{
    Horizontal, apply_standard_refraction, equatorial_to_horizontal, equatorial_to_vec3,
    horizontal_to_equatorial, wrap_deg_360,
};
use crate::engine::ephemeris::{geocentric_to_topocentric, sun_ephemeris};
use crate::engine::rise_set::ObserverLocation;
use crate::engine::time::{gmst_deg, last_deg, ut_to_tt_jd, ymd_hms_to_jd};

const WGS84_A_KM: f64 = 6378.137;
const WGS84_F: f64 = 1.0 / 298.257_223_563;
const WGS84_E2: f64 = WGS84_F * (2.0 - WGS84_F);
const EARTH_MEAN_RADIUS_KM: f64 = 6371.0;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SatelliteSkyPos {
    pub id: String,
    pub norad_id: u32,
    pub name: String,
    pub category: String,
    pub enabled: bool,
    pub ra_deg: f64,
    pub dec_deg: f64,
    pub az_deg: f64,
    pub alt_deg: f64,
    pub range_km: f64,
    pub altitude_km: f64,
    pub velocity_km_s: f64,
    pub subpoint_lat_deg: f64,
    pub subpoint_lon_deg: f64,
    pub is_sunlit: bool,
    pub is_visible: bool,
    pub epoch_age_days: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SatellitePassPoint {
    pub jd_ut: f64,
    pub az_deg: f64,
    pub alt_deg: f64,
    pub range_km: f64,
    pub is_sunlit: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SatellitePass {
    pub sat_id: String,
    pub sat_name: String,
    pub norad_id: u32,
    pub aos_jd_ut: f64,
    pub aos_str: String,
    pub aos_az_deg: f64,
    pub max_jd_ut: f64,
    pub max_str: String,
    pub max_alt_deg: f64,
    pub max_az_deg: f64,
    pub los_jd_ut: f64,
    pub los_str: String,
    pub los_az_deg: f64,
    pub duration_sec: u32,
    pub is_sunlit_max: bool,
    pub sun_alt_at_max_deg: f64,
    pub is_visible: bool,
    pub track: Vec<SatellitePassPoint>,
}

/// Strictly parse plain-text 3-line or 2-line TLE text into validated `SatelliteRecord`s.
pub fn parse_tle_text(text: &str, category: &str) -> Vec<SatelliteRecord> {
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.chars().any(|c| c.is_control() && c != '\t'))
        .collect();

    let mut out = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        if lines[i].starts_with("1 ") && i + 1 < lines.len() && lines[i + 1].starts_with("2 ") {
            let l1 = lines[i];
            let l2 = lines[i + 1];
            if let Ok(el) = Elements::from_tle(None, l1.as_bytes(), l2.as_bytes()) {
                let norad = el.norad_id as u32;
                out.push(SatelliteRecord {
                    id: format!("sat:{norad}"),
                    norad_id: norad,
                    name: format!("NORAD {norad}"),
                    line1: l1.to_owned(),
                    line2: l2.to_owned(),
                    category: category.to_owned(),
                    enabled: true,
                });
            }
            i += 2;
        } else if i + 2 < lines.len()
            && !lines[i].starts_with("1 ")
            && !lines[i].starts_with("2 ")
            && lines[i + 1].starts_with("1 ")
            && lines[i + 2].starts_with("2 ")
        {
            let name = lines[i].trim().trim_start_matches('0').trim().to_owned();
            let l1 = lines[i + 1];
            let l2 = lines[i + 2];
            if let Ok(el) = Elements::from_tle(Some(name.clone()), l1.as_bytes(), l2.as_bytes()) {
                let norad = el.norad_id as u32;
                let final_name = if name.is_empty() {
                    format!("NORAD {norad}")
                } else {
                    name
                };
                out.push(SatelliteRecord {
                    id: format!("sat:{norad}"),
                    norad_id: norad,
                    name: final_name,
                    line1: l1.to_owned(),
                    line2: l2.to_owned(),
                    category: category.to_owned(),
                    enabled: true,
                });
            }
            i += 3;
        } else {
            i += 1;
        }
    }
    out
}

fn elements_epoch_jd(el: &Elements) -> f64 {
    let dt = &el.datetime;
    let sec = f64::from(dt.second()) + f64::from(dt.nanosecond()) / 1e9;
    ymd_hms_to_jd(
        dt.year(),
        dt.month() as u8,
        dt.day() as u8,
        dt.hour() as u8,
        dt.minute() as u8,
        sec,
    )
}

fn observer_ecef_km(lat_deg: f64, lon_deg: f64, alt_m: f64) -> ([f64; 3], f64, f64) {
    let lat = lat_deg.to_radians();
    let lon = lon_deg.to_radians();
    let (slat, clat) = lat.sin_cos();
    let (slon, clon) = lon.sin_cos();
    let n = WGS84_A_KM / (1.0 - WGS84_E2 * slat * slat).sqrt();
    let alt_km = alt_m / 1000.0;
    let x = (n + alt_km) * clat * clon;
    let y = (n + alt_km) * clat * slon;
    let z = (n * (1.0 - WGS84_E2) + alt_km) * slat;
    ([x, y, z], lat, lon)
}

fn ecef_to_geodetic_deg_km(pos: [f64; 3]) -> (f64, f64, f64) {
    let [x, y, z] = pos;
    let r_xy = (x * x + y * y).sqrt();
    let lon_deg = y.atan2(x).to_degrees();
    let mut lat = z.atan2(r_xy * (1.0 - WGS84_E2));
    for _ in 0..5 {
        let slat = lat.sin();
        let n = WGS84_A_KM / (1.0 - WGS84_E2 * slat * slat).sqrt();
        lat = (z + WGS84_E2 * n * slat).atan2(r_xy);
    }
    let slat = lat.sin();
    let clat = lat.cos();
    let n = WGS84_A_KM / (1.0 - WGS84_E2 * slat * slat).sqrt();
    let alt_km = if clat.abs() > 1e-6 {
        r_xy / clat - n
    } else {
        z.abs() / slat.abs() - n * (1.0 - WGS84_E2)
    };
    (lat.to_degrees(), lon_deg, alt_km)
}

struct SatEval {
    ra_deg: f64,
    dec_deg: f64,
    az_deg: f64,
    alt_deg: f64,
    range_km: f64,
    altitude_km: f64,
    vel_km_s: f64,
    sub_lat: f64,
    sub_lon: f64,
    is_sunlit: bool,
    sun_alt_deg: f64,
}

fn eval_sat_internal(
    constants: &Constants,
    epoch_jd: f64,
    jd_ut: f64,
    loc: &ObserverLocation,
    refraction: bool,
) -> Result<SatEval, String> {
    let dt_min = (jd_ut - epoch_jd) * 1440.0;
    let pred = constants
        .propagate(MinutesSinceEpoch(dt_min))
        .map_err(|e| format!("SGP4伝播エラー: {e}"))?;

    let [rx, ry, rz] = pred.position;
    let [vx, vy, vz] = pred.velocity;
    let vel_km_s = (vx * vx + vy * vy + vz * vz).sqrt();

    let theta = gmst_deg(jd_ut).to_radians();
    let (st, ct) = theta.sin_cos();
    let ecef_sat = [rx * ct + ry * st, -rx * st + ry * ct, rz];

    let (obs_ecef, lat_rad, lon_rad) = observer_ecef_km(loc.lat_deg, loc.lon_deg, loc.alt_m);
    let dx = ecef_sat[0] - obs_ecef[0];
    let dy = ecef_sat[1] - obs_ecef[1];
    let dz = ecef_sat[2] - obs_ecef[2];

    let (slat, clat) = lat_rad.sin_cos();
    let (slon, clon) = lon_rad.sin_cos();

    let east = -slon * dx + clon * dy;
    let north = -slat * clon * dx - slat * slon * dy + clat * dz;
    let up = clat * clon * dx + clat * slon * dy + slat * dz;

    let range_km = (east * east + north * north + up * up).sqrt();
    let az_deg = wrap_deg_360(east.atan2(north).to_degrees());
    let true_alt_deg = (up / range_km.max(1e-6)).clamp(-1.0, 1.0).asin().to_degrees();
    let alt_deg = if refraction {
        apply_standard_refraction(true_alt_deg)
    } else {
        true_alt_deg
    };

    let (sub_lat, sub_lon, altitude_km) = ecef_to_geodetic_deg_km(ecef_sat);

    let last = last_deg(jd_ut, loc.lon_deg);
    let eq_app = horizontal_to_equatorial(
        Horizontal {
            az_deg,
            alt_deg: true_alt_deg,
        },
        loc.lat_deg,
        last,
    );

    // Cylindrical Earth shadow & observer Sun altitude check
    let sun = sun_ephemeris(ut_to_tt_jd(jd_ut));
    let sun_u = equatorial_to_vec3(sun.eq_apparent);
    let dot_sun = rx * sun_u.x + ry * sun_u.y + rz * sun_u.z;
    let r2 = rx * rx + ry * ry + rz * rz;
    let is_sunlit = if dot_sun >= 0.0 {
        true
    } else {
        let perp2 = (r2 - dot_sun * dot_sun).max(0.0);
        perp2.sqrt() > EARTH_MEAN_RADIUS_KM
    };

    let sun_topo =
        geocentric_to_topocentric(sun.eq_apparent, sun.geo_au, loc.lat_deg, loc.alt_m, last);
    let sun_alt_deg = equatorial_to_horizontal(sun_topo, loc.lat_deg, last).alt_deg;

    Ok(SatEval {
        ra_deg: eq_app.ra_deg,
        dec_deg: eq_app.dec_deg,
        az_deg,
        alt_deg,
        range_km,
        altitude_km,
        vel_km_s,
        sub_lat,
        sub_lon,
        is_sunlit,
        sun_alt_deg,
    })
}

pub fn propagate_satellite_at(
    rec: &SatelliteRecord,
    jd_ut: f64,
    loc: &ObserverLocation,
    refraction: bool,
) -> Result<SatelliteSkyPos, String> {
    let el = Elements::from_tle(
        Some(rec.name.clone()),
        rec.line1.trim().as_bytes(),
        rec.line2.trim().as_bytes(),
    )
    .map_err(|e| format!("{} のTLE解析エラー: {e}", rec.name))?;
    let epoch_jd = elements_epoch_jd(&el);
    let constants = Constants::from_elements(&el)
        .map_err(|e| format!("{} のSGP4定数生成エラー: {e}", rec.name))?;

    let ev = eval_sat_internal(&constants, epoch_jd, jd_ut, loc, refraction)?;
    let is_visible = ev.alt_deg > 0.0 && ev.is_sunlit && ev.sun_alt_deg < -4.0;

    Ok(SatelliteSkyPos {
        id: rec.id.clone(),
        norad_id: rec.norad_id,
        name: rec.name.clone(),
        category: rec.category.clone(),
        enabled: rec.enabled,
        ra_deg: ev.ra_deg,
        dec_deg: ev.dec_deg,
        az_deg: ev.az_deg,
        alt_deg: ev.alt_deg,
        range_km: ev.range_km,
        altitude_km: ev.altitude_km,
        velocity_km_s: ev.vel_km_s,
        subpoint_lat_deg: ev.sub_lat,
        subpoint_lon_deg: ev.sub_lon,
        is_sunlit: ev.is_sunlit,
        is_visible,
        epoch_age_days: jd_ut - epoch_jd,
    })
}

fn refine_horizon_crossing(
    constants: &Constants,
    epoch_jd: f64,
    loc: &ObserverLocation,
    mut a: f64,
    mut b: f64,
    rising: bool,
) -> f64 {
    for _ in 0..16 {
        let mid = 0.5 * (a + b);
        let alt = eval_sat_internal(constants, epoch_jd, mid, loc, false)
            .map(|r| r.alt_deg)
            .unwrap_or(-90.0);
        if rising {
            if alt < 0.0 {
                a = mid;
            } else {
                b = mid;
            }
        } else if alt >= 0.0 {
            a = mid;
        } else {
            b = mid;
        }
    }
    0.5 * (a + b)
}

pub fn predict_satellite_passes(
    rec: &SatelliteRecord,
    start_jd_ut: f64,
    hours: f64,
    min_max_alt_deg: f64,
    visible_only: bool,
    loc: &ObserverLocation,
) -> Result<Vec<SatellitePass>, String> {
    let el = Elements::from_tle(
        Some(rec.name.clone()),
        rec.line1.trim().as_bytes(),
        rec.line2.trim().as_bytes(),
    )
    .map_err(|e| format!("{} のTLE解析エラー: {e}", rec.name))?;
    let epoch_jd = elements_epoch_jd(&el);
    let constants = Constants::from_elements(&el)
        .map_err(|e| format!("{} のSGP4定数生成エラー: {e}", rec.name))?;

    let span_hours = hours.clamp(6.0, 120.0);
    let step_days = 30.0 / 86400.0; // 30-second step
    let steps = ((span_hours * 3600.0) / 30.0).ceil() as usize;

    let mut passes = Vec::new();
    let mut prev_jd = start_jd_ut;
    let mut prev_alt = eval_sat_internal(&constants, epoch_jd, prev_jd, loc, false)
        .map(|r| r.alt_deg)
        .unwrap_or(-90.0);

    let mut active_aos: Option<f64> = if prev_alt >= 0.0 { Some(prev_jd) } else { None };
    let mut active_max_jd = prev_jd;
    let mut active_max_alt = prev_alt;

    for i in 1..=steps {
        let jd = start_jd_ut + (i as f64) * step_days;
        let Ok(res) = eval_sat_internal(&constants, epoch_jd, jd, loc, false) else {
            active_aos = None;
            prev_jd = jd;
            prev_alt = -90.0;
            continue;
        };
        let alt = res.alt_deg;

        if active_aos.is_none() && prev_alt < 0.0 && alt >= 0.0 {
            let aos = refine_horizon_crossing(&constants, epoch_jd, loc, prev_jd, jd, true);
            active_aos = Some(aos);
            active_max_jd = jd;
            active_max_alt = alt;
        } else if active_aos.is_some() && alt > active_max_alt {
            active_max_alt = alt;
            active_max_jd = jd;
        }

        if let Some(aos_jd) = active_aos
            && ((prev_alt >= 0.0 && alt < 0.0) || i == steps)
        {
            let los_jd = if alt < 0.0 {
                refine_horizon_crossing(&constants, epoch_jd, loc, prev_jd, jd, false)
            } else {
                jd
            };

            // Fine-tune TCA around active_max_jd
            let mut best_tca_jd = active_max_jd;
            let mut best_tca_alt = active_max_alt;
            for dt_s in -30..=30 {
                let probe = active_max_jd + f64::from(dt_s) / 86400.0;
                if let Ok(r) = eval_sat_internal(&constants, epoch_jd, probe, loc, false)
                    && r.alt_deg > best_tca_alt
                {
                    best_tca_alt = r.alt_deg;
                    best_tca_jd = probe;
                }
            }

            if best_tca_alt >= min_max_alt_deg
                && let (Ok(aos_ev), Ok(max_ev), Ok(los_ev)) = (
                    eval_sat_internal(&constants, epoch_jd, aos_jd, loc, true),
                    eval_sat_internal(&constants, epoch_jd, best_tca_jd, loc, true),
                    eval_sat_internal(&constants, epoch_jd, los_jd, loc, true),
                )
            {
                let sun_alt_max = max_ev.sun_alt_deg;
                let is_sunlit_max = max_ev.is_sunlit;
                let is_visible = is_sunlit_max && sun_alt_max < -4.0;
                if !visible_only || is_visible {
                    let track_steps = 20usize;
                    let mut track = Vec::with_capacity(track_steps + 1);
                    for k in 0..=track_steps {
                        let tj = aos_jd + (los_jd - aos_jd) * (k as f64 / track_steps as f64);
                        if let Ok(ev) = eval_sat_internal(&constants, epoch_jd, tj, loc, true) {
                            track.push(SatellitePassPoint {
                                jd_ut: tj,
                                az_deg: ev.az_deg,
                                alt_deg: ev.alt_deg.max(0.0),
                                range_km: ev.range_km,
                                is_sunlit: ev.is_sunlit,
                            });
                        }
                    }

                    let dur_sec = ((los_jd - aos_jd) * 86400.0).max(0.0).round() as u32;
                    passes.push(SatellitePass {
                        sat_id: rec.id.clone(),
                        sat_name: rec.name.clone(),
                        norad_id: rec.norad_id,
                        aos_jd_ut: aos_jd,
                        aos_str: format_local_hm(Some(aos_jd), loc.tz_offset_min)
                            .unwrap_or_default(),
                        aos_az_deg: aos_ev.az_deg,
                        max_jd_ut: best_tca_jd,
                        max_str: format_local_hm(Some(best_tca_jd), loc.tz_offset_min)
                            .unwrap_or_default(),
                        max_alt_deg: max_ev.alt_deg,
                        max_az_deg: max_ev.az_deg,
                        los_jd_ut: los_jd,
                        los_str: format_local_hm(Some(los_jd), loc.tz_offset_min)
                            .unwrap_or_default(),
                        los_az_deg: los_ev.az_deg,
                        duration_sec: dur_sec,
                        is_sunlit_max,
                        sun_alt_at_max_deg: sun_alt_max,
                        is_visible,
                        track,
                    });
                }
            }
            active_aos = None;
            active_max_alt = -90.0;
        }

        prev_jd = jd;
        prev_alt = alt;
    }

    Ok(passes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::comet_db::default_satellites;
    use crate::engine::time::ymd_hms_to_jd;

    #[test]
    fn parses_and_propagates_iss_tle_accurately() {
        let sats = default_satellites();
        let iss = &sats[0];
        let tle_txt = format!("{}\n{}\n{}\n", iss.name, iss.line1, iss.line2);
        let parsed = parse_tle_text(&tle_txt, "stations");
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].norad_id, 25544);

        let jd = ymd_hms_to_jd(2026, 11, 23, 10, 0, 0.0);
        let pos =
            propagate_satellite_at(iss, jd, &ObserverLocation::AKASHI, true).expect("iss pos");
        assert!(pos.altitude_km > 350.0 && pos.altitude_km < 460.0);
        assert!(pos.velocity_km_s > 7.3 && pos.velocity_km_s < 7.9);
        assert!(pos.ra_deg.is_finite() && pos.dec_deg.is_finite());
        assert!(pos.az_deg >= 0.0 && pos.az_deg <= 360.0);
    }

    #[test]
    fn predicts_iss_passes_over_akashi() {
        let sats = default_satellites();
        let iss = &sats[0];
        let jd = ymd_hms_to_jd(2026, 11, 23, 0, 0, 0.0);
        let passes = predict_satellite_passes(iss, jd, 48.0, 5.0, false, &ObserverLocation::AKASHI)
            .expect("passes");
        assert!(!passes.is_empty(), "Expected ISS passes over Akashi within 48h");
        assert!(!passes[0].track.is_empty());
        assert!(passes[0].max_alt_deg >= 5.0);
    }
}
