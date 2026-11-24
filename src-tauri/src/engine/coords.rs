use serde::{Deserialize, Serialize};

/// Right Ascension and Declination in degrees.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Equatorial {
    pub ra_deg: f64,
    pub dec_deg: f64,
}

/// Horizontal coordinates in degrees.
/// Azimuth is measured clockwise from North: N=0°, E=90°, S=180°, W=270°.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Horizontal {
    pub az_deg: f64,
    pub alt_deg: f64,
}

/// Ecliptic longitude and latitude in degrees.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Ecliptic {
    pub lon_deg: f64,
    pub lat_deg: f64,
}

/// IAU 1958 Galactic longitude and latitude in degrees.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Galactic {
    pub l_deg: f64,
    pub b_deg: f64,
}

/// 3D Cartesian vector (unit sphere, AU, or parsecs depending on context).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Vec3 {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

impl Vec3 {
    pub const ZERO: Self = Self {
        x: 0.0,
        y: 0.0,
        z: 0.0,
    };

    #[inline]
    pub const fn new(x: f64, y: f64, z: f64) -> Self {
        Self { x, y, z }
    }

    #[inline]
    pub fn dot(self, other: Self) -> f64 {
        self.x * other.x + self.y * other.y + self.z * other.z
    }

    #[inline]
    pub fn cross(self, other: Self) -> Self {
        Self {
            x: self.y * other.z - self.z * other.y,
            y: self.z * other.x - self.x * other.z,
            z: self.x * other.y - self.y * other.x,
        }
    }

    #[inline]
    pub fn norm_sq(self) -> f64 {
        self.dot(self)
    }

    #[inline]
    pub fn norm(self) -> f64 {
        self.norm_sq().sqrt()
    }

    #[inline]
    pub fn normalize(self) -> Self {
        let n = self.norm();
        if n > 0.0 {
            self.scale(1.0 / n)
        } else {
            Self::ZERO
        }
    }

    #[inline]
    pub fn scale(self, s: f64) -> Self {
        Self {
            x: self.x * s,
            y: self.y * s,
            z: self.z * s,
        }
    }
}

impl std::ops::Add for Vec3 {
    type Output = Self;

    #[inline]
    fn add(self, other: Self) -> Self {
        Self {
            x: self.x + other.x,
            y: self.y + other.y,
            z: self.z + other.z,
        }
    }
}

impl std::ops::Sub for Vec3 {
    type Output = Self;

    #[inline]
    fn sub(self, other: Self) -> Self {
        Self {
            x: self.x - other.x,
            y: self.y - other.y,
            z: self.z - other.z,
        }
    }
}

/// Normalize angle in degrees to `[0.0, 360.0)`.
#[inline]
pub fn wrap_deg_360(deg: f64) -> f64 {
    let r = deg.rem_euclid(360.0);
    if r >= 360.0 { 0.0 } else { r }
}

/// Normalize angle in degrees to `[-180.0, 180.0)`.
#[inline]
pub fn wrap_deg_180(deg: f64) -> f64 {
    let mut r = wrap_deg_360(deg);
    if r >= 180.0 {
        r -= 360.0;
    }
    r
}

/// Convert spherical angles `(lon_deg, lat_deg)` and radius `r` to Cartesian `Vec3`.
#[inline]
pub fn spherical_to_vec3(lon_deg: f64, lat_deg: f64, radius: f64) -> Vec3 {
    let lon = lon_deg.to_radians();
    let lat = lat_deg.to_radians();
    let cos_lat = lat.cos();
    Vec3::new(
        radius * cos_lat * lon.cos(),
        radius * cos_lat * lon.sin(),
        radius * lat.sin(),
    )
}

/// Convert Cartesian `Vec3` to `(lon_deg in [0, 360), lat_deg in [-90, 90], radius)`.
#[inline]
pub fn vec3_to_spherical(v: Vec3) -> (f64, f64, f64) {
    let r = v.norm();
    if r == 0.0 {
        return (0.0, 0.0, 0.0);
    }
    let lon_deg = wrap_deg_360(v.y.atan2(v.x).to_degrees());
    let lat_deg = (v.z / r).clamp(-1.0, 1.0).asin().to_degrees();
    (lon_deg, lat_deg, r)
}

