use rayon::prelude::*;
use serde::{Deserialize, Serialize};

use crate::engine::catalog::StarCatalog;
use crate::engine::coords::{
    Equatorial, Horizontal, Vec3, angular_distance_deg, spherical_to_vec3, vec3_to_equatorial,
    wrap_deg_180, wrap_deg_360,
};
use crate::engine::ephemeris::{
    AU_KM, DwarfPlanet, LIGHT_TIME_DAYS_PER_AU, Planet, dwarf_planet_ephemeris,
    earth_helio_j2000_au, ecliptic_vec_to_equatorial_vec, equatorial_vec_to_ecliptic_vec,
    moon_ephemeris,
};
use crate::engine::precession::{J2000_JD, OBLIQUITY_J2000_DEG, star_position_3d_pc};

const EARTH_RADIUS_KM: f64 = 6_378.137;
const SUN_RADIUS_KM: f64 = 695_700.0;
const MOON_RADIUS_KM: f64 = 1_737.4;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ObserverBody {
    Mercury,
    Venus,
    Moon,
    Mars,
    Jupiter,
    Saturn,
    Uranus,
    Neptune,
}

impl ObserverBody {
    pub const fn name_ja(self) -> &'static str {
        match self {
            Self::Mercury => "水星",
            Self::Venus => "金星",
            Self::Moon => "月",
            Self::Mars => "火星",
            Self::Jupiter => "木星",
            Self::Saturn => "土星",
            Self::Uranus => "天王星",
            Self::Neptune => "海王星",
        }
    }

    /// IAU 2015 J2000 North Pole `(ra_deg, dec_deg)` and prime meridian `(w0_deg, w_dot_deg_per_day)`.
    pub const fn rotation_model(self) -> (f64, f64, f64, f64) {
        match self {
            Self::Mercury => (281.0103, 61.4155, 329.5988, 6.138_510_8),
            Self::Venus => (272.76, 67.16, 160.20, -1.481_368_8),
            Self::Moon => (269.9949, 66.5392, 38.3213, 13.176_358_15),
            Self::Mars => (317.68143, 52.88650, 176.630, 350.891_982_26),
            Self::Jupiter => (268.056595, 64.495303, 284.95, 870.536_000_0),
            Self::Saturn => (40.589, 83.537, 38.90, 810.793_902_4),
            Self::Uranus => (257.311, -15.175, 203.81, -501.160_092_8),
            Self::Neptune => (299.36, 43.46, 253.18, 536.312_849_2),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum RemoteTargetBody {
    Sun,
    Earth,
    Moon,
    Planet(Planet),
    DwarfPlanet(DwarfPlanet),
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct RemoteBodyEphemeris {
    pub eq_j2000: Equatorial,
    pub distance_au: f64,
    pub helio_au: f64,
    pub elongation_deg: f64,
    pub phase_angle_deg: f64,
    pub illuminated_fraction: f64,
    pub angular_diameter_arcsec: f64,
    pub visual_magnitude: f64,
}

fn observer_helio_j2000_ecl(observer: ObserverBody, jd_tt: f64) -> Vec3 {
    match observer {
        ObserverBody::Mercury => vsop_j2000_vec(Planet::Mercury, jd_tt),
        ObserverBody::Venus => vsop_j2000_vec(Planet::Venus, jd_tt),
        ObserverBody::Mars => vsop_j2000_vec(Planet::Mars, jd_tt),
        ObserverBody::Jupiter => vsop_j2000_vec(Planet::Jupiter, jd_tt),
        ObserverBody::Saturn => vsop_j2000_vec(Planet::Saturn, jd_tt),
        ObserverBody::Uranus => vsop_j2000_vec(Planet::Uranus, jd_tt),
        ObserverBody::Neptune => vsop_j2000_vec(Planet::Neptune, jd_tt),
        ObserverBody::Moon => {
            let earth = earth_helio_j2000_au(jd_tt);
            let m = moon_ephemeris(jd_tt);
            let moon_geo_eq = spherical_to_vec3(m.eq_j2000.ra_deg, m.eq_j2000.dec_deg, m.geo_au);
            let moon_geo_ecl = equatorial_vec_to_ecliptic_vec(moon_geo_eq, OBLIQUITY_J2000_DEG);
            earth + moon_geo_ecl
        }
    }
}

fn vsop_j2000_vec(planet: Planet, jd_tt: f64) -> Vec3 {
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

fn target_helio_j2000_ecl(target: RemoteTargetBody, jd_tt: f64) -> (Vec3, f64, f64) {
    match target {
        RemoteTargetBody::Sun => (Vec3::ZERO, SUN_RADIUS_KM, -26.74),
        RemoteTargetBody::Earth => (earth_helio_j2000_au(jd_tt), EARTH_RADIUS_KM, -3.99),
        RemoteTargetBody::Moon => (
            observer_helio_j2000_ecl(ObserverBody::Moon, jd_tt),
            MOON_RADIUS_KM,
            0.28,
        ),
        RemoteTargetBody::Planet(p) => {
            let v = vsop_j2000_vec(p, jd_tt);
            let h_mag = match p {
                Planet::Mercury => -0.42,
                Planet::Venus => -4.40,
                Planet::Mars => -1.52,
                Planet::Jupiter => -9.40,
                Planet::Saturn => -8.88,
                Planet::Uranus => -7.19,
                Planet::Neptune => -6.87,
            };
            (v, p.equatorial_radius_km(), h_mag)
        }
        RemoteTargetBody::DwarfPlanet(dp) => {
            let eph = dwarf_planet_ephemeris(dp, jd_tt);
            let h_mag = match dp {
                DwarfPlanet::Pluto => -0.7,
                DwarfPlanet::Eris => -1.17,
            };
            (eph.helio_xyz_j2000_au, dp.radius_km(), h_mag)
        }
    }
}

/// Compute position, angular size, phase, and magnitude of `target` as seen from `observer`
/// in J2000.0 equatorial coordinates at `jd_tt`.
pub fn body_from_other_planet(
    observer: ObserverBody,
    target: RemoteTargetBody,
    jd_tt: f64,
) -> RemoteBodyEphemeris {
    let obs_pos = observer_helio_j2000_ecl(observer, jd_tt);
    let obs_r = obs_pos.norm();

    let (mut tgt_pos, radius_km, h_mag) = target_helio_j2000_ecl(target, jd_tt);
    if !matches!(target, RemoteTargetBody::Sun) {
        for _ in 0..2 {
            let delta = (tgt_pos - obs_pos).norm();
            let (p, _, _) =
                target_helio_j2000_ecl(target, jd_tt - LIGHT_TIME_DAYS_PER_AU * delta);
            tgt_pos = p;
        }
    }

    let rel_ecl = tgt_pos - obs_pos;
    let distance_au = rel_ecl.norm();
    let helio_au = tgt_pos.norm();

    let rel_eq = ecliptic_vec_to_equatorial_vec(rel_ecl, OBLIQUITY_J2000_DEG);
    let eq_j2000 = vec3_to_equatorial(rel_eq);

    let sun_rel_eq = ecliptic_vec_to_equatorial_vec(obs_pos.scale(-1.0), OBLIQUITY_J2000_DEG);
    let sun_eq = vec3_to_equatorial(sun_rel_eq);
    let elongation_deg = if matches!(target, RemoteTargetBody::Sun) {
        0.0
    } else {
        angular_distance_deg(eq_j2000, sun_eq)
    };

    let (phase_angle_deg, illuminated_fraction, visual_magnitude) =
        if matches!(target, RemoteTargetBody::Sun) {
            (0.0, 1.0, -26.74 + 5.0 * distance_au.max(1e-6).log10())
        } else {
            let cos_i = ((helio_au * helio_au + distance_au * distance_au - obs_r * obs_r)
                / (2.0 * helio_au * distance_au).max(1e-12))
            .clamp(-1.0, 1.0);
            let i_deg = cos_i.acos().to_degrees();
            let illum = 0.5 * (1.0 + cos_i);
            let mag = h_mag
                + 5.0 * (helio_au * distance_au).max(1e-9).log10()
                + 0.015 * i_deg;
            (i_deg, illum, mag)
        };

    let angular_diameter_arcsec = if distance_au > 0.0 {
        2.0 * (radius_km / (distance_au * AU_KM))
            .clamp(-1.0, 1.0)
            .asin()
            .to_degrees()
            * 3600.0
    } else {
        0.0
    };

    RemoteBodyEphemeris {
        eq_j2000,
        distance_au,
        helio_au,
        elongation_deg,
        phase_angle_deg,
        illuminated_fraction,
        angular_diameter_arcsec,
        visual_magnitude,
    }
}

/// Convert J2000.0 equatorial coordinates to local `(Azimuth, Altitude)` on the surface
/// of `observer` at body-fixed planetographic `(lat_deg, lon_east_deg)` using IAU 2015 rotation.
pub fn planet_surface_to_horizontal(
    observer: ObserverBody,
    eq_j2000: Equatorial,
    lat_deg: f64,
    lon_east_deg: f64,
    jd_tt: f64,
) -> Horizontal {
    let (alpha0_deg, delta0_deg, w0_deg, w_dot) = observer.rotation_model();
    let d = jd_tt - J2000_JD;
    let w_deg = wrap_deg_360(w0_deg + w_dot * d);

    // Body-fixed basis vectors expressed in J2000 equatorial coordinates
    let n_pole = spherical_to_vec3(alpha0_deg, delta0_deg, 1.0);
    let node_dir = Vec3::new(0.0, 0.0, 1.0).cross(n_pole).normalize();
    let y_pole = n_pole.cross(node_dir).normalize();

    let star_vec = spherical_to_vec3(eq_j2000.ra_deg, eq_j2000.dec_deg, 1.0);
    let star_x_node = star_vec.dot(node_dir);
    let star_y_node = star_vec.dot(y_pole);
    let star_z_pole = star_vec.dot(n_pole);

    let dec_body = star_z_pole.clamp(-1.0, 1.0).asin().to_degrees();
    let ra_body_from_node = star_y_node.atan2(star_x_node).to_degrees();
    let ha_deg = wrap_deg_180(w_deg + lon_east_deg - ra_body_from_node);

    let ha = ha_deg.to_radians();
    let lat = lat_deg.to_radians();
    let dec = dec_body.to_radians();
    let (sin_ha, cos_ha) = ha.sin_cos();
    let (sin_lat, cos_lat) = lat.sin_cos();
    let (sin_dec, cos_dec) = dec.sin_cos();

    let alt_deg = (sin_lat * sin_dec + cos_lat * cos_dec * cos_ha)
        .clamp(-1.0, 1.0)
        .asin()
        .to_degrees();
    let az_deg = wrap_deg_360(
        (-sin_ha * cos_dec)
            .atan2(cos_lat * sin_dec - sin_lat * cos_dec * cos_ha)
            .to_degrees(),
    );

    Horizontal { az_deg, alt_deg }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReprojectedStar {
    pub star_idx: u32,
    pub hip: u32,
    pub is_sun: bool,
    pub name: String,
    pub eq_j2000: Equatorial,
    pub dist_pc: f64,
    pub mag: f32,
    pub ci: f32,
}

/// Reproject all stars up to `max_mag` as seen from another star system (`origin_hip`),
/// shifting 3D parsec coordinates, recomputing apparent magnitudes, and inserting the Sun.
pub fn reproject_stars_from_star(
    catalog: &StarCatalog,
    origin_hip: u32,
    max_mag: f32,
) -> Result<Vec<ReprojectedStar>, String> {
    let origin = catalog
        .find_by_hip(origin_hip)
        .ok_or_else(|| format!("Origin star HIP {origin_hip} not found"))?;
    if origin.dist_pc <= 0.0 {
        return Err(format!("Origin star HIP {origin_hip} has no valid distance"));
    }

    let origin_pos = star_position_3d_pc(
        f64::from(origin.ra_rad),
        f64::from(origin.dec_rad),
        f64::from(origin.dist_pc),
    );

    let mut result: Vec<ReprojectedStar> = catalog
        .stars
        .par_iter()
        .enumerate()
        .filter_map(|(idx, star)| {
            if star.hip == origin_hip {
                return None;
            }
            let (eq_j2000, dist_pc, new_mag) = if star.dist_pc > 0.0 {
                let p = star_position_3d_pc(
                    f64::from(star.ra_rad),
                    f64::from(star.dec_rad),
                    f64::from(star.dist_pc),
                );
                let rel = p - origin_pos;
                let d_new = rel.norm();
                if d_new < 1e-6 {
                    return None;
                }
                let m_abs = f64::from(star.mag) - 5.0 * (f64::from(star.dist_pc).log10() - 1.0);
                let m_new = (m_abs + 5.0 * (d_new.log10() - 1.0)) as f32;
                (vec3_to_equatorial(rel), d_new, m_new)
            } else {
                let eq = Equatorial {
                    ra_deg: f64::from(star.ra_rad).to_degrees(),
                    dec_deg: f64::from(star.dec_rad).to_degrees(),
                };
                (eq, 0.0, star.mag)
            };

            if new_mag > max_mag {
                return None;
            }

            let proper = catalog.proper_name(star);
            let name = if !proper.is_empty() {
                proper.to_string()
            } else if star.hip > 0 {
                format!("HIP {}", star.hip)
            } else {
                format!("HYG {}", star.id)
            };

            Some(ReprojectedStar {
                star_idx: idx as u32,
                hip: star.hip,
                is_sun: false,
                name,
                eq_j2000,
                dist_pc,
                mag: new_mag,
                ci: star.ci,
            })
        })
        .collect();

    // Inject the Sun (Sol, M_abs = 4.83, B-V = 0.656) at 0 - origin_pos
    let sun_rel = origin_pos.scale(-1.0);
    let sun_dist_pc = sun_rel.norm();
    let sun_mag = (4.83 + 5.0 * (sun_dist_pc.log10() - 1.0)) as f32;
    if sun_mag <= max_mag {
        result.push(ReprojectedStar {
            star_idx: u32::MAX,
            hip: 0,
            is_sun: true,
            name: "Sun (太陽)".to_string(),
            eq_j2000: vec3_to_equatorial(sun_rel),
            dist_pc: sun_dist_pc,
            mag: sun_mag,
            ci: 0.656,
        });
    }

    result.sort_by(|a, b| a.mag.total_cmp(&b.mag));
    Ok(result)
}

#[cfg(test)]
mod tests {
    use crate::engine::catalog::{CatalogStore, resolve_assets_dir};

    use super::*;

    #[test]
    fn earth_seen_from_moon_size_and_distance() {
        let earth = body_from_other_planet(ObserverBody::Moon, RemoteTargetBody::Earth, J2000_JD);
        // Mean Earth distance from Moon ~ 0.00257 AU, angular diameter ~ 1.8°..2.1°
        assert!(
            earth.distance_au > 0.0023 && earth.distance_au < 0.0028,
            "dist={}",
            earth.distance_au
        );
        let diam_deg = earth.angular_diameter_arcsec / 3600.0;
        assert!(diam_deg > 1.7 && diam_deg < 2.2, "diam_deg={diam_deg}");
    }

    #[test]
    fn sun_seen_from_alpha_centauri_is_in_cassiopeia() {
        let assets = resolve_assets_dir(None).expect("assets dir");
        let store = CatalogStore::load_from_dir(&assets).expect("catalog load");

        // Rigil Kentaurus / Alpha Centauri A: HIP 71683, RA≈219.9°, Dec≈-60.8°, dist≈1.325 pc
        // Opposite direction on sky (where the Sun appears): RA ≈ 39.9°, Dec ≈ +60.8° (Cassiopeia!), mag ≈ +0.4..+0.5
        let stars = reproject_stars_from_star(&store.stars, 71683, 6.5).expect("reprojection");
        let sun = stars.iter().find(|s| s.is_sun).expect("Sun must appear");

        assert!(
            (sun.eq_j2000.ra_deg - 39.9).abs() < 1.0,
            "sun ra={}",
            sun.eq_j2000.ra_deg
        );
        assert!(
            (sun.eq_j2000.dec_deg - 60.8).abs() < 1.0,
            "sun dec={}",
            sun.eq_j2000.dec_deg
        );
        assert!(sun.mag > 0.3 && sun.mag < 0.6, "sun mag={}", sun.mag);
    }
}
