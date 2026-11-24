use chrono::{Datelike, Timelike, Utc};
use serde::{Deserialize, Serialize};

use crate::engine::coords::{wrap_deg_180, wrap_deg_360};
use crate::engine::ephemeris::{
    moon_apparent_ecliptic_lon_deg, sun_apparent_ecliptic_lon_deg, sun_ephemeris,
};
use crate::engine::precession::{J2000_JD, nutation};

pub const MJD_OFFSET: f64 = 2_400_000.5;
const JST_OFFSET_DAYS: f64 = 9.0 / 24.0;
const SYNODIC_MONTH_DAYS: f64 = 29.530_588_853;
const TROPICAL_YEAR_DAYS: f64 = 365.242_189;

/// Convert calendar date (`year` in astronomical numbering: 1 BC = 0, 2 BC = -1)
/// and fractional day (1-based, e.g. `1.5` = day 1 at 12:00 UT) to Julian Day (Meeus Ch. 7).
/// Automatically switches from Julian to Gregorian calendar at 1582-10-15.
pub fn calendar_to_jd(year: i32, month: u8, day_with_frac: f64) -> f64 {
    let mut y = i64::from(year);
    let mut m = i64::from(month);
    if m <= 2 {
        y -= 1;
        m += 12;
    }

    let is_gregorian =
        (year > 1582) || (year == 1582 && (month > 10 || (month == 10 && day_with_frac >= 15.0)));

    let b = if is_gregorian {
        let a = y.div_euclid(100);
        2 - a + a.div_euclid(4)
    } else {
        0
    };

    let term_y = (365.25 * (y + 4716) as f64).floor();
    let term_m = (30.6001 * (m + 1) as f64).floor();
    term_y + term_m + day_with_frac + (b as f64) - 1524.5
}

/// Convert discrete `(year, month, day, hour, minute, second)` in UT to Julian Day.
pub fn ymd_hms_to_jd(year: i32, month: u8, day: u8, hour: u8, minute: u8, second: f64) -> f64 {
    let frac = (f64::from(hour) + f64::from(minute) / 60.0 + second / 3600.0) / 24.0;
    calendar_to_jd(year, month, f64::from(day) + frac)
}

/// Convert Julian Day to `(year, month, day, hour, minute, second)` (Meeus Ch. 7).
pub fn jd_to_ymd_hms(jd: f64) -> (i32, u8, u8, u8, u8, f64) {
    let jd_plus = jd + 0.5;
    let z = jd_plus.floor() as i64;
    let f = jd_plus - (z as f64);

    let a = if z < 2_299_161 {
        z
    } else {
        let alpha = (((z as f64) - 1_867_216.25) / 36_524.25).floor() as i64;
        z + 1 + alpha - alpha.div_euclid(4)
    };

    let b = a + 1524;
    let c = (((b as f64) - 122.1) / 365.25).floor() as i64;
    let d = (365.25 * (c as f64)).floor() as i64;
    let e = (((b - d) as f64) / 30.6001).floor() as i64;

    let day_float = (b - d) as f64 - (30.6001 * (e as f64)).floor() + f;
    let day = day_float.floor() as u8;
    let day_frac = day_float - f64::from(day);

    let month = if e < 14 { (e - 1) as u8 } else { (e - 13) as u8 };
    let year = if month > 2 { (c - 4716) as i32 } else { (c - 4715) as i32 };

    let total_seconds = day_frac * 86_400.0;
    let mut hour = (total_seconds / 3600.0).floor() as u8;
    let rem = total_seconds - f64::from(hour) * 3600.0;
    let mut minute = (rem / 60.0).floor() as u8;
    let mut second = rem - f64::from(minute) * 60.0;

    if second >= 59.999_999 {
        second = 0.0;
        minute += 1;
        if minute >= 60 {
            minute = 0;
            hour += 1;
            if hour >= 24 {
                return jd_to_ymd_hms(jd + 1e-9);
            }
        }
    }

    (year, month, day, hour, minute, second)
}

#[inline]
pub fn jd_to_mjd(jd: f64) -> f64 {
    jd - MJD_OFFSET
}

#[inline]
pub fn mjd_to_jd(mjd: f64) -> f64 {
    mjd + MJD_OFFSET
}