/// Convert `Equatorial` coordinates to unit `Vec3`.
#[inline]
pub fn equatorial_to_vec3(eq: Equatorial) -> Vec3 {
    spherical_to_vec3(eq.ra_deg, eq.dec_deg, 1.0)
}

/// Convert `Vec3` to `Equatorial` coordinates.
#[inline]
pub fn vec3_to_equatorial(v: Vec3) -> Equatorial {
    let (ra_deg, dec_deg, _) = vec3_to_spherical(v);
    Equatorial { ra_deg, dec_deg }
}

/// Convert Equatorial `(RA, Dec)` to Horizontal `(Azimuth from North, Altitude)` (Meeus Ch. 13).
pub fn equatorial_to_horizontal(eq: Equatorial, lat_deg: f64, lst_deg: f64) -> Horizontal {
    let ha = wrap_deg_180(lst_deg - eq.ra_deg).to_radians();
    let lat = lat_deg.to_radians();
    let dec = eq.dec_deg.to_radians();

    let (sin_ha, cos_ha) = ha.sin_cos();
    let (sin_lat, cos_lat) = lat.sin_cos();
    let (sin_dec, cos_dec) = dec.sin_cos();

    let sin_alt = (sin_lat * sin_dec + cos_lat * cos_dec * cos_ha).clamp(-1.0, 1.0);
    let alt_deg = sin_alt.asin().to_degrees();

    // Azimuth measured clockwise from North (N=0, E=90, S=180, W=270)
    let y = -sin_ha * cos_dec;
    let x = cos_lat * sin_dec - sin_lat * cos_dec * cos_ha;
    let az_deg = wrap_deg_360(y.atan2(x).to_degrees());

    Horizontal { az_deg, alt_deg }
}

/// Convert Horizontal `(Azimuth from North, Altitude)` to Equatorial `(RA, Dec)` (Meeus Ch. 13).
pub fn horizontal_to_equatorial(hor: Horizontal, lat_deg: f64, lst_deg: f64) -> Equatorial {
    let az = hor.az_deg.to_radians();
    let alt = hor.alt_deg.to_radians();
    let lat = lat_deg.to_radians();

    let (sin_az, cos_az) = az.sin_cos();
    let (sin_alt, cos_alt) = alt.sin_cos();
    let (sin_lat, cos_lat) = lat.sin_cos();

    let sin_dec = (sin_lat * sin_alt + cos_lat * cos_alt * cos_az).clamp(-1.0, 1.0);
    let dec_deg = sin_dec.asin().to_degrees();

    let y = -sin_az * cos_alt;
    let x = cos_lat * sin_alt - sin_lat * cos_alt * cos_az;
    let ha_deg = y.atan2(x).to_degrees();
    let ra_deg = wrap_deg_360(lst_deg - ha_deg);

    Equatorial { ra_deg, dec_deg }
}

/// Convert Equatorial `(RA, Dec)` to Ecliptic `(lon, lat)` given obliquity `eps_deg` (Meeus Eq. 13.1-13.2).
pub fn equatorial_to_ecliptic(eq: Equatorial, obliquity_deg: f64) -> Ecliptic {
    let ra = eq.ra_deg.to_radians();
    let dec = eq.dec_deg.to_radians();
    let eps = obliquity_deg.to_radians();

    let (sin_ra, cos_ra) = ra.sin_cos();
    let (sin_dec, cos_dec) = dec.sin_cos();
    let (sin_eps, cos_eps) = eps.sin_cos();

    let y = sin_ra * cos_eps * cos_dec + sin_dec * sin_eps;
    let x = cos_ra * cos_dec;
    let lon_deg = wrap_deg_360(y.atan2(x).to_degrees());

    let sin_lat = (sin_dec * cos_eps - cos_dec * sin_eps * sin_ra).clamp(-1.0, 1.0);
    let lat_deg = sin_lat.asin().to_degrees();

    Ecliptic { lon_deg, lat_deg }
}

