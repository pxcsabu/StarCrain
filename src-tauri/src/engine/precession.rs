use serde::{Deserialize, Serialize};

use crate::engine::coords::{
    Ecliptic, Equatorial, Vec3, ecliptic_to_equatorial, equatorial_to_ecliptic,
    equatorial_to_vec3, vec3_to_equatorial, wrap_deg_360,
};

pub const J2000_JD: f64 = 2_451_545.0;
pub const B1950_JD: f64 = 2_433_282.423_459_05;
const DAYS_PER_JULIAN_CENTURY: f64 = 36_525.0;
const ARCSEC_TO_RAD: f64 = std::f64::consts::PI / (180.0 * 3600.0);
const MAS_TO_RAD: f64 = ARCSEC_TO_RAD * 0.001;

/// Mean obliquity of the ecliptic at J2000.0 (degrees).
pub const OBLIQUITY_J2000_DEG: f64 = 23.439_291_111_111_11;

/// Nutation in longitude, obliquity, and resulting mean/true obliquity (degrees).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Nutation {
    pub delta_psi_deg: f64,
    pub delta_eps_deg: f64,
    pub mean_obliquity_deg: f64,
    pub true_obliquity_deg: f64,
}

/// 3x3 rotation matrix applied to column vectors.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Mat3(pub [[f64; 3]; 3]);

impl Mat3 {
    pub const IDENTITY: Self = Self([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]);

    pub fn mul_vec(&self, v: Vec3) -> Vec3 {
        Vec3::new(
            self.0[0][0] * v.x + self.0[0][1] * v.y + self.0[0][2] * v.z,
            self.0[1][0] * v.x + self.0[1][1] * v.y + self.0[1][2] * v.z,
            self.0[2][0] * v.x + self.0[2][1] * v.y + self.0[2][2] * v.z,
        )
    }

    pub fn transpose(&self) -> Self {
        Self([
            [self.0[0][0], self.0[1][0], self.0[2][0]],
            [self.0[0][1], self.0[1][1], self.0[2][1]],
            [self.0[0][2], self.0[1][2], self.0[2][2]],
        ])
    }

    pub fn mul_mat(&self, rhs: &Self) -> Self {
        let mut out = [[0.0; 3]; 3];
        for (i, row) in out.iter_mut().enumerate() {
            for (j, cell) in row.iter_mut().enumerate() {
                *cell = self.0[i][0] * rhs.0[0][j]
                    + self.0[i][1] * rhs.0[1][j]
                    + self.0[i][2] * rhs.0[2][j];
            }
        }
        Self(out)
    }
}

/// Mean obliquity of the ecliptic in degrees (Laskar 1986 / Meeus Eq. 22.3).
/// Bounded cleanly beyond ±10,000 years so multi-millennia simulations never diverge.
pub fn mean_obliquity_deg(jd_tt: f64) -> f64 {
    let u_raw = (jd_tt - J2000_JD) / (DAYS_PER_JULIAN_CENTURY * 100.0);
    let u = u_raw.clamp(-1.0, 1.0);
    let u2 = u * u;
    let u3 = u2 * u;
    let u4 = u2 * u2;
    let u5 = u4 * u;
    let u6 = u3 * u3;
    let u7 = u6 * u;
    let u8 = u4 * u4;
    let u9 = u8 * u;
    let u10 = u5 * u5;

    let arcsec = 84_381.448
        - 4_680.93 * u
        - 1.55 * u2
        + 1_999.25 * u3
        - 51.38 * u4
        - 249.67 * u5
        - 39.05 * u6
        + 7.12 * u7
        + 27.87 * u8
        + 5.79 * u9
        + 2.45 * u10;

    arcsec / 3600.0
}

// IAU 1980 Nutation Series (Meeus Table 22.A):
// (D, M, M', F, Omega, psi_0 [0.0001"], psi_t [0.0001"/c], eps_0 [0.0001"], eps_t [0.0001"/c])
type NutationTerm = (i8, i8, i8, i8, i8, f64, f64, f64, f64);