/// Current UTC instant as Julian Day (`JD_UT`).
pub fn now_utc_jd() -> f64 {
    let now = Utc::now();
    let sec = f64::from(now.second()) + f64::from(now.nanosecond()) * 1e-9;
    ymd_hms_to_jd(
        now.year(),
        now.month() as u8,
        now.day() as u8,
        now.hour() as u8,
        now.minute() as u8,
        sec,
    )
}

/// Convert `decimal_year` (e.g. `2026.5`) to `ΔT = TT - UT` in seconds.
/// Combines Espenak & Meeus (2006) piecewise polynomials (BC 3000..AD 5000)
/// with observed IERS values for 2005–2026.
pub fn delta_t_seconds(y: f64) -> f64 {
    if y < -500.0 {
        let u = (y - 1820.0) / 100.0;
        -20.0 + 32.0 * u * u
    } else if y < 500.0 {
        let u = y / 100.0;
        let u2 = u * u;
        let u3 = u2 * u;
        let u4 = u2 * u2;
        let u5 = u4 * u;
        let u6 = u3 * u3;
        10_583.6 - 1014.41 * u + 33.78311 * u2 - 5.952053 * u3 - 0.1798452 * u4
            + 0.022174192 * u5
            + 0.0090316521 * u6
    } else if y < 1600.0 {
        let u = (y - 1000.0) / 100.0;
        let u2 = u * u;
        let u3 = u2 * u;
        let u4 = u2 * u2;
        let u5 = u4 * u;
        let u6 = u3 * u3;
        1574.2 - 556.01 * u + 71.23472 * u2 + 0.319781 * u3 - 0.8503463 * u4 - 0.005050998 * u5
            + 0.0083572073 * u6
    } else if y < 1700.0 {
        let t = y - 1600.0;
        120.0 - 0.9808 * t - 0.01532 * t * t + t * t * t / 7129.0
    } else if y < 1800.0 {
        let t = y - 1700.0;
        let t2 = t * t;
        8.83 + 0.1603 * t - 0.0059285 * t2 + 0.00013336 * t2 * t - t2 * t2 / 1_174_000.0
    } else if y < 1860.0 {
        let t = y - 1800.0;
        let t2 = t * t;
        let t3 = t2 * t;
        let t4 = t2 * t2;
        13.72 - 0.332447 * t + 0.0068612 * t2 + 0.0041116 * t3 - 0.00037436 * t4
            + 0.0000121272 * t4 * t
            - 0.0000001699 * t3 * t3
            + 0.000000000875 * t4 * t3
    } else if y < 1900.0 {
        let t = y - 1860.0;
        let t2 = t * t;
        let t3 = t2 * t;
        let t4 = t2 * t2;
        7.62 + 0.5737 * t - 0.251754 * t2 + 0.01680668 * t3 - 0.0004473624 * t4
            + t4 * t / 233_174.0
    } else if y < 1920.0 {
        let t = y - 1900.0;
        let t2 = t * t;
        -2.79 + 1.494119 * t - 0.0598939 * t2 + 0.0061966 * t2 * t - 0.000197 * t2 * t2
    } else if y < 1941.0 {
        let t = y - 1920.0;
        21.20 + 0.84493 * t - 0.076100 * t * t + 0.0020936 * t * t * t
    } else if y < 1961.0 {
        let t = y - 1950.0;
        29.07 + 0.407 * t - t * t / 233.0 + t * t * t / 2547.0
    } else if y < 1986.0 {
        let t = y - 1975.0;
        45.45 + 1.067 * t - t * t / 260.0 - t * t * t / 718.0
    } else if y < 2005.0 {
        let t = y - 2000.0;
        let t2 = t * t;
        63.86 + 0.3345 * t - 0.060374 * t2 + 0.0017275 * t2 * t + 0.000651814 * t2 * t2
            + 0.00002373599 * t2 * t2 * t
    } else if y <= 2026.5 {
        // IERS observed table 2005..2026
        const ANCHORS: [(f64, f64); 6] = [
            (2005.0, 64.69),
            (2010.0, 66.07),
            (2015.0, 67.64),
            (2020.0, 69.36),
            (2024.0, 69.18),
            (2026.5, 69.20),
        ];
        for w in ANCHORS.windows(2) {
            if y <= w[1].0 {
                let frac = (y - w[0].0) / (w[1].0 - w[0].0);
                return w[0].1 + frac * (w[1].1 - w[0].1);
            }
        }
        69.20
    } else if y < 2050.0 {
        let t = y - 2026.5;
        69.20 + 0.30 * t + 0.012 * t * t
    } else if y < 2150.0 {
        let t = y - 1820.0;
        -20.0 + 32.0 * (t / 100.0).powi(2) - 0.5628 * (2150.0 - y)
    } else {
        let u = (y - 1820.0) / 100.0;
        -20.0 + 32.0 * u * u
    }
}

