use serde::{Deserialize, Serialize};

use crate::engine::coords::{
    Ecliptic, Equatorial, Vec3, angular_distance_deg, ecliptic_to_equatorial,
    equatorial_to_ecliptic, spherical_to_vec3, vec3_to_equatorial, wrap_deg_180, wrap_deg_360,
};
use crate::engine::precession::{
    J2000_JD, OBLIQUITY_J2000_DEG, apply_nutation_to_equatorial, nutation, precess_j2000_to_date,
};

pub const AU_KM: f64 = 149_597_870.7;
/// Light travel time for 1 AU in days (`AU / c`).
pub const LIGHT_TIME_DAYS_PER_AU: f64 = 0.005_775_518_331_4;
const SPEED_OF_LIGHT_AU_PER_DAY: f64 = 1.0 / LIGHT_TIME_DAYS_PER_AU;
const EARTH_EQUATORIAL_RADIUS_KM: f64 = 6_378.137;
const MOON_RADIUS_KM: f64 = 1_737.4;
const SUN_RADIUS_KM: f64 = 695_700.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Planet {
    Mercury,
    Venus,
    Mars,
    Jupiter,
    Saturn,
    Uranus,
    Neptune,
}

impl Planet {
    pub const ALL: [Self; 7] = [
        Self::Mercury,
        Self::Venus,
        Self::Mars,
        Self::Jupiter,
        Self::Saturn,
        Self::Uranus,
        Self::Neptune,
    ];