#[rustfmt::skip]
const NUTATION_TERMS: [NutationTerm; 63] = [
    ( 0,  0,  0,  0,  1, -171996.0, -174.2,  92025.0,   8.9),
    (-2,  0,  0,  2,  2,  -13187.0,   -1.6,   5736.0,  -3.1),
    ( 0,  0,  0,  2,  2,   -2274.0,   -0.2,    977.0,  -0.5),
    ( 0,  0,  0,  0,  2,    2062.0,    0.2,   -895.0,   0.5),
    ( 0,  1,  0,  0,  0,    1426.0,   -3.4,     54.0,  -0.1),
    ( 0,  0,  1,  0,  0,     712.0,    0.1,     -7.0,   0.0),
    (-2,  1,  0,  2,  2,    -517.0,    1.2,    224.0,  -0.6),
    ( 0,  0,  0,  2,  1,    -386.0,   -0.4,    200.0,   0.0),
    ( 0,  0,  1,  2,  2,    -301.0,    0.0,    129.0,  -0.1),
    (-2, -1,  0,  2,  2,     217.0,   -0.5,    -95.0,   0.3),
    (-2,  0,  1,  0,  0,    -158.0,    0.0,      0.0,   0.0),
    (-2,  0,  0,  2,  1,     129.0,    0.1,    -70.0,   0.0),
    ( 0,  0, -1,  2,  2,     123.0,    0.0,    -53.0,   0.0),
    ( 2,  0,  0,  0,  0,      63.0,    0.0,      0.0,   0.0),
    ( 0,  0,  1,  0,  1,      63.0,    0.1,    -33.0,   0.0),
    ( 2,  0, -1,  2,  2,     -59.0,    0.0,     26.0,   0.0),
    ( 0,  0, -1,  0,  1,     -58.0,   -0.1,     32.0,   0.0),
    ( 0,  0,  1,  2,  1,     -51.0,    0.0,     27.0,   0.0),
    (-2,  0,  2,  0,  0,      48.0,    0.0,      0.0,   0.0),
    ( 0,  0, -2,  2,  1,      46.0,    0.0,    -24.0,   0.0),
    ( 2,  0,  0,  2,  2,     -38.0,    0.0,     16.0,   0.0),
    ( 0,  0,  2,  2,  2,     -31.0,    0.0,     13.0,   0.0),
    ( 0,  0,  2,  0,  0,      29.0,    0.0,      0.0,   0.0),
    (-2,  0,  1,  2,  2,      29.0,    0.0,    -12.0,   0.0),
    ( 0,  0,  0,  2,  0,      26.0,    0.0,      0.0,   0.0),
    (-2,  0,  0,  2,  0,     -22.0,    0.0,      0.0,   0.0),
    ( 0,  0, -1,  2,  1,      21.0,    0.0,    -10.0,   0.0),
    ( 0,  2,  0,  0,  0,      17.0,   -0.1,      0.0,   0.0),
    ( 2,  0, -1,  0,  1,      16.0,    0.0,     -8.0,   0.0),
    (-2,  2,  0,  2,  2,     -16.0,    0.1,      7.0,   0.0),
    ( 0,  1,  0,  0,  1,     -15.0,    0.0,      9.0,   0.0),
    (-2,  0,  1,  0,  1,     -13.0,    0.0,      7.0,   0.0),
    ( 0, -1,  0,  0,  1,     -12.0,    0.0,      6.0,   0.0),
    ( 0,  0,  2, -2,  0,      11.0,    0.0,      0.0,   0.0),
    ( 2,  0, -1,  2,  1,     -10.0,    0.0,      5.0,   0.0),
    ( 2,  0,  1,  2,  2,      -8.0,    0.0,      3.0,   0.0),
    ( 0,  1,  0,  2,  2,       7.0,    0.0,     -3.0,   0.0),
    (-2,  1,  1,  0,  0,      -7.0,    0.0,      0.0,   0.0),
    ( 0, -1,  0,  2,  2,      -7.0,    0.0,      3.0,   0.0),
    ( 2,  0,  0,  2,  1,      -7.0,    0.0,      3.0,   0.0),
    ( 2,  0,  1,  0,  0,       6.0,    0.0,      0.0,   0.0),
    (-2,  0,  2,  2,  2,       6.0,    0.0,     -3.0,   0.0),
    (-2,  0,  1,  2,  1,       6.0,    0.0,     -3.0,   0.0),
    ( 2,  0, -2,  0,  1,      -6.0,    0.0,      3.0,   0.0),
    ( 2,  0,  0,  0,  1,      -6.0,    0.0,      3.0,   0.0),
    ( 0, -1,  1,  0,  0,       5.0,    0.0,      0.0,   0.0),
    (-2, -1,  0,  2,  1,      -5.0,    0.0,      3.0,   0.0),
    (-2,  0,  0,  0,  1,      -5.0,    0.0,      3.0,   0.0),
    ( 0,  0,  2,  2,  1,      -5.0,    0.0,      3.0,   0.0),
    (-2,  0,  2,  0,  1,       4.0,    0.0,      0.0,   0.0),
    (-2,  1,  0,  2,  1,       4.0,    0.0,      0.0,   0.0),
    ( 0,  0,  1, -2,  0,       4.0,    0.0,      0.0,   0.0),
    (-1,  0,  1,  0,  0,      -4.0,    0.0,      0.0,   0.0),
    (-2,  1,  0,  0,  0,      -4.0,    0.0,      0.0,   0.0),
    ( 1,  0,  0,  0,  0,      -4.0,    0.0,      0.0,   0.0),
    ( 0,  0,  1,  2,  0,       3.0,    0.0,      0.0,   0.0),
    ( 0,  0, -2,  2,  2,      -3.0,    0.0,      0.0,   0.0),
    (-1, -1,  1,  0,  0,      -3.0,    0.0,      0.0,   0.0),
    ( 0,  1,  1,  0,  0,      -3.0,    0.0,      0.0,   0.0),
    ( 0, -1,  1,  2,  2,      -3.0,    0.0,      0.0,   0.0),
    ( 2, -1, -1,  2,  2,      -3.0,    0.0,      0.0,   0.0),
    ( 0,  0,  3,  2,  2,      -3.0,    0.0,      0.0,   0.0),
    ( 2, -1,  0,  2,  2,      -3.0,    0.0,      0.0,   0.0),
];