#[inline]
pub fn jd_to_decimal_year(jd: f64) -> f64 {
    2000.0 + (jd - J2000_JD) / 365.25
}

#[inline]
pub fn ut_to_tt_jd(jd_ut: f64) -> f64 {
    let dt = delta_t_seconds(jd_to_decimal_year(jd_ut));
    jd_ut + dt / 86_400.0
}

#[inline]
pub fn tt_to_ut_jd(jd_tt: f64) -> f64 {
    let dt = delta_t_seconds(jd_to_decimal_year(jd_tt));
    jd_tt - dt / 86_400.0
}

/// Greenwich Mean Sidereal Time (GMST) in degrees `[0, 360)` for `jd_ut` (Meeus Eq. 12.4).
pub fn gmst_deg(jd_ut: f64) -> f64 {
    let t = (jd_ut - J2000_JD) / 36_525.0;
    let t2 = t * t;
    let t3 = t2 * t;
    let theta = 280.460_618_37
        + 360.985_647_366_29 * (jd_ut - J2000_JD)
        + 0.000_387_933 * t2
        - t3 / 38_710_000.0;
    wrap_deg_360(theta)
}

/// Greenwich Apparent Sidereal Time (GAST) in degrees `[0, 360)` including Equation of Equinoxes.
pub fn gast_deg(jd_ut: f64) -> f64 {
    let nut = nutation(ut_to_tt_jd(jd_ut));
    let eq_eq = nut.delta_psi_deg * nut.true_obliquity_deg.to_radians().cos();
    wrap_deg_360(gmst_deg(jd_ut) + eq_eq)
}

/// Local Mean Sidereal Time (LST) in degrees `[0, 360)`, East longitude positive.
#[inline]
pub fn lst_deg(jd_ut: f64, lon_deg: f64) -> f64 {
    wrap_deg_360(gmst_deg(jd_ut) + lon_deg)
}

/// Local Apparent Sidereal Time (LAST) in degrees `[0, 360)`, East longitude positive.
#[inline]
pub fn last_deg(jd_ut: f64, lon_deg: f64) -> f64 {
    wrap_deg_360(gast_deg(jd_ut) + lon_deg)
}

/// Hour angle `HA = LST - RA` wrapped to `[-180, 180)` degrees.
#[inline]
pub fn hour_angle_deg(local_sidereal_deg: f64, ra_deg: f64) -> f64 {
    wrap_deg_180(local_sidereal_deg - ra_deg)
}

