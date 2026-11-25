use serde::{Deserialize, Serialize};

use crate::engine::coords::{
    Vec3, apply_standard_refraction, equatorial_to_horizontal, spherical_to_vec3, wrap_deg_360,
};
use crate::engine::ephemeris::{
    LIGHT_TIME_DAYS_PER_AU, Planet, ecliptic_vec_to_equatorial_vec,
    geocentric_to_topocentric, planet_ephemeris, sun_ephemeris,
};
use crate::engine::precession::{J2000_JD, OBLIQUITY_J2000_DEG};
use crate::engine::rise_set::ObserverLocation;
use crate::engine::time::{jd_to_ymd_hms, last_deg, ut_to_tt_jd};

const SATURN_EQ_RADIUS_KM: f64 = 60_268.0;
const SATURN_FLATTENING_INV: f64 = 1.0 / (1.0 - 0.09796); // polar/eq = 0.90204

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct SaturnPhysicalEphemeris {
    pub jd_tt: f64,
    /// Sub-Earth Saturn ring tilt `B` (degrees): > 0 northern ring face visible, < 0 southern face visible.
    pub ring_tilt_earth_deg: f64,
    /// Sub-Solar ring tilt `B'` (degrees).
    pub ring_tilt_sun_deg: f64,
    /// Position angle of Saturn's rotational North pole (degrees East of Celestial North).
    pub north_pole_pa_deg: f64,
    pub phase_angle_deg: f64,
    pub apparent_eq_diam_arcsec: f64,
    pub geo_au: f64,
    pub ring_outer_rs: f64,
    pub cassini_rs: f64,
    pub ring_inner_rs: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SaturnMoonPosition {
    pub id: String,
    pub name_ja: String,
    pub roman: String,
    pub mag: f64,
    pub period_days: f64,
    /// Offset along Saturn's ring major axis in Saturn equatorial radii (+West, -East).
    pub x_rs: f64,
    /// Offset perpendicular to Saturn's equator toward Saturn's North pole (+North, -South).
    pub y_rs: f64,
    /// Line-of-sight offset toward Earth (+Earthward / front, -behind Saturn).
    pub z_rs: f64,
    /// Total sky angular separation from Saturn center in arcseconds.
    pub separation_arcsec: f64,
    /// True sky position angle East of North in degrees.
    pub pa_deg: f64,
    pub in_transit: bool,
    pub in_occultation: bool,
    pub in_eclipse: bool,
    pub status_ja: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TitanElongationEvent {
    pub jd_ut: f64,
    pub time_str: String,
    pub direction_ja: String,
    pub is_east: bool,
    pub x_rs: f64,
    pub sep_arcsec: f64,
    pub saturn_alt_deg: f64,
    pub observable: bool,
}

struct SaturnMoonSpec {
    id: &'static str,
    name_ja: &'static str,
    roman: &'static str,
    mag: f64,
    a_km: f64,
    e: f64,
    omega_deg: f64,
    m0_deg: f64,
    i_deg: f64,
    node_deg: f64,
    period_days: f64,
    laplace_ra_deg: f64,
    laplace_dec_deg: f64,
}

// JPL Solar System Dynamics (SAT441, Epoch J2000 = 2000-01-01.5 TDB) mean elements
// referenced to local Laplace planes (ICRF / J2000).
const SATURN_MOONS: [SaturnMoonSpec; 8] = [
    SaturnMoonSpec {
        id: "mimas",
        name_ja: "ミマス",
        roman: "I",
        mag: 12.9,
        a_km: 186_000.0,
        e: 0.020,
        omega_deg: 160.4,
        m0_deg: 275.3,
        i_deg: 1.6,
        node_deg: 66.2,
        period_days: 0.942_422,
        laplace_ra_deg: 40.589,
        laplace_dec_deg: 83.537,
    },
    SaturnMoonSpec {
        id: "enceladus",
        name_ja: "エンケラドゥス",
        roman: "II",
        mag: 11.7,
        a_km: 238_400.0,
        e: 0.005,
        omega_deg: 119.5,
        m0_deg: 57.0,
        i_deg: 0.0,
        node_deg: 0.0,
        period_days: 1.370_218,
        laplace_ra_deg: 40.589,
        laplace_dec_deg: 83.537,
    },
    SaturnMoonSpec {
        id: "tethys",
        name_ja: "テティス",
        roman: "III",
        mag: 10.2,
        a_km: 295_000.0,
        e: 0.001,
        omega_deg: 335.3,
        m0_deg: 0.0,
        i_deg: 1.1,
        node_deg: 273.0,
        period_days: 1.887_802,
        laplace_ra_deg: 40.589,
        laplace_dec_deg: 83.537,
    },
    SaturnMoonSpec {
        id: "dione",
        name_ja: "ディオネ",
        roman: "IV",
        mag: 10.4,
        a_km: 377_700.0,
        e: 0.002,
        omega_deg: 116.0,
        m0_deg: 212.0,
        i_deg: 0.0,
        node_deg: 0.0,
        period_days: 2.736_916,
        laplace_ra_deg: 40.589,
        laplace_dec_deg: 83.537,
    },
    SaturnMoonSpec {
        id: "rhea",
        name_ja: "レア",
        roman: "V",
        mag: 9.7,
        a_km: 527_200.0,
        e: 0.001,
        omega_deg: 44.3,
        m0_deg: 31.5,
        i_deg: 0.3,
        node_deg: 133.7,
        period_days: 4.517_503,
        laplace_ra_deg: 40.589,
        laplace_dec_deg: 83.537,
    },
    SaturnMoonSpec {
        id: "titan",
        name_ja: "タイタン",
        roman: "VI",
        mag: 8.4,
        a_km: 1_221_900.0,
        e: 0.029,
        omega_deg: 78.3,
        m0_deg: 11.7,
        i_deg: 0.3,
        node_deg: 78.6,
        period_days: 15.945_448,
        laplace_ra_deg: 40.589,
        laplace_dec_deg: 83.537,
    },
    SaturnMoonSpec {
        id: "hyperion",
        name_ja: "ヒペリオン",
        roman: "VII",
        mag: 14.2,
        a_km: 1_481_500.0,
        e: 0.105,
        omega_deg: 214.0,
        m0_deg: 122.9,
        i_deg: 0.6,
        node_deg: 87.1,
        period_days: 21.276_658,
        laplace_ra_deg: 40.589,
        laplace_dec_deg: 83.537,
    },
    SaturnMoonSpec {
        id: "iapetus",
        name_ja: "イアペトゥス",
        roman: "VIII",
        mag: 11.1,
        a_km: 3_561_700.0,
        e: 0.028,
        omega_deg: 254.5,
        m0_deg: 74.8,
        i_deg: 7.6,
        node_deg: 86.5,
        period_days: 79.331_002,
        laplace_ra_deg: 288.7,
        laplace_dec_deg: 78.9,
    },
];

struct SaturnSkyBasis {
    physical: SaturnPhysicalEphemeris,
    t_sat_corr_jd: f64,
    u_to_earth_eq: Vec3,
    u_to_sun_eq: Vec3,
    u_ring_west_eq: Vec3,
    u_ring_north_eq: Vec3,
    e_sky_eq: Vec3,
    n_sky_eq: Vec3,
    u_sun_west: Vec3,
    u_sun_north: Vec3,
}

fn saturn_sky_basis(jd_tt: f64) -> SaturnSkyBasis {
    let eph = planet_ephemeris(Planet::Saturn, jd_tt);
    let tau = eph.geo_au * LIGHT_TIME_DAYS_PER_AU;
    let t_corr = jd_tt - tau;

    // Saturn rotational North Pole in J2000 equatorial frame (IAU 2015)
    let t_cen = (t_corr - J2000_JD) / 36_525.0;
    let alpha_p = 40.589 - 0.036 * t_cen;
    let delta_p = 83.537 - 0.004 * t_cen;
    let p_sat = spherical_to_vec3(alpha_p, delta_p, 1.0).normalize();

    // Unit vector from Earth to Saturn in J2000 equatorial frame
    let geo_eq = ecliptic_vec_to_equatorial_vec(eph.geo_xyz_j2000_au, OBLIQUITY_J2000_DEG);
    let u_earth_to_sat = geo_eq.normalize();
    let u_to_earth_eq = u_earth_to_sat.scale(-1.0);

    // Unit vector from Saturn to Sun in J2000 equatorial frame
    let helio_eq = ecliptic_vec_to_equatorial_vec(eph.helio_xyz_j2000_au, OBLIQUITY_J2000_DEG);
    let u_to_sun_eq = helio_eq.scale(-1.0).normalize();

    let ring_tilt_earth_deg = u_to_earth_eq.dot(p_sat).clamp(-1.0, 1.0).asin().to_degrees();
    let ring_tilt_sun_deg = u_to_sun_eq.dot(p_sat).clamp(-1.0, 1.0).asin().to_degrees();

    // Celestial North & East orthogonal tangent basis on the sky plane perpendicular to u_earth_to_sat
    let k_cel = Vec3::new(0.0, 0.0, 1.0);
    let e_sky_eq = k_cel.cross(u_earth_to_sat).normalize();
    let n_sky_eq = u_earth_to_sat.cross(e_sky_eq).normalize();

    let north_pole_pa_deg = wrap_deg_360(
        p_sat.dot(e_sky_eq).atan2(p_sat.dot(n_sky_eq)).to_degrees(),
    );

    // Ring-aligned sky basis: +West along ring major axis, +North along projected Saturn pole
    let u_ring_west_eq = u_earth_to_sat.cross(p_sat).normalize();
    let u_ring_north_eq = u_to_earth_eq.cross(u_ring_west_eq).normalize();

    // Solar-view shadow basis (projection onto plane perpendicular to Saturn -> Sun)
    let u_sat_to_sun = u_to_sun_eq;
    let u_sun_west = p_sat.cross(u_sat_to_sun).normalize();
    let u_sun_north = u_sat_to_sun.cross(u_sun_west).normalize();

    let physical = SaturnPhysicalEphemeris {
        jd_tt,
        ring_tilt_earth_deg,
        ring_tilt_sun_deg,
        north_pole_pa_deg,
        phase_angle_deg: eph.phase_angle_deg,
        apparent_eq_diam_arcsec: eph.angular_diameter_arcsec,
        geo_au: eph.geo_au,
        ring_outer_rs: 2.269,
        cassini_rs: 1.98,
        ring_inner_rs: 1.235,
    };

    SaturnSkyBasis {
        physical,
        t_sat_corr_jd: t_corr,
        u_to_earth_eq,
        u_to_sun_eq,
        u_ring_west_eq,
        u_ring_north_eq,
        e_sky_eq,
        n_sky_eq,
        u_sun_west,
        u_sun_north,
    }
}

fn solve_kepler(m_rad: f64, e: f64) -> f64 {
    let m = m_rad.rem_euclid(std::f64::consts::TAU);
    let mut ea = m + e * m.sin();
    for _ in 0..6 {
        let f = ea - e * ea.sin() - m;
        let fp = 1.0 - e * ea.cos();
        if fp.abs() > 1e-12 {
            ea -= f / fp;
        }
    }
    ea
}

fn moon_j2000_eq_rs(spec: &SaturnMoonSpec, t_corr_jd: f64) -> Vec3 {
    let dt = t_corr_jd - J2000_JD;
    let a_rs = spec.a_km / SATURN_EQ_RADIUS_KM;
    let mean_anom = (spec.m0_deg + 360.0 * (dt / spec.period_days)).to_radians();
    let ea = solve_kepler(mean_anom, spec.e);
    let nu = 2.0
        * ((1.0 + spec.e).sqrt() * (0.5 * ea).sin())
            .atan2((1.0 - spec.e).sqrt() * (0.5 * ea).cos());
    let r = a_rs * (1.0 - spec.e * ea.cos());

    let u = spec.omega_deg.to_radians() + nu;
    let inc = spec.i_deg.to_radians();
    let node = spec.node_deg.to_radians();

    let (su, cu) = u.sin_cos();
    let (so, co) = node.sin_cos();
    let (si, ci) = inc.sin_cos();

    let x_orb = r * (co * cu - so * su * ci);
    let y_orb = r * (so * cu + co * su * ci);
    let z_orb = r * (su * si);

    // Local Laplace plane basis in ICRF / J2000 equatorial coordinates
    let pole = spherical_to_vec3(spec.laplace_ra_deg, spec.laplace_dec_deg, 1.0).normalize();
    let k_cel = Vec3::new(0.0, 0.0, 1.0);
    let e_asc = k_cel.cross(pole).normalize();
    let e_perp = pole.cross(e_asc).normalize();

    e_asc.scale(x_orb) + e_perp.scale(y_orb) + pole.scale(z_orb)
}

pub fn saturn_physical_ephemeris(jd_tt: f64) -> SaturnPhysicalEphemeris {
    saturn_sky_basis(jd_tt).physical
}

pub fn saturn_moons_at(jd_tt: f64) -> (SaturnPhysicalEphemeris, Vec<SaturnMoonPosition>) {
    let basis = saturn_sky_basis(jd_tt);
    let radius_arcsec = basis.physical.apparent_eq_diam_arcsec * 0.5;

    let moons = SATURN_MOONS
        .iter()
        .map(|spec| {
            let r_eq = moon_j2000_eq_rs(spec, basis.t_sat_corr_jd);
            let x_rs = r_eq.dot(basis.u_ring_west_eq);
            let y_rs = r_eq.dot(basis.u_ring_north_eq);
            let z_rs = r_eq.dot(basis.u_to_earth_eq);

            let disk_dist_sq = x_rs * x_rs + (y_rs * SATURN_FLATTENING_INV).powi(2);
            let in_transit = z_rs > 0.0 && disk_dist_sq <= 1.0;
            let in_occultation = z_rs < 0.0 && disk_dist_sq <= 1.0;

            let sun_z = r_eq.dot(basis.u_to_sun_eq);
            let sun_x = r_eq.dot(basis.u_sun_west);
            let sun_y = r_eq.dot(basis.u_sun_north);
            let sh_dist_sq = sun_x * sun_x + (sun_y * SATURN_FLATTENING_INV).powi(2);
            let in_eclipse = sun_z < 0.0 && sh_dist_sq <= 1.0;

            let status_ja = match (in_transit, in_occultation, in_eclipse) {
                (_, true, true) => "掩蔽・食 (Oc+Ec)",
                (_, true, false) => "掩蔽 (Oc)",
                (_, false, true) => "食 (Ec)",
                (true, _, _) => "本体前面通過 (Tr)",
                _ => "観測可",
            }
            .to_owned();

            let sky_e = r_eq.dot(basis.e_sky_eq);
            let sky_n = r_eq.dot(basis.n_sky_eq);
            let sep_rs = (sky_e * sky_e + sky_n * sky_n).sqrt();
            let separation_arcsec = sep_rs * radius_arcsec;
            let pa_deg = wrap_deg_360(sky_e.atan2(sky_n).to_degrees());

            SaturnMoonPosition {
                id: spec.id.to_owned(),
                name_ja: spec.name_ja.to_owned(),
                roman: spec.roman.to_owned(),
                mag: spec.mag,
                period_days: spec.period_days,
                x_rs,
                y_rs,
                z_rs,
                separation_arcsec,
                pa_deg,
                in_transit,
                in_occultation,
                in_eclipse,
                status_ja,
            }
        })
        .collect();

    (basis.physical, moons)
}

pub fn saturn_moon_x_at(jd_tt: f64) -> [f64; 8] {
    let basis = saturn_sky_basis(jd_tt);
    let mut out = [0.0; 8];
    for (idx, spec) in SATURN_MOONS.iter().enumerate() {
        let r_eq = moon_j2000_eq_rs(spec, basis.t_sat_corr_jd);
        out[idx] = r_eq.dot(basis.u_ring_west_eq);
    }
    out
}

pub fn upcoming_titan_elongations(
    start_jd_ut: f64,
    count: usize,
    loc: &ObserverLocation,
) -> Vec<TitanElongationEvent> {
    let titan_spec = &SATURN_MOONS[5];
    let step_days = 0.25; // 6 hours (period ~ 15.945 d)
    let mut out = Vec::with_capacity(count);
    let mut t = start_jd_ut;
    let max_jd = start_jd_ut + 40.0;

    let eval_titan_x = |jd_ut: f64| -> (f64, f64) {
        let basis = saturn_sky_basis(ut_to_tt_jd(jd_ut));
        let r_eq = moon_j2000_eq_rs(titan_spec, basis.t_sat_corr_jd);
        let x_rs = r_eq.dot(basis.u_ring_west_eq);
        let sep_arcsec = r_eq.dot(basis.u_ring_west_eq).hypot(r_eq.dot(basis.u_ring_north_eq))
            * basis.physical.apparent_eq_diam_arcsec
            * 0.5;
        (x_rs, sep_arcsec)
    };

    let mut x_prev = eval_titan_x(t - step_days).0;
    let mut x_curr = eval_titan_x(t).0;

    while out.len() < count && t < max_jd {
        let t_next = t + step_days;
        let x_next = eval_titan_x(t_next).0;

        // Local maximum (+West) or local minimum (-East)
        let is_west_max = x_curr > x_prev && x_curr >= x_next && x_curr > 15.0;
        let is_east_max = x_curr < x_prev && x_curr <= x_next && x_curr < -15.0;

        if is_west_max || is_east_max {
            // Golden-section search in [t - step_days, t_next]
            let mut a = t - step_days;
            let mut b = t_next;
            let inv_phi = 0.618_033_988_749_895;
            let sign = if is_west_max { 1.0 } else { -1.0 };
            for _ in 0..20 {
                let c = b - inv_phi * (b - a);
                let d = a + inv_phi * (b - a);
                let fc = eval_titan_x(c).0 * sign;
                let fd = eval_titan_x(d).0 * sign;
                if fc < fd {
                    a = c;
                } else {
                    b = d;
                }
            }
            let exact_jd_ut = 0.5 * (a + b);
            let (exact_x, sep_arcsec) = eval_titan_x(exact_jd_ut);
            let exact_tt = ut_to_tt_jd(exact_jd_ut);
            let lst = last_deg(exact_jd_ut, loc.lon_deg);
            let sat_eph = planet_ephemeris(Planet::Saturn, exact_tt);
            let sat_topo = geocentric_to_topocentric(
                sat_eph.eq_apparent,
                sat_eph.geo_au,
                loc.lat_deg,
                loc.alt_m,
                lst,
            );
            let saturn_alt_deg = apply_standard_refraction(
                equatorial_to_horizontal(sat_topo, loc.lat_deg, lst).alt_deg,
            );
            let sun_eph = sun_ephemeris(exact_tt);
            let sun_alt_deg =
                equatorial_to_horizontal(sun_eph.eq_apparent, loc.lat_deg, lst).alt_deg;

            let local_jd = exact_jd_ut + f64::from(loc.tz_offset_min) / 1440.0 + (0.5 / 1440.0);
            let (y, m, d, hh, mm, _) = jd_to_ymd_hms(local_jd);
            let is_east = exact_x < 0.0;

            out.push(TitanElongationEvent {
                jd_ut: exact_jd_ut,
                time_str: format!("{y:04}-{m:02}-{d:02} {hh:02}:{mm:02}"),
                direction_ja: if is_east {
                    "東方最大離角 (E)".to_owned()
                } else {
                    "西方最大離角 (W)".to_owned()
                },
                is_east,
                x_rs: exact_x,
                sep_arcsec,
                saturn_alt_deg,
                observable: saturn_alt_deg > 10.0 && sun_alt_deg < -6.0,
            });
        }

        x_prev = x_curr;
        x_curr = x_next;
        t = t_next;
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::ephemeris::saturn_ring_tilt_deg;

    #[test]
    fn saturn_ring_tilt_matches_ephemeris_helper() {
        let jd_tt = ut_to_tt_jd(2_460_600.0);
        let eph = planet_ephemeris(Planet::Saturn, jd_tt);
        let expected_b = saturn_ring_tilt_deg(eph.geo_xyz_j2000_au);
        let phys = saturn_physical_ephemeris(jd_tt);
        assert!(
            (phys.ring_tilt_earth_deg - expected_b).abs() < 0.05,
            "ring tilt mismatch: {} vs {}",
            phys.ring_tilt_earth_deg,
            expected_b
        );
    }

    #[test]
    fn saturn_moons_orbit_radii_and_titan_period() {
        let jd0 = ut_to_tt_jd(2_461_100.0);
        let (_, m0) = saturn_moons_at(jd0);
        assert_eq!(m0.len(), 8);
        for m in &m0 {
            assert!(m.x_rs.is_finite() && m.y_rs.is_finite() && m.z_rs.is_finite());
        }

        let basis0 = saturn_sky_basis(jd0);
        let inertial0 = moon_j2000_eq_rs(&SATURN_MOONS[5], basis0.t_sat_corr_jd);
        let inertial1 =
            moon_j2000_eq_rs(&SATURN_MOONS[5], basis0.t_sat_corr_jd + 15.945_448);
        assert!(
            (inertial0 - inertial1).norm() < 1e-6,
            "Titan inertial position did not close after one sidereal period"
        );

        let titan0 = &m0[5];
        let (_, m1) = saturn_moons_at(jd0 + 15.945_448);
        let titan1 = &m1[5];
        assert!(
            (titan0.x_rs - titan1.x_rs).abs() < 0.9,
            "Titan sky projection drifted too far after one sidereal period: {} vs {}",
            titan0.x_rs,
            titan1.x_rs
        );

        let iapetus = &m0[7];
        let dist_3d = (iapetus.x_rs.powi(2) + iapetus.y_rs.powi(2) + iapetus.z_rs.powi(2)).sqrt();
        assert!(dist_3d > 55.0 && dist_3d < 63.0, "Iapetus radius unexpected: {dist_3d}");
    }

    #[test]
    fn titan_elongations_found_in_window() {
        let loc = ObserverLocation {
            lat_deg: 34.6431,
            lon_deg: 134.9972,
            alt_m: 10.0,
            tz_offset_min: 540,
        };
        let events = upcoming_titan_elongations(2_461_100.0, 4, &loc);
        assert!(events.len() >= 3, "expected >=3 Titan elongations, got {}", events.len());
    }
}