/// Full 63-term IAU 1980 Nutation and Mean/True Obliquity (Meeus Ch. 22).
pub fn nutation(jd_tt: f64) -> Nutation {
    let t = (jd_tt - J2000_JD) / DAYS_PER_JULIAN_CENTURY;
    let t2 = t * t;
    let t3 = t2 * t;

    let d = wrap_deg_360(
        297.850_36 + 445_267.111_480 * t - 0.001_914_2 * t2 + t3 / 189_474.0,
    );
    let m = wrap_deg_360(
        357.527_72 + 35_999.050_340 * t - 0.000_160_3 * t2 - t3 / 300_000.0,
    );
    let mp = wrap_deg_360(
        134.962_98 + 477_198.867_398 * t + 0.008_697_2 * t2 + t3 / 56_250.0,
    );
    let f = wrap_deg_360(
        93.271_91 + 483_202.017_538 * t - 0.003_682_5 * t2 + t3 / 327_270.0,
    );
    let om = wrap_deg_360(
        125.044_52 - 1_934.136_261 * t + 0.002_070_8 * t2 + t3 / 450_000.0,
    );

    let mut d_psi_0001 = 0.0_f64;
    let mut d_eps_0001 = 0.0_f64;

    for &(cd, cm, cmp, cf, com, psi0, psit, eps0, epst) in &NUTATION_TERMS {
        let arg = (f64::from(cd) * d
            + f64::from(cm) * m
            + f64::from(cmp) * mp
            + f64::from(cf) * f
            + f64::from(com) * om)
            .to_radians();
        let (s, c) = arg.sin_cos();
        d_psi_0001 += (psi0 + psit * t) * s;
        d_eps_0001 += (eps0 + epst * t) * c;
    }

    let delta_psi_deg = d_psi_0001 * 0.0001 / 3600.0;
    let delta_eps_deg = d_eps_0001 * 0.0001 / 3600.0;
    let mean_obliquity = mean_obliquity_deg(jd_tt);
    Nutation {
        delta_psi_deg,
        delta_eps_deg,
        mean_obliquity_deg: mean_obliquity,
        true_obliquity_deg: mean_obliquity + delta_eps_deg,
    }
}