/// Equation of Time (`apparent solar time - mean solar time`) in minutes (Meeus Eq. 28.1).
pub fn equation_of_time_min(jd_tt: f64) -> f64 {
    let tau = (jd_tt - J2000_JD) / 365_250.0;
    let tau2 = tau * tau;
    let tau3 = tau2 * tau;
    let tau4 = tau2 * tau2;
    let tau5 = tau4 * tau;
    let l0 = wrap_deg_360(
        280.466_456_7
            + 360_007.698_277_9 * tau
            + 0.030_320_28 * tau2
            + tau3 / 49_931.0
            - tau4 / 15_300.0
            - tau5 / 2_000_000.0,
    );
    let sun = sun_ephemeris(jd_tt);
    let nut = nutation(jd_tt);
    let eq_eq = nut.delta_psi_deg * nut.true_obliquity_deg.to_radians().cos();
    let e_deg = wrap_deg_180(l0 - 0.005_718_3 - sun.eq_apparent.ra_deg + eq_eq);
    4.0 * e_deg
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SolarTermInfo {
    pub index: u8,
    pub lon_deg: u16,
    pub name_ja: &'static str,
    pub is_chuki: bool,
}

pub const SOLAR_TERMS: [SolarTermInfo; 24] = [
    SolarTermInfo { index: 0, lon_deg: 0, name_ja: "春分", is_chuki: true },
    SolarTermInfo { index: 1, lon_deg: 15, name_ja: "清明", is_chuki: false },
    SolarTermInfo { index: 2, lon_deg: 30, name_ja: "穀雨", is_chuki: true },
    SolarTermInfo { index: 3, lon_deg: 45, name_ja: "立夏", is_chuki: false },
    SolarTermInfo { index: 4, lon_deg: 60, name_ja: "小満", is_chuki: true },
    SolarTermInfo { index: 5, lon_deg: 75, name_ja: "芒種", is_chuki: false },
    SolarTermInfo { index: 6, lon_deg: 90, name_ja: "夏至", is_chuki: true },
    SolarTermInfo { index: 7, lon_deg: 105, name_ja: "小暑", is_chuki: false },
    SolarTermInfo { index: 8, lon_deg: 120, name_ja: "大暑", is_chuki: true },
    SolarTermInfo { index: 9, lon_deg: 135, name_ja: "立秋", is_chuki: false },
    SolarTermInfo { index: 10, lon_deg: 150, name_ja: "処暑", is_chuki: true },
    SolarTermInfo { index: 11, lon_deg: 165, name_ja: "白露", is_chuki: false },
    SolarTermInfo { index: 12, lon_deg: 180, name_ja: "秋分", is_chuki: true },
    SolarTermInfo { index: 13, lon_deg: 195, name_ja: "寒露", is_chuki: false },
    SolarTermInfo { index: 14, lon_deg: 210, name_ja: "霜降", is_chuki: true },
    SolarTermInfo { index: 15, lon_deg: 225, name_ja: "立冬", is_chuki: false },
    SolarTermInfo { index: 16, lon_deg: 240, name_ja: "小雪", is_chuki: true },
    SolarTermInfo { index: 17, lon_deg: 255, name_ja: "大雪", is_chuki: false },
    SolarTermInfo { index: 18, lon_deg: 270, name_ja: "冬至", is_chuki: true },
    SolarTermInfo { index: 19, lon_deg: 285, name_ja: "小寒", is_chuki: false },
    SolarTermInfo { index: 20, lon_deg: 300, name_ja: "大寒", is_chuki: true },
    SolarTermInfo { index: 21, lon_deg: 315, name_ja: "立春", is_chuki: false },
    SolarTermInfo { index: 22, lon_deg: 330, name_ja: "雨水", is_chuki: true },
    SolarTermInfo { index: 23, lon_deg: 345, name_ja: "啓蟄", is_chuki: false },
];

/// Find `jd_tt` near `approx_jd_tt` when the Sun reaches apparent ecliptic longitude `target_lon_deg`.
pub fn find_solar_longitude_jd_tt(target_lon_deg: f64, approx_jd_tt: f64) -> f64 {
    let mut jd = approx_jd_tt;
    for _ in 0..8 {
        let cur = sun_apparent_ecliptic_lon_deg(jd);
        let diff = wrap_deg_180(target_lon_deg - cur);
        jd += diff * (TROPICAL_YEAR_DAYS / 360.0);
        if diff.abs() < 1e-8 {
            break;
        }
    }
    jd
}

/// Find `jd_ut` of solar term `term_index` (`0` = 春分 0°, ..., `18` = 冬至 270°) in calendar `year`.
pub fn find_solar_term_jd_ut(year: i32, term_index: u8) -> f64 {
    let idx = term_index % 24;
    let target_lon = f64::from(SOLAR_TERMS[usize::from(idx)].lon_deg);
    // Approximate JD of March equinox in `year`, then advance by target_lon / 360 * tropical_year
    let approx_equinox = ymd_hms_to_jd(year, 3, 20, 12, 0, 0.0);
    let approx_term = approx_equinox + (target_lon / 360.0) * TROPICAL_YEAR_DAYS;
    // If term_index >= 19 (小寒..啓蟄, Jan..Mar), keep within the requested Gregorian year
    let mut jd_tt = find_solar_longitude_jd_tt(target_lon, approx_term);
    let (y_found, _, _, _, _, _) = jd_to_ymd_hms(tt_to_ut_jd(jd_tt) + JST_OFFSET_DAYS);
    if y_found > year {
        jd_tt = find_solar_longitude_jd_tt(target_lon, jd_tt - TROPICAL_YEAR_DAYS);
    } else if y_found < year {
        jd_tt = find_solar_longitude_jd_tt(target_lon, jd_tt + TROPICAL_YEAR_DAYS);
    }
    tt_to_ut_jd(jd_tt)
}

/// Check if a Japanese solar term falls on the given JST date `(year, month, day)`.
pub fn solar_term_on_jst_date(year: i32, month: u8, day: u8) -> Option<&'static str> {
    let target_day = jst_day_number(year, month, day);
    // Quick solar longitude estimate at noon JST
    let noon_ut = ymd_hms_to_jd(year, month, day, 3, 0, 0.0);
    let approx_lon = sun_apparent_ecliptic_lon_deg(ut_to_tt_jd(noon_ut));
    let nearest_idx = ((approx_lon / 15.0).round() as u8) % 24;
    let jd_ut = find_solar_term_jd_ut(year, nearest_idx);
    if jd_ut_to_jst_day_number(jd_ut) == target_day {
        Some(SOLAR_TERMS[usize::from(nearest_idx)].name_ja)
    } else {
        None
    }
}