/// Convert Ecliptic `(lon, lat)` to Equatorial `(RA, Dec)` given obliquity `eps_deg` (Meeus Eq. 13.3-13.4).
pub fn ecliptic_to_equatorial(ecl: Ecliptic, obliquity_deg: f64) -> Equatorial {
    let lon = ecl.lon_deg.to_radians();
    let lat = ecl.lat_deg.to_radians();
    let eps = obliquity_deg.to_radians();

    let (sin_lon, cos_lon) = lon.sin_cos();
    let (sin_lat, cos_lat) = lat.sin_cos();
    let (sin_eps, cos_eps) = eps.sin_cos();

    let y = sin_lon * cos_eps * cos_lat - sin_lat * sin_eps;
    let x = cos_lon * cos_lat;
    let ra_deg = wrap_deg_360(y.atan2(x).to_degrees());

    let sin_dec = (sin_lat * cos_eps + cos_lat * sin_eps * sin_lon).clamp(-1.0, 1.0);
    let dec_deg = sin_dec.asin().to_degrees();

    Equatorial { ra_deg, dec_deg }
}

// IAU 1958 Galactic coordinate constants in J2000.0 (FK5)
const NGP_RA_J2000_DEG: f64 = 192.859_481_206_534_8;
const NGP_DEC_J2000_DEG: f64 = 27.128_251_180_856_22;
const GAL_LON_NCP_DEG: f64 = 122.931_918_568_002_6;

/// Convert J2000.0 Equatorial coordinates to IAU Galactic `(l, b)` coordinates.
pub fn equatorial_j2000_to_galactic(eq: Equatorial) -> Galactic {
    let d_ra = (eq.ra_deg - NGP_RA_J2000_DEG).to_radians();
    let dec = eq.dec_deg.to_radians();
    let dec_g = NGP_DEC_J2000_DEG.to_radians();

    let (sin_dra, cos_dra) = d_ra.sin_cos();
    let (sin_dec, cos_dec) = dec.sin_cos();
    let (sin_dg, cos_dg) = dec_g.sin_cos();

    let sin_b = (sin_dec * sin_dg + cos_dec * cos_dg * cos_dra).clamp(-1.0, 1.0);
    let b_deg = sin_b.asin().to_degrees();

    let y = cos_dec * sin_dra;
    let x = sin_dec * cos_dg - cos_dec * sin_dg * cos_dra;
    let l_deg = wrap_deg_360(GAL_LON_NCP_DEG - y.atan2(x).to_degrees());

    Galactic { l_deg, b_deg }
}

/// Convert IAU Galactic `(l, b)` coordinates to J2000.0 Equatorial coordinates.
pub fn galactic_to_equatorial_j2000(gal: Galactic) -> Equatorial {
    let theta = (GAL_LON_NCP_DEG - gal.l_deg).to_radians();
    let b = gal.b_deg.to_radians();
    let dec_g = NGP_DEC_J2000_DEG.to_radians();

    let (sin_th, cos_th) = theta.sin_cos();
    let (sin_b, cos_b) = b.sin_cos();
    let (sin_dg, cos_dg) = dec_g.sin_cos();

    let sin_dec = (sin_b * sin_dg + cos_b * cos_dg * cos_th).clamp(-1.0, 1.0);
    let dec_deg = sin_dec.asin().to_degrees();

    let y = cos_b * sin_th;
    let x = sin_b * cos_dg - cos_b * sin_dg * cos_th;
    let ra_deg = wrap_deg_360(NGP_RA_J2000_DEG + y.atan2(x).to_degrees());

    Equatorial { ra_deg, dec_deg }
}

/// Atmospheric refraction correction (degrees) to add to true altitude `true_alt_deg`
/// to obtain apparent altitude (Saemundsson formula, Meeus Eq. 16.4).
/// Smoothly tapers to zero below `-1°` to avoid singularities deep below the horizon.
pub fn refraction_true_to_apparent_deg(true_alt_deg: f64, pressure_hpa: f64, temp_c: f64) -> f64 {
    if true_alt_deg <= -5.0 {
        return 0.0;
    }
    let h = true_alt_deg.max(-1.0);
    let arg_deg = h + 10.3 / (h + 5.11);
    let r_arcmin = 1.02 / arg_deg.to_radians().tan();
    let pt_factor = (pressure_hpa / 1010.0) * (283.0 / (273.0 + temp_c));
    let taper = if true_alt_deg < -1.0 {
        (true_alt_deg + 5.0) / 4.0
    } else {
        1.0
    };
    (r_arcmin / 60.0) * pt_factor * taper
}