/// Rigorous Lieske (1979) equatorial precession matrix from J2000.0 to `jd_tt` (Meeus Eq. 21.3).
/// Accurate for ±1,500 years around J2000.0.
pub fn precession_matrix_j2000_to_date(jd_tt: f64) -> Mat3 {
    let t = (jd_tt - J2000_JD) / DAYS_PER_JULIAN_CENTURY;
    let t2 = t * t;
    let t3 = t2 * t;

    let zeta = (2_306.218_1 * t + 0.30188 * t2 + 0.017998 * t3) * ARCSEC_TO_RAD;
    let z = (2_306.218_1 * t + 1.09468 * t2 + 0.018203 * t3) * ARCSEC_TO_RAD;
    let theta = (2_004.310_9 * t - 0.42665 * t2 - 0.041833 * t3) * ARCSEC_TO_RAD;

    let (sz, cz) = zeta.sin_cos();
    let (szz, czz) = z.sin_cos();
    let (st, ct) = theta.sin_cos();

    // R = Rz(-z) * Ry(+theta) * Rz(-zeta)
    Mat3([
        [
            czz * ct * cz - szz * sz,
            -czz * ct * sz - szz * cz,
            -czz * st,
        ],
        [
            szz * ct * cz + czz * sz,
            -szz * ct * sz + czz * cz,
            -szz * st,
        ],
        [st * cz, -st * sz, ct],
    ])
}

/// Long-term ecliptic-pole precession for multi-millennia Past/Future mode (|T| > 15 centuries).
fn precess_long_term_j2000_to_date(eq: Equatorial, jd_tt: f64) -> Equatorial {
    let years = (jd_tt - J2000_JD) / 365.25;
    let ecl_j2000 = equatorial_to_ecliptic(eq, OBLIQUITY_J2000_DEG);
    // General precession in longitude ~ 50.2879695"/yr (25,771.6-yr full cycle)
    let delta_lon_deg = (50.287_969_5 * years) / 3600.0;
    let ecl_date = Ecliptic {
        lon_deg: wrap_deg_360(ecl_j2000.lon_deg + delta_lon_deg),
        lat_deg: ecl_j2000.lat_deg,
    };
    ecliptic_to_equatorial(ecl_date, mean_obliquity_deg(jd_tt))
}

fn precess_long_term_date_to_j2000(eq: Equatorial, jd_tt: f64) -> Equatorial {
    let years = (jd_tt - J2000_JD) / 365.25;
    let ecl_date = equatorial_to_ecliptic(eq, mean_obliquity_deg(jd_tt));
    let delta_lon_deg = (50.287_969_5 * years) / 3600.0;
    let ecl_j2000 = Ecliptic {
        lon_deg: wrap_deg_360(ecl_date.lon_deg - delta_lon_deg),
        lat_deg: ecl_date.lat_deg,
    };
    ecliptic_to_equatorial(ecl_j2000, OBLIQUITY_J2000_DEG)
}

/// Precess mean equatorial coordinates from J2000.0 to epoch `jd_tt`
/// (exact Lieske within ±1,500 yrs; smooth blend to physical ecliptic precession out to ±15,000+ yrs).
pub fn precess_j2000_to_date(eq: Equatorial, jd_tt: f64) -> Equatorial {
    let abs_t = ((jd_tt - J2000_JD) / DAYS_PER_JULIAN_CENTURY).abs();
    if abs_t <= 10.0 {
        let v = equatorial_to_vec3(eq);
        return vec3_to_equatorial(precession_matrix_j2000_to_date(jd_tt).mul_vec(v));
    }
    if abs_t >= 20.0 {
        return precess_long_term_j2000_to_date(eq, jd_tt);
    }
    let alpha = (abs_t - 10.0) / 10.0;
    let w = alpha * alpha * (3.0 - 2.0 * alpha);
    let v_short = precession_matrix_j2000_to_date(jd_tt).mul_vec(equatorial_to_vec3(eq));
    let v_long = equatorial_to_vec3(precess_long_term_j2000_to_date(eq, jd_tt));
    vec3_to_equatorial((v_short.scale(1.0 - w) + v_long.scale(w)).normalize())
}

/// Precess mean equatorial coordinates from epoch `jd_tt` back to J2000.0.
pub fn precess_date_to_j2000(eq: Equatorial, jd_tt: f64) -> Equatorial {
    let abs_t = ((jd_tt - J2000_JD) / DAYS_PER_JULIAN_CENTURY).abs();
    if abs_t <= 10.0 {
        let v = equatorial_to_vec3(eq);
        return vec3_to_equatorial(
            precession_matrix_j2000_to_date(jd_tt)
                .transpose()
                .mul_vec(v),
        );
    }
    if abs_t >= 20.0 {
        return precess_long_term_date_to_j2000(eq, jd_tt);
    }
    let alpha = (abs_t - 10.0) / 10.0;
    let w = alpha * alpha * (3.0 - 2.0 * alpha);
    let v_short = precession_matrix_j2000_to_date(jd_tt)
        .transpose()
        .mul_vec(equatorial_to_vec3(eq));
    let v_long = equatorial_to_vec3(precess_long_term_date_to_j2000(eq, jd_tt));
    vec3_to_equatorial((v_short.scale(1.0 - w) + v_long.scale(w)).normalize())
}