/// Find exact New Moon (`jd_ut`) closest to `approx_jd_ut`.
pub fn find_new_moon_near_jd_ut(approx_jd_ut: f64) -> f64 {
    let mut jd_tt = ut_to_tt_jd(approx_jd_ut);
    for _ in 0..10 {
        let diff = wrap_deg_180(
            moon_apparent_ecliptic_lon_deg(jd_tt) - sun_apparent_ecliptic_lon_deg(jd_tt),
        );
        jd_tt -= diff * (SYNODIC_MONTH_DAYS / 360.0);
        if diff.abs() < 1e-7 {
            break;
        }
    }
    tt_to_ut_jd(jd_tt)
}

/// Integer JST day number (0h JST = `jd_ut + 9/24 + 0.5`).
#[inline]
pub fn jst_day_number(year: i32, month: u8, day: u8) -> i64 {
    (calendar_to_jd(year, month, f64::from(day)) + 0.5).floor() as i64
}

#[inline]
pub fn jd_ut_to_jst_day_number(jd_ut: f64) -> i64 {
    (jd_ut + JST_OFFSET_DAYS + 0.5).floor() as i64
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Rokuyo {
    Taian,
    Shakko,
    Sensho,
    Tomobiki,
    Senbu,
    Butsumetsu,
}

impl Rokuyo {
    pub const fn name_ja(self) -> &'static str {
        match self {
            Self::Taian => "大安",
            Self::Shakko => "赤口",
            Self::Sensho => "先勝",
            Self::Tomobiki => "友引",
            Self::Senbu => "先負",
            Self::Butsumetsu => "仏滅",
        }
    }

    pub const fn from_lunar(month: u8, day: u8) -> Self {
        match (month as usize + day as usize) % 6 {
            0 => Self::Taian,
            1 => Self::Shakko,
            2 => Self::Sensho,
            3 => Self::Tomobiki,
            4 => Self::Senbu,
            _ => Self::Butsumetsu,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct KyurekiDate {
    pub year: i32,
    pub month: u8,
    pub is_leap: bool,
    pub day: u8,
    pub rokuyo: Rokuyo,
}

fn find_new_moon_jst_day_before_or_on(target_jst_day: i64) -> (f64, i64) {
    let jd_noon_ut = (target_jst_day as f64) - JST_OFFSET_DAYS;
    let sun_lon = sun_apparent_ecliptic_lon_deg(ut_to_tt_jd(jd_noon_ut));
    let moon_lon = moon_apparent_ecliptic_lon_deg(ut_to_tt_jd(jd_noon_ut));
    let phase = wrap_deg_360(moon_lon - sun_lon);
    let mut nm_ut = find_new_moon_near_jd_ut(jd_noon_ut - (phase / 360.0) * SYNODIC_MONTH_DAYS);
    let mut nm_day = jd_ut_to_jst_day_number(nm_ut);

    while nm_day > target_jst_day {
        nm_ut = find_new_moon_near_jd_ut(nm_ut - SYNODIC_MONTH_DAYS);
        nm_day = jd_ut_to_jst_day_number(nm_ut);
    }
    loop {
        let next_ut = find_new_moon_near_jd_ut(nm_ut + SYNODIC_MONTH_DAYS);
        let next_day = jd_ut_to_jst_day_number(next_ut);
        if next_day <= target_jst_day {
            nm_ut = next_ut;
            nm_day = next_day;
        } else {
            break;
        }
    }
    (nm_ut, nm_day)
}

/// Compute official Japanese Kyureki (天保暦) lunar date and Rokuyo for JST date `(year, month, day)`.
pub fn gregorian_to_kyureki(year: i32, month: u8, day: u8) -> KyurekiDate {
    let target_day = jst_day_number(year, month, day);
    let (cur_nm_ut, cur_nm_day) = find_new_moon_jst_day_before_or_on(target_day);
    let lunar_day = (target_day - cur_nm_day + 1) as u8;

    // Collect Chūki (principal solar terms at 0°, 30°, ..., 330°) JST day numbers covering nearby years
    let mut chuki_days: Vec<i64> = Vec::with_capacity(30);
    let mut ws_days: Vec<(i32, i64)> = Vec::with_capacity(3);
    for y in (year - 1)..=(year + 1) {
        for &term_idx in &[0u8, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22] {
            let jd_ut = find_solar_term_jd_ut(y, term_idx);
            let d = jd_ut_to_jst_day_number(jd_ut);
            chuki_days.push(d);
            if term_idx == 18 {
                ws_days.push((y, d));
            }
        }
    }
    chuki_days.sort_unstable();
    chuki_days.dedup();
    ws_days.sort_by_key(|x| x.1);

    // Find the Winter Solstice lunation (Month 11) immediately on or before cur_nm_day
    let mut ws_idx = 0usize;
    for (i, &(_, ws_day)) in ws_days.iter().enumerate() {
        let (_, ws_nm_day) = find_new_moon_jst_day_before_or_on(ws_day);
        if ws_nm_day <= cur_nm_day {
            ws_idx = i;
        }
    }
    let (_, ws_start_day) = ws_days[ws_idx];
    let (m11_prev_ut, m11_prev_day) = find_new_moon_jst_day_before_or_on(ws_start_day);

    let m11_next_day = if ws_idx + 1 < ws_days.len() {
        let (_, ws_end_day) = ws_days[ws_idx + 1];
        find_new_moon_jst_day_before_or_on(ws_end_day).1
    } else {
        m11_prev_day + 400
    };

    // Build all lunations from m11_prev up to (but not including) m11_next
    let mut lunations: Vec<(i64, i64)> = Vec::with_capacity(14);
    let mut nm_ut = m11_prev_ut;
    let mut nm_day = m11_prev_day;
    while nm_day < m11_next_day {
        let next_ut = find_new_moon_near_jd_ut(nm_ut + SYNODIC_MONTH_DAYS);
        let next_day = jd_ut_to_jst_day_number(next_ut);
        lunations.push((nm_day, next_day));
        nm_ut = next_ut;
        nm_day = next_day;
    }

    let has_leap = lunations.len() == 13;
    let mut leap_assigned = false;
    let mut cur_month: u8 = 11;
    let mut cur_leap = false;

    for (idx, &(start_d, end_d)) in lunations.iter().enumerate() {
        let has_chuki = chuki_days.iter().any(|&c| c >= start_d && c < end_d);
        let (m, is_leap) = if idx == 0 {
            (11, false)
        } else if has_leap && !leap_assigned && !has_chuki {
            leap_assigned = true;
            (cur_month, true)
        } else {
            let next_m = if cur_month == 12 { 1 } else { cur_month + 1 };
            (next_m, false)
        };
        cur_month = m;
        cur_leap = is_leap;
        if start_d == cur_nm_day {
            break;
        }
    }

    // Approximate lunar year matching Gregorian New Year boundary
    let approx_lunar_year = if cur_month >= 11 && month <= 2 {
        year - 1
    } else if cur_month <= 2 && month >= 11 {
        year + 1
    } else {
        year
    };

    let _ = cur_nm_ut;
    KyurekiDate {
        year: approx_lunar_year,
        month: cur_month,
        is_leap: cur_leap,
        day: lunar_day,
        rokuyo: Rokuyo::from_lunar(cur_month, lunar_day),
    }
}

/// Day of week (0 = Sunday, 1 = Monday, ..., 6 = Saturday) for JST date.
fn day_of_week(year: i32, month: u8, day: u8) -> u8 {
    // JD at noon + 1.5 mod 7 => 0=Sun, 1=Mon, ...
    let d = (calendar_to_jd(year, month, f64::from(day)) + 1.5).round() as i64;
    d.rem_euclid(7) as u8
}

fn nth_monday_day(year: i32, month: u8, nth: u8) -> u8 {
    let dow_first = day_of_week(year, month, 1);
    let first_mon = 1 + ((8 - dow_first) % 7);
    first_mon + (nth - 1) * 7
}

fn base_japanese_holiday(year: i32, month: u8, day: u8) -> Option<&'static str> {
    match (month, day) {
        (1, 1) => Some("元日"),
        (1, d) if year >= 2000 && d == nth_monday_day(year, 1, 2) => Some("成人の日"),
        (1, 15) if year < 2000 => Some("成人の日"),
        (2, 11) if year >= 1967 => Some("建国記念の日"),
        (2, 23) if year >= 2020 => Some("天皇誕生日"),
        (3, d) => {
            let (_, _, eq_day, _, _, _) =
                jd_to_ymd_hms(find_solar_term_jd_ut(year, 0) + JST_OFFSET_DAYS);
            if d == eq_day {
                Some("春分の日")
            } else {
                None
            }
        }
        (4, 29) if year >= 2007 => Some("昭和の日"),
        (4, 29) if year >= 1989 => Some("みどりの日"),
        (4, 29) => Some("天皇誕生日"),
        (5, 3) => Some("憲法記念日"),
        (5, 4) if year >= 2007 => Some("みどりの日"),
        (5, 5) => Some("こどもの日"),
        (7, d) if year >= 2003 && year != 2020 && year != 2021 && d == nth_monday_day(year, 7, 3) => {
            Some("海の日")
        }
        (8, 11) if year >= 2016 && year != 2020 && year != 2021 => Some("山の日"),
        (9, d) if year >= 2003 && d == nth_monday_day(year, 9, 3) => Some("敬老の日"),
        (9, d) => {
            let (_, _, eq_day, _, _, _) =
                jd_to_ymd_hms(find_solar_term_jd_ut(year, 12) + JST_OFFSET_DAYS);
            if d == eq_day {
                Some("秋分の日")
            } else {
                None
            }
        }
        (10, d) if year >= 2000 && year != 2020 && year != 2021 && d == nth_monday_day(year, 10, 2) => {
            if year >= 2020 {
                Some("スポーツの日")
            } else {
                Some("体育の日")
            }
        }
        (11, 3) => Some("文化の日"),
        (11, 23) => Some("勤労感謝の日"),
        (12, 23) if (1989..=2018).contains(&year) => Some("天皇誕生日"),
        _ => None,
    }
}

/// Official Japanese National Holiday for `(year, month, day)` including 振替休日 and 国民の休日.
pub fn japanese_holiday(year: i32, month: u8, day: u8) -> Option<&'static str> {
    if let Some(h) = base_japanese_holiday(year, month, day) {
        return Some(h);
    }

    let dow = day_of_week(year, month, day);
    let target_day = jst_day_number(year, month, day);

    // 振替休日: If a holiday fell on Sunday, the next non-holiday weekday is a substitute holiday
    if dow >= 1 {
        let mut back = 1i64;
        loop {
            let prev_jd = (target_day - back) as f64;
            let (py, pm, pd, _, _, _) = jd_to_ymd_hms(prev_jd);
            if base_japanese_holiday(py, pm, pd).is_some() {
                if day_of_week(py, pm, pd) == 0 {
                    return Some("振替休日");
                }
                back += 1;
            } else {
                break;
            }
        }
    }

    // 国民の休日: A non-holiday sandwiched immediately between two national holidays (e.g., 2026-09-22)
    let (py, pm, pd, _, _, _) = jd_to_ymd_hms((target_day - 1) as f64);
    let (ny, nm, nd, _, _, _) = jd_to_ymd_hms((target_day + 1) as f64);
    if base_japanese_holiday(py, pm, pd).is_some() && base_japanese_holiday(ny, nm, nd).is_some()
    {
        return Some("国民の休日");
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn meeus_ch7_julian_day_and_mjd() {
        // Sputnik launch: 1957-10-04 19:26:24 UT = 1957-10-04.81 UT -> JD 2436116.31
        let jd_sputnik = calendar_to_jd(1957, 10, 4.81);
        assert!((jd_sputnik - 2_436_116.31).abs() < 1e-6);

        // J2000.0: 2000-01-01 12:00:00 -> JD 2451545.0, MJD 51544.5
        let jd2000 = ymd_hms_to_jd(2000, 1, 1, 12, 0, 0.0);
        assert!((jd2000 - 2_451_545.0).abs() < 1e-9);
        assert!((jd_to_mjd(jd2000) - 51_544.5).abs() < 1e-9);
        assert!((mjd_to_jd(51_544.5) - 2_451_545.0).abs() < 1e-9);

        // BC year roundtrip (-4712 = 4713 BC Jan 1 12:00 UT = JD 0.0)
        let jd0 = calendar_to_jd(-4712, 1, 1.5);
        assert!(jd0.abs() < 1e-9, "jd0={jd0}");
        let (y, m, d, h, min, s) = jd_to_ymd_hms(2_436_116.31);
        assert_eq!((y, m, d), (1957, 10, 4));
        assert_eq!((h, min), (19, 26));
        assert!((s - 24.0).abs() < 0.1);
    }

    #[test]
    fn delta_t_historical_modern_and_extreme() {
        assert!((delta_t_seconds(1900.0) - (-2.79)).abs() < 0.1);
        assert!((delta_t_seconds(2000.0) - 63.86).abs() < 0.2);
        assert!((delta_t_seconds(2026.0) - 69.2).abs() < 0.5);
        assert!(delta_t_seconds(-2500.0).is_finite());
        assert!(delta_t_seconds(4500.0).is_finite());
    }

    #[test]
    fn meeus_example_12a_gmst() {
        // 1987-04-10 00:00:00 UT -> JD = 2446895.5
        // Meeus: GMST = 13h10m46.3668s = 197.693195°
        let gmst = gmst_deg(2_446_895.5);
        assert!((gmst - 197.693_195).abs() < 1e-4, "gmst={gmst}");

        // Akashi LST at 135.0°E = wrap(gmst + 135.0)
        let akashi_lst = lst_deg(2_446_895.5, 135.0);
        assert!((akashi_lst - wrap_deg_360(197.693_195 + 135.0)).abs() < 1e-4);
    }

    #[test]
    fn year_2026_kyureki_and_rokuyo_and_holidays() {
        // 2026-02-17 is Kyureki New Year (旧暦 2026年1月1日, 先勝)
        let shogatsu = gregorian_to_kyureki(2026, 2, 17);
        assert_eq!(shogatsu.year, 2026);
        assert_eq!(shogatsu.month, 1);
        assert!(!shogatsu.is_leap);
        assert_eq!(shogatsu.day, 1);
        assert_eq!(shogatsu.rokuyo, Rokuyo::Sensho);

        // 2026-09-25 is Chūshū no Meigetsu (旧暦 2026年8月15日)
        let meigetsu = gregorian_to_kyureki(2026, 9, 25);
        assert_eq!(meigetsu.month, 8);
        assert_eq!(meigetsu.day, 15);
        assert!(!meigetsu.is_leap);

        // 2026 Japanese Holidays (Silver Week: 9/21 敬老の日, 9/22 国民の休日, 9/23 秋分の日)
        assert_eq!(japanese_holiday(2026, 3, 20), Some("春分の日"));
        assert_eq!(japanese_holiday(2026, 9, 21), Some("敬老の日"));
        assert_eq!(japanese_holiday(2026, 9, 22), Some("国民の休日"));
        assert_eq!(japanese_holiday(2026, 9, 23), Some("秋分の日"));
        assert_eq!(solar_term_on_jst_date(2026, 3, 20), Some("春分"));
        assert_eq!(solar_term_on_jst_date(2026, 6, 21), Some("夏至"));
    }
}