/// Atmospheric refraction correction (degrees) to subtract from apparent altitude `app_alt_deg`
/// to obtain true (airless) altitude (Bennett formula, Meeus Eq. 16.3).
/// Smoothly tapers to zero below `-1°`.
pub fn refraction_apparent_to_true_deg(app_alt_deg: f64, pressure_hpa: f64, temp_c: f64) -> f64 {
    if app_alt_deg <= -5.0 {
        return 0.0;
    }
    let h0 = app_alt_deg.max(-1.0);
    let arg_deg = h0 + 7.31 / (h0 + 4.4);
    let r_arcmin = 1.0 / arg_deg.to_radians().tan();
    let pt_factor = (pressure_hpa / 1010.0) * (283.0 / (273.0 + temp_c));
    let taper = if app_alt_deg < -1.0 {
        (app_alt_deg + 5.0) / 4.0
    } else {
        1.0
    };
    (r_arcmin / 60.0) * pt_factor * taper
}

/// Standard-atmosphere (1010 hPa, 10 °C) refraction helper: returns apparent altitude.
#[inline]
pub fn apply_standard_refraction(true_alt_deg: f64) -> f64 {
    true_alt_deg + refraction_true_to_apparent_deg(true_alt_deg, 1010.0, 10.0)
}

/// Standard-atmosphere (1010 hPa, 10 °C) inverse refraction helper: returns true altitude.
#[inline]
pub fn remove_standard_refraction(app_alt_deg: f64) -> f64 {
    app_alt_deg - refraction_apparent_to_true_deg(app_alt_deg, 1010.0, 10.0)
}