/// Precess mean equatorial coordinates from `from_jd_tt` to `to_jd_tt`.
pub fn precess_between_epochs(eq: Equatorial, from_jd_tt: f64, to_jd_tt: f64) -> Equatorial {
    if (from_jd_tt - to_jd_tt).abs() < 1e-9 {
        return eq;
    }
    let eq_j2000 = if (from_jd_tt - J2000_JD).abs() < 1e-9 {
        eq
    } else {
        precess_date_to_j2000(eq, from_jd_tt)
    };
    if (to_jd_tt - J2000_JD).abs() < 1e-9 {
        eq_j2000
    } else {
        precess_j2000_to_date(eq_j2000, to_jd_tt)
    }
}

/// Position of the epoch-of-date North Celestial Pole expressed in J2000.0 coordinates
/// (used for plotting the precession pole path in Past/Future mode).
pub fn north_celestial_pole_j2000(jd_tt: f64) -> Equatorial {
    precess_date_to_j2000(
        Equatorial {
            ra_deg: 0.0,
            dec_deg: 90.0,
        },
        jd_tt,
    )
}

/// Position of the epoch-of-date South Celestial Pole expressed in J2000.0 coordinates.
pub fn south_celestial_pole_j2000(jd_tt: f64) -> Equatorial {
    precess_date_to_j2000(
        Equatorial {
            ra_deg: 0.0,
            dec_deg: -90.0,
        },
        jd_tt,
    )
}

/// Apply nutation (`delta_psi_deg`, `delta_eps_deg`, `mean_obliquity_deg`) to mean coordinates
/// of date to obtain apparent coordinates of date.
pub fn apply_nutation_to_equatorial(eq_mean_date: Equatorial, nut: &Nutation) -> Equatorial {
    let ecl = equatorial_to_ecliptic(eq_mean_date, nut.mean_obliquity_deg);
    let ecl_apparent = Ecliptic {
        lon_deg: wrap_deg_360(ecl.lon_deg + nut.delta_psi_deg),
        lat_deg: ecl.lat_deg,
    };
    ecliptic_to_equatorial(ecl_apparent, nut.true_obliquity_deg)
}

// Standard IAU FK4(B1950.0) -> FK5(J2000.0) orthogonal rotation matrix (Aoki et al. 1983)
#[rustfmt::skip]
const B1950_TO_J2000_MAT: Mat3 = Mat3([
    [ 0.9999256794956877, -0.0111814832204662, -0.0048590038153592],
    [ 0.0111814832391717,  0.9999374848933135, -0.0000271625947142],
    [ 0.0048590037723143, -0.0000271702937440,  0.9999881946023742],
]);

/// Convert B1950.0 equatorial coordinates to J2000.0 equatorial coordinates.
pub fn b1950_to_j2000(eq: Equatorial) -> Equatorial {
    vec3_to_equatorial(B1950_TO_J2000_MAT.mul_vec(equatorial_to_vec3(eq)))
}

/// Convert J2000.0 equatorial coordinates to B1950.0 equatorial coordinates.
pub fn j2000_to_b1950(eq: Equatorial) -> Equatorial {
    vec3_to_equatorial(
        B1950_TO_J2000_MAT
            .transpose()
            .mul_vec(equatorial_to_vec3(eq)),
    )
}

/// Convert star spherical J2000 `(ra_rad, dec_rad)` and distance (`dist_pc`) to 3D Cartesian parsecs.
#[inline]
pub fn star_position_3d_pc(ra_rad: f64, dec_rad: f64, dist_pc: f64) -> Vec3 {
    let (sd, cd) = dec_rad.sin_cos();
    let (sa, ca) = ra_rad.sin_cos();
    Vec3::new(dist_pc * cd * ca, dist_pc * cd * sa, dist_pc * sd)
}

