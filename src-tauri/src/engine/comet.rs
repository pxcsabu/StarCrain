use serde::{Deserialize, Serialize};

use crate::engine::coords::{
    Ecliptic, Equatorial, Vec3, angular_distance_deg, equatorial_to_ecliptic, vec3_to_equatorial,
};
use crate::engine::ephemeris::{
    AU_KM, LIGHT_TIME_DAYS_PER_AU, earth_helio_j2000_au, earth_velocity_j2000_au_day,
    ecliptic_vec_to_equatorial_vec, sun_ephemeris,
};
use crate::engine::precession::{
    OBLIQUITY_J2000_DEG, apply_nutation_to_equatorial, nutation, precess_j2000_to_date,
};

/// Gaussian gravitational constant `k` (`AU^(3/2) / day`).
const GAUSS_K: f64 = 0.017_202_098_95;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CometElements {
    pub id: String,
    pub name: String,
    pub epoch_perihelion_jd: f64,
    pub perihelion_dist_au: f64,
    pub eccentricity: f64,
    pub inclination_deg: f64,
    pub arg_periapsis_deg: f64,
    pub ascending_node_deg: f64,
    pub abs_mag_h: f64,
    /// Photometric slope parameter `k` in `m = H + 5*log10(Δ) + k*log10(r)` (typically `10.0` = `2.5 * 4`).
    pub slope_param_k: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct CometEphemeris {
    pub helio_xyz_j2000_au: Vec3,
    pub geo_xyz_j2000_au: Vec3,
    pub eq_j2000: Equatorial,
    pub eq_apparent: Equatorial,
    pub ecliptic_apparent: Ecliptic,
    pub helio_au: f64,
    pub geo_au: f64,
    pub elongation_deg: f64,
    pub phase_angle_deg: f64,
    pub visual_magnitude: f64,
}

/// Solve orbital plane `(x_orb, y_orb)` in AU for elliptical (`e < 1`),
/// parabolic (`e ≈ 1`, Barker's equation), and hyperbolic (`e > 1`) orbits.
pub fn orbital_plane_xy_au(q_au: f64, e: f64, dt_days: f64) -> (f64, f64) {
    if (e - 1.0).abs() < 1e-7 {
        // Parabolic: Barker's equation (Meeus Ch. 34)
        let half_w = (1.5 * GAUSS_K / std::f64::consts::SQRT_2) * dt_days / q_au.powf(1.5);
        let y = (half_w.abs() + (half_w * half_w + 1.0).sqrt()).cbrt();
        let s = half_w.signum() * (y - 1.0 / y);
        let x_orb = q_au * (1.0 - s * s);
        let y_orb = 2.0 * q_au * s;
        (x_orb, y_orb)
    } else if e < 1.0 {
        // Elliptical
        let a = q_au / (1.0 - e);
        let n = GAUSS_K / a.powf(1.5);
        let m = (n * dt_days).rem_euclid(std::f64::consts::TAU);
        let mut ea = if e < 0.8 { m } else { std::f64::consts::PI };
        for _ in 0..32 {
            let sin_e = ea.sin();
            let cos_e = ea.cos();
            let f = ea - e * sin_e - m;
            let fp = 1.0 - e * cos_e;
            let fpp = e * sin_e;
            let delta = f / (fp - 0.5 * f * fpp / fp);
            ea -= delta;
            if delta.abs() < 1e-13 {
                break;
            }
        }
        let x_orb = a * (ea.cos() - e);
        let y_orb = a * (1.0 - e * e).sqrt() * ea.sin();
        (x_orb, y_orb)
    } else {
        // Hyperbolic: e sinh(H) - H = M_h
        let a_abs = q_au / (e - 1.0);
        let n_h = GAUSS_K / a_abs.powf(1.5);
        let mh = n_h * dt_days;
        let mut h = if mh == 0.0 {
            0.0
        } else if mh.abs() < 5.0 {
            (mh / (e - 1.0)).asinh()
        } else {
            mh.signum() * (2.0 * mh.abs() / e + 1.8).ln()
        };
        for _ in 0..40 {
            let sinh_h = h.sinh();
            let cosh_h = h.cosh();
            let f = e * sinh_h - h - mh;
            let fp = e * cosh_h - 1.0;
            let delta = f / fp;
            h -= delta;
            if delta.abs() < 1e-13 {
                break;
            }
        }
        let x_orb = a_abs * (e - h.cosh());
        let y_orb = a_abs * (e * e - 1.0).sqrt() * h.sinh();
        (x_orb, y_orb)
    }
}

fn orbital_xy_to_j2000_ecliptic(el: &CometElements, x_orb: f64, y_orb: f64) -> Vec3 {
    let (so, co) = el.arg_periapsis_deg.to_radians().sin_cos();
    let (sn, cn) = el.ascending_node_deg.to_radians().sin_cos();
    let (si, ci) = el.inclination_deg.to_radians().sin_cos();

    let x = (cn * co - sn * so * ci) * x_orb + (-cn * so - sn * co * ci) * y_orb;
    let y = (sn * co + cn * so * ci) * x_orb + (-sn * so + cn * co * ci) * y_orb;
    let z = (so * si) * x_orb + (co * si) * y_orb;
    Vec3::new(x, y, z)
}

/// Heliocentric J2000 ecliptic Cartesian coordinates (AU) of a comet at `jd_tt`.
pub fn comet_heliocentric_xyz_j2000_au(el: &CometElements, jd_tt: f64) -> Vec3 {
    let dt = jd_tt - el.epoch_perihelion_jd;
    let (x_orb, y_orb) = orbital_plane_xy_au(el.perihelion_dist_au, el.eccentricity, dt);
    orbital_xy_to_j2000_ecliptic(el, x_orb, y_orb)
}

/// Smoothly sample a comet's orbital curve in J2000 ecliptic AU coordinates using
/// perihelion-refined anomaly parameterization so curves stay crisp even at high eccentricity.
pub fn sample_comet_orbit_j2000_au(
    el: &CometElements,
    steps: usize,
    max_radius_au: f64,
) -> Vec<[f64; 3]> {
    let n = steps.max(120);
    let q = el.perihelion_dist_au.max(1e-4);
    let e = el.eccentricity.max(0.0);
    let mut pts = Vec::with_capacity(n + 1);

    if e < 0.995 {
        let a = q / (1.0 - e);
        let b = a * (1.0 - e * e).sqrt();
        let k = 0.28 * e;
        for i in 0..=n {
            let u = -std::f64::consts::PI + (i as f64 / n as f64) * std::f64::consts::TAU;
            let ea = u - k * u.sin();
            let x_orb = a * (ea.cos() - e);
            let y_orb = b * ea.sin();
            let v = orbital_xy_to_j2000_ecliptic(el, x_orb, y_orb);
            pts.push([v.x, v.y, v.z]);
        }
    } else {
        let p = q * (1.0 + e);
        let cos_lim = ((p / max_radius_au.max(q * 2.0)) - 1.0) / e;
        let nu_max = cos_lim
            .clamp(-0.9992, 0.9992)
            .acos()
            .min(std::f64::consts::PI * 0.96);
        for i in 0..=n {
            let s = -1.0 + 2.0 * (i as f64 / n as f64);
            let nu = nu_max * s * (0.45 + 0.55 * s.abs());
            let denom = (1.0 + e * nu.cos()).max(1e-6);
            let r = (p / denom).min(max_radius_au * 1.05);
            let x_orb = r * nu.cos();
            let y_orb = r * nu.sin();
            let v = orbital_xy_to_j2000_ecliptic(el, x_orb, y_orb);
            pts.push([v.x, v.y, v.z]);
        }
    }

    pts
}

/// Full geocentric/apparent comet ephemeris at `jd_tt` (with light-time & annual aberration).
pub fn comet_ephemeris(el: &CometElements, jd_tt: f64) -> CometEphemeris {
    let earth_pos = earth_helio_j2000_au(jd_tt);
    let earth_vel = earth_velocity_j2000_au_day(jd_tt);

    let mut pos = comet_heliocentric_xyz_j2000_au(el, jd_tt);
    for _ in 0..2 {
        let delta = (pos - earth_pos).norm();
        pos = comet_heliocentric_xyz_j2000_au(el, jd_tt - LIGHT_TIME_DAYS_PER_AU * delta);
    }

    let geo_ecl = pos - earth_pos;
    let helio_au = pos.norm();
    let geo_au = geo_ecl.norm();

    let geo_j2000_eq = ecliptic_vec_to_equatorial_vec(geo_ecl, OBLIQUITY_J2000_DEG);
    let eq_j2000 = vec3_to_equatorial(geo_j2000_eq);

    let speed_of_light_au_day = 1.0 / LIGHT_TIME_DAYS_PER_AU;
    let earth_vel_eq = ecliptic_vec_to_equatorial_vec(earth_vel, OBLIQUITY_J2000_DEG);
    let u_aberr = (geo_j2000_eq.normalize() + earth_vel_eq.scale(1.0 / speed_of_light_au_day))
        .normalize();
    let eq_aberr_j2000 = vec3_to_equatorial(u_aberr);

    let eq_mean_date = precess_j2000_to_date(eq_aberr_j2000, jd_tt);
    let nut = nutation(jd_tt);
    let eq_apparent = apply_nutation_to_equatorial(eq_mean_date, &nut);
    let ecliptic_apparent = equatorial_to_ecliptic(eq_apparent, nut.true_obliquity_deg);

    let sun_eq = sun_ephemeris(jd_tt).eq_apparent;
    let elongation_deg = angular_distance_deg(eq_apparent, sun_eq);

    let r_earth = earth_pos.norm();
    let cos_phase = ((helio_au * helio_au + geo_au * geo_au - r_earth * r_earth)
        / (2.0 * helio_au * geo_au))
        .clamp(-1.0, 1.0);
    let phase_angle_deg = cos_phase.acos().to_degrees();

    let visual_magnitude =
        el.abs_mag_h + 5.0 * geo_au.max(1e-6).log10() + el.slope_param_k * helio_au.max(1e-6).log10();

    let _ = AU_KM;
    CometEphemeris {
        helio_xyz_j2000_au: pos,
        geo_xyz_j2000_au: geo_ecl,
        eq_j2000,
        eq_apparent,
        ecliptic_apparent,
        helio_au,
        geo_au,
        elongation_deg,
        phase_angle_deg,
        visual_magnitude,
    }
}

#[cfg(test)]
mod tests {
    use crate::engine::time::calendar_to_jd;

    use super::*;

    #[test]
    fn elliptical_halley_1986_perihelion() {
        // 1P/Halley 1986 apparition: T = 1986-02-09.4589 TT, q = 0.58710 AU, e = 0.96727
        let t_p = calendar_to_jd(1986, 2, 9.4589);
        let halley = CometElements {
            id: "1P".into(),
            name: "1P/Halley".into(),
            epoch_perihelion_jd: t_p,
            perihelion_dist_au: 0.587_10,
            eccentricity: 0.967_27,
            inclination_deg: 162.239,
            arg_periapsis_deg: 111.847,
            ascending_node_deg: 58.860,
            abs_mag_h: 5.5,
            slope_param_k: 10.0,
        };
        let p_peri = comet_heliocentric_xyz_j2000_au(&halley, t_p);
        assert!((p_peri.norm() - halley.perihelion_dist_au).abs() < 1e-9);

        let eph = comet_ephemeris(&halley, t_p + 30.0);
        assert!(eph.helio_au > 0.7 && eph.helio_au < 1.0);
        assert!(eph.visual_magnitude.is_finite());
    }

    #[test]
    fn parabolic_barker_meeus_ch34_check() {
        // Verify exact Barker equation & parabolic conic geometry across perihelion distances and dt
        for &(q, dt) in &[(1.486_78, 66.4342), (0.5, -25.0), (1.0, 0.0), (2.2, 180.0)] {
            let (x, y) = orbital_plane_xy_au(q, 1.0, dt);
            let r = x.hypot(y);
            let nu = y.atan2(x);
            let s = (0.5 * nu).tan();
            let lhs = s + s * s * s / 3.0;
            let rhs = (GAUSS_K / std::f64::consts::SQRT_2) * dt / q.powf(1.5);
            assert!((lhs - rhs).abs() < 1e-11, "Barker mismatch: {lhs} vs {rhs}");
            let r_conic = q * (1.0 + s * s);
            assert!((r - r_conic).abs() < 1e-11, "r mismatch: {r} vs {r_conic}");
        }
    }

    #[test]
    fn hyperbolic_orbit_conic_equation_check() {
        let q = 1.25;
        let e = 1.35;
        for dt in [-120.0, -30.0, 0.0, 45.0, 180.0] {
            let (x, y) = orbital_plane_xy_au(q, e, dt);
            let r = x.hypot(y);
            let nu = y.atan2(x);
            let r_conic = q * (1.0 + e) / (1.0 + e * nu.cos());
            assert!((r - r_conic).abs() < 1e-10, "dt={dt}: r={r} vs {r_conic}");
        }
    }

    #[test]
    fn sampled_comet_orbits_are_smooth_and_accurate() {
        let t_p = calendar_to_jd(1986, 2, 9.4589);
        let halley = CometElements {
            id: "1P".into(),
            name: "1P/Halley".into(),
            epoch_perihelion_jd: t_p,
            perihelion_dist_au: 0.587_10,
            eccentricity: 0.967_27,
            inclination_deg: 162.239,
            arg_periapsis_deg: 111.847,
            ascending_node_deg: 58.860,
            abs_mag_h: 5.5,
            slope_param_k: 10.0,
        };
        let pts = sample_comet_orbit_j2000_au(&halley, 480, 45.0);
        assert_eq!(pts.len(), 481);
        let loop_gap = {
            let a = pts[0];
            let b = pts[pts.len() - 1];
            ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt()
        };
        assert!(loop_gap < 1e-9, "elliptical orbit must close smoothly: gap={loop_gap}");

        let min_r = pts
            .iter()
            .map(|p| (p[0] * p[0] + p[1] * p[1] + p[2] * p[2]).sqrt())
            .fold(f64::INFINITY, f64::min);
        assert!(
            (min_r - halley.perihelion_dist_au).abs() < 1e-3,
            "perihelion min_r={min_r} vs q={}",
            halley.perihelion_dist_au
        );

        let mut max_turn_deg = 0.0_f64;
        for w in pts.windows(3) {
            let v1 = [w[1][0] - w[0][0], w[1][1] - w[0][1], w[1][2] - w[0][2]];
            let v2 = [w[2][0] - w[1][0], w[2][1] - w[1][1], w[2][2] - w[1][2]];
            let n1 = (v1[0] * v1[0] + v1[1] * v1[1] + v1[2] * v1[2]).sqrt();
            let n2 = (v2[0] * v2[0] + v2[1] * v2[1] + v2[2] * v2[2]).sqrt();
            let dot = ((v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2]) / (n1 * n2)).clamp(-1.0, 1.0);
            max_turn_deg = max_turn_deg.max(dot.acos().to_degrees());
        }
        assert!(max_turn_deg < 4.5, "jagged comet orbit segment angle={max_turn_deg}");

        let hyper = CometElements {
            eccentricity: 1.05,
            perihelion_dist_au: 0.8,
            ..halley
        };
        let hpts = sample_comet_orbit_j2000_au(&hyper, 320, 40.0);
        assert_eq!(hpts.len(), 321);
        let h_min = hpts
            .iter()
            .map(|p| (p[0] * p[0] + p[1] * p[1] + p[2] * p[2]).sqrt())
            .fold(f64::INFINITY, f64::min);
        let h_max = hpts
            .iter()
            .map(|p| (p[0] * p[0] + p[1] * p[1] + p[2] * p[2]).sqrt())
            .fold(0.0_f64, f64::max);
        assert!((h_min - 0.8).abs() < 1e-3, "h_min={h_min}");
        assert!(h_max <= 42.5, "h_max={h_max}");
    }
}