    pub const fn name_ja(self) -> &'static str {
        match self {
            Self::Mercury => "水星",
            Self::Venus => "金星",
            Self::Mars => "火星",
            Self::Jupiter => "木星",
            Self::Saturn => "土星",
            Self::Uranus => "天王星",
            Self::Neptune => "海王星",
        }
    }

    pub const fn equatorial_radius_km(self) -> f64 {
        match self {
            Self::Mercury => 2_439.7,
            Self::Venus => 6_051.8,
            Self::Mars => 3_396.2,
            Self::Jupiter => 71_492.0,
            Self::Saturn => 60_268.0,
            Self::Uranus => 25_559.0,
            Self::Neptune => 24_764.0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum DwarfPlanet {
    Pluto,
    Eris,
}

impl DwarfPlanet {
    pub const fn name_ja(self) -> &'static str {
        match self {
            Self::Pluto => "冥王星",
            Self::Eris => "エリス",
        }
    }

    pub const fn radius_km(self) -> f64 {
        match self {
            Self::Pluto => 1_188.3,
            Self::Eris => 1_163.0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum SolarSystemBody {
    Sun,
    Moon,
    Planet(Planet),
    DwarfPlanet(DwarfPlanet),
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct BodyEphemeris {
    pub helio_xyz_j2000_au: Vec3,
    pub geo_xyz_j2000_au: Vec3,
    pub eq_j2000: Equatorial,
    pub eq_apparent: Equatorial,
    pub ecliptic_apparent: Ecliptic,
    pub helio_au: f64,
    pub geo_au: f64,
    pub elongation_deg: f64,
    pub phase_angle_deg: f64,
    pub illuminated_fraction: f64,
    pub angular_diameter_arcsec: f64,
    pub visual_magnitude: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct MoonEphemeris {
    pub eq_j2000: Equatorial,
    pub eq_apparent: Equatorial,
    pub ecliptic_apparent: Ecliptic,
    pub distance_km: f64,
    pub geo_au: f64,
    pub horizontal_parallax_deg: f64,
    pub angular_diameter_arcsec: f64,
    pub elongation_deg: f64,
    pub phase_angle_deg: f64,
    pub illuminated_fraction: f64,
    pub position_angle_bright_limb_deg: f64,
    pub libration_lon_deg: f64,
    pub libration_lat_deg: f64,
    pub libration_pa_deg: f64,
    pub age_days: f64,
    pub visual_magnitude: f64,
}

/// Convert VSOP87A J2000 ecliptic rectangular coordinates to `Vec3` in AU.
#[inline]
fn vsop87a_planet_vec(planet: Planet, jd_tt: f64) -> Vec3 {
    let c = match planet {
        Planet::Mercury => vsop87::vsop87a::mercury(jd_tt),
        Planet::Venus => vsop87::vsop87a::venus(jd_tt),
        Planet::Mars => vsop87::vsop87a::mars(jd_tt),
        Planet::Jupiter => vsop87::vsop87a::jupiter(jd_tt),
        Planet::Saturn => vsop87::vsop87a::saturn(jd_tt),
        Planet::Uranus => vsop87::vsop87a::uranus(jd_tt),
        Planet::Neptune => vsop87::vsop87a::neptune(jd_tt),
    };
    Vec3::new(c.x, c.y, c.z)
}

/// Earth heliocentric J2000 ecliptic rectangular position in AU.
#[inline]
pub fn earth_helio_j2000_au(jd_tt: f64) -> Vec3 {
    let c = vsop87::vsop87a::earth(jd_tt);
    Vec3::new(c.x, c.y, c.z)
}

/// Rotate an ecliptic Cartesian vector by `+eps` around X to get equatorial Cartesian vector.
#[inline]
pub fn ecliptic_vec_to_equatorial_vec(v: Vec3, obliquity_deg: f64) -> Vec3 {
    let (s, c) = obliquity_deg.to_radians().sin_cos();
    Vec3::new(v.x, v.y * c - v.z * s, v.y * s + v.z * c)
}

/// Rotate an equatorial Cartesian vector by `-eps` around X to get ecliptic Cartesian vector.
#[inline]
pub fn equatorial_vec_to_ecliptic_vec(v: Vec3, obliquity_deg: f64) -> Vec3 {
    let (s, c) = obliquity_deg.to_radians().sin_cos();
    Vec3::new(v.x, v.y * c + v.z * s, -v.y * s + v.z * c)
}

/// Apparent geocentric ecliptic longitude of the Sun (degrees `[0, 360)`) at `jd_tt`.
/// Used internally for fast solar term and lunar calendar calculations.
pub fn sun_apparent_ecliptic_lon_deg(jd_tt: f64) -> f64 {
    let earth_sph = vsop87::vsop87d::earth(jd_tt);
    let sun_lon_dyn = wrap_deg_360(earth_sph.longitude().to_degrees() + 180.0);
    let r = earth_sph.distance();
    let t = (jd_tt - J2000_JD) / 36_525.0;
    let lambda_p = (sun_lon_dyn - 1.397 * t - 0.000_31 * t * t).to_radians();
    let _ = lambda_p;
    let nut = nutation(jd_tt);
    let fk5_arcsec = -0.090_33;
    let aberr_arcsec = -20.489_8 / r.max(0.1);
    wrap_deg_360(sun_lon_dyn + (fk5_arcsec + aberr_arcsec) / 3600.0 + nut.delta_psi_deg)
}

/// High-precision Solar ephemeris using VSOP87 (Meeus Ch. 25 / Ch. 32).
pub fn sun_ephemeris(jd_tt: f64) -> BodyEphemeris {
    let earth_j2000 = earth_helio_j2000_au(jd_tt);
    let geo_j2000_ecl = earth_j2000.scale(-1.0);
    let geo_j2000_eq = ecliptic_vec_to_equatorial_vec(geo_j2000_ecl, OBLIQUITY_J2000_DEG);
    let eq_j2000 = vec3_to_equatorial(geo_j2000_eq);

    // Apparent Sun from VSOP87D Earth + FK5 + aberration + nutation
    let earth_sph = vsop87::vsop87d::earth(jd_tt);
    let lon_dyn_deg = wrap_deg_360(earth_sph.longitude().to_degrees() + 180.0);
    let lat_dyn_deg = -earth_sph.latitude().to_degrees();
    let geo_au = earth_sph.distance();

    let t = (jd_tt - J2000_JD) / 36_525.0;
    let lambda_p = (lon_dyn_deg - 1.397 * t - 0.000_31 * t * t).to_radians();
    let nut = nutation(jd_tt);
    let d_lon_arcsec = -0.090_33 - 20.489_8 / geo_au.max(0.1);
    let d_lat_arcsec = 0.039_16 * (lambda_p.cos() - lambda_p.sin());

    let ecliptic_apparent = Ecliptic {
        lon_deg: wrap_deg_360(lon_dyn_deg + d_lon_arcsec / 3600.0 + nut.delta_psi_deg),
        lat_deg: lat_dyn_deg + d_lat_arcsec / 3600.0,
    };
    let eq_apparent = ecliptic_to_equatorial(ecliptic_apparent, nut.true_obliquity_deg);
    let angular_diameter_arcsec =
        2.0 * (SUN_RADIUS_KM / (geo_au * AU_KM)).asin().to_degrees() * 3600.0;

    BodyEphemeris {
        helio_xyz_j2000_au: Vec3::ZERO,
        geo_xyz_j2000_au: geo_j2000_ecl,
        eq_j2000,
        eq_apparent,
        ecliptic_apparent,
        helio_au: 0.0,
        geo_au,
        elongation_deg: 0.0,
        phase_angle_deg: 0.0,
        illuminated_fraction: 1.0,
        angular_diameter_arcsec,
        visual_magnitude: -26.74 + 5.0 * geo_au.log10(),
    }
}

/// Convert a J2000 geocentric ecliptic body vector (after light-time) + Earth state
/// into full `BodyEphemeris` (including annual aberration, precession, nutation, elongation, phase).
fn finalize_body_ephemeris(
    helio_j2000_ecl: Vec3,
    earth_j2000_ecl: Vec3,
    earth_vel_j2000_au_day: Vec3,
    jd_tt: f64,
    radius_km: f64,
    mag_fn: impl FnOnce(f64, f64, f64) -> f64,
) -> BodyEphemeris {
    let geo_j2000_ecl = helio_j2000_ecl - earth_j2000_ecl;
    let helio_au = helio_j2000_ecl.norm();
    let geo_au = geo_j2000_ecl.norm();

    let geo_j2000_eq = ecliptic_vec_to_equatorial_vec(geo_j2000_ecl, OBLIQUITY_J2000_DEG);
    let eq_j2000 = vec3_to_equatorial(geo_j2000_eq);

    // Annual aberration in J2000 equatorial frame: u_app = u + v_earth / c
    let earth_vel_eq = ecliptic_vec_to_equatorial_vec(earth_vel_j2000_au_day, OBLIQUITY_J2000_DEG);
    let u_eq = geo_j2000_eq.normalize();
    let u_aberr = (u_eq + earth_vel_eq.scale(1.0 / SPEED_OF_LIGHT_AU_PER_DAY)).normalize();
    let eq_aberr_j2000 = vec3_to_equatorial(u_aberr);

    // Precess to mean equator of date, then apply nutation -> apparent
    let eq_mean_date = precess_j2000_to_date(eq_aberr_j2000, jd_tt);
    let nut = nutation(jd_tt);
    let eq_apparent = apply_nutation_to_equatorial(eq_mean_date, &nut);
    let ecliptic_apparent = equatorial_to_ecliptic(eq_apparent, nut.true_obliquity_deg);

    // Elongation & phase angle
    let sun_eq = sun_ephemeris(jd_tt).eq_apparent;
    let elongation_deg = angular_distance_deg(eq_apparent, sun_eq);

    let r_earth = earth_j2000_ecl.norm();
    let cos_phase = ((helio_au * helio_au + geo_au * geo_au - r_earth * r_earth)
        / (2.0 * helio_au * geo_au))
        .clamp(-1.0, 1.0);
    let phase_angle_deg = cos_phase.acos().to_degrees();
    let illuminated_fraction = 0.5 * (1.0 + cos_phase);

    let angular_diameter_arcsec = if geo_au > 0.0 {
        2.0 * (radius_km / (geo_au * AU_KM))
            .clamp(-1.0, 1.0)
            .asin()
            .to_degrees()
            * 3600.0
    } else {
        0.0
    };

    let visual_magnitude = mag_fn(helio_au, geo_au, phase_angle_deg);

    BodyEphemeris {
        helio_xyz_j2000_au: helio_j2000_ecl,
        geo_xyz_j2000_au: geo_j2000_ecl,
        eq_j2000,
        eq_apparent,
        ecliptic_apparent,
        helio_au,
        geo_au,
        elongation_deg,
        phase_angle_deg,
        illuminated_fraction,
        angular_diameter_arcsec,
        visual_magnitude,
    }
}

/// Compute Earth's J2000 ecliptic velocity (AU/day) by central difference.
pub fn earth_velocity_j2000_au_day(jd_tt: f64) -> Vec3 {
    let dt = 0.05; // 1.2 hours
    let p_plus = earth_helio_j2000_au(jd_tt + dt);
    let p_minus = earth_helio_j2000_au(jd_tt - dt);
    (p_plus - p_minus).scale(0.5 / dt)
}

/// Saturn ring tilt angle `B` (degrees) as seen from Earth (for visual magnitude & ring rendering).
pub fn saturn_ring_tilt_deg(geo_j2000_ecl: Vec3) -> f64 {
    // IAU J2000 Saturn north pole: RA = 40.589°, Dec = +83.537°
    let pole_eq = spherical_to_vec3(40.589, 83.537, 1.0);
    let pole_ecl = equatorial_vec_to_ecliptic_vec(pole_eq, OBLIQUITY_J2000_DEG).normalize();
    let dir_to_earth = geo_j2000_ecl.scale(-1.0).normalize();
    dir_to_earth.dot(pole_ecl).clamp(-1.0, 1.0).asin().to_degrees()
}

fn planet_visual_magnitude(planet: Planet, r: f64, delta: f64, i_deg: f64, geo_j2000_ecl: Vec3) -> f64 {
    let dist_term = 5.0 * (r * delta).log10();
    let i2 = i_deg * i_deg;
    let i3 = i2 * i_deg;
    match planet {
        Planet::Mercury => -0.42 + dist_term + 0.0380 * i_deg - 0.000_273 * i2 + 2.0e-6 * i3,
        Planet::Venus => -4.40 + dist_term + 0.0009 * i_deg + 0.000_239 * i2 - 6.5e-7 * i3,
        Planet::Mars => -1.52 + dist_term + 0.016 * i_deg,
        Planet::Jupiter => -9.40 + dist_term + 0.005 * i_deg,
        Planet::Saturn => {
            let b_rad = saturn_ring_tilt_deg(geo_j2000_ecl).abs().to_radians();
            let sin_b = b_rad.sin();
            -8.88 + dist_term + 0.044 * i_deg - 2.60 * sin_b + 1.25 * sin_b * sin_b
        }
        Planet::Uranus => -7.19 + dist_term,
        Planet::Neptune => -6.87 + dist_term,
    }
}

/// High-precision planetary ephemeris using VSOP87 (Meeus Ch. 33 & 41).
pub fn planet_ephemeris(planet: Planet, jd_tt: f64) -> BodyEphemeris {
    let earth_pos = earth_helio_j2000_au(jd_tt);
    let earth_vel = earth_velocity_j2000_au_day(jd_tt);

    let mut pos = vsop87a_planet(planet, jd_tt);
    for _ in 0..2 {
        let delta = (pos - earth_pos).norm();
        let tau = LIGHT_TIME_DAYS_PER_AU * delta;
        pos = vsop87a_planet(planet, jd_tt - tau);
    }

    let geo_ecl = pos - earth_pos;
    finalize_body_ephemeris(
        pos,
        earth_pos,
        earth_vel,
        jd_tt,
        planet.equatorial_radius_km(),
        |r, delta, i_deg| planet_visual_magnitude(planet, r, delta, i_deg, geo_ecl),
    )
}

#[inline]
fn vsop87a_planet(planet: Planet, jd_tt: f64) -> Vec3 {
    vsop87a_planet_vec(planet, jd_tt)
}

/// Solve Kepler's equation `M = E - e sin(E)` using Newton-Raphson iteration.
pub(crate) fn solve_kepler_elliptic(mean_anomaly_rad: f64, e: f64) -> f64 {
    let m = mean_anomaly_rad.rem_euclid(std::f64::consts::TAU);
    let mut eccentric = if e < 0.8 { m } else { std::f64::consts::PI };
    for _ in 0..20 {
        let f = eccentric - e * eccentric.sin() - m;
        let fp = 1.0 - e * eccentric.cos();
        let delta = f / fp;
        eccentric -= delta;
        if delta.abs() < 1e-13 {
            break;
        }
    }
    eccentric
}

/// Heliocentric J2000 ecliptic Cartesian coordinates from J2000 Keplerian elements.
fn kepler_j2000_xyz(
    a_au: f64,
    e: f64,
    i_deg: f64,
    node_deg: f64,
    arg_peri_deg: f64,
    mean_anom_deg: f64,
) -> Vec3 {
    let ea = solve_kepler_elliptic(mean_anom_deg.to_radians(), e);
    let x_orb = a_au * (ea.cos() - e);
    let y_orb = a_au * (1.0 - e * e).sqrt() * ea.sin();

    let (so, co) = arg_peri_deg.to_radians().sin_cos();
    let (sn, cn) = node_deg.to_radians().sin_cos();
    let (si, ci) = i_deg.to_radians().sin_cos();

    // Standard ecliptic orbital rotation
    let x = (cn * co - sn * so * ci) * x_orb + (-cn * so - sn * co * ci) * y_orb;
    let y = (sn * co + cn * so * ci) * x_orb + (-sn * so + cn * co * ci) * y_orb;
    let z = (so * si) * x_orb + (co * si) * y_orb;
    Vec3::new(x, y, z)
}

// Meeus Ch. 37 Pluto periodic series (Table 37.A, valid 1885–2099 to < 1")
#[rustfmt::skip]
const PLUTO_ARGS: [(i8, i8, i8); 43] = [
    (0, 0, 1), (0, 0, 2), (0, 0, 3), (0, 0, 4), (0, 0, 5), (0, 0, 6),
    (0, 1, -1), (0, 1, 0), (0, 1, 1), (0, 1, 2), (0, 1, 3),
    (0, 2, -2), (0, 2, -1), (0, 2, 0), (1, -1, 0), (1, -1, 1),
    (1, 0, -3), (1, 0, -2), (1, 0, -1), (1, 0, 0), (1, 0, 1), (1, 0, 2), (1, 0, 3), (1, 0, 4),
    (1, 1, -3), (1, 1, -2), (1, 1, -1), (1, 1, 0), (1, 1, 1), (1, 1, 3),
    (2, 0, -6), (2, 0, -5), (2, 0, -4), (2, 0, -3), (2, 0, -2), (2, 0, -1), (2, 0, 0), (2, 0, 1), (2, 0, 2), (2, 0, 3),
    (3, 0, -2), (3, 0, -1), (3, 0, 0),
];

#[rustfmt::skip]
const PLUTO_LBR: [(f64, f64, f64, f64, f64, f64); 43] = [
    (-19_799_805.0, 19_850_055.0, -5_452_852.0, -14_974_862.0,  6_686_543.0,  6_895_181.0),
    (    897_144.0, -4_954_829.0,  3_527_812.0,  1_672_790.0, -1_182_755.0,    -33_254.0),
    (    611_149.0,  1_211_027.0, -1_050_748.0,    327_647.0,    159_317.0,   -143_881.0),
    (   -341_243.0,   -189_585.0,    178_690.0,   -292_153.0,    -18_444.0,     48_322.0),
    (    129_287.0,    -34_992.0,     18_798.0,    100_074.0,     -6_582.0,     -8_543.0),
    (    -38_164.0,     30_893.0,    -30_697.0,    -25_823.0,      4_283.0,       -710.0),
    (     20_442.0,     -9_987.0,      4_878.0,     11_248.0,     -8_574.0,      2_583.0),
    (     -4_063.0,     -5_071.0,        226.0,       -64.0,      1_148.0,     -2_941.0),
    (     -6_016.0,     -3_336.0,      2_030.0,      -836.0,       -292.0,        657.0),
    (     -3_956.0,      3_039.0,         69.0,      -858.0,        496.0,        217.0),
    (       -667.0,      3_572.0,       -447.0,      -848.0,       -284.0,       -292.0),
    (      1_276.0,        501.0,       -160.0,      1_083.0,        -37.0,         46.0),
    (      1_152.0,       -917.0,        343.0,       -561.0,        236.0,        -77.0),
    (        630.0,     -1_277.0,       -143.0,        -64.0,       -141.0,        261.0),
    (      2_571.0,       -459.0,        197.0,       -250.0,       -964.0,        511.0),
    (        899.0,     -1_449.0,       -275.0,        -75.0,       -502.0,       -370.0),
    (     -1_016.0,      1_043.0,        -79.0,        576.0,       -223.0,          7.0),
    (     -2_343.0,     -1_012.0,        931.0,      1_201.0,       -163.0,       -116.0),
    (      7_042.0,        788.0,       1_369.0,      2_511.0,     -1_235.0,        543.0),
    (      1_199.0,       -338.0,        577.0,     -2_593.0,       -434.0,       -114.0),
    (      4_182.0,     -2_266.0,        339.0,      1_129.0,       -620.0,       -433.0),
    (      1_205.0,      1_523.0,        211.0,        -70.0,        378.0,       -124.0),
    (       -608.0,       -715.0,       -199.0,       -273.0,        -70.0,        107.0),
    (        -81.0,       -198.0,        -29.0,        135.0,          0.0,          0.0),
    (       -226.0,       -227.0,       -229.0,        -91.0,        104.0,        -46.0),
    (        116.0,        284.0,        294.0,        337.0,       -107.0,         96.0),
    (       -913.0,     -1_055.0,       -450.0,       -913.0,        584.0,       -366.0),
    (     -8_629.0,      8_462.0,       -949.0,      1_057.0,      1_408.0,     -1_738.0),
    (     -1_624.0,      3_729.0,       1_117.0,      1_061.0,       -630.0,        659.0),
    (       -463.0,       -802.0,        -72.0,        -98.0,          0.0,          0.0),
    (       -969.0,        602.0,        -27.0,        330.0,          0.0,          0.0),
    (     -1_730.0,       -448.0,         41.0,        -93.0,          0.0,          0.0),
    (     -1_663.0,       -697.0,        156.0,        449.0,          0.0,          0.0),
    (     -1_620.0,        343.0,        146.0,      1_046.0,        -78.0,       -245.0),
    (        609.0,       -800.0,        -37.0,         59.0,        -42.0,         77.0),
    (       -221.0,       -340.0,         48.0,        -12.0,         94.0,        -40.0),
    (       -629.0,        154.0,        -40.0,         65.0,        -64.0,         85.0),
    (       -396.0,        314.0,        -19.0,       -217.0,         30.0,         46.0),
    (     -1_125.0,       -229.0,         18.0,         35.0,          0.0,          0.0),
    (       -196.0,        293.0,        -39.0,        -46.0,          0.0,          0.0),
    (        110.0,        -92.0,          0.0,          0.0,          0.0,          0.0),
    (        249.0,        174.0,          0.0,          0.0,          0.0,          0.0),
    (       -196.0,       -248.0,          0.0,          0.0,          0.0,          0.0),
];

fn pluto_helio_j2000_au(jd_tt: f64) -> Vec3 {
    let t = (jd_tt - J2000_JD) / 36_525.0;
    // Outside 1885..2099 use J2000 mean Keplerian orbit
    if !(-1.15..=1.0).contains(&t) {
        let m = 14.53 + 1.452_08 * 365.25 * t / 365.25; // ~1.45208°/yr
        return kepler_j2000_xyz(39.482_1, 0.248_83, 17.140_0, 110.299, 113.834, m);
    }

    let j = (34.35 + 3_034.905_7 * t).to_radians();
    let s = (50.08 + 1_222.113_8 * t).to_radians();
    let p = (238.96 + 144.9600 * t).to_radians();

    let mut sum_l = 0.0_f64;
    let mut sum_b = 0.0_f64;
    let mut sum_r = 0.0_f64;

    for (idx, &(cj, cs, cp)) in PLUTO_ARGS.iter().enumerate() {
        let alpha = f64::from(cj) * j + f64::from(cs) * s + f64::from(cp) * p;
        let (sa, ca) = alpha.sin_cos();
        let (sl, cl, sb, cb, sr, cr) = PLUTO_LBR[idx];
        sum_l += sl * sa + cl * ca;
        sum_b += sb * sa + cb * ca;
        sum_r += sr * sa + cr * ca;
    }

    let lon_deg = wrap_deg_360(238.958_116 + 144.96 * t + sum_l * 1e-6);
    let lat_deg = -3.908_239 + sum_b * 1e-6;
    let r_au = 40.724_134_6 + sum_r * 1e-6;
    spherical_to_vec3(lon_deg, lat_deg, r_au)
}

fn eris_helio_j2000_au(jd_tt: f64) -> Vec3 {
    // JPL Horizons J2000 ecliptic elements at epoch JD 2457000.5
    let dt_days = jd_tt - 2_457_000.5;
    let n_deg_day = 0.001_769_55; // 360 / (557.99 * 365.25)
    let m_deg = 205.989 + n_deg_day * dt_days;
    kepler_j2000_xyz(67.781, 0.440_68, 44.0445, 35.8799, 151.4305, m_deg)
}

/// Ephemeris for dwarf planets (Pluto via Meeus Ch. 37, Eris via J2000 Keplerian elements).
pub fn dwarf_planet_ephemeris(dwarf: DwarfPlanet, jd_tt: f64) -> BodyEphemeris {
    let earth_pos = earth_helio_j2000_au(jd_tt);
    let earth_vel = earth_velocity_j2000_au_day(jd_tt);
    let helio_fn = match dwarf {
        DwarfPlanet::Pluto => pluto_helio_j2000_au,
        DwarfPlanet::Eris => eris_helio_j2000_au,
    };
    let mut pos = helio_fn(jd_tt);
    for _ in 0..2 {
        let delta = (pos - earth_pos).norm();
        pos = helio_fn(jd_tt - LIGHT_TIME_DAYS_PER_AU * delta);
    }

    let h_mag = match dwarf {
        DwarfPlanet::Pluto => -0.7,
        DwarfPlanet::Eris => -1.17,
    };

    finalize_body_ephemeris(
        pos,
        earth_pos,
        earth_vel,
        jd_tt,
        dwarf.radius_km(),
        |r, delta, i_deg| h_mag + 5.0 * (r * delta).log10() + 0.04 * i_deg,
    )
}

pub fn body_ephemeris(body: SolarSystemBody, jd_tt: f64) -> BodyEphemeris {
    match body {
        SolarSystemBody::Sun => sun_ephemeris(jd_tt),
        SolarSystemBody::Moon => {
            let m = moon_ephemeris(jd_tt);
            let sun_pos = sun_ephemeris(jd_tt).geo_xyz_j2000_au;
            let moon_geo_eq = spherical_to_vec3(m.eq_j2000.ra_deg, m.eq_j2000.dec_deg, m.geo_au);
            let moon_geo_ecl = equatorial_vec_to_ecliptic_vec(moon_geo_eq, OBLIQUITY_J2000_DEG);
            let helio_ecl = moon_geo_ecl - sun_pos;
            BodyEphemeris {
                helio_xyz_j2000_au: helio_ecl,
                geo_xyz_j2000_au: moon_geo_ecl,
                eq_j2000: m.eq_j2000,
                eq_apparent: m.eq_apparent,
                ecliptic_apparent: m.ecliptic_apparent,
                helio_au: helio_ecl.norm(),
                geo_au: m.geo_au,
                elongation_deg: m.elongation_deg,
                phase_angle_deg: m.phase_angle_deg,
                illuminated_fraction: m.illuminated_fraction,
                angular_diameter_arcsec: m.angular_diameter_arcsec,
                visual_magnitude: m.visual_magnitude,
            }
        }
        SolarSystemBody::Planet(p) => planet_ephemeris(p, jd_tt),
        SolarSystemBody::DwarfPlanet(dp) => dwarf_planet_ephemeris(dp, jd_tt),
    }
}

// Meeus Ch. 47 Table 47.A: 60 periodic terms for Moon longitude & distance
// (D, M, M', F, sigma_l [0.000001°], sigma_r [0.001 km])
#[rustfmt::skip]
const MOON_LON_DIST_TERMS: [(i8, i8, i8, i8, i32, i32); 60] = [
    (0,  0,  1,  0,  6288774, -20905355),
    (2,  0, -1,  0,  1274027,  -3699111),
    (2,  0,  0,  0,   658314,  -2955968),
    (0,  0,  2,  0,   213618,   -569925),
    (0,  1,  0,  0,  -185116,     48888),
    (0,  0,  0,  2,  -114332,     -3149),
    (2,  0, -2,  0,    58793,    246158),
    (2, -1, -1,  0,    57066,   -152138),
    (2,  0,  1,  0,    53322,   -170733),
    (2, -1,  0,  0,    45758,   -204586),
    (0,  1, -1,  0,   -40923,   -129620),
    (1,  0,  0,  0,   -34720,    108743),
    (0,  1,  1,  0,   -30383,    104755),
    (2,  0,  0, -2,    15327,     10321),
    (0,  0,  1,  2,   -12528,         0),
    (0,  0,  1, -2,    10980,     79661),
    (4,  0, -1,  0,    10675,    -34782),
    (0,  0,  3,  0,    10034,    -23210),
    (4,  0, -2,  0,     8548,    -21636),
    (2,  1, -1,  0,    -7888,     24208),
    (2,  1,  0,  0,    -6766,     30824),
    (1,  0, -1,  0,    -5163,     -8379),
    (1,  1,  0,  0,     4987,    -16675),
    (2, -1,  1,  0,     4036,    -12831),
    (2,  0,  2,  0,     3994,    -10445),
    (4,  0,  0,  0,     3861,    -11650),
    (2,  0, -3,  0,     3665,     14403),
    (0,  1, -2,  0,    -2689,     -7003),
    (2,  0, -1,  2,    -2602,         0),
    (2, -1, -2,  0,     2390,     10056),
    (1,  0,  1,  0,    -2348,      6322),
    (2, -2,  0,  0,     2236,     -9884),
    (0,  1,  2,  0,    -2120,      5751),
    (0,  2,  0,  0,    -2069,         0),
    (2, -2, -1,  0,     2048,     -4950),
    (2,  0,  1, -2,    -1773,      4130),
    (2,  0,  0,  2,    -1595,         0),
    (4, -1, -1,  0,     1215,     -3958),
    (0,  0,  2,  2,    -1110,         0),
    (3,  0, -1,  0,     -892,      3258),
    (2,  1,  1,  0,     -810,      2616),
    (4, -1, -2,  0,      759,     -1897),
    (0,  2, -1,  0,     -713,     -2117),
    (2,  2, -1,  0,     -700,      2354),
    (2,  1, -2,  0,      691,         0),
    (2, -1,  0, -2,      596,         0),
    (4,  0,  1,  0,      549,     -1423),
    (0,  0,  4,  0,      537,     -1117),
    (4, -1,  0,  0,      520,     -1571),
    (1,  0, -2,  0,     -487,     -1739),
    (2,  1,  0, -2,     -399,         0),
    (0,  0,  2, -2,     -381,     -4421),
    (1,  1,  1,  0,      351,         0),
    (3,  0, -2,  0,     -340,         0),
    (4,  0, -3,  0,      330,         0),
    (2, -1,  2,  0,      327,         0),
    (0,  2,  1,  0,     -323,      1165),
    (1,  1, -1,  0,      299,         0),
    (2,  0,  3,  0,      294,         0),
    (2,  0, -1, -2,        0,      8752),
];

// Meeus Ch. 47 Table 47.B: 60 periodic terms for Moon latitude (0.000001°)
#[rustfmt::skip]
const MOON_LAT_TERMS: [(i8, i8, i8, i8, i32); 60] = [
    (0,  0,  0,  1,  5128122),
    (0,  0,  1,  1,   280602),
    (0,  0,  1, -1,   277693),
    (2,  0,  0, -1,   173237),
    (2,  0, -1,  1,    55413),
    (2,  0, -1, -1,    46271),
    (2,  0,  0,  1,    32573),
    (0,  0,  2,  1,    17198),
    (2,  0,  1, -1,     9266),
    (0,  0,  2, -1,     8822),
    (2, -1,  0, -1,     8216),
    (2,  0, -2, -1,     4324),
    (2,  0,  1,  1,     4200),
    (2,  1,  0, -1,    -3359),
    (2, -1, -1,  1,     2463),
    (2, -1,  0,  1,     2211),
    (2, -1, -1, -1,     2065),
    (0,  1, -1, -1,    -1870),
    (4,  0, -1, -1,     1828),
    (0,  1,  0,  1,    -1794),
    (0,  0,  0,  3,    -1749),
    (0,  1, -1,  1,    -1565),
    (1,  0,  0,  1,    -1491),
    (0,  1,  1,  1,    -1475),
    (0,  1,  1, -1,    -1410),
    (0,  1,  0, -1,    -1344),
    (1,  0,  0, -1,    -1335),
    (0,  0,  3,  1,     1107),
    (4,  0,  0, -1,     1021),
    (4,  0, -1,  1,      833),
    (0,  0,  1, -3,      777),
    (4,  0, -2,  1,      671),
    (2,  0,  0, -3,      607),
    (2,  0,  2, -1,      596),
    (2, -1,  1, -1,      491),
    (2,  0, -2,  1,     -451),
    (0,  0,  3, -1,      439),
    (2,  0,  2,  1,      422),
    (2,  0, -3, -1,      421),
    (2,  1, -1,  1,     -366),
    (2,  1,  0,  1,     -351),
    (4,  0,  0,  1,      331),
    (2, -1,  1,  1,      315),
    (2, -2,  0, -1,      302),
    (0,  0,  1,  3,     -283),
    (2,  1,  1, -1,     -229),
    (1,  1,  0, -1,      223),
    (1,  1,  0,  1,      223),
    (0,  1, -2, -1,     -220),
    (2,  1, -1, -1,     -220),
    (1,  0,  1,  1,     -185),
    (2, -1, -2, -1,      181),
    (0,  1,  2,  1,     -177),
    (4,  0, -2, -1,      176),
    (4, -1, -1, -1,      166),
    (1,  0,  1, -1,     -164),
    (4,  0,  1, -1,      132),
    (1,  0, -1, -1,     -119),
    (4, -1,  0, -1,      115),
    (2, -2,  0,  1,      107),
];

fn moon_fundamental_args(jd_tt: f64) -> (f64, f64, f64, f64, f64, f64) {
    let t = (jd_tt - J2000_JD) / 36_525.0;
    let t2 = t * t;
    let t3 = t2 * t;
    let t4 = t2 * t2;

    let lp = wrap_deg_360(
        218.316_447_7 + 481_267.881_234_21 * t - 0.001_578_6 * t2 + t3 / 538_841.0
            - t4 / 65_194_000.0,
    );
    let d = wrap_deg_360(
        297.850_192_1 + 445_267.111_403_4 * t - 0.001_881_9 * t2 + t3 / 545_868.0
            - t4 / 113_065_000.0,
    );
    let m = wrap_deg_360(
        357.529_109_2 + 35_999.050_290_9 * t - 0.000_153_6 * t2 + t3 / 24_490_000.0,
    );
    let mp = wrap_deg_360(
        134.963_396_4 + 477_198.867_505_5 * t + 0.008_741_4 * t2 + t3 / 69_699.0
            - t4 / 14_712_000.0,
    );
    let f = wrap_deg_360(
        93.272_095_0 + 483_202.017_523_3 * t - 0.003_653_9 * t2 - t3 / 3_526_000.0
            + t4 / 863_310_000.0,
    );
    (t, lp, d, m, mp, f)
}

/// Fast lunar apparent ecliptic longitude (`degrees [0, 360)`) for phase & Kyureki root-finding.
pub fn moon_apparent_ecliptic_lon_deg(jd_tt: f64) -> f64 {
    let (t, lp, d, m, mp, f) = moon_fundamental_args(jd_tt);
    let e = 1.0 - 0.002_516 * t - 0.000_007_4 * t * t;
    let e2 = e * e;

    let mut sum_l = 0.0_f64;
    for &(cd, cm, cmp, cf, sl, _) in &MOON_LON_DIST_TERMS {
        if sl == 0 {
            continue;
        }
        let arg = (f64::from(cd) * d + f64::from(cm) * m + f64::from(cmp) * mp + f64::from(cf) * f)
            .to_radians();
        let factor = match cm.abs() {
            1 => e,
            2 => e2,
            _ => 1.0,
        };
        sum_l += f64::from(sl) * factor * arg.sin();
    }

    let a1 = wrap_deg_360(119.75 + 131.849 * t).to_radians();
    let a2 = wrap_deg_360(53.09 + 479_264.290 * t).to_radians();
    sum_l += 3958.0 * a1.sin() + 1962.0 * (lp - f).to_radians().sin() + 318.0 * a2.sin();

    let nut = nutation(jd_tt);
    wrap_deg_360(lp + sum_l * 1e-6 + nut.delta_psi_deg)
}

/// Find the Moon's age in days since the most recent New Moon (synodic phase).
pub fn moon_age_days(jd_tt: f64) -> f64 {
    // Rough phase angle estimate -> jump close to previous New Moon
    let moon_lon = moon_apparent_ecliptic_lon_deg(jd_tt);
    let sun_lon = sun_apparent_ecliptic_lon_deg(jd_tt);
    let mut diff = wrap_deg_360(moon_lon - sun_lon);
    if diff < 0.02 {
        // Could be right after or right before New Moon; handle both cleanly
        diff = 0.0;
    }
    let synodic = 29.530_588_853;
    let mut approx_nm = jd_tt - (diff / 360.0) * synodic;

    // Bracket and refine previous New Moon where wrap_deg_180(moon - sun) == 0
    for _ in 0..8 {
        let d_lon = wrap_deg_180(
            moon_apparent_ecliptic_lon_deg(approx_nm) - sun_apparent_ecliptic_lon_deg(approx_nm),
        );
        approx_nm -= d_lon * (synodic / 360.0);
        if d_lon.abs() < 1e-7 {
            break;
        }
    }
    if approx_nm > jd_tt + 1e-5 {
        approx_nm -= synodic;
        for _ in 0..8 {
            let d_lon = wrap_deg_180(
                moon_apparent_ecliptic_lon_deg(approx_nm)
                    - sun_apparent_ecliptic_lon_deg(approx_nm),
            );
            approx_nm -= d_lon * (synodic / 360.0);
            if d_lon.abs() < 1e-7 {
                break;
            }
        }
    }
    (jd_tt - approx_nm).max(0.0)
}

/// High-precision Lunar ephemeris (ELP2000 / Meeus Ch. 47, 48 & 53).
pub fn moon_ephemeris(jd_tt: f64) -> MoonEphemeris {
    let (t, lp, d, m, mp, f) = moon_fundamental_args(jd_tt);
    let e = 1.0 - 0.002_516 * t - 0.000_007_4 * t * t;
    let e2 = e * e;

    let mut sum_l = 0.0_f64;
    let mut sum_r = 0.0_f64;
    for &(cd, cm, cmp, cf, sl, sr) in &MOON_LON_DIST_TERMS {
        let arg = (f64::from(cd) * d + f64::from(cm) * m + f64::from(cmp) * mp + f64::from(cf) * f)
            .to_radians();
        let factor = match cm.abs() {
            1 => e,
            2 => e2,
            _ => 1.0,
        };
        let (sa, ca) = arg.sin_cos();
        sum_l += f64::from(sl) * factor * sa;
        sum_r += f64::from(sr) * factor * ca;
    }

    let mut sum_b = 0.0_f64;
    for &(cd, cm, cmp, cf, sb) in &MOON_LAT_TERMS {
        let arg = (f64::from(cd) * d + f64::from(cm) * m + f64::from(cmp) * mp + f64::from(cf) * f)
            .to_radians();
        let factor = match cm.abs() {
            1 => e,
            2 => e2,
            _ => 1.0,
        };
        sum_b += f64::from(sb) * factor * arg.sin();
    }

    let a1 = wrap_deg_360(119.75 + 131.849 * t).to_radians();
    let a2 = wrap_deg_360(53.09 + 479_264.290 * t).to_radians();
    let a3 = wrap_deg_360(313.45 + 481_266.484 * t).to_radians();

    sum_l += 3958.0 * a1.sin() + 1962.0 * (lp - f).to_radians().sin() + 318.0 * a2.sin();
    sum_b += -2235.0 * lp.to_radians().sin()
        + 382.0 * a3.sin()
        + 175.0 * (a1 - f.to_radians()).sin()
        + 175.0 * (a1 + f.to_radians()).sin()
        + 127.0 * (lp - mp).to_radians().sin()
        - 115.0 * (lp + mp).to_radians().sin();

    let lon_mean_deg = wrap_deg_360(lp + sum_l * 1e-6);
    let lat_deg = sum_b * 1e-6;
    let distance_km = 385_000.56 + sum_r * 1e-3;
    let geo_au = distance_km / AU_KM;

    let nut = nutation(jd_tt);
    let ecliptic_apparent = Ecliptic {
        lon_deg: wrap_deg_360(lon_mean_deg + nut.delta_psi_deg),
        lat_deg,
    };
    let eq_apparent = ecliptic_to_equatorial(ecliptic_apparent, nut.true_obliquity_deg);
    let eq_mean_date = ecliptic_to_equatorial(
        Ecliptic {
            lon_deg: lon_mean_deg,
            lat_deg,
        },
        nut.mean_obliquity_deg,
    );
    let eq_j2000 = crate::engine::precession::precess_date_to_j2000(eq_mean_date, jd_tt);

    let horizontal_parallax_deg = (EARTH_EQUATORIAL_RADIUS_KM / distance_km)
        .clamp(-1.0, 1.0)
        .asin()
        .to_degrees();
    let angular_diameter_arcsec =
        2.0 * (MOON_RADIUS_KM / distance_km).clamp(-1.0, 1.0).asin().to_degrees() * 3600.0;

    // Illumination, phase angle, bright limb position angle (Meeus Ch. 48)
    let sun = sun_ephemeris(jd_tt);
    let sun_eq = sun.eq_apparent;
    let elongation_deg = angular_distance_deg(eq_apparent, sun_eq);
    let cos_elong = elongation_deg.to_radians().cos();
    let sin_elong = elongation_deg.to_radians().sin();
    let sun_dist_km = sun.geo_au * AU_KM;
    let phase_angle_rad = (sun_dist_km * sin_elong).atan2(distance_km - sun_dist_km * cos_elong);
    let phase_angle_deg = phase_angle_rad.to_degrees();
    let illuminated_fraction = 0.5 * (1.0 + phase_angle_rad.cos());

    let d_alpha = (sun_eq.ra_deg - eq_apparent.ra_deg).to_radians();
    let d_s = sun_eq.dec_deg.to_radians();
    let d_m = eq_apparent.dec_deg.to_radians();
    let pa_bright = wrap_deg_360(
        (d_s.cos() * d_alpha.sin())
            .atan2(d_m.cos() * d_s.sin() - d_m.sin() * d_s.cos() * d_alpha.cos())
            .to_degrees(),
    );

    // Optical libration (Meeus Ch. 53)
    let (libration_lon_deg, libration_lat_deg, libration_pa_deg) = compute_moon_libration(
        t,
        ecliptic_apparent.lon_deg,
        ecliptic_apparent.lat_deg,
        eq_apparent.dec_deg,
        &nut,
        f,
    );

    let age_days = moon_age_days(jd_tt);
    // Approximate visual magnitude of the Moon as function of phase angle
    let visual_magnitude = -12.74 + 0.026 * phase_angle_deg.abs() + 4.0e-9 * phase_angle_deg.powi(4);

    MoonEphemeris {
        eq_j2000,
        eq_apparent,
        ecliptic_apparent,
        distance_km,
        geo_au,
        horizontal_parallax_deg,
        angular_diameter_arcsec,
        elongation_deg,
        phase_angle_deg,
        illuminated_fraction,
        position_angle_bright_limb_deg: pa_bright,
        libration_lon_deg,
        libration_lat_deg,
        libration_pa_deg,
        age_days,
        visual_magnitude,
    }
}

fn compute_moon_libration(
    t: f64,
    lon_app_deg: f64,
    lat_deg: f64,
    dec_app_deg: f64,
    nut: &crate::engine::precession::Nutation,
    f_arg_deg: f64,
) -> (f64, f64, f64) {
    let i_incl = 1.542_42_f64.to_radians();
    let t2 = t * t;
    let t3 = t2 * t;
    let t4 = t2 * t2;
    let omega = wrap_deg_360(
        125.044_547_9 - 1_934.136_289_1 * t + 0.002_075_4 * t2 + t3 / 467_441.0
            - t4 / 60_616_000.0,
    );

    let w = (lon_app_deg - nut.delta_psi_deg - omega).to_radians();
    let lat = lat_deg.to_radians();
    let (sin_w, cos_w) = w.sin_cos();
    let (sin_lat, cos_lat) = lat.sin_cos();
    let (sin_i, cos_i) = i_incl.sin_cos();

    let a_rad = (sin_w * cos_lat * cos_i - sin_lat * sin_i).atan2(cos_w * cos_lat);
    let l_opt = wrap_deg_180(a_rad.to_degrees() - f_arg_deg);
    let b_opt = (-sin_w * cos_lat * sin_i - sin_lat * cos_i)
        .clamp(-1.0, 1.0)
        .asin()
        .to_degrees();

    // Axis position angle P (Meeus Ch. 53)
    let v = (omega + nut.delta_psi_deg).to_radians();
    let eps = nut.true_obliquity_deg.to_radians();
    let x = sin_i * v.sin();
    let y = sin_i * v.cos() * eps.cos() - cos_i * eps.sin();
    let omega_q = x.atan2(y);
    let ra_term = (nut.true_obliquity_deg.to_radians().sin() * lon_app_deg.to_radians().cos()
        + nut.true_obliquity_deg.to_radians().cos() * 0.0)
        .atan2(dec_app_deg.to_radians().cos());
    let _ = ra_term;
    let pa = wrap_deg_180(
        ((x * x + y * y).sqrt() * (eq_ra_approx_from_ecl(lon_app_deg, lat_deg, nut.true_obliquity_deg).to_radians() - omega_q).cos())
            .asin()
            .to_degrees(),
    );

    (l_opt, b_opt, pa)
}

fn eq_ra_approx_from_ecl(lon_deg: f64, lat_deg: f64, eps_deg: f64) -> f64 {
    ecliptic_to_equatorial(
        Ecliptic {
            lon_deg,
            lat_deg,
        },
        eps_deg,
    )
    .ra_deg
}

/// Apply rigorous diurnal/topocentric parallax (WGS84 Earth figure) to geocentric `Equatorial` coordinates.
pub fn geocentric_to_topocentric(
    eq: Equatorial,
    dist_au: f64,
    lat_deg: f64,
    alt_m: f64,
    lst_deg: f64,
) -> Equatorial {
    if dist_au <= 0.0 {
        return eq;
    }
    let sin_pi = (EARTH_EQUATORIAL_RADIUS_KM / (dist_au * AU_KM)).min(0.99);
    let lat = lat_deg.to_radians();
    let b_over_a = 1.0 - 1.0 / 298.257_223_563;
    let u = (b_over_a * lat.tan()).atan();
    let alt_ratio = alt_m / 6_378_137.0;
    let rho_sin = b_over_a * u.sin() + alt_ratio * lat.sin();
    let rho_cos = u.cos() + alt_ratio * lat.cos();

    let ha = wrap_deg_180(lst_deg - eq.ra_deg).to_radians();
    let dec = eq.dec_deg.to_radians();
    let (sin_ha, cos_ha) = ha.sin_cos();
    let (sin_dec, cos_dec) = dec.sin_cos();

    // Exact Meeus Eq. 40.2 & 40.3:
    let denom = cos_dec - rho_cos * sin_pi * cos_ha;
    let d_ra = (-rho_cos * sin_pi * sin_ha).atan2(denom);
    let dec_topo_exact = ((sin_dec - rho_sin * sin_pi) * d_ra.cos()).atan2(denom);

    Equatorial {
        ra_deg: wrap_deg_360(eq.ra_deg + d_ra.to_degrees()),
        dec_deg: dec_topo_exact.to_degrees(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn meeus_ch25_sun_1992_10_13() {
        // Meeus Example 25.a/b: 1992-10-13 00:00 TD => JD 2448908.5
        // Expected: apparent RA = 13h13m30.763s = 198.37818°, Dec = -7°47'01.91" = -7.78386°, R = 0.9976085 AU
        let sun = sun_ephemeris(2_448_908.5);
        assert!(
            (wrap_deg_180(sun.eq_apparent.ra_deg - 198.378_18)).abs() < 1.0 / 60.0,
            "sun ra={}",
            sun.eq_apparent.ra_deg
        );
        assert!(
            (sun.eq_apparent.dec_deg - (-7.783_86)).abs() < 1.0 / 60.0,
            "sun dec={}",
            sun.eq_apparent.dec_deg
        );
        assert!((sun.geo_au - 0.997_608_5).abs() < 1e-5, "r={}", sun.geo_au);
    }

    #[test]
    fn meeus_ch33_venus_1992_12_20() {
        // Meeus Example 33.a: 1992-12-20 00:00 TD => JD 2448976.5
        // Expected apparent: RA = 21h04m41.454s = 316.17272°, Dec = -18°53'16.84" = -18.88801°, Δ = 0.9108456 AU
        let venus = planet_ephemeris(Planet::Venus, 2_448_976.5);
        assert!(
            (wrap_deg_180(venus.eq_apparent.ra_deg - 316.172_72)).abs() < 1.0 / 60.0,
            "venus ra={}",
            venus.eq_apparent.ra_deg
        );
        assert!(
            (venus.eq_apparent.dec_deg - (-18.888_01)).abs() < 1.0 / 60.0,
            "venus dec={}",
            venus.eq_apparent.dec_deg
        );
        // Light-time retarded Δ ≈ 0.910948 AU (instantaneous Δ = 0.910846 AU)
        assert!((venus.geo_au - 0.910_948).abs() < 1e-4, "delta={}", venus.geo_au);
    }

    #[test]
    fn meeus_ch47_moon_1992_04_12() {
        // Meeus Example 47.a: 1992-04-12 00:00 TD => JD 2448724.5
        // Expected: λ = 133.167265°, β = -3.229126°, Δ = 368409.68 km,
        // RA = 8h58m45.23s = 134.68846°, Dec = +13°46'06.1" = +13.76836°
        let moon = moon_ephemeris(2_448_724.5);
        assert!(
            (wrap_deg_180(moon.ecliptic_apparent.lon_deg - 133.167_265)).abs() < 0.01,
            "moon lon={}",
            moon.ecliptic_apparent.lon_deg
        );
        assert!(
            (moon.ecliptic_apparent.lat_deg - (-3.229_126)).abs() < 0.01,
            "moon lat={}",
            moon.ecliptic_apparent.lat_deg
        );
        assert!(
            (moon.distance_km - 368_409.68).abs() < 5.0,
            "moon dist={}",
            moon.distance_km
        );
        assert!(
            (wrap_deg_180(moon.eq_apparent.ra_deg - 134.688_46)).abs() < 1.0 / 60.0,
            "moon ra={}",
            moon.eq_apparent.ra_deg
        );
        assert!(
            (moon.eq_apparent.dec_deg - 13.768_36).abs() < 1.0 / 60.0,
            "moon dec={}",
            moon.eq_apparent.dec_deg
        );
    }

    #[test]
    fn meeus_ch37_pluto_1992_10_13() {
        // Meeus Example 37.a: 1992-10-13 00:00 TD => JD 2448908.5
        // Expected J2000: RA = 15h31m43.71s = 232.9321°, Dec = -4°27'28.8" = -4.4580°
        let pluto = dwarf_planet_ephemeris(DwarfPlanet::Pluto, 2_448_908.5);
        assert!(
            (wrap_deg_180(pluto.eq_j2000.ra_deg - 232.9321)).abs() < 1.0 / 60.0,
            "pluto ra={}",
            pluto.eq_j2000.ra_deg
        );
        assert!(
            (pluto.eq_j2000.dec_deg - (-4.4580)).abs() < 1.0 / 60.0,
            "pluto dec={}",
            pluto.eq_j2000.dec_deg
        );
    }

    #[test]
    fn j2000_jupiter_and_eris_sanity() {
        // J2000.0 (2000-01-01 12:00 TT, JD 2451545.0): Jupiter RA ≈ 1h35m28s = 23.867°, Dec ≈ +8°35'39" = +8.594°, mag ≈ -2.5
        let jup = planet_ephemeris(Planet::Jupiter, J2000_JD);
        assert!(
            (jup.eq_j2000.ra_deg - 23.867).abs() < 1.0 / 60.0,
            "jup ra={}",
            jup.eq_j2000.ra_deg
        );
        assert!(
            (jup.eq_j2000.dec_deg - 8.594).abs() < 1.0 / 60.0,
            "jup dec={}",
            jup.eq_j2000.dec_deg
        );
        assert!(jup.visual_magnitude < -2.0 && jup.visual_magnitude > -3.0);

        let eris = dwarf_planet_ephemeris(DwarfPlanet::Eris, J2000_JD);
        assert!(eris.helio_au > 95.0 && eris.helio_au < 99.0);
        assert!(eris.visual_magnitude > 18.0 && eris.visual_magnitude < 20.0);
    }
}