/// Propagate star proper motion (`pm_ra_mas_yr` = `μ_α cos δ`, `pm_dec_mas_yr` = `μ_δ`)
/// over `years_from_j2000` (supports ±100,000 years safely near poles).
/// Returns `(new_j2000_equatorial, updated_dist_pc)`.
pub fn propagate_proper_motion(
    ra_rad: f64,
    dec_rad: f64,
    pm_ra_mas_yr: f64,
    pm_dec_mas_yr: f64,
    dist_pc: f64,
    years_from_j2000: f64,
) -> (Equatorial, f64) {
    let (sd, cd) = dec_rad.sin_cos();
    let (sa, ca) = ra_rad.sin_cos();

    let u = Vec3::new(cd * ca, cd * sa, sd);
    if pm_ra_mas_yr == 0.0 && pm_dec_mas_yr == 0.0 || years_from_j2000 == 0.0 {
        return (vec3_to_equatorial(u), dist_pc);
    }

    let e_ra = Vec3::new(-sa, ca, 0.0);
    let e_dec = Vec3::new(-sd * ca, -sd * sa, cd);

    let mu_ra = pm_ra_mas_yr * MAS_TO_RAD;
    let mu_dec = pm_dec_mas_yr * MAS_TO_RAD;
    let v_tan = e_ra.scale(mu_ra) + e_dec.scale(mu_dec);

    if dist_pc > 0.0 {
        let pos = u.scale(dist_pc) + v_tan.scale(dist_pc * years_from_j2000);
        let new_dist = pos.norm();
        return (vec3_to_equatorial(pos), new_dist);
    }

    // Distant star with unknown parallax: rotate cleanly along great circle
    let speed = v_tan.norm();
    if speed == 0.0 {
        return (vec3_to_equatorial(u), 0.0);
    }
    let angle = speed * years_from_j2000;
    let (s_ang, c_ang) = angle.sin_cos();
    let dir = u.scale(c_ang) + v_tan.scale(s_ang / speed);
    (vec3_to_equatorial(dir), 0.0)
}

#[cfg(test)]
mod tests {
    use crate::engine::coords::angular_distance_deg;

    use super::*;

    #[test]
    fn meeus_example_22a_nutation_1987_04_10() {
        // 1987-04-10 00:00 TD -> JD = 2446895.5
        // Meeus result: delta_psi = -3.788", delta_eps = +9.443", eps0 = 23°26'27.407", eps = 23°26'36.850"
        let nut = nutation(2_446_895.5);
        let dpsi_arcsec = nut.delta_psi_deg * 3600.0;
        let deps_arcsec = nut.delta_eps_deg * 3600.0;
        let expected_eps0 = 23.0 + 26.0 / 60.0 + 27.407 / 3600.0;
        let expected_eps = 23.0 + 26.0 / 60.0 + 36.850 / 3600.0;

        assert!(
            (dpsi_arcsec - (-3.788)).abs() < 0.05,
            "dpsi={dpsi_arcsec}\""
        );
        assert!(
            (deps_arcsec - 9.443).abs() < 0.05,
            "deps={deps_arcsec}\""
        );
        assert!((nut.mean_obliquity_deg - expected_eps0).abs() < 1e-6);
        assert!((nut.true_obliquity_deg - expected_eps).abs() < 2e-5);
    }

