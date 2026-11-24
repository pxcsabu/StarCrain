use serde::{Deserialize, Serialize};

use crate::engine::coords::{Equatorial, apply_standard_refraction, equatorial_to_horizontal};
use crate::engine::ephemeris::{
    Planet, geocentric_to_topocentric, moon_ephemeris, planet_ephemeris, sun_ephemeris,
};
use crate::engine::precession::{nutation, precess_j2000_to_date};
use crate::engine::time::{calendar_to_jd, last_deg, ut_to_tt_jd};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ObserverLocation {
    pub lat_deg: f64,
    pub lon_deg: f64,
    pub alt_m: f64,
    pub tz_offset_min: i32,
}

impl ObserverLocation {
    pub const AKASHI: Self = Self {
        lat_deg: 34.6431,
        lon_deg: 134.9972,
        alt_m: 10.0,
        tz_offset_min: 540,
    };
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RiseSetStatus {
    Normal,
    Circumpolar,
    NeverRises,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct RiseSetResult {
    pub rise_jd_ut: Option<f64>,
    pub transit_jd_ut: Option<f64>,
    pub set_jd_ut: Option<f64>,
    pub max_alt_deg: f64,
    pub min_alt_deg: f64,
    pub status: RiseSetStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct TwilightTimes {
    pub civil_dawn_jd_ut: Option<f64>,
    pub civil_dusk_jd_ut: Option<f64>,
    pub nautical_dawn_jd_ut: Option<f64>,
    pub nautical_dusk_jd_ut: Option<f64>,
    pub astro_dawn_jd_ut: Option<f64>,
    pub astro_dusk_jd_ut: Option<f64>,
}

/// Local midnight `(year, month, day 00:00)` converted to `jd_ut`.
pub fn local_midnight_jd_ut(year: i32, month: u8, day: u8, tz_offset_min: i32) -> f64 {
    calendar_to_jd(year, month, f64::from(day)) - f64::from(tz_offset_min) / 1440.0
}

fn bisect_crossing(
    mut a: f64,
    mut b: f64,
    target_alt_deg: f64,
    rising: bool,
    alt_fn: &impl Fn(f64) -> f64,
) -> f64 {
    for _ in 0..34 {
        let mid = 0.5 * (a + b);
        let v = alt_fn(mid) - target_alt_deg;
        if rising {
            if v < 0.0 {
                a = mid;
            } else {
                b = mid;
            }
        } else if v >= 0.0 {
            a = mid;
        } else {
            b = mid;
        }
    }
    0.5 * (a + b)
}

fn golden_extremum(
    mut a: f64,
    mut b: f64,
    find_max: bool,
    alt_fn: &impl Fn(f64) -> f64,
) -> (f64, f64) {
    const INV_PHI: f64 = 0.618_033_988_749_894_9;
    let mut c = b - INV_PHI * (b - a);
    let mut d = a + INV_PHI * (b - a);
    let mut fc = alt_fn(c);
    let mut fd = alt_fn(d);
    for _ in 0..36 {
        let pick_left = if find_max { fc > fd } else { fc < fd };
        if pick_left {
            b = d;
            d = c;
            fd = fc;
            c = b - INV_PHI * (b - a);
            fc = alt_fn(c);
        } else {
            a = c;
            c = d;
            fc = fd;
            d = a + INV_PHI * (b - a);
            fd = alt_fn(d);
        }
    }
    let t = 0.5 * (a + b);
    (t, alt_fn(t))
}

fn solve_day_crossings(
    start_jd_ut: f64,
    target_alt_deg: f64,
    alt_fn: impl Fn(f64) -> f64,
) -> RiseSetResult {
    const STEPS: usize = 96; // 15-minute intervals over 24h
    let mut ts = [0.0_f64; STEPS + 1];
    let mut alts = [0.0_f64; STEPS + 1];
    for i in 0..=STEPS {
        let t = start_jd_ut + (i as f64) / (STEPS as f64);
        ts[i] = t;
        alts[i] = alt_fn(t);
    }

    let mut rise_jd_ut = None;
    let mut set_jd_ut = None;
    for i in 0..STEPS {
        let v0 = alts[i] - target_alt_deg;
        let v1 = alts[i + 1] - target_alt_deg;
        if rise_jd_ut.is_none() && v0 < 0.0 && v1 >= 0.0 {
            rise_jd_ut = Some(bisect_crossing(ts[i], ts[i + 1], target_alt_deg, true, &alt_fn));
        }
        if set_jd_ut.is_none() && v0 >= 0.0 && v1 < 0.0 {
            set_jd_ut = Some(bisect_crossing(ts[i], ts[i + 1], target_alt_deg, false, &alt_fn));
        }
    }

    let mut max_i = 0usize;
    let mut min_i = 0usize;
    for i in 1..=STEPS {
        if alts[i] > alts[max_i] {
            max_i = i;
        }
        if alts[i] < alts[min_i] {
            min_i = i;
        }
    }

    let left_max = ts[max_i.saturating_sub(1)];
    let right_max = ts[(max_i + 1).min(STEPS)];
    let (transit_t, max_alt_deg) = if max_i == 0 || max_i == STEPS {
        (ts[max_i], alts[max_i])
    } else {
        golden_extremum(left_max, right_max, true, &alt_fn)
    };

    let left_min = ts[min_i.saturating_sub(1)];
    let right_min = ts[(min_i + 1).min(STEPS)];
    let (_, min_alt_deg) = if min_i == 0 || min_i == STEPS {
        (ts[min_i], alts[min_i])
    } else {
        golden_extremum(left_min, right_min, false, &alt_fn)
    };

    // Refine transit_jd_ut only if local maximum occurred strictly inside the day
    let transit_jd_ut = if max_alt_deg >= target_alt_deg && max_i > 0 && max_i < STEPS {
        Some(transit_t)
    } else if max_alt_deg >= target_alt_deg {
        // Check if transit is near the edges; still return peak if above horizon
        Some(transit_t)
    } else {
        None
    };

    let status = if rise_jd_ut.is_none() && set_jd_ut.is_none() {
        if min_alt_deg >= target_alt_deg {
            RiseSetStatus::Circumpolar
        } else {
            RiseSetStatus::NeverRises
        }
    } else {
        RiseSetStatus::Normal
    };

    RiseSetResult {
        rise_jd_ut,
        transit_jd_ut,
        set_jd_ut,
        max_alt_deg,
        min_alt_deg,
        status,
    }
}

fn sun_true_alt_deg(jd_ut: f64, loc: &ObserverLocation) -> f64 {
    let jd_tt = ut_to_tt_jd(jd_ut);
    let eph = sun_ephemeris(jd_tt);
    let lst = last_deg(jd_ut, loc.lon_deg);
    let topo = geocentric_to_topocentric(eph.eq_apparent, eph.geo_au, loc.lat_deg, loc.alt_m, lst);
    equatorial_to_horizontal(topo, loc.lat_deg, lst).alt_deg
}

/// Solar sunrise, transit, and sunset on local calendar date `(year, month, day)`.
/// Standard criterion: geometric center altitude = `-0.833333°` (`-50'`).
pub fn sun_rise_set(loc: &ObserverLocation, year: i32, month: u8, day: u8) -> RiseSetResult {
    let start = local_midnight_jd_ut(year, month, day, loc.tz_offset_min);
    solve_day_crossings(start, -50.0 / 60.0, |jd| sun_true_alt_deg(jd, loc))
}

/// Civil (-6°), Nautical (-12°), and Astronomical (-18°) dawn/dusk on local calendar date.
pub fn sun_twilight(loc: &ObserverLocation, year: i32, month: u8, day: u8) -> TwilightTimes {
    let start = local_midnight_jd_ut(year, month, day, loc.tz_offset_min);
    let civil = solve_day_crossings(start, -6.0, |jd| sun_true_alt_deg(jd, loc));
    let nautical = solve_day_crossings(start, -12.0, |jd| sun_true_alt_deg(jd, loc));
    let astro = solve_day_crossings(start, -18.0, |jd| sun_true_alt_deg(jd, loc));

    TwilightTimes {
        civil_dawn_jd_ut: civil.rise_jd_ut,
        civil_dusk_jd_ut: civil.set_jd_ut,
        nautical_dawn_jd_ut: nautical.rise_jd_ut,
        nautical_dusk_jd_ut: nautical.set_jd_ut,
        astro_dawn_jd_ut: astro.rise_jd_ut,
        astro_dusk_jd_ut: astro.set_jd_ut,
    }
}

/// Lunar moonrise, transit, and moonset using topocentric parallax + refraction + semi-diameter.
pub fn moon_rise_set(loc: &ObserverLocation, year: i32, month: u8, day: u8) -> RiseSetResult {
    let start = local_midnight_jd_ut(year, month, day, loc.tz_offset_min);
    // Apparent upper-limb altitude above geometric horizon:
    // true_topo_alt + refraction(34') + semi_diameter = 0
    solve_day_crossings(start, 0.0, |jd| {
        let jd_tt = ut_to_tt_jd(jd);
        let eph = moon_ephemeris(jd_tt);
        let lst = last_deg(jd, loc.lon_deg);
        let topo =
            geocentric_to_topocentric(eph.eq_apparent, eph.geo_au, loc.lat_deg, loc.alt_m, lst);
        let topo_alt = equatorial_to_horizontal(topo, loc.lat_deg, lst).alt_deg;
        let semi_diam_deg = (eph.angular_diameter_arcsec * 0.5) / 3600.0;
        topo_alt + (34.0 / 60.0) + semi_diam_deg
    })
}

/// Planetary rise, transit, and set on local calendar date `(year, month, day)`.
pub fn planet_rise_set(
    planet: Planet,
    loc: &ObserverLocation,
    year: i32,
    month: u8,
    day: u8,
) -> RiseSetResult {
    let start = local_midnight_jd_ut(year, month, day, loc.tz_offset_min);
    solve_day_crossings(start, -34.0 / 60.0, |jd| {
        let jd_tt = ut_to_tt_jd(jd);
        let eph = planet_ephemeris(planet, jd_tt);
        let lst = last_deg(jd, loc.lon_deg);
        let topo =
            geocentric_to_topocentric(eph.eq_apparent, eph.geo_au, loc.lat_deg, loc.alt_m, lst);
        equatorial_to_horizontal(topo, loc.lat_deg, lst).alt_deg
    })
}

/// Rise, transit, and set for any fixed J2000.0 equatorial object (`star`, `DSO`, etc.).
pub fn equatorial_j2000_rise_set(
    eq_j2000: Equatorial,
    loc: &ObserverLocation,
    year: i32,
    month: u8,
    day: u8,
) -> RiseSetResult {
    let start = local_midnight_jd_ut(year, month, day, loc.tz_offset_min);
    let jd_tt_mid = ut_to_tt_jd(start + 0.5);
    let nut = nutation(jd_tt_mid);
    let eq_date = crate::engine::precession::apply_nutation_to_equatorial(
        precess_j2000_to_date(eq_j2000, jd_tt_mid),
        &nut,
    );
    solve_day_crossings(start, -34.0 / 60.0, |jd| {
        let lst = last_deg(jd, loc.lon_deg);
        equatorial_to_horizontal(eq_date, loc.lat_deg, lst).alt_deg
    })
}

/// Find all `(rising_jd_ut, setting_jd_ut)` local-day times when a J2000.0 celestial object
/// reaches apparent altitude `target_app_alt_deg` (used by AstroCalculator "高度→時刻").
pub fn altitude_crossing_times(
    eq_j2000: Equatorial,
    target_app_alt_deg: f64,
    loc: &ObserverLocation,
    year: i32,
    month: u8,
    day: u8,
) -> (Option<f64>, Option<f64>) {
    let start = local_midnight_jd_ut(year, month, day, loc.tz_offset_min);
    let jd_tt_mid = ut_to_tt_jd(start + 0.5);
    let nut = nutation(jd_tt_mid);
    let eq_date = crate::engine::precession::apply_nutation_to_equatorial(
        precess_j2000_to_date(eq_j2000, jd_tt_mid),
        &nut,
    );
    let res = solve_day_crossings(start, target_app_alt_deg, |jd| {
        let lst = last_deg(jd, loc.lon_deg);
        let true_alt = equatorial_to_horizontal(eq_date, loc.lat_deg, lst).alt_deg;
        apply_standard_refraction(true_alt)
    });
    (res.rise_jd_ut, res.set_jd_ut)
}

#[cfg(test)]
mod tests {
    use crate::engine::time::jd_to_ymd_hms;

    use super::*;

    fn jd_to_jst_hm(jd_ut: f64) -> (u8, u8, f64) {
        let (_, _, _, h, m, s) = jd_to_ymd_hms(jd_ut + 9.0 / 24.0);
        (h, m, s)
    }

    #[test]
    fn akashi_2026_sunrise_sunset_matches_naoj() {
        // 2026-01-01 Akashi (34.6431N, 134.9972E): NAOJ-consistent Sunrise ≈ 07:07.0 JST, Sunset ≈ 16:59.9 JST
        let jan1 = sun_rise_set(&ObserverLocation::AKASHI, 2026, 1, 1);
        assert_eq!(jan1.status, RiseSetStatus::Normal);
        let (rh, rm, rs) = jd_to_jst_hm(jan1.rise_jd_ut.unwrap());
        let (sh, sm, ss) = jd_to_jst_hm(jan1.set_jd_ut.unwrap());
        println!("Akashi 2026-01-01 rise={rh:02}:{rm:02}:{rs:04.1} set={sh:02}:{sm:02}:{ss:04.1}");
        let r_min = f64::from(rh) * 60.0 + f64::from(rm) + rs / 60.0;
        let s_min = f64::from(sh) * 60.0 + f64::from(sm) + ss / 60.0;
        assert!((r_min - (7.0 * 60.0 + 7.0)).abs() <= 1.0, "Jan1 rise {rh:02}:{rm:02}:{rs:04.1}");
        assert!((s_min - (16.0 * 60.0 + 59.9)).abs() <= 1.0, "Jan1 set {sh:02}:{sm:02}:{ss:04.1}");

        // 2026-06-21 Akashi: NAOJ-consistent Sunrise ≈ 04:47.3 JST, Sunset ≈ 19:16.2 JST
        let jun21 = sun_rise_set(&ObserverLocation::AKASHI, 2026, 6, 21);
        assert_eq!(jun21.status, RiseSetStatus::Normal);
        let (rh2, rm2, rs2) = jd_to_jst_hm(jun21.rise_jd_ut.unwrap());
        let (sh2, sm2, ss2) = jd_to_jst_hm(jun21.set_jd_ut.unwrap());
        println!("Akashi 2026-06-21 rise={rh2:02}:{rm2:02}:{rs2:04.1} set={sh2:02}:{sm2:02}:{ss2:04.1}");
        let r2_min = f64::from(rh2) * 60.0 + f64::from(rm2) + rs2 / 60.0;
        let s2_min = f64::from(sh2) * 60.0 + f64::from(sm2) + ss2 / 60.0;
        assert!((r2_min - (4.0 * 60.0 + 47.3)).abs() <= 1.0, "Jun21 rise {rh2:02}:{rm2:02}:{rs2:04.1}");
        assert!((s2_min - (19.0 * 60.0 + 16.2)).abs() <= 1.0, "Jun21 set {sh2:02}:{sm2:02}:{ss2:04.1}");

        // Twilight ordering on Jan 1
        let tw = sun_twilight(&ObserverLocation::AKASHI, 2026, 1, 1);
        assert!(tw.astro_dawn_jd_ut.unwrap() < tw.nautical_dawn_jd_ut.unwrap());
        assert!(tw.nautical_dawn_jd_ut.unwrap() < tw.civil_dawn_jd_ut.unwrap());
        assert!(tw.civil_dawn_jd_ut.unwrap() < jan1.rise_jd_ut.unwrap());
        assert!(jan1.rise_jd_ut.unwrap() < jan1.transit_jd_ut.unwrap());
        assert!(jan1.transit_jd_ut.unwrap() < jan1.set_jd_ut.unwrap());
        assert!(jan1.set_jd_ut.unwrap() < tw.civil_dusk_jd_ut.unwrap());
        assert!(tw.civil_dusk_jd_ut.unwrap() < tw.nautical_dusk_jd_ut.unwrap());
        assert!(tw.nautical_dusk_jd_ut.unwrap() < tw.astro_dusk_jd_ut.unwrap());
    }

    #[test]
    fn polar_midnight_sun_and_polar_night() {
        let arctic = ObserverLocation {
            lat_deg: 75.0,
            lon_deg: 20.0,
            alt_m: 0.0,
            tz_offset_min: 60,
        };
        let summer = sun_rise_set(&arctic, 2026, 6, 21);
        assert_eq!(summer.status, RiseSetStatus::Circumpolar);

        let winter = sun_rise_set(&arctic, 2026, 12, 21);
        assert_eq!(winter.status, RiseSetStatus::NeverRises);
    }

    #[test]
    fn moon_jupiter_and_sirius_rise_set_sanity() {
        let moon = moon_rise_set(&ObserverLocation::AKASHI, 2026, 1, 1);
        assert_eq!(moon.status, RiseSetStatus::Normal);
        assert!(moon.transit_jd_ut.is_some());

        let jup = planet_rise_set(Planet::Jupiter, &ObserverLocation::AKASHI, 2026, 1, 1);
        assert_eq!(jup.status, RiseSetStatus::Normal);

        let sirius = Equatorial {
            ra_deg: 101.287_155,
            dec_deg: -16.716_116,
        };
        let sirius_rs = equatorial_j2000_rise_set(sirius, &ObserverLocation::AKASHI, 2026, 1, 1);
        assert_eq!(sirius_rs.status, RiseSetStatus::Normal);
        // Sirius on Jan 1 transits near midnight JST
        let (th, _, _) = jd_to_jst_hm(sirius_rs.transit_jd_ut.unwrap());
        assert!(th == 23 || th == 0, "sirius transit hour={th}");

        let (r30, s30) =
            altitude_crossing_times(sirius, 30.0, &ObserverLocation::AKASHI, 2026, 1, 1);
        assert!(r30.is_some() && s30.is_some());
    }
}
