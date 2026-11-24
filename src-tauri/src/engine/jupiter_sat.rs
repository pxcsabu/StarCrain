use serde::{Deserialize, Serialize};

use crate::engine::coords::{apply_standard_refraction, equatorial_to_horizontal, wrap_deg_180, wrap_deg_360};
use crate::engine::ephemeris::{
    Planet, geocentric_to_topocentric, planet_ephemeris, sun_ephemeris,
};
use crate::engine::precession::J2000_JD;
use crate::engine::rise_set::ObserverLocation;
use crate::engine::time::{jd_to_ymd_hms, last_deg, ut_to_tt_jd};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct JupiterPhysicalEphemeris {
    pub jd_tt: f64,
    pub cm_sys1_deg: f64,
    pub cm_sys2_deg: f64,
    pub cm_sys3_deg: f64,
    pub de_deg: f64,
    pub ds_deg: f64,
    pub phase_angle_deg: f64,
    pub pole_pa_deg: f64,
    pub apparent_eq_diam_arcsec: f64,
    pub grs_sys2_lon_deg: f64,
    /// Offset from central meridian (`cm_sys2 - grs_lon`), wrapped to `[-180, 180)`. Visible when `|offset| < 65°`.
    pub grs_offset_deg: f64,
    pub grs_visible: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GalileanMoonPosition {
    pub id: String,
    pub name_ja: String,
    pub x_rj: f64,
    pub y_rj: f64,
    pub z_rj: f64,
    pub x_shadow_rj: f64,
    pub y_shadow_rj: f64,
    pub status_ja: String,
    pub in_front_of_disk: bool,
    pub behind_disk: bool,
    pub in_eclipse: bool,
    pub shadow_on_disk: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GrsTransitEvent {
    pub jd_ut: f64,
    pub time_str: String,
    pub cm_sys2_deg: f64,
    pub jupiter_alt_deg: f64,
    pub sun_alt_deg: f64,
    pub observable: bool,
}

struct MeeusJupAux {
    d_prime: f64,
    psi_deg: f64,
    b_deg: f64,
    de_deg: f64,
    ds_deg: f64,
}

fn jupiter_meeus_aux(jd_tt: f64) -> MeeusJupAux {
    let d = jd_tt - J2000_JD;
    let v = (172.74 + 0.001_115_88 * d).to_radians();
    let m = (357.529 + 0.985_600_3 * d).to_radians();
    let n_deg = 20.020 + 0.083_085_3 * d + 0.329 * v.sin();
    let n = n_deg.to_radians();
    let j_deg = 66.115 + 0.902_517_9 * d - 0.329 * v.sin();

    let a_deg = 1.915 * m.sin() + 0.020 * (2.0 * m).sin();
    let b_deg = 5.555 * n.sin() + 0.168 * (2.0 * n).sin();
    let k = (j_deg + a_deg - b_deg).to_radians();

    let r_earth = 1.000_14 - 0.016_71 * m.cos() - 0.000_14 * (2.0 * m).cos();
    let r_jup = 5.208_72 - 0.252_08 * n.cos() - 0.006_11 * (2.0 * n).cos();
    let delta = (r_jup * r_jup + r_earth * r_earth - 2.0 * r_jup * r_earth * k.cos()).sqrt();
    let psi_deg = ((r_earth / delta) * k.sin()).clamp(-1.0, 1.0).asin().to_degrees();

    let d_prime = d - delta / 173.144_6;
    let lambda_deg = 34.35 + 0.083_091 * d + 0.329 * v.sin() + b_deg;
    let ds_deg = 3.12 * (lambda_deg + 42.8).to_radians().sin();
    let psi_r = psi_deg.to_radians();
    let de_deg = ds_deg
        - 2.22 * psi_r.sin() * (lambda_deg + 22.0).to_radians().cos()
        - 1.30 * ((r_jup - delta) / delta) * (lambda_deg - 100.5).to_radians().sin();

    MeeusJupAux {
        d_prime,
        psi_deg,
        b_deg,
        de_deg,
        ds_deg,
    }
}

/// Compute Jupiter's physical ephemeris (System I/II/III central meridians, axis tilt, GRS offset) at `jd_tt` (Meeus Ch. 43 / IAU).
pub fn jupiter_physical_ephemeris(jd_tt: f64, grs_sys2_lon_deg: f64) -> JupiterPhysicalEphemeris {
    let eph = planet_ephemeris(Planet::Jupiter, jd_tt);
    let aux = jupiter_meeus_aux(jd_tt);

    // Light-time corrected days since J2000.0 (exact VSOP87 distance)
    let tau = eph.geo_au * crate::engine::ephemeris::LIGHT_TIME_DAYS_PER_AU;
    let d_obs = (jd_tt - tau) - J2000_JD;
    let t_cen = d_obs / 36_525.0;

    // IAU Jupiter North Pole in J2000 equatorial coordinates
    let alpha_p = (268.056_595 - 0.006_499 * t_cen).to_radians();
    let delta_p = (64.495_303 + 0.002_413 * t_cen).to_radians();

    // Direction Earth -> Jupiter in J2000 equatorial coordinates (apparent vector without date precession matches IAU)
    let ra_j = eph.eq_j2000.ra_deg.to_radians();
    let dec_j = eph.eq_j2000.dec_deg.to_radians();
    let d_alpha = alpha_p - ra_j;

    // Sub-Earth planetocentric declination D_E and sub-Earth meridian node angle zeta
    let sin_de = (-delta_p.sin() * dec_j.sin() - delta_p.cos() * dec_j.cos() * d_alpha.cos())
        .clamp(-1.0, 1.0);
    let de_deg = sin_de.asin().to_degrees();

    let zeta_deg = (delta_p.sin() * dec_j.cos() * d_alpha.cos() - delta_p.cos() * dec_j.sin())
        .atan2(dec_j.cos() * d_alpha.sin())
        .to_degrees();

    let polar_pa_deg = wrap_deg_360(
        (delta_p.cos() * d_alpha.sin())
            .atan2(delta_p.sin() * dec_j.cos() - delta_p.cos() * dec_j.sin() * d_alpha.cos())
            .to_degrees(),
    );

    // IAU prime meridians W_1, W_2, W_3 measured east from IAU node
    let w1 = 67.1 + 877.900_035_39 * d_obs;
    let w2 = 43.3 + 870.270_035_39 * d_obs;
    let w3 = 284.95 + 870.536_000_0 * d_obs;

    let cm_sys1_deg = wrap_deg_360(w1 - zeta_deg);
    let cm_sys2_deg = wrap_deg_360(w2 - zeta_deg);
    let cm_sys3_deg = wrap_deg_360(w3 - zeta_deg);

    let grs_offset_deg = wrap_deg_180(cm_sys2_deg - grs_sys2_lon_deg);
    let grs_visible = grs_offset_deg.abs() <= 68.0;

    JupiterPhysicalEphemeris {
        jd_tt,
        cm_sys1_deg,
        cm_sys2_deg,
        cm_sys3_deg,
        de_deg,
        ds_deg: aux.ds_deg,
        phase_angle_deg: eph.phase_angle_deg,
        pole_pa_deg: polar_pa_deg,
        apparent_eq_diam_arcsec: eph.angular_diameter_arcsec,
        grs_sys2_lon_deg: wrap_deg_360(grs_sys2_lon_deg),
        grs_offset_deg,
        grs_visible,
    }
}

/// Compute Galilean satellite positions (X, Y, Z in Jupiter equatorial radii) at `jd_tt` (Meeus Ch. 44).
pub fn galilean_moons_at(jd_tt: f64) -> [GalileanMoonPosition; 4] {
    let aux = jupiter_meeus_aux(jd_tt);
    let d_p = aux.d_prime;
    let psi_b = aux.psi_deg - aux.b_deg;
    let de_r = aux.de_deg.to_radians();

    let u1_0 = wrap_deg_360(163.8069 + 203.405_864_6 * d_p + psi_b);
    let u2_0 = wrap_deg_360(358.4140 + 101.291_633_5 * d_p + psi_b);
    let u3_0 = wrap_deg_360(5.7176 + 50.234_518_0 * d_p + psi_b);
    let u4_0 = wrap_deg_360(224.8092 + 21.487_980_0 * d_p + psi_b);

    let g = (331.18 + 50.310_482 * d_p).to_radians();
    let h = (87.45 + 21.569_231 * d_p).to_radians();

    let diff12 = 2.0 * (u1_0 - u2_0).to_radians();
    let diff23 = 2.0 * (u2_0 - u3_0).to_radians();

    let u1 = (u1_0 + 0.472 * diff12.sin()).to_radians();
    let u2 = (u2_0 + 1.065 * diff23.sin()).to_radians();
    let u3 = (u3_0 + 0.165 * g.sin()).to_radians();
    let u4 = (u4_0 + 0.843 * h.sin()).to_radians();

    let r1 = 5.9057 - 0.0244 * diff12.cos();
    let r2 = 9.3966 - 0.0882 * diff23.cos();
    let r3 = 14.9883 - 0.0216 * g.cos();
    let r4 = 26.3627 - 0.1939 * h.cos();

    let flattening_inv = 1.0 / (1.0 - 0.06487); // ~1.0694, flattening 1/15.4

    let specs = [
        ("io", "イオ (I)", r1, u1),
        ("europa", "エウロパ (II)", r2, u2),
        ("ganymede", "ガニメデ (III)", r3, u3),
        ("callisto", "カリスト (IV)", r4, u4),
    ];

    let psi_r = aux.psi_deg.to_radians();
    let ds_r = aux.ds_deg.to_radians();

    let build_one = |(id, name_ja, r, u): (&str, &str, f64, f64)| -> GalileanMoonPosition {
        // Meeus Eq. 44.1: X = r * sin(u), Y = -r * cos(u) * sin(D_E), Z = r * cos(u) * cos(D_E)
        // (+X = West of Jupiter, -X = East, -Y = North; Z > 0 = closer to Earth, Z < 0 = behind Jupiter)
        let x = r * u.sin();
        let y = -r * u.cos() * de_r.sin();
        let z = r * u.cos() * de_r.cos();

        // Sun-view coordinates for shadow / eclipse test (phase angle offset ~ -psi)
        let u_s = u - psi_r;
        let x_sh = r * u_s.sin();
        let y_sh = -r * u_s.cos() * ds_r.sin();
        let z_sh = r * u_s.cos() * ds_r.cos();

        let disk_dist_sq = x * x + (y * flattening_inv) * (y * flattening_inv);
        let sh_dist_sq = x_sh * x_sh + (y_sh * flattening_inv) * (y_sh * flattening_inv);

        let in_front_of_disk = z > 0.0 && disk_dist_sq <= 1.0;
        let behind_disk = z < 0.0 && disk_dist_sq <= 1.0;
        let in_eclipse = z_sh < 0.0 && sh_dist_sq <= 1.0;
        let shadow_on_disk = z_sh > 0.0 && sh_dist_sq <= 1.0;

        let status_ja = match (in_front_of_disk, behind_disk, in_eclipse, shadow_on_disk) {
            (_, true, true, _) => "掩蔽・食 (Oc+Ec)".to_owned(),
            (_, true, false, _) => "掩蔽 (Oc)".to_owned(),
            (_, false, true, _) => "食 (Ec)".to_owned(),
            (true, _, _, true) => "本体・影通過 (Tr+Sh)".to_owned(),
            (true, _, _, false) => "本体通過 (Tr)".to_owned(),
            (false, _, _, true) => "影通過 (Sh)".to_owned(),
            _ => "通常".to_owned(),
        };

        GalileanMoonPosition {
            id: id.to_owned(),
            name_ja: name_ja.to_owned(),
            x_rj: x,
            y_rj: y,
            z_rj: z,
            x_shadow_rj: x_sh,
            y_shadow_rj: y_sh,
            status_ja,
            in_front_of_disk,
            behind_disk,
            in_eclipse,
            shadow_on_disk,
        }
    };

    [
        build_one(specs[0]),
        build_one(specs[1]),
        build_one(specs[2]),
        build_one(specs[3]),
    ]
}

/// Find the next `count` Great Red Spot central-meridian transit events starting at `start_jd_ut`.
pub fn upcoming_grs_transits(
    start_jd_ut: f64,
    count: usize,
    grs_sys2_lon_deg: f64,
    loc: &ObserverLocation,
) -> Vec<GrsTransitEvent> {
    let mut out = Vec::with_capacity(count);
    let step_days = 0.04; // ~57.6 min (< 1/10th Jupiter rotation ~9.928h)
    let mut t = start_jd_ut;
    let mut prev_off =
        jupiter_physical_ephemeris(ut_to_tt_jd(t), grs_sys2_lon_deg).grs_offset_deg;

    let max_scan_jd = start_jd_ut + 15.0;
    while out.len() < count && t < max_scan_jd {
        let next_t = t + step_days;
        let next_off =
            jupiter_physical_ephemeris(ut_to_tt_jd(next_t), grs_sys2_lon_deg).grs_offset_deg;

        // Crossing 0 from negative to positive (CM II increases ~36.26°/hr)
        if prev_off <= 0.0 && next_off > 0.0 && (next_off - prev_off) < 90.0 {
            let mut a = t;
            let mut b = next_t;
            for _ in 0..24 {
                let mid = 0.5 * (a + b);
                let off_mid =
                    jupiter_physical_ephemeris(ut_to_tt_jd(mid), grs_sys2_lon_deg).grs_offset_deg;
                if off_mid < 0.0 {
                    a = mid;
                } else {
                    b = mid;
                }
            }
            let exact_jd_ut = 0.5 * (a + b);
            let exact_tt = ut_to_tt_jd(exact_jd_ut);
            let phys = jupiter_physical_ephemeris(exact_tt, grs_sys2_lon_deg);

            let lst = last_deg(exact_jd_ut, loc.lon_deg);
            let jup_eph = planet_ephemeris(Planet::Jupiter, exact_tt);
            let jup_topo = geocentric_to_topocentric(
                jup_eph.eq_apparent,
                jup_eph.geo_au,
                loc.lat_deg,
                loc.alt_m,
                lst,
            );
            let jup_alt_deg = apply_standard_refraction(
                equatorial_to_horizontal(jup_topo, loc.lat_deg, lst).alt_deg,
            );

            let sun_eph = sun_ephemeris(exact_tt);
            let sun_alt_deg =
                equatorial_to_horizontal(sun_eph.eq_apparent, loc.lat_deg, lst).alt_deg;

            let local_jd = exact_jd_ut + f64::from(loc.tz_offset_min) / 1440.0 + (0.5 / 1440.0);
            let (y, m, d, hh, mm, _) = jd_to_ymd_hms(local_jd);

            out.push(GrsTransitEvent {
                jd_ut: exact_jd_ut,
                time_str: format!("{y:04}-{m:02}-{d:02} {hh:02}:{mm:02}"),
                cm_sys2_deg: phys.cm_sys2_deg,
                jupiter_alt_deg: jup_alt_deg,
                sun_alt_deg,
                observable: jup_alt_deg > 10.0 && sun_alt_deg < -6.0,
            });
        }

        t = next_t;
        prev_off = next_off;
    }

    out
}

#[cfg(test)]
mod tests {
    use crate::engine::time::ymd_hms_to_jd;

    use super::*;

    #[test]
    fn meeus_example_43a_and_44a_jupiter_dec_1992() {
        // Meeus Ex 43.a & 44.a: 1992 December 16, 0h TD
        let jd_tt = ymd_hms_to_jd(1992, 12, 16, 0, 0, 0.0);
        let phys = jupiter_physical_ephemeris(jd_tt, 65.0);
        let moons = galilean_moons_at(jd_tt);

        println!(
            "1992-12-16 Jupiter CM1={:.2}° CM2={:.2}° De={:.2}° | X=[{:.2}, {:.2}, {:.2}, {:.2}]",
            phys.cm_sys1_deg,
            phys.cm_sys2_deg,
            phys.de_deg,
            moons[0].x_rj,
            moons[1].x_rj,
            moons[2].x_rj,
            moons[3].x_rj,
        );

        assert!(
            wrap_deg_180(phys.cm_sys1_deg - 267.14).abs() < 0.5,
            "CM I={}",
            phys.cm_sys1_deg
        );
        assert!(
            wrap_deg_180(phys.cm_sys2_deg - 71.88).abs() < 0.5,
            "CM II={}",
            phys.cm_sys2_deg
        );
        assert!((phys.de_deg - (-2.48)).abs() < 0.1, "De={}", phys.de_deg);

        // Galilean X positions check (Meeus Ex 44.a: X1≈-3.44, X2≈+7.44, X3≈+1.24, X4≈+7.08)
        assert!((moons[0].x_rj - (-3.44)).abs() < 0.2, "Io X={}", moons[0].x_rj);
        assert!((moons[1].x_rj - 7.44).abs() < 0.2, "Europa X={}", moons[1].x_rj);
        assert!((moons[2].x_rj - 1.24).abs() < 0.2, "Ganymede X={}", moons[2].x_rj);
        assert!((moons[3].x_rj - 7.08).abs() < 0.25, "Callisto X={}", moons[3].x_rj);
    }

    #[test]
    fn grs_transits_occur_every_9_93_hours() {
        let jd_ut = ymd_hms_to_jd(2026, 1, 10, 12, 0, 0.0);
        let transits = upcoming_grs_transits(jd_ut, 6, 65.0, &ObserverLocation::AKASHI);
        assert_eq!(transits.len(), 6);
        for w in transits.windows(2) {
            let period_h = (w[1].jd_ut - w[0].jd_ut) * 24.0;
            assert!(
                (period_h - 9.928).abs() < 0.05,
                "Expected GRS transit period ~9.928h, got {period_h:.4}h"
            );
        }
    }
}