    #[test]
    fn meeus_example_21b_theta_persei_precession() {
        // Theta Persei J2000: RA = 2h44m11.986s = 41.049942°, Dec = +49°13'42.48" = +49.228467°
        // Epoch 2028-11-13.19 TD = JD 2462088.69
        // First propagate proper motion (+0.3425 s/yr -> +3.3536" ? wait: Meeus Ex 21.b gives PM=0.03425s/yr, -0.0895"/yr)
        // Here test pure precession from J2000 -> JD 2462088.69:
        // Without PM, theta Persei precesses to RA ≈ 41.54666°, Dec ≈ +49.34848°
        let j2000 = Equatorial {
            ra_deg: 41.049_942,
            dec_deg: 49.228_467,
        };
        let jd = 2_462_088.69;
        let prec = precess_j2000_to_date(j2000, jd);
        // Check exact roundtrip
        let back = precess_date_to_j2000(prec, jd);
        assert!(angular_distance_deg(j2000, back) < 1e-10);

        // Include Meeus Ex 21.b PM: mu_ra_deg = 0.03425 * 15 / 3600 = 0.000142708°/yr => mu_ra*cos(dec) = 335.42 mas/yr, mu_dec = -89.5 mas/yr
        let dt_yr = (jd - J2000_JD) / 365.25;
        let mu_ra_cosd_mas = 0.03425 * 15.0 * 1000.0 * j2000.dec_deg.to_radians().cos();
        let (pm_eq, _) = propagate_proper_motion(
            j2000.ra_deg.to_radians(),
            j2000.dec_deg.to_radians(),
            mu_ra_cosd_mas,
            -89.5,
            0.0,
            dt_yr,
        );
        let final_eq = precess_j2000_to_date(pm_eq, jd);
        // Meeus Ex 21.b answer: RA = 2h46m11.331s = 41.547213°, Dec = +49°20'54.54" = +49.348483°
        assert!(
            angular_distance_deg(
                final_eq,
                Equatorial {
                    ra_deg: 41.547_213,
                    dec_deg: 49.348_483
                }
            ) * 3600.0
                < 0.5
        );
    }

    #[test]
    fn b1950_j2000_roundtrip_and_shift() {
        let j2000 = Equatorial {
            ra_deg: 101.287_155,
            dec_deg: -16.716_116,
        };
        let b1950 = j2000_to_b1950(j2000);
        // Sirius B1950 was RA ~ 6h42m56.7s = 100.736°, Dec ~ -16°38.8' = -16.647°
        assert!((b1950.ra_deg - 100.736).abs() < 0.05);
        assert!((b1950.dec_deg - (-16.647)).abs() < 0.05);

        let back = b1950_to_j2000(b1950);
        assert!(angular_distance_deg(j2000, back) < 1e-10);
    }

    #[test]
    fn long_term_precession_15000_years_and_pole_stars() {
        // AD 14000 (~+12,000 years): NCP near Vega (RA=279.23°, Dec=+38.78°)
        let jd_14000 = J2000_JD + 12_000.0 * 365.25;
        let pole_14000 = north_celestial_pole_j2000(jd_14000);
        let vega = Equatorial {
            ra_deg: 279.2346,
            dec_deg: 38.7837,
        };
        let sep_vega = angular_distance_deg(pole_14000, vega);
        assert!(sep_vega < 6.0, "AD 14000 pole sep from Vega = {sep_vega}°");

        // BC 2800 (~-4,800 years): NCP near Thuban (RA=211.10°, Dec=+64.38°)
        let jd_bc2800 = J2000_JD - 4_800.0 * 365.25;
        let pole_bc2800 = north_celestial_pole_j2000(jd_bc2800);
        let thuban = Equatorial {
            ra_deg: 211.097,
            dec_deg: 64.376,
        };
        let sep_thuban = angular_distance_deg(pole_bc2800, thuban);
        assert!(
            sep_thuban < 3.0,
            "BC 2800 pole sep from Thuban = {sep_thuban}°"
        );

        // Full ±15,000 year roundtrip check
        let jd_plus15k = J2000_JD + 15_000.0 * 365.25;
        let p = precess_j2000_to_date(vega, jd_plus15k);
        let back = precess_date_to_j2000(p, jd_plus15k);
        assert!(angular_distance_deg(vega, back) < 1e-7);
    }

    #[test]
    fn proper_motion_100k_years_remains_valid() {
        // Sirius: pmra=-546.01 mas/yr, pmdec=-1223.07 mas/yr, dist=2.6371 pc
        let (future_eq, future_dist) = propagate_proper_motion(
            101.287_155_f64.to_radians(),
            (-16.716_116_f64).to_radians(),
            -546.01,
            -1_223.07,
            2.6371,
            100_000.0,
        );
        assert!(future_eq.ra_deg.is_finite());
        assert!(future_eq.dec_deg.is_finite());
        assert!(future_dist > 2.6371);

        // Unknown-parallax star over -100,000 years
        let (past_eq, past_dist) = propagate_proper_motion(
            10.0_f64.to_radians(),
            89.0_f64.to_radians(),
            500.0,
            500.0,
            0.0,
            -100_000.0,
        );
        assert!(past_eq.ra_deg.is_finite());
        assert!(past_eq.dec_deg.abs() <= 90.0);
        assert_eq!(past_dist, 0.0);
    }
}