/// Numerically stable angular distance in degrees between two spherical points `(ra_deg, dec_deg)`
/// using Vincenty's spherical formula (accurate across both sub-arcsecond and antipodal separations).
pub fn angular_distance_deg(a: Equatorial, b: Equatorial) -> f64 {
    let da = (a.ra_deg - b.ra_deg).to_radians();
    let d1 = a.dec_deg.to_radians();
    let d2 = b.dec_deg.to_radians();

    let (sin_d1, cos_d1) = d1.sin_cos();
    let (sin_d2, cos_d2) = d2.sin_cos();
    let (sin_da, cos_da) = da.sin_cos();

    let term1 = cos_d2 * sin_da;
    let term2 = cos_d1 * sin_d2 - sin_d1 * cos_d2 * cos_da;
    let num = (term1 * term1 + term2 * term2).sqrt();
    let den = sin_d1 * sin_d2 + cos_d1 * cos_d2 * cos_da;

    num.atan2(den).to_degrees()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn meeus_example_13a_pollux_equatorial_ecliptic() {
        // Pollux: RA = 7h45m18.946s = 116.328942°, Dec = +28°01'34.26" = +28.026183°
        // Obliquity = 23.4392911°
        let pollux = Equatorial {
            ra_deg: 116.328_942,
            dec_deg: 28.026_183,
        };
        let eps = 23.439_291_1;
        let ecl = equatorial_to_ecliptic(pollux, eps);
        assert!(
            (ecl.lon_deg - 113.215_630).abs() < 1e-4,
            "lon={}",
            ecl.lon_deg
        );
        assert!(
            (ecl.lat_deg - 6.684_170).abs() < 1e-4,
            "lat={}",
            ecl.lat_deg
        );

        let back = ecliptic_to_equatorial(ecl, eps);
        assert!((back.ra_deg - pollux.ra_deg).abs() < 1e-9);
        assert!((back.dec_deg - pollux.dec_deg).abs() < 1e-9);
    }

    #[test]
    fn meeus_example_13b_venus_horizontal() {
        // Meeus Example 13.b: Venus at USNO (lat=+38°55'17"=38.921389°, lon=77°03'56"W)
        // 1987-04-10 19h21m00s UT => Greenwich GAST = 128.737873°, LST = 51.672317°
        // Venus: RA = 23h09m16.641s = 347.319338°, Dec = -6°43'11.61" = -6.719892°
        // Meeus result: Az from South = 68.0337° => Az from North = 248.0337°, Alt = 15.1249°
        let venus = Equatorial {
            ra_deg: 347.319_338,
            dec_deg: -6.719_892,
        };
        let lat = 38.921_389;
        let lst = 51.672_317;
        let hor = equatorial_to_horizontal(venus, lat, lst);

        assert!((hor.az_deg - 248.0337).abs() < 0.002, "az={}", hor.az_deg);
        assert!((hor.alt_deg - 15.1249).abs() < 0.002, "alt={}", hor.alt_deg);

        let back = horizontal_to_equatorial(hor, lat, lst);
        assert!((wrap_deg_180(back.ra_deg - venus.ra_deg)).abs() < 1e-9);
        assert!((back.dec_deg - venus.dec_deg).abs() < 1e-9);
    }

    #[test]
    fn galactic_roundtrip_and_sgr_a_star() {
        // Galactic Center Sgr A* J2000: RA = 266.4168°, Dec = -29.0078° -> l ~ 359.94°, b ~ -0.05°
        let sgr_a = Equatorial {
            ra_deg: 266.4168,
            dec_deg: -29.0078,
        };
        let gal = equatorial_j2000_to_galactic(sgr_a);
        assert!(wrap_deg_180(gal.l_deg).abs() < 0.15, "l={}", gal.l_deg);
        assert!(gal.b_deg.abs() < 0.15, "b={}", gal.b_deg);

        let back = galactic_to_equatorial_j2000(gal);
        assert!(angular_distance_deg(sgr_a, back) < 1e-10);
    }

    #[test]
    fn meeus_example_17a_angular_distance() {
        // Arcturus (RA=14h15m39.7s=213.9154°, Dec=+19°10'57"=19.1825°)
        // Spica    (RA=13h25m11.6s=201.2983°, Dec=-11°09'41"=-11.1614°)
        // Meeus: d = 32.7930°
        let arcturus = Equatorial {
            ra_deg: 213.915_417,
            dec_deg: 19.182_500,
        };
        let spica = Equatorial {
            ra_deg: 201.298_333,
            dec_deg: -11.161_389,
        };
        let sep = angular_distance_deg(arcturus, spica);
        assert!((sep - 32.7930).abs() < 0.001, "sep={sep}");

        // Tiny 1-arcsecond separation & antipodal 180° check
        let p1 = Equatorial {
            ra_deg: 45.0,
            dec_deg: 30.0,
        };
        let p2 = Equatorial {
            ra_deg: 45.0,
            dec_deg: 30.0 + 1.0 / 3600.0,
        };
        let tiny_arcsec = angular_distance_deg(p1, p2) * 3600.0;
        assert!((tiny_arcsec - 1.0).abs() < 1e-6);

        let antipode = Equatorial {
            ra_deg: 225.0,
            dec_deg: -30.0,
        };
        assert!((angular_distance_deg(p1, antipode) - 180.0).abs() < 1e-10);
    }

    #[test]
    fn atmospheric_refraction_horizon_and_zenith() {
        let r0 = refraction_true_to_apparent_deg(0.0, 1010.0, 10.0);
        // At 0° true altitude, refraction is roughly 28-30 arcmin (~0.48°)
        assert!(r0 > 0.45 && r0 < 0.55, "r0={r0}");
        let r90 = refraction_true_to_apparent_deg(90.0, 1010.0, 10.0);
        assert!(r90.abs() < 0.001, "r90={r90}");

        // True -> Apparent -> True consistency at 15°
        let app = apply_standard_refraction(15.0);
        let back = remove_standard_refraction(app);
        assert!((back - 15.0).abs() < 0.002, "back={back}");
    }
}
