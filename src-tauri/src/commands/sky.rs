use std::cmp::Ordering;
use std::collections::HashMap;

use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::engine::catalog::{
    AsterismEntry, CatalogStatus, CatalogStore, ConstellationEntry, ConstellationMyth, DsoEntry,
    LocationPreset, MeteorShower, MilkyWayLevel, StarGuide, VariableStar,
};
use crate::engine::comet::{CometElements, comet_ephemeris};
use crate::engine::comet_db::CometDb;
use crate::engine::coords::{
    Equatorial, Horizontal, Vec3, angular_distance_deg, apply_standard_refraction,
    equatorial_to_horizontal, equatorial_to_vec3, horizontal_to_equatorial,
    remove_standard_refraction, vec3_to_equatorial, wrap_deg_360,
};
use crate::engine::ephemeris::{
    DwarfPlanet, Planet, dwarf_planet_ephemeris, geocentric_to_topocentric, moon_ephemeris,
    planet_ephemeris, saturn_ring_tilt_deg, sun_ephemeris,
};
use crate::engine::other_planet::{
    ObserverBody, RemoteTargetBody, body_from_other_planet, planet_surface_to_horizontal,
    reproject_stars_from_star,
};
use crate::engine::precession::{
    J2000_JD, apply_nutation_to_equatorial, north_celestial_pole_j2000, nutation,
    precess_j2000_to_date, propagate_proper_motion, south_celestial_pole_j2000,
    star_position_3d_pc,
};
use crate::engine::projection::{ProjectionParams, horizontal_to_enu_vec, unproject_screen};
use crate::engine::rise_set::{
    ObserverLocation, RiseSetStatus, TwilightTimes, equatorial_j2000_rise_set, moon_rise_set,
    planet_rise_set, sun_rise_set, sun_twilight,
};
use crate::engine::sky_color::{Rgb, SkyColorInput, SkyPalette, compute_sky_palette};
use crate::engine::time::{
    gmst_deg, jd_to_ymd_hms, last_deg, lst_deg, now_utc_jd, ut_to_tt_jd,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkyViewMode {
    #[default]
    Normal,
    Precession,
    ProperMotion,
    OtherPlanet,
    OtherStar,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PoleTrackPoint {
    pub year: i32,
    pub ra_deg: f64,
    pub dec_deg: f64,
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SolFromStarInfo {
    pub ra_deg: f64,
    pub dec_deg: f64,
    pub mag: f64,
    pub dist_ly: f64,
    pub origin_name: String,
}

#[tauri::command]
pub fn get_catalog_status(store: State<'_, CatalogStore>) -> CatalogStatus {
    store.status()
}

fn pack_star_vecs_to_bytes(entries: &[(Vec3, f32, f32)]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(entries.len() * 20);
    for &(v, mag, ci) in entries {
        bytes.extend_from_slice(&(v.x as f32).to_le_bytes());
        bytes.extend_from_slice(&(v.y as f32).to_le_bytes());
        bytes.extend_from_slice(&(v.z as f32).to_le_bytes());
        bytes.extend_from_slice(&mag.to_le_bytes());
        bytes.extend_from_slice(&ci.to_le_bytes());
    }
    bytes
}

/// Pack all stars sorted by magnitude ascending into little-endian `f32`
/// quintuples `[x_j2000, y_j2000, z_j2000, mag, ci]` (20 bytes/star).
pub fn build_sky_star_bytes(store: &CatalogStore) -> Vec<u8> {
    let stars = &store.stars.stars;
    let mut order: Vec<usize> = (0..stars.len()).collect();
    order.sort_unstable_by(|&a, &b| stars[a].mag.total_cmp(&stars[b].mag));

    let mut bytes = Vec::with_capacity(stars.len() * 20);
    for idx in order {
        let s = &stars[idx];
        let (sd, cd) = f64::from(s.dec_rad).sin_cos();
        let (sr, cr) = f64::from(s.ra_rad).sin_cos();
        let x = (cd * cr) as f32;
        let y = (cd * sr) as f32;
        let z = sd as f32;
        bytes.extend_from_slice(&x.to_le_bytes());
        bytes.extend_from_slice(&y.to_le_bytes());
        bytes.extend_from_slice(&z.to_le_bytes());
        bytes.extend_from_slice(&s.mag.to_le_bytes());
        bytes.extend_from_slice(&s.ci.to_le_bytes());
    }
    bytes
}

/// Return all stars sorted by magnitude ascending, packed as little-endian `f32`
/// quintuples `[x_j2000, y_j2000, z_j2000, mag, ci]` (20 bytes/star).
#[tauri::command]
pub fn get_sky_star_buffer(store: State<'_, CatalogStore>) -> tauri::ipc::Response {
    tauri::ipc::Response::new(build_sky_star_bytes(&store))
}

fn dso_kind_code(obj_type: &str) -> f32 {
    if obj_type == "GC" || obj_type == "GCl" {
        1.0
    } else if matches!(obj_type, "OC" | "OCl" | "*Ass" | "Cl+N") {
        2.0
    } else if obj_type == "PN" {
        3.0
    } else if obj_type.contains('G') {
        0.0
    } else if matches!(
        obj_type,
        "HII" | "Neb" | "EmN" | "RfN" | "SNR" | "DrkN" | "EN" | "RN"
    ) {
        4.0
    } else {
        5.0
    }
}

/// Pack all DSO entries (~13,000+) sorted with Messier first then magnitude ascending into
/// little-endian `f32` septuples `[x_j2000, y_j2000, z_j2000, mag, maj_ax_arcmin, kind_code, messier_num]`.
pub fn build_sky_dso_bytes(store: &CatalogStore) -> Vec<u8> {
    let mut order: Vec<usize> = (0..store.dsos.len()).collect();
    order.sort_unstable_by(|&a, &b| {
        let da = &store.dsos[a];
        let db = &store.dsos[b];
        match (da.messier, db.messier) {
            (Some(ma), Some(mb)) => ma.cmp(&mb),
            (Some(_), None) => Ordering::Less,
            (None, Some(_)) => Ordering::Greater,
            (None, None) => da.mag.unwrap_or(99.0).total_cmp(&db.mag.unwrap_or(99.0)),
        }
    });

    let mut bytes = Vec::with_capacity(order.len() * 28);
    for idx in order {
        let d = &store.dsos[idx];
        let (sd, cd) = d.dec_deg.to_radians().sin_cos();
        let (sr, cr) = d.ra_deg.to_radians().sin_cos();
        let x = (cd * cr) as f32;
        let y = (cd * sr) as f32;
        let z = sd as f32;
        let mag = d.mag.unwrap_or(14.5);
        let maj = d.maj_ax_arcmin.unwrap_or(6.0);
        let kind = dso_kind_code(&d.obj_type);
        let messier_num = d.messier.map_or(0.0, f32::from);
        bytes.extend_from_slice(&x.to_le_bytes());
        bytes.extend_from_slice(&y.to_le_bytes());
        bytes.extend_from_slice(&z.to_le_bytes());
        bytes.extend_from_slice(&mag.to_le_bytes());
        bytes.extend_from_slice(&maj.to_le_bytes());
        bytes.extend_from_slice(&kind.to_le_bytes());
        bytes.extend_from_slice(&messier_num.to_le_bytes());
    }
    bytes
}

/// Binary IPC buffer of all 13,000+ DSOs for fast spatial-culled canvas rendering.
#[tauri::command]
pub fn get_sky_dso_buffer(store: State<'_, CatalogStore>) -> tauri::ipc::Response {
    tauri::ipc::Response::new(build_sky_dso_bytes(&store))
}

pub fn build_proper_motion_star_bytes(
    store: &CatalogStore,
    years_from_j2000: f64,
    max_mag: f32,
) -> Vec<u8> {
    let dt_years = years_from_j2000.clamp(-100_000.0, 100_000.0);
    let mut moved: Vec<(Vec3, f32, f32)> = store
        .stars
        .stars
        .par_iter()
        .filter(|s| s.mag <= max_mag)
        .map(|s| {
            let (eq_new, _) = propagate_proper_motion(
                f64::from(s.ra_rad),
                f64::from(s.dec_rad),
                f64::from(s.pm_ra),
                f64::from(s.pm_dec),
                f64::from(s.dist_pc),
                dt_years,
            );
            (equatorial_to_vec3(eq_new), s.mag, s.ci)
        })
        .collect();
    moved.sort_unstable_by(|a, b| a.1.total_cmp(&b.1));
    pack_star_vecs_to_bytes(&moved)
}

#[tauri::command]
pub fn get_proper_motion_star_buffer(
    years_from_j2000: f64,
    max_mag: f32,
    store: State<'_, CatalogStore>,
) -> tauri::ipc::Response {
    tauri::ipc::Response::new(build_proper_motion_star_bytes(
        &store,
        years_from_j2000,
        max_mag,
    ))
}

pub fn build_reprojected_star_bytes(
    store: &CatalogStore,
    origin_hip: u32,
    max_mag: f32,
) -> Result<Vec<u8>, String> {
    let stars = reproject_stars_from_star(&store.stars, origin_hip, max_mag)?;
    let mut vecs: Vec<(Vec3, f32, f32)> = stars
        .into_iter()
        .map(|s| (equatorial_to_vec3(s.eq_j2000), s.mag, s.ci))
        .collect();
    vecs.sort_unstable_by(|a, b| a.1.total_cmp(&b.1));
    Ok(pack_star_vecs_to_bytes(&vecs))
}

#[tauri::command]
pub fn get_reprojected_star_buffer(
    origin_hip: u32,
    max_mag: f32,
    store: State<'_, CatalogStore>,
) -> Result<tauri::ipc::Response, String> {
    let bytes = build_reprojected_star_bytes(&store, origin_hip, max_mag)?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[derive(Debug, Clone, Serialize)]
pub struct NamedStarAsset {
    pub hip: u32,
    pub proper_name: String,
    pub name_ja: Option<String>,
    pub bayer: String,
    pub flam_num: u16,
    pub con: String,
    pub ra_deg: f64,
    pub dec_deg: f64,
    pub mag: f32,
    pub ci: f32,
    pub dist_pc: f32,
}

#[derive(Debug, Clone, Serialize)]
pub struct SkyStaticAssets {
    pub named_stars: Vec<NamedStarAsset>,
    pub dsos: Vec<DsoEntry>,
    pub constellations: Vec<ConstellationEntry>,
    pub asterisms: Vec<AsterismEntry>,
    pub milky_way: Vec<MilkyWayLevel>,
    pub locations: Vec<LocationPreset>,
    pub meteor_showers: Vec<MeteorShower>,
    pub star_guides: Vec<StarGuide>,
    pub variable_stars: Vec<VariableStar>,
    pub constellation_myths: Vec<ConstellationMyth>,
}

#[tauri::command]
pub fn get_sky_static_assets(store: State<'_, CatalogStore>) -> SkyStaticAssets {
    let mut ja_by_hip: HashMap<u32, &str> = HashMap::with_capacity(store.star_guides.len());
    for g in &store.star_guides {
        ja_by_hip.insert(g.hip, g.name_ja.as_str());
    }

    let mut named_stars = Vec::with_capacity(3_600);
    for star in &store.stars.stars {
        let proper = store.stars.proper_name(star);
        let guide_ja = if star.hip > 0 {
            ja_by_hip.get(&star.hip).copied()
        } else {
            None
        };
        if star.mag <= 5.5 || !proper.is_empty() || guide_ja.is_some() {
            named_stars.push(NamedStarAsset {
                hip: star.hip,
                proper_name: proper.to_owned(),
                name_ja: guide_ja.map(str::to_owned),
                bayer: store.stars.bayer(star).to_owned(),
                flam_num: star.flam_num,
                con: store.stars.constellation_code(star).unwrap_or("").to_owned(),
                ra_deg: wrap_deg_360(f64::from(star.ra_rad).to_degrees()),
                dec_deg: f64::from(star.dec_rad).to_degrees(),
                mag: star.mag,
                ci: star.ci,
                dist_pc: star.dist_pc,
            });
        }
    }
    named_stars.sort_by(|a, b| a.mag.total_cmp(&b.mag));

    let mut dsos: Vec<DsoEntry> = store
        .dsos
        .iter()
        .filter(|d| d.messier.is_some() || d.mag.unwrap_or(99.0) <= 10.5)
        .cloned()
        .collect();
    dsos.sort_by(|a, b| match (a.messier, b.messier) {
        (Some(ma), Some(mb)) => ma.cmp(&mb),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => a.mag.unwrap_or(99.0).total_cmp(&b.mag.unwrap_or(99.0)),
    });

    SkyStaticAssets {
        named_stars,
        dsos,
        constellations: store.constellations.clone(),
        asterisms: store.asterisms.clone(),
        milky_way: store.milky_way.clone(),
        locations: store.locations.clone(),
        meteor_showers: store.meteor_showers.clone(),
        star_guides: store.star_guides.clone(),
        variable_stars: store.variable_stars.clone(),
        constellation_myths: store.constellation_myths.clone(),
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct SkyFrameRequest {
    pub jd_ut: Option<f64>,
    pub lat_deg: f64,
    pub lon_deg: f64,
    pub alt_m: f64,
    pub tz_offset_min: i32,
    pub limiting_mag: f64,
    pub realism_level: u8,
    pub night_vision: bool,
    pub refraction: bool,
    #[serde(default)]
    pub view_mode: SkyViewMode,
    #[serde(default)]
    pub observer_body: Option<ObserverBody>,
    #[serde(default)]
    pub origin_star_hip: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LocalDateTimeParts {
    pub year: i32,
    pub month: u8,
    pub day: u8,
    pub hour: u8,
    pub minute: u8,
    pub second: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct SolarSystemBodyRender {
    pub id: String,
    pub kind: String,
    pub name_ja: String,
    pub name_en: String,
    pub ra_deg: f64,
    pub dec_deg: f64,
    pub az_deg: f64,
    pub alt_deg: f64,
    pub geo_au: f64,
    pub helio_au: f64,
    pub visual_magnitude: f64,
    pub angular_diameter_arcsec: f64,
    pub illuminated_fraction: f64,
    pub phase_angle_deg: f64,
    pub elongation_deg: f64,
    pub moon_age_days: Option<f64>,
    pub bright_limb_pa_deg: Option<f64>,
    pub saturn_ring_tilt_deg: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SkyFrame {
    pub jd_ut: f64,
    pub jd_tt: f64,
    pub gmst_deg: f64,
    pub lst_deg: f64,
    pub last_deg: f64,
    pub obliquity_deg: f64,
    pub local_dt: LocalDateTimeParts,
    pub view_mode: SkyViewMode,
    pub j2000_to_apparent_matrix: [[f64; 3]; 3],
    pub j2000_to_enu_override: Option<[[f64; 3]; 3]>,
    pub pole_track_north: Vec<PoleTrackPoint>,
    pub pole_track_south: Vec<PoleTrackPoint>,
    pub sol_from_other_star: Option<SolFromStarInfo>,
    pub bodies: Vec<SolarSystemBodyRender>,
    pub sky_palette: SkyPalette,
}

fn j2000_to_apparent_matrix_internal(jd_tt: f64) -> ([[f64; 3]; 3], f64) {
    let nut = nutation(jd_tt);
    let xform = |ra_deg: f64, dec_deg: f64| -> Vec3 {
        let eq = Equatorial { ra_deg, dec_deg };
        let mean_date = precess_j2000_to_date(eq, jd_tt);
        let app = apply_nutation_to_equatorial(mean_date, &nut);
        equatorial_to_vec3(app)
    };
    let c0 = xform(0.0, 0.0);
    let c1 = xform(90.0, 0.0);
    let c2 = xform(0.0, 90.0);
    let m = [
        [c0.x, c1.x, c2.x],
        [c0.y, c1.y, c2.y],
        [c0.z, c1.z, c2.z],
    ];
    (m, nut.true_obliquity_deg)
}

#[inline]
fn mat3_mul_vec(m: &[[f64; 3]; 3], v: Vec3) -> Vec3 {
    Vec3::new(
        m[0][0] * v.x + m[0][1] * v.y + m[0][2] * v.z,
        m[1][0] * v.x + m[1][1] * v.y + m[1][2] * v.z,
        m[2][0] * v.x + m[2][1] * v.y + m[2][2] * v.z,
    )
}

#[inline]
fn mat3_transpose_mul_vec(m: &[[f64; 3]; 3], v: Vec3) -> Vec3 {
    Vec3::new(
        m[0][0] * v.x + m[1][0] * v.y + m[2][0] * v.z,
        m[0][1] * v.x + m[1][1] * v.y + m[2][1] * v.z,
        m[0][2] * v.x + m[1][2] * v.y + m[2][2] * v.z,
    )
}

fn moon_bright_limb_pa_deg(sun: Equatorial, moon: Equatorial) -> f64 {
    let dm = moon.dec_deg.to_radians();
    let ds = sun.dec_deg.to_radians();
    let da = (sun.ra_deg - moon.ra_deg).to_radians();
    let y = ds.cos() * da.sin();
    let x = dm.cos() * ds.sin() - dm.sin() * ds.cos() * da.cos();
    wrap_deg_360(y.atan2(x).to_degrees())
}

fn body_to_hor(
    eq_app: Equatorial,
    geo_au: f64,
    req: &SkyFrameRequest,
    last: f64,
) -> Horizontal {
    let topo = geocentric_to_topocentric(eq_app, geo_au, req.lat_deg, req.alt_m, last);
    let mut hor = equatorial_to_horizontal(topo, req.lat_deg, last);
    if req.refraction {
        hor.alt_deg = apply_standard_refraction(hor.alt_deg);
    }
    hor
}

fn build_solar_system_bodies(
    req: &SkyFrameRequest,
    jd_tt: f64,
    last: f64,
    comets: &[CometElements],
) -> Vec<SolarSystemBodyRender> {
    let mut bodies = Vec::with_capacity(11 + comets.len());

    let sun = sun_ephemeris(jd_tt);
    let sun_hor = body_to_hor(sun.eq_apparent, sun.geo_au, req, last);
    bodies.push(SolarSystemBodyRender {
        id: "sun".into(),
        kind: "sun".into(),
        name_ja: "太陽".into(),
        name_en: "Sun".into(),
        ra_deg: sun.eq_apparent.ra_deg,
        dec_deg: sun.eq_apparent.dec_deg,
        az_deg: sun_hor.az_deg,
        alt_deg: sun_hor.alt_deg,
        geo_au: sun.geo_au,
        helio_au: sun.helio_au,
        visual_magnitude: sun.visual_magnitude,
        angular_diameter_arcsec: sun.angular_diameter_arcsec,
        illuminated_fraction: sun.illuminated_fraction,
        phase_angle_deg: sun.phase_angle_deg,
        elongation_deg: sun.elongation_deg,
        moon_age_days: None,
        bright_limb_pa_deg: None,
        saturn_ring_tilt_deg: None,
    });

    let moon = moon_ephemeris(jd_tt);
    let moon_hor = body_to_hor(moon.eq_apparent, moon.geo_au, req, last);
    bodies.push(SolarSystemBodyRender {
        id: "moon".into(),
        kind: "moon".into(),
        name_ja: "月".into(),
        name_en: "Moon".into(),
        ra_deg: moon.eq_apparent.ra_deg,
        dec_deg: moon.eq_apparent.dec_deg,
        az_deg: moon_hor.az_deg,
        alt_deg: moon_hor.alt_deg,
        geo_au: moon.geo_au,
        helio_au: 1.0,
        visual_magnitude: moon.visual_magnitude,
        angular_diameter_arcsec: moon.angular_diameter_arcsec,
        illuminated_fraction: moon.illuminated_fraction,
        phase_angle_deg: moon.phase_angle_deg,
        elongation_deg: moon.elongation_deg,
        moon_age_days: Some(moon.age_days),
        bright_limb_pa_deg: Some(moon_bright_limb_pa_deg(sun.eq_apparent, moon.eq_apparent)),
        saturn_ring_tilt_deg: None,
    });

    let planets: [(Planet, &str, &str, &str); 7] = [
        (Planet::Mercury, "mercury", "水星", "Mercury"),
        (Planet::Venus, "venus", "金星", "Venus"),
        (Planet::Mars, "mars", "火星", "Mars"),
        (Planet::Jupiter, "jupiter", "木星", "Jupiter"),
        (Planet::Saturn, "saturn", "土星", "Saturn"),
        (Planet::Uranus, "uranus", "天王星", "Uranus"),
        (Planet::Neptune, "neptune", "海王星", "Neptune"),
    ];

    for (planet, id, name_ja, name_en) in planets {
        let eph = planet_ephemeris(planet, jd_tt);
        let hor = body_to_hor(eph.eq_apparent, eph.geo_au, req, last);
        let ring_tilt = if matches!(planet, Planet::Saturn) {
            Some(saturn_ring_tilt_deg(eph.geo_xyz_j2000_au))
        } else {
            None
        };
        bodies.push(SolarSystemBodyRender {
            id: id.into(),
            kind: "planet".into(),
            name_ja: name_ja.into(),
            name_en: name_en.into(),
            ra_deg: eph.eq_apparent.ra_deg,
            dec_deg: eph.eq_apparent.dec_deg,
            az_deg: hor.az_deg,
            alt_deg: hor.alt_deg,
            geo_au: eph.geo_au,
            helio_au: eph.helio_au,
            visual_magnitude: eph.visual_magnitude,
            angular_diameter_arcsec: eph.angular_diameter_arcsec,
            illuminated_fraction: eph.illuminated_fraction,
            phase_angle_deg: eph.phase_angle_deg,
            elongation_deg: eph.elongation_deg,
            moon_age_days: None,
            bright_limb_pa_deg: None,
            saturn_ring_tilt_deg: ring_tilt,
        });
    }

    for (dwarf, id, name_ja, name_en) in [
        (DwarfPlanet::Pluto, "pluto", "冥王星", "Pluto"),
        (DwarfPlanet::Eris, "eris", "エリス", "Eris"),
    ] {
        let eph = dwarf_planet_ephemeris(dwarf, jd_tt);
        let hor = body_to_hor(eph.eq_apparent, eph.geo_au, req, last);
        bodies.push(SolarSystemBodyRender {
            id: id.into(),
            kind: "dwarf_planet".into(),
            name_ja: name_ja.into(),
            name_en: name_en.into(),
            ra_deg: eph.eq_apparent.ra_deg,
            dec_deg: eph.eq_apparent.dec_deg,
            az_deg: hor.az_deg,
            alt_deg: hor.alt_deg,
            geo_au: eph.geo_au,
            helio_au: eph.helio_au,
            visual_magnitude: eph.visual_magnitude,
            angular_diameter_arcsec: eph.angular_diameter_arcsec,
            illuminated_fraction: eph.illuminated_fraction,
            phase_angle_deg: eph.phase_angle_deg,
            elongation_deg: eph.elongation_deg,
            moon_age_days: None,
            bright_limb_pa_deg: None,
            saturn_ring_tilt_deg: None,
        });
    }

    for comet in comets {
        let ce = comet_ephemeris(comet, jd_tt);
        let hor = body_to_hor(ce.eq_apparent, ce.geo_au, req, last);
        let anti_sun_pa = wrap_deg_360(moon_bright_limb_pa_deg(sun.eq_apparent, ce.eq_apparent) + 180.0);
        bodies.push(SolarSystemBodyRender {
            id: comet.id.clone(),
            kind: "comet".into(),
            name_ja: comet.name.clone(),
            name_en: comet.name.clone(),
            ra_deg: ce.eq_apparent.ra_deg,
            dec_deg: ce.eq_apparent.dec_deg,
            az_deg: hor.az_deg,
            alt_deg: hor.alt_deg,
            geo_au: ce.geo_au,
            helio_au: ce.helio_au,
            visual_magnitude: ce.visual_magnitude,
            angular_diameter_arcsec: (120.0 / ce.geo_au.max(0.2)).clamp(8.0, 240.0),
            illuminated_fraction: 1.0,
            phase_angle_deg: ce.phase_angle_deg,
            elongation_deg: ce.elongation_deg,
            moon_age_days: None,
            bright_limb_pa_deg: Some(anti_sun_pa),
            saturn_ring_tilt_deg: None,
        });
    }

    bodies
}

fn j2000_to_other_planet_enu_matrix(
    obs: ObserverBody,
    jd_tt: f64,
    lat_deg: f64,
    lon_deg: f64,
) -> [[f64; 3]; 3] {
    let xform = |ra_deg: f64, dec_deg: f64| -> Vec3 {
        let hor =
            planet_surface_to_horizontal(obs, Equatorial { ra_deg, dec_deg }, lat_deg, lon_deg, jd_tt);
        horizontal_to_enu_vec(hor)
    };
    let c0 = xform(0.0, 0.0);
    let c1 = xform(90.0, 0.0);
    let c2 = xform(0.0, 90.0);
    [
        [c0.x, c1.x, c2.x],
        [c0.y, c1.y, c2.y],
        [c0.z, c1.z, c2.z],
    ]
}

fn build_other_planet_bodies(
    obs: ObserverBody,
    req: &SkyFrameRequest,
    jd_tt: f64,
) -> Vec<SolarSystemBodyRender> {
    let mut list: Vec<(RemoteTargetBody, &str, &str, &str, &str)> = vec![
        (RemoteTargetBody::Sun, "sun", "sun", "太陽", "Sun"),
        (RemoteTargetBody::Earth, "planet", "earth", "地球", "Earth"),
    ];
    if !matches!(obs, ObserverBody::Moon) {
        list.push((RemoteTargetBody::Moon, "moon", "moon", "月", "Moon"));
    }

    let planet_defs: [(ObserverBody, Planet, &str, &str, &str); 7] = [
        (ObserverBody::Mercury, Planet::Mercury, "mercury", "水星", "Mercury"),
        (ObserverBody::Venus, Planet::Venus, "venus", "金星", "Venus"),
        (ObserverBody::Mars, Planet::Mars, "mars", "火星", "Mars"),
        (ObserverBody::Jupiter, Planet::Jupiter, "jupiter", "木星", "Jupiter"),
        (ObserverBody::Saturn, Planet::Saturn, "saturn", "土星", "Saturn"),
        (ObserverBody::Uranus, Planet::Uranus, "uranus", "天王星", "Uranus"),
        (ObserverBody::Neptune, Planet::Neptune, "neptune", "海王星", "Neptune"),
    ];
    for (o, p, id, name_ja, name_en) in planet_defs {
        if o != obs {
            list.push((RemoteTargetBody::Planet(p), "planet", id, name_ja, name_en));
        }
    }
    list.push((
        RemoteTargetBody::DwarfPlanet(DwarfPlanet::Pluto),
        "dwarf_planet",
        "pluto",
        "冥王星",
        "Pluto",
    ));
    list.push((
        RemoteTargetBody::DwarfPlanet(DwarfPlanet::Eris),
        "dwarf_planet",
        "eris",
        "エリス",
        "Eris",
    ));

    let mut bodies = Vec::with_capacity(list.len());
    for (target, kind, id, name_ja, name_en) in list {
        let eph = body_from_other_planet(obs, target, jd_tt);
        let hor =
            planet_surface_to_horizontal(obs, eph.eq_j2000, req.lat_deg, req.lon_deg, jd_tt);
        bodies.push(SolarSystemBodyRender {
            id: id.into(),
            kind: kind.into(),
            name_ja: name_ja.into(),
            name_en: name_en.into(),
            ra_deg: eph.eq_j2000.ra_deg,
            dec_deg: eph.eq_j2000.dec_deg,
            az_deg: hor.az_deg,
            alt_deg: hor.alt_deg,
            geo_au: eph.distance_au,
            helio_au: eph.helio_au,
            visual_magnitude: eph.visual_magnitude,
            angular_diameter_arcsec: eph.angular_diameter_arcsec,
            illuminated_fraction: eph.illuminated_fraction,
            phase_angle_deg: eph.phase_angle_deg,
            elongation_deg: eph.elongation_deg,
            moon_age_days: None,
            bright_limb_pa_deg: None,
            saturn_ring_tilt_deg: matches!(target, RemoteTargetBody::Planet(Planet::Saturn))
                .then_some(14.0),
        });
    }
    bodies
}

fn adjust_palette_for_body(
    obs: ObserverBody,
    sun_alt_deg: f64,
    realism_level: u8,
    night_vision: bool,
) -> SkyPalette {
    let red = |c: Rgb| -> Rgb {
        if !night_vision {
            return c;
        }
        let luma = 0.299 * f64::from(c.r) + 0.587 * f64::from(c.g) + 0.114 * f64::from(c.b);
        Rgb::new((luma * 0.85).round().clamp(0.0, 210.0) as u8, 0, 0)
    };
    let day = (sun_alt_deg / 18.0 + 0.35).clamp(0.0, 1.0);
    if realism_level == 0 || matches!(obs, ObserverBody::Moon | ObserverBody::Mercury) {
        let g = if matches!(obs, ObserverBody::Moon) {
            Rgb::new(26, 26, 28)
        } else {
            Rgb::new(32, 28, 25)
        };
        return SkyPalette {
            zenith: red(Rgb::new(2, 4, 10)),
            mid_sky: red(Rgb::new(3, 5, 12)),
            horizon: red(Rgb::new(5, 8, 16)),
            sun_glow: red(Rgb::new(0, 0, 0)),
            sun_glow_strength: 0.0,
            anti_solar_glow: red(Rgb::new(0, 0, 0)),
            anti_solar_strength: 0.0,
            moonlight_glow: red(Rgb::new(0, 0, 0)),
            moonlight_strength: 0.0,
            light_pollution: red(Rgb::new(0, 0, 0)),
            light_pollution_strength: 0.0,
            ground: red(g),
            horizon_line: red(Rgb::new(72, 74, 82)),
            star_visibility_factor: 1.0,
            estimated_bortle: 1,
        };
    }

    let (z, m, h, g, glow) = match obs {
        ObserverBody::Mars => (
            Rgb::new((4.0 + 54.0 * day) as u8, (6.0 + 34.0 * day) as u8, (14.0 + 28.0 * day) as u8),
            Rgb::new((6.0 + 96.0 * day) as u8, (10.0 + 58.0 * day) as u8, (20.0 + 42.0 * day) as u8),
            Rgb::new((12.0 + 148.0 * day) as u8, (16.0 + 90.0 * day) as u8, (26.0 + 56.0 * day) as u8),
            Rgb::new(64, 30, 18),
            Rgb::new(105, 152, 210), // Mars sunsets are cool-bluish around the Sun
        ),
        ObserverBody::Venus => (
            Rgb::new((6.0 + 118.0 * day) as u8, (8.0 + 86.0 * day) as u8, (16.0 + 34.0 * day) as u8),
            Rgb::new((10.0 + 168.0 * day) as u8, (12.0 + 126.0 * day) as u8, (22.0 + 54.0 * day) as u8),
            Rgb::new((16.0 + 196.0 * day) as u8, (18.0 + 150.0 * day) as u8, (28.0 + 70.0 * day) as u8),
            Rgb::new(58, 42, 20),
            Rgb::new(240, 184, 96),
        ),
        _ => (
            Rgb::new((4.0 + 14.0 * day) as u8, (8.0 + 46.0 * day) as u8, (18.0 + 94.0 * day) as u8),
            Rgb::new((8.0 + 24.0 * day) as u8, (14.0 + 68.0 * day) as u8, (30.0 + 128.0 * day) as u8),
            Rgb::new((14.0 + 44.0 * day) as u8, (22.0 + 96.0 * day) as u8, (42.0 + 148.0 * day) as u8),
            Rgb::new(14, 24, 42),
            Rgb::new(120, 195, 245),
        ),
    };

    SkyPalette {
        zenith: red(z),
        mid_sky: red(m),
        horizon: red(h),
        sun_glow: red(glow),
        sun_glow_strength: if sun_alt_deg > -12.0 && sun_alt_deg < 14.0 {
            0.55
        } else {
            0.0
        },
        anti_solar_glow: red(Rgb::new(0, 0, 0)),
        anti_solar_strength: 0.0,
        moonlight_glow: red(Rgb::new(0, 0, 0)),
        moonlight_strength: 0.0,
        light_pollution: red(Rgb::new(0, 0, 0)),
        light_pollution_strength: 0.0,
        ground: red(g),
        horizon_line: red(Rgb::new(120, 108, 96)),
        star_visibility_factor: (1.0 - 0.72 * day).clamp(0.25, 1.0),
        estimated_bortle: 1,
    }
}

fn build_pole_tracks() -> (Vec<PoleTrackPoint>, Vec<PoleTrackPoint>) {
    let label_for_north = |yr: i32| -> Option<String> {
        match yr {
            -13000 => Some("BC13000 ベガ付近".into()),
            -3000 => Some("BC3000 トゥバン".into()),
            2000 => Some("2000 ポラリス".into()),
            7500 => Some("7500 アルデラミン".into()),
            14000 => Some("14000 ベガ".into()),
            _ => (yr % 5000 == 0).then(|| format!("{yr}年")),
        }
    };

    let mut north = Vec::with_capacity(61);
    let mut south = Vec::with_capacity(61);
    for yr in (-15_000..=15_000).step_by(500) {
        let jd = J2000_JD + (f64::from(yr) - 2_000.0) * 365.25;
        let np = north_celestial_pole_j2000(jd);
        let sp = south_celestial_pole_j2000(jd);
        north.push(PoleTrackPoint {
            year: yr,
            ra_deg: np.ra_deg,
            dec_deg: np.dec_deg,
            label: label_for_north(yr),
        });
        south.push(PoleTrackPoint {
            year: yr,
            ra_deg: sp.ra_deg,
            dec_deg: sp.dec_deg,
            label: (yr % 5000 == 0).then(|| format!("{yr}年")),
        });
    }
    (north, south)
}

pub fn compute_sky_frame_impl(
    req: SkyFrameRequest,
    store: Option<&CatalogStore>,
    comets: &[CometElements],
) -> SkyFrame {
    let jd_ut = req.jd_ut.unwrap_or_else(now_utc_jd);
    let jd_tt = ut_to_tt_jd(jd_ut);
    let gmst = gmst_deg(jd_ut);
    let lst = lst_deg(jd_ut, req.lon_deg);
    let last = last_deg(jd_ut, req.lon_deg);
    let (j2000_to_apparent_matrix, obliquity_deg) = j2000_to_apparent_matrix_internal(jd_tt);
    let (year, month, day, hour, minute, second) =
        jd_to_ymd_hms(jd_ut + f64::from(req.tz_offset_min) / 1440.0);

    let (j2000_to_enu_override, bodies, sky_palette) =
        if req.view_mode == SkyViewMode::OtherPlanet {
            let obs = req.observer_body.unwrap_or(ObserverBody::Mars);
            let mat = j2000_to_other_planet_enu_matrix(obs, jd_tt, req.lat_deg, req.lon_deg);
            let b = build_other_planet_bodies(obs, &req, jd_tt);
            let sun_alt = b.first().map(|s| s.alt_deg).unwrap_or(-30.0);
            let pal =
                adjust_palette_for_body(obs, sun_alt, req.realism_level, req.night_vision);
            (Some(mat), b, pal)
        } else {
            let b = build_solar_system_bodies(&req, jd_tt, last, comets);
            let sun_b = &b[0];
            let moon_b = &b[1];
            let pal = compute_sky_palette(&SkyColorInput {
                sun_alt_deg: sun_b.alt_deg,
                sun_az_deg: sun_b.az_deg,
                moon_alt_deg: moon_b.alt_deg,
                moon_az_deg: moon_b.az_deg,
                moon_illuminated_fraction: moon_b.illuminated_fraction,
                limiting_mag: req.limiting_mag,
                realism_level: req.realism_level,
                night_vision: req.night_vision,
            });
            (None, b, pal)
        };

    let (pole_track_north, pole_track_south) = if req.view_mode == SkyViewMode::Precession {
        build_pole_tracks()
    } else {
        (Vec::new(), Vec::new())
    };

    let sol_from_other_star = if req.view_mode == SkyViewMode::OtherStar {
        let origin_hip = req.origin_star_hip.unwrap_or(71_683);
        store.and_then(|cat| {
            cat.stars.find_by_hip(origin_hip).and_then(|star| {
                if star.dist_pc <= 0.0 {
                    return None;
                }
                let pos = star_position_3d_pc(
                    f64::from(star.ra_rad),
                    f64::from(star.dec_rad),
                    f64::from(star.dist_pc),
                );
                let sol_eq = vec3_to_equatorial(pos.scale(-1.0));
                let dist_pc = f64::from(star.dist_pc);
                let sol_mag = 4.83 + 5.0 * (dist_pc.log10() - 1.0);
                let origin_name = {
                    let proper = cat.stars.proper_name(star);
                    if !proper.is_empty() {
                        proper.to_owned()
                    } else {
                        format!("HIP {origin_hip}")
                    }
                };
                Some(SolFromStarInfo {
                    ra_deg: sol_eq.ra_deg,
                    dec_deg: sol_eq.dec_deg,
                    mag: sol_mag,
                    dist_ly: dist_pc * 3.261_56,
                    origin_name,
                })
            })
        })
    } else {
        None
    };

    SkyFrame {
        jd_ut,
        jd_tt,
        gmst_deg: gmst,
        lst_deg: lst,
        last_deg: last,
        obliquity_deg,
        local_dt: LocalDateTimeParts {
            year,
            month,
            day,
            hour,
            minute,
            second,
        },
        view_mode: req.view_mode,
        j2000_to_apparent_matrix,
        j2000_to_enu_override,
        pole_track_north,
        pole_track_south,
        sol_from_other_star,
        bodies,
        sky_palette,
    }
}

#[tauri::command]
pub fn compute_sky_frame(
    req: SkyFrameRequest,
    store: State<'_, CatalogStore>,
    comet_db: State<'_, CometDb>,
) -> SkyFrame {
    let comets = comet_db.list_enabled_elements();
    compute_sky_frame_impl(req, Some(&store), &comets)
}

#[derive(Debug, Clone, Deserialize)]
pub struct PickSkyRequest {
    pub x: f64,
    pub y: f64,
    pub projection: ProjectionParams,
    pub jd_ut: f64,
    pub lat_deg: f64,
    pub lon_deg: f64,
    pub alt_m: f64,
    pub tz_offset_min: i32,
    pub limiting_mag: f64,
    pub refraction: bool,
    pub search_radius_deg: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct PickedObject {
    pub kind: String,
    pub id: String,
    pub name_ja: String,
    pub name_en: String,
    pub constellation: Option<String>,
    pub mag: Option<f64>,
    pub ra_deg: f64,
    pub dec_deg: f64,
    pub az_deg: f64,
    pub alt_deg: f64,
    pub dist_text: String,
    pub angular_sep_deg: f64,
    pub extra_info: String,
}

#[tauri::command]
pub fn pick_sky_object(
    req: PickSkyRequest,
    store: State<'_, CatalogStore>,
    comet_db: State<'_, CometDb>,
) -> Option<PickedObject> {
    let last = last_deg(req.jd_ut, req.lon_deg);
    let inv = unproject_screen(req.x, req.y, &req.projection, req.lat_deg, last)?;

    let (click_az, click_alt) = (inv.az_deg?, inv.alt_deg?);
    let eq_click_app = if req.projection.mode.is_equatorial() {
        Equatorial {
            ra_deg: inv.ra_deg?,
            dec_deg: inv.dec_deg?,
        }
    } else {
        let true_alt = if req.refraction {
            remove_standard_refraction(click_alt)
        } else {
            click_alt
        };
        horizontal_to_equatorial(
            Horizontal {
                az_deg: click_az,
                alt_deg: true_alt,
            },
            req.lat_deg,
            last,
        )
    };

    let jd_tt = ut_to_tt_jd(req.jd_ut);
    let (mat, _) = j2000_to_apparent_matrix_internal(jd_tt);
    let eq_click_j2000 = vec3_to_equatorial(mat3_transpose_mul_vec(
        &mat,
        equatorial_to_vec3(eq_click_app),
    ));

    let frame_req = SkyFrameRequest {
        jd_ut: Some(req.jd_ut),
        lat_deg: req.lat_deg,
        lon_deg: req.lon_deg,
        alt_m: req.alt_m,
        tz_offset_min: req.tz_offset_min,
        limiting_mag: req.limiting_mag,
        realism_level: 0,
        night_vision: false,
        refraction: req.refraction,
        view_mode: SkyViewMode::Normal,
        observer_body: None,
        origin_star_hip: None,
    };
    let comets = comet_db.list_enabled_elements();
    let bodies = build_solar_system_bodies(&frame_req, jd_tt, last, &comets);
    let max_r = req.search_radius_deg.clamp(0.2, 8.0);

    let mut best_score = f64::INFINITY;
    let mut best_pick: Option<PickedObject> = None;

    for b in bodies {
        if !req.projection.show_below_horizon && b.alt_deg < -0.5 {
            continue;
        }
        let body_eq = Equatorial {
            ra_deg: b.ra_deg,
            dec_deg: b.dec_deg,
        };
        let sep = angular_distance_deg(body_eq, eq_click_app);
        let body_radius_deg = (b.angular_diameter_arcsec / 7200.0).min(1.5);
        if sep <= max_r + body_radius_deg {
            let score = (sep - body_radius_deg).max(0.0) - 0.12;
            if score < best_score {
                best_score = score;
                let extra = if b.id == "moon" {
                    format!(
                        "月齢 {:.1}日 / 輝面比 {:.0}% / 視直径 {:.1}'",
                        b.moon_age_days.unwrap_or(0.0),
                        b.illuminated_fraction * 100.0,
                        b.angular_diameter_arcsec / 60.0
                    )
                } else if b.id == "sun" {
                    format!("視直径 {:.1}'", b.angular_diameter_arcsec / 60.0)
                } else if b.kind == "comet" {
                    format!(
                        "日心 {:.3} AU / 地心 {:.3} AU / 離角 {:.1}°",
                        b.helio_au, b.geo_au, b.elongation_deg
                    )
                } else {
                    format!(
                        "離角 {:.1}° / 輝面比 {:.0}% / 視直径 {:.1}\"",
                        b.elongation_deg,
                        b.illuminated_fraction * 100.0,
                        b.angular_diameter_arcsec
                    )
                };
                best_pick = Some(PickedObject {
                    kind: b.kind,
                    id: b.id,
                    name_ja: b.name_ja,
                    name_en: b.name_en,
                    constellation: None,
                    mag: Some(b.visual_magnitude),
                    ra_deg: b.ra_deg,
                    dec_deg: b.dec_deg,
                    az_deg: b.az_deg,
                    alt_deg: b.alt_deg,
                    dist_text: format!("{:.4} AU", b.geo_au),
                    angular_sep_deg: sep,
                    extra_info: extra,
                });
            }
        }
    }

    let mut ja_by_hip: HashMap<u32, &str> = HashMap::new();
    for g in &store.star_guides {
        ja_by_hip.insert(g.hip, g.name_ja.as_str());
    }

    let mag_limit = req.limiting_mag + 0.5;
    for star in &store.stars.stars {
        let mag = f64::from(star.mag);
        if mag > mag_limit {
            continue;
        }
        let dec_j2000 = f64::from(star.dec_rad).to_degrees();
        if (dec_j2000 - eq_click_j2000.dec_deg).abs() > max_r {
            continue;
        }
        let eq_star_j2000 = Equatorial {
            ra_deg: wrap_deg_360(f64::from(star.ra_rad).to_degrees()),
            dec_deg: dec_j2000,
        };
        let sep = angular_distance_deg(eq_star_j2000, eq_click_j2000);
        if sep > max_r {
            continue;
        }
        let eq_app = vec3_to_equatorial(mat3_mul_vec(&mat, equatorial_to_vec3(eq_star_j2000)));
        let mut hor = equatorial_to_horizontal(eq_app, req.lat_deg, last);
        if req.refraction {
            hor.alt_deg = apply_standard_refraction(hor.alt_deg);
        }
        if !req.projection.show_below_horizon && hor.alt_deg < -0.5 {
            continue;
        }
        let score = sep + 0.018 * mag.max(-1.5);
        if score < best_score {
            best_score = score;
            let proper = store.stars.proper_name(star);
            let bayer = store.stars.bayer(star);
            let con = store.stars.constellation_code(star).unwrap_or("");
            let guide_ja = if star.hip > 0 {
                ja_by_hip.get(&star.hip).copied()
            } else {
                None
            };
            let title_en = if !proper.is_empty() {
                proper.to_owned()
            } else if !bayer.is_empty() {
                format!("{bayer} {con}")
            } else if star.hip > 0 {
                format!("HIP {}", star.hip)
            } else {
                format!("Star #{}", star.id)
            };
            let title_ja = guide_ja.map(str::to_owned).unwrap_or_else(|| title_en.clone());
            let dist_ly = f64::from(star.dist_pc) * 3.261_56;
            let dist_text = if star.dist_pc > 0.0 && star.dist_pc < 99_000.0 {
                format!("{dist_ly:.1} 光年")
            } else {
                "距離不明".into()
            };
            best_pick = Some(PickedObject {
                kind: "star".into(),
                id: if star.hip > 0 {
                    format!("HIP {}", star.hip)
                } else {
                    format!("STAR {}", star.id)
                },
                name_ja: title_ja,
                name_en: title_en,
                constellation: (!con.is_empty()).then(|| con.to_owned()),
                mag: Some(mag),
                ra_deg: eq_app.ra_deg,
                dec_deg: eq_app.dec_deg,
                az_deg: hor.az_deg,
                alt_deg: hor.alt_deg,
                dist_text,
                angular_sep_deg: sep,
                extra_info: format!("色指数 B-V {:.2}", star.ci),
            });
        }
    }

    for dso in &store.dsos {
        if dso.messier.is_none() && f64::from(dso.mag.unwrap_or(99.0)) > req.limiting_mag + 4.5 {
            continue;
        }
        if (dso.dec_deg - eq_click_j2000.dec_deg).abs() > max_r {
            continue;
        }
        let eq_j2000 = Equatorial {
            ra_deg: dso.ra_deg,
            dec_deg: dso.dec_deg,
        };
        let sep = angular_distance_deg(eq_j2000, eq_click_j2000);
        if sep > max_r {
            continue;
        }
        let eq_app = vec3_to_equatorial(mat3_mul_vec(&mat, equatorial_to_vec3(eq_j2000)));
        let mut hor = equatorial_to_horizontal(eq_app, req.lat_deg, last);
        if req.refraction {
            hor.alt_deg = apply_standard_refraction(hor.alt_deg);
        }
        if !req.projection.show_below_horizon && hor.alt_deg < -0.5 {
            continue;
        }
        let mag = dso.mag.map(f64::from);
        let score = sep + if dso.messier.is_some() { 0.02 } else { 0.08 };
        if score < best_score {
            best_score = score;
            let m_label = dso
                .messier
                .map(|m| format!("M{m}"))
                .unwrap_or_else(|| dso.id.clone());
            let name_ja = dso
                .name_ja
                .clone()
                .map(|j| format!("{m_label} {j}"))
                .unwrap_or_else(|| m_label.clone());
            best_pick = Some(PickedObject {
                kind: "dso".into(),
                id: m_label,
                name_ja,
                name_en: dso.name_en.clone(),
                constellation: Some(dso.constellation.clone()),
                mag,
                ra_deg: eq_app.ra_deg,
                dec_deg: eq_app.dec_deg,
                az_deg: hor.az_deg,
                alt_deg: hor.alt_deg,
                dist_text: dso.obj_type.clone(),
                angular_sep_deg: sep,
                extra_info: dso
                    .maj_ax_arcmin
                    .map(|a| format!("視直径 {a:.1}'"))
                    .unwrap_or_else(|| dso.obj_type.clone()),
            });
        }
    }

    best_pick
}

#[derive(Debug, Clone, Deserialize)]
pub struct DayTimesRequest {
    pub jd_ut: f64,
    pub lat_deg: f64,
    pub lon_deg: f64,
    pub alt_m: f64,
    pub tz_offset_min: i32,
    #[serde(default)]
    pub year: Option<i32>,
    #[serde(default)]
    pub month: Option<u8>,
    #[serde(default)]
    pub day: Option<u8>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DaySpecialTimes {
    pub date_str: String,
    pub sunrise_jd_ut: Option<f64>,
    pub sunrise_str: Option<String>,
    pub solar_transit_jd_ut: Option<f64>,
    pub solar_transit_str: Option<String>,
    pub sunset_jd_ut: Option<f64>,
    pub sunset_str: Option<String>,
    pub moonrise_jd_ut: Option<f64>,
    pub moonrise_str: Option<String>,
    pub lunar_transit_jd_ut: Option<f64>,
    pub lunar_transit_str: Option<String>,
    pub moonset_jd_ut: Option<f64>,
    pub moonset_str: Option<String>,
    pub civil_dawn_jd_ut: Option<f64>,
    pub civil_dawn_str: Option<String>,
    pub civil_dusk_jd_ut: Option<f64>,
    pub civil_dusk_str: Option<String>,
    pub nautical_dawn_jd_ut: Option<f64>,
    pub nautical_dawn_str: Option<String>,
    pub nautical_dusk_jd_ut: Option<f64>,
    pub nautical_dusk_str: Option<String>,
    pub astro_dawn_jd_ut: Option<f64>,
    pub astro_dawn_str: Option<String>,
    pub astro_dusk_jd_ut: Option<f64>,
    pub astro_dusk_str: Option<String>,
}

fn fmt_local_hm(jd_ut: Option<f64>, tz_offset_min: i32) -> Option<String> {
    let jd = jd_ut?;
    let (_, _, _, h, m, s) = jd_to_ymd_hms(jd + f64::from(tz_offset_min) / 1440.0 + 0.5 / 1440.0);
    let _ = s;
    Some(format!("{h:02}:{m:02}"))
}

pub fn get_day_special_times_impl(req: DayTimesRequest) -> DaySpecialTimes {
    let (year, month, day) = match (req.year, req.month, req.day) {
        (Some(y), Some(m), Some(d)) => (y, m, d),
        _ => {
            let (y, m, d, _, _, _) =
                jd_to_ymd_hms(req.jd_ut + f64::from(req.tz_offset_min) / 1440.0);
            (y, m, d)
        }
    };
    let loc = ObserverLocation {
        lat_deg: req.lat_deg,
        lon_deg: req.lon_deg,
        alt_m: req.alt_m,
        tz_offset_min: req.tz_offset_min,
    };
    let sun = sun_rise_set(&loc, year, month, day);
    let moon = moon_rise_set(&loc, year, month, day);
    let tw: TwilightTimes = sun_twilight(&loc, year, month, day);
    let tz = req.tz_offset_min;

    DaySpecialTimes {
        date_str: format!("{year:04}-{month:02}-{day:02}"),
        sunrise_jd_ut: sun.rise_jd_ut,
        sunrise_str: fmt_local_hm(sun.rise_jd_ut, tz),
        solar_transit_jd_ut: sun.transit_jd_ut,
        solar_transit_str: fmt_local_hm(sun.transit_jd_ut, tz),
        sunset_jd_ut: sun.set_jd_ut,
        sunset_str: fmt_local_hm(sun.set_jd_ut, tz),
        moonrise_jd_ut: moon.rise_jd_ut,
        moonrise_str: fmt_local_hm(moon.rise_jd_ut, tz),
        lunar_transit_jd_ut: moon.transit_jd_ut,
        lunar_transit_str: fmt_local_hm(moon.transit_jd_ut, tz),
        moonset_jd_ut: moon.set_jd_ut,
        moonset_str: fmt_local_hm(moon.set_jd_ut, tz),
        civil_dawn_jd_ut: tw.civil_dawn_jd_ut,
        civil_dawn_str: fmt_local_hm(tw.civil_dawn_jd_ut, tz),
        civil_dusk_jd_ut: tw.civil_dusk_jd_ut,
        civil_dusk_str: fmt_local_hm(tw.civil_dusk_jd_ut, tz),
        nautical_dawn_jd_ut: tw.nautical_dawn_jd_ut,
        nautical_dawn_str: fmt_local_hm(tw.nautical_dawn_jd_ut, tz),
        nautical_dusk_jd_ut: tw.nautical_dusk_jd_ut,
        nautical_dusk_str: fmt_local_hm(tw.nautical_dusk_jd_ut, tz),
        astro_dawn_jd_ut: tw.astro_dawn_jd_ut,
        astro_dawn_str: fmt_local_hm(tw.astro_dawn_jd_ut, tz),
        astro_dusk_jd_ut: tw.astro_dusk_jd_ut,
        astro_dusk_str: fmt_local_hm(tw.astro_dusk_jd_ut, tz),
    }
}

#[tauri::command]
pub fn get_day_special_times(req: DayTimesRequest) -> DaySpecialTimes {
    get_day_special_times_impl(req)
}

#[derive(Debug, Clone, Deserialize)]
pub struct ObjectDetailRequest {
    pub kind: String,
    pub id: String,
    pub ra_deg: f64,
    pub dec_deg: f64,
    pub jd_ut: f64,
    pub lat_deg: f64,
    pub lon_deg: f64,
    pub alt_m: f64,
    pub tz_offset_min: i32,
}

#[derive(Debug, Clone, Serialize)]
pub struct AltitudeSample {
    pub offset_hours: f64,
    pub local_hour: f64,
    pub label: String,
    pub jd_ut: f64,
    pub alt_deg: f64,
    pub az_deg: f64,
    pub sun_alt_deg: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ObjectDetails {
    pub rise_jd_ut: Option<f64>,
    pub rise_str: Option<String>,
    pub transit_jd_ut: Option<f64>,
    pub transit_str: Option<String>,
    pub set_jd_ut: Option<f64>,
    pub set_str: Option<String>,
    pub max_alt_deg: f64,
    pub status: String,
    pub moon_separation_deg: f64,
    pub elongation_deg: f64,
    pub constellation_ja: Option<String>,
    pub spectrum: Option<String>,
    pub commentary_ja: Option<String>,
    pub how_to_find_ja: Option<String>,
    pub altitude_curve: Vec<AltitudeSample>,
}

fn planet_from_id(id: &str) -> Option<Planet> {
    match id.to_ascii_lowercase().as_str() {
        "mercury" => Some(Planet::Mercury),
        "venus" => Some(Planet::Venus),
        "mars" => Some(Planet::Mars),
        "jupiter" => Some(Planet::Jupiter),
        "saturn" => Some(Planet::Saturn),
        "uranus" => Some(Planet::Uranus),
        "neptune" => Some(Planet::Neptune),
        _ => None,
    }
}

pub fn get_object_details_impl(
    req: ObjectDetailRequest,
    store: Option<&CatalogStore>,
    comet_db: Option<&CometDb>,
) -> ObjectDetails {
    let matched_comet = if req.kind.eq_ignore_ascii_case("comet") || req.id.starts_with("comet:") {
        comet_db.and_then(|db| db.find_by_id(&req.id))
    } else {
        None
    };
    let matched_comet_el = matched_comet.as_ref().map(|c| c.to_elements());
    let tz_days = f64::from(req.tz_offset_min) / 1440.0;
    let (y, m, d, hour, _, _) = jd_to_ymd_hms(req.jd_ut + tz_days);
    let loc = ObserverLocation {
        lat_deg: req.lat_deg,
        lon_deg: req.lon_deg,
        alt_m: req.alt_m,
        tz_offset_min: req.tz_offset_min,
    };

    // Convert input Apparent coordinates back to J2000 for star/DSO rise/set calculations
    let jd_tt_now = ut_to_tt_jd(req.jd_ut);
    let (mat_now, _) = j2000_to_apparent_matrix_internal(jd_tt_now);
    let eq_app_now = Equatorial {
        ra_deg: req.ra_deg,
        dec_deg: req.dec_deg,
    };
    let eq_j2000_now =
        vec3_to_equatorial(mat3_transpose_mul_vec(&mat_now, equatorial_to_vec3(eq_app_now)));

    let rs = if req.id.eq_ignore_ascii_case("sun") {
        sun_rise_set(&loc, y, m, d)
    } else if req.id.eq_ignore_ascii_case("moon") {
        moon_rise_set(&loc, y, m, d)
    } else if let Some(planet) = planet_from_id(&req.id) {
        planet_rise_set(planet, &loc, y, m, d)
    } else {
        equatorial_j2000_rise_set(eq_j2000_now, &loc, y, m, d)
    };

    // Anchor 24h overnight altitude curve on local midnight between afternoon and morning:
    // if local hour >= 12 -> center at tomorrow's 00:00 (12:00 today .. 12:00 tomorrow);
    // if local hour < 12  -> center at today's 00:00 (12:00 yesterday .. 12:00 today).
    let midnight_base_ut = if hour >= 12 {
        crate::engine::time::calendar_to_jd(y, m, f64::from(d) + 1.0) - tz_days
    } else {
        crate::engine::time::calendar_to_jd(y, m, f64::from(d)) - tz_days
    };

    let mut altitude_curve = Vec::with_capacity(49);
    let (mat_mid, _) = j2000_to_apparent_matrix_internal(ut_to_tt_jd(midnight_base_ut));
    let eq_date_fixed = vec3_to_equatorial(mat3_mul_vec(&mat_mid, equatorial_to_vec3(eq_j2000_now)));

    for i in 0..=48 {
        let offset_hours = -12.0 + 0.5 * (i as f64);
        let t_jd = midnight_base_ut + offset_hours / 24.0;
        let t_tt = ut_to_tt_jd(t_jd);
        let t_last = last_deg(t_jd, req.lon_deg);

        let sun_t = sun_ephemeris(t_tt);
        let sun_topo = geocentric_to_topocentric(
            sun_t.eq_apparent,
            sun_t.geo_au,
            req.lat_deg,
            req.alt_m,
            t_last,
        );
        let sun_alt_deg = equatorial_to_horizontal(sun_topo, req.lat_deg, t_last).alt_deg;

        let hor = if req.id.eq_ignore_ascii_case("sun") {
            let mut h = equatorial_to_horizontal(sun_topo, req.lat_deg, t_last);
            h.alt_deg = apply_standard_refraction(h.alt_deg);
            h
        } else if req.id.eq_ignore_ascii_case("moon") {
            let m_eph = moon_ephemeris(t_tt);
            let m_topo = geocentric_to_topocentric(
                m_eph.eq_apparent,
                m_eph.geo_au,
                req.lat_deg,
                req.alt_m,
                t_last,
            );
            let mut h = equatorial_to_horizontal(m_topo, req.lat_deg, t_last);
            h.alt_deg = apply_standard_refraction(h.alt_deg);
            h
        } else if let Some(planet) = planet_from_id(&req.id) {
            let p_eph = planet_ephemeris(planet, t_tt);
            let p_topo = geocentric_to_topocentric(
                p_eph.eq_apparent,
                p_eph.geo_au,
                req.lat_deg,
                req.alt_m,
                t_last,
            );
            let mut h = equatorial_to_horizontal(p_topo, req.lat_deg, t_last);
            h.alt_deg = apply_standard_refraction(h.alt_deg);
            h
        } else if let Some(comet_el) = &matched_comet_el {
            let c_eph = comet_ephemeris(comet_el, t_tt);
            let c_topo = geocentric_to_topocentric(
                c_eph.eq_apparent,
                c_eph.geo_au,
                req.lat_deg,
                req.alt_m,
                t_last,
            );
            let mut h = equatorial_to_horizontal(c_topo, req.lat_deg, t_last);
            h.alt_deg = apply_standard_refraction(h.alt_deg);
            h
        } else {
            let mut h = equatorial_to_horizontal(eq_date_fixed, req.lat_deg, t_last);
            h.alt_deg = apply_standard_refraction(h.alt_deg);
            h
        };

        let (_, _, _, lh, lm, _) = jd_to_ymd_hms(t_jd + tz_days + 0.01 / 1440.0);
        let local_hour = if offset_hours < 0.0 {
            12.0 + (offset_hours + 12.0)
        } else {
            offset_hours
        };
        altitude_curve.push(AltitudeSample {
            offset_hours,
            local_hour,
            label: format!("{lh:02}:{lm:02}"),
            jd_ut: t_jd,
            alt_deg: hor.alt_deg,
            az_deg: hor.az_deg,
            sun_alt_deg,
        });
    }

    let moon_now = moon_ephemeris(jd_tt_now);
    let sun_now = sun_ephemeris(jd_tt_now);
    let moon_separation_deg = angular_distance_deg(eq_app_now, moon_now.eq_apparent);
    let elongation_deg = angular_distance_deg(eq_app_now, sun_now.eq_apparent);

    let mut constellation_ja = None;
    let mut spectrum = None;
    let mut commentary_ja = None;
    let mut how_to_find_ja = None;

    if let Some(cat) = store {
        if let Some(myth) = cat
            .constellation_myths
            .iter()
            .find(|c| c.id.eq_ignore_ascii_case(&req.id))
        {
            constellation_ja = Some(myth.name_ja.clone());
            commentary_ja = Some(myth.summary.clone());
            how_to_find_ja = Some(myth.how_to_find.clone());
        } else if let Some(hip_str) = req.id.strip_prefix("HIP ")
            && let Ok(hip) = hip_str.trim().parse::<u32>()
        {
            if let Some(g) = cat.star_guides.iter().find(|s| s.hip == hip) {
                spectrum = Some(g.spectrum.clone());
                commentary_ja = Some(g.commentary_ja.clone());
                how_to_find_ja = Some(g.summary_ja.clone());
            }
            if let Some(v) = cat.variable_stars.iter().find(|v| v.hip == hip) {
                spectrum = spectrum.or_else(|| Some(v.spectrum.clone()));
                let v_txt = format!(
                    "変光星 ({}): {:.2}〜{:.2}等 {}",
                    v.var_type,
                    v.mag_max,
                    v.mag_min,
                    v.period_days
                        .map(|p| format!("/ 周期 {p:.2}日"))
                        .unwrap_or_default()
                );
                commentary_ja = Some(
                    commentary_ja
                        .map(|c| format!("{c} / {v_txt}"))
                        .unwrap_or(v_txt),
                );
            }
        }
        if constellation_ja.is_none()
            && let Some(con) = cat
                .constellations
                .iter()
                .find(|c| c.id.eq_ignore_ascii_case(&req.id))
        {
            constellation_ja = Some(con.name_ja.clone());
        }
    }

    if let Some(comet_rec) = matched_comet {
        let (py, pm, pd, ph, pmin, _) = jd_to_ymd_hms(comet_rec.epoch_perihelion_jd);
        let elem_txt = format!(
            "軌道要素: T={py:04}-{pm:02}-{pd:02} {ph:02}:{pmin:02} UTC / q={:.4} AU / e={:.5} / i={:.2}° / ω={:.2}° / Ω={:.2}° / H={:.1} / K={:.1}",
            comet_rec.perihelion_dist_au,
            comet_rec.eccentricity,
            comet_rec.inclination_deg,
            comet_rec.arg_periapsis_deg,
            comet_rec.ascending_node_deg,
            comet_rec.abs_mag_h,
            comet_rec.slope_param_k,
        );
        commentary_ja = Some(if comet_rec.notes.trim().is_empty() {
            elem_txt
        } else {
            format!("{} — {elem_txt}", comet_rec.notes.trim())
        });
    }

    let status_str = match rs.status {
        RiseSetStatus::Normal => "通常出没".to_owned(),
        RiseSetStatus::Circumpolar => "周極星（一日中沈まない）".to_owned(),
        RiseSetStatus::NeverRises => "地平線下にあり昇らない".to_owned(),
    };

    ObjectDetails {
        rise_jd_ut: rs.rise_jd_ut,
        rise_str: fmt_local_hm(rs.rise_jd_ut, req.tz_offset_min),
        transit_jd_ut: rs.transit_jd_ut,
        transit_str: fmt_local_hm(rs.transit_jd_ut, req.tz_offset_min),
        set_jd_ut: rs.set_jd_ut,
        set_str: fmt_local_hm(rs.set_jd_ut, req.tz_offset_min),
        max_alt_deg: rs.max_alt_deg,
        status: status_str,
        moon_separation_deg,
        elongation_deg,
        constellation_ja,
        spectrum,
        commentary_ja,
        how_to_find_ja,
        altitude_curve,
    }
}

#[tauri::command]
pub fn get_object_details(
    req: ObjectDetailRequest,
    store: State<'_, CatalogStore>,
    comet_db: State<'_, CometDb>,
) -> ObjectDetails {
    get_object_details_impl(req, Some(&store), Some(&comet_db))
}

#[derive(Debug, Clone, Deserialize)]
pub struct SearchRequest {
    pub query: String,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub mag_max: Option<f64>,
    #[serde(default)]
    pub ra_min_h: Option<f64>,
    #[serde(default)]
    pub ra_max_h: Option<f64>,
    #[serde(default)]
    pub only_variables: bool,
    pub jd_ut: f64,
    pub lat_deg: f64,
    pub lon_deg: f64,
    pub refraction: bool,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchResultItem {
    pub kind: String,
    pub id: String,
    pub name_ja: String,
    pub name_en: String,
    pub constellation: Option<String>,
    pub obj_type: String,
    pub mag: Option<f64>,
    pub ra_deg: f64,
    pub dec_deg: f64,
    pub az_deg: f64,
    pub alt_deg: f64,
    pub extra: String,
}

fn app_hor(
    eq_j2000: Equatorial,
    mat: &[[f64; 3]; 3],
    lat_deg: f64,
    last_deg: f64,
    refraction: bool,
) -> (Equatorial, Horizontal) {
    let eq_app = vec3_to_equatorial(mat3_mul_vec(mat, equatorial_to_vec3(eq_j2000)));
    let mut hor = equatorial_to_horizontal(eq_app, lat_deg, last_deg);
    if refraction {
        hor.alt_deg = apply_standard_refraction(hor.alt_deg);
    }
    (eq_app, hor)
}

pub fn search_sky_objects_impl(
    req: &SearchRequest,
    store: &CatalogStore,
    comets: &[CometElements],
) -> Vec<SearchResultItem> {
    let q = req.query.trim().to_ascii_lowercase();
    let cat_filter = req.category.trim().to_ascii_lowercase();
    let all_cats = cat_filter.is_empty() || cat_filter == "all";
    let limit = req.limit.unwrap_or(80).clamp(1, 250);

    let jd_tt = ut_to_tt_jd(req.jd_ut);
    let last = last_deg(req.jd_ut, req.lon_deg);
    let (mat, _) = j2000_to_apparent_matrix_internal(jd_tt);

    let mut out: Vec<(i32, f64, SearchResultItem)> = Vec::new();
    let matches_ra = |ra_deg: f64| -> bool {
        let ra_h = ra_deg / 15.0;
        let min_ok = req.ra_min_h.map(|m| ra_h >= m).unwrap_or(true);
        let max_ok = req.ra_max_h.map(|m| ra_h <= m).unwrap_or(true);
        min_ok && max_ok
    };
    let matches_mag = |mag: Option<f64>| -> bool {
        match (mag, req.mag_max) {
            (Some(v), Some(lim)) => v <= lim,
            (None, Some(_)) => true,
            _ => true,
        }
    };

    if (all_cats || cat_filter == "planet" || cat_filter == "comet") && !req.only_variables {
        let frame_req = SkyFrameRequest {
            jd_ut: Some(req.jd_ut),
            lat_deg: req.lat_deg,
            lon_deg: req.lon_deg,
            alt_m: 0.0,
            tz_offset_min: 540,
            limiting_mag: 22.0,
            realism_level: 0,
            night_vision: false,
            refraction: req.refraction,
            view_mode: SkyViewMode::Normal,
            observer_body: None,
            origin_star_hip: None,
        };
        for b in build_solar_system_bodies(&frame_req, jd_tt, last, comets) {
            if cat_filter == "comet" && b.kind != "comet" {
                continue;
            }
            let text_match = q.is_empty()
                || b.name_ja.to_ascii_lowercase().contains(&q)
                || b.name_en.to_ascii_lowercase().contains(&q)
                || b.id.to_ascii_lowercase().contains(&q);
            if text_match && matches_mag(Some(b.visual_magnitude)) && matches_ra(b.ra_deg) {
                let exact = i32::from(
                    !q.is_empty()
                        && (b.name_ja == req.query.trim()
                            || b.name_en.eq_ignore_ascii_case(req.query.trim())),
                );
                let obj_type = if b.kind == "comet" {
                    "彗星"
                } else {
                    "太陽系"
                };
                out.push((
                    exact * 100 + 30,
                    b.visual_magnitude,
                    SearchResultItem {
                        kind: b.kind,
                        id: b.id,
                        name_ja: b.name_ja,
                        name_en: b.name_en,
                        constellation: None,
                        obj_type: obj_type.into(),
                        mag: Some(b.visual_magnitude),
                        ra_deg: b.ra_deg,
                        dec_deg: b.dec_deg,
                        az_deg: b.az_deg,
                        alt_deg: b.alt_deg,
                        extra: format!("{:.3} AU / 離角 {:.0}°", b.geo_au, b.elongation_deg),
                    },
                ));
            }
        }
    }

    if (all_cats || cat_filter == "constellation") && !req.only_variables {
        for con in &store.constellations {
            let text_match = q.is_empty()
                || con.name_ja.to_ascii_lowercase().contains(&q)
                || con.name_en.to_ascii_lowercase().contains(&q)
                || con.name_la.to_ascii_lowercase().contains(&q)
                || con.id.to_ascii_lowercase().contains(&q);
            if text_match && matches_ra(con.center_ra_deg) {
                let (eq_app, hor) = app_hor(
                    Equatorial {
                        ra_deg: con.center_ra_deg,
                        dec_deg: con.center_dec_deg,
                    },
                    &mat,
                    req.lat_deg,
                    last,
                    req.refraction,
                );
                let exact = i32::from(
                    !q.is_empty()
                        && (con.name_ja == req.query.trim()
                            || con.id.eq_ignore_ascii_case(req.query.trim())),
                );
                out.push((
                    exact * 100 + 25,
                    f64::from(con.rank),
                    SearchResultItem {
                        kind: "constellation".into(),
                        id: con.id.clone(),
                        name_ja: con.name_ja.clone(),
                        name_en: con.name_en.clone(),
                        constellation: Some(con.id.clone()),
                        obj_type: "星座".into(),
                        mag: None,
                        ra_deg: eq_app.ra_deg,
                        dec_deg: eq_app.dec_deg,
                        az_deg: hor.az_deg,
                        alt_deg: hor.alt_deg,
                        extra: format!("{} ({})", con.name_la, con.genitive),
                    },
                ));
            }
        }
    }

    if all_cats || cat_filter == "variable" || (cat_filter == "star" && req.only_variables) {
        for v in &store.variable_stars {
            let text_match = q.is_empty()
                || v.name_ja.to_ascii_lowercase().contains(&q)
                || v.name_en.to_ascii_lowercase().contains(&q)
                || v.constellation.to_ascii_lowercase().contains(&q)
                || v.var_type.to_ascii_lowercase().contains(&q);
            let mag = f64::from(v.mag_max);
            if text_match && matches_mag(Some(mag)) && matches_ra(v.ra_deg) {
                let (eq_app, hor) = app_hor(
                    Equatorial {
                        ra_deg: v.ra_deg,
                        dec_deg: v.dec_deg,
                    },
                    &mat,
                    req.lat_deg,
                    last,
                    req.refraction,
                );
                out.push((
                    18,
                    mag,
                    SearchResultItem {
                        kind: "star".into(),
                        id: if v.hip > 0 {
                            format!("HIP {}", v.hip)
                        } else {
                            v.id.clone()
                        },
                        name_ja: v.name_ja.clone(),
                        name_en: v.name_en.clone(),
                        constellation: Some(v.constellation.clone()),
                        obj_type: format!("変光星 {}", v.var_type),
                        mag: Some(mag),
                        ra_deg: eq_app.ra_deg,
                        dec_deg: eq_app.dec_deg,
                        az_deg: hor.az_deg,
                        alt_deg: hor.alt_deg,
                        extra: format!("{:.1}〜{:.1}等 ({})", v.mag_max, v.mag_min, v.spectrum),
                    },
                ));
            }
        }
    }

    if (all_cats || cat_filter == "star") && !req.only_variables {
        let mut ja_by_hip: HashMap<u32, &str> = HashMap::with_capacity(store.star_guides.len());
        for g in &store.star_guides {
            ja_by_hip.insert(g.hip, g.name_ja.as_str());
        }
        let max_star_mag = req.mag_max.unwrap_or(if q.is_empty() { 3.5 } else { 8.5 });
        let mut star_hits = 0usize;
        for s in &store.stars.stars {
            let mag = f64::from(s.mag);
            if mag > max_star_mag {
                continue;
            }
            let proper = store.stars.proper_name(s);
            let bayer = store.stars.bayer(s);
            let con = store.stars.constellation_code(s).unwrap_or("");
            let ja = (s.hip > 0).then(|| ja_by_hip.get(&s.hip).copied()).flatten();
            let hip_str = format!("hip {}", s.hip);
            let text_match = q.is_empty()
                || ja.map(|n| n.to_ascii_lowercase().contains(&q)).unwrap_or(false)
                || proper.to_ascii_lowercase().contains(&q)
                || bayer.to_ascii_lowercase().contains(&q)
                || con.to_ascii_lowercase().contains(&q)
                || (s.hip > 0 && hip_str.contains(&q));
            if !text_match {
                continue;
            }
            let eq_j = Equatorial {
                ra_deg: wrap_deg_360(f64::from(s.ra_rad).to_degrees()),
                dec_deg: f64::from(s.dec_rad).to_degrees(),
            };
            if !matches_ra(eq_j.ra_deg) {
                continue;
            }
            let (eq_app, hor) = app_hor(eq_j, &mat, req.lat_deg, last, req.refraction);
            let title_en = if !proper.is_empty() {
                proper.to_owned()
            } else if !bayer.is_empty() {
                format!("{bayer} {con}")
            } else {
                format!("HIP {}", s.hip)
            };
            let title_ja = ja.map(str::to_owned).unwrap_or_else(|| title_en.clone());
            let exact = i32::from(
                !q.is_empty()
                    && (title_ja.eq_ignore_ascii_case(req.query.trim())
                        || title_en.eq_ignore_ascii_case(req.query.trim())),
            );
            out.push((
                exact * 100 + 15,
                mag,
                SearchResultItem {
                    kind: "star".into(),
                    id: if s.hip > 0 {
                        format!("HIP {}", s.hip)
                    } else {
                        format!("STAR {}", s.id)
                    },
                    name_ja: title_ja,
                    name_en: title_en,
                    constellation: (!con.is_empty()).then(|| con.to_owned()),
                    obj_type: "恒星".into(),
                    mag: Some(mag),
                    ra_deg: eq_app.ra_deg,
                    dec_deg: eq_app.dec_deg,
                    az_deg: hor.az_deg,
                    alt_deg: hor.alt_deg,
                    extra: if s.dist_pc > 0.0 && s.dist_pc < 90_000.0 {
                        format!("{:.1} 光年", f64::from(s.dist_pc) * 3.261_56)
                    } else {
                        format!("B-V {:.2}", s.ci)
                    },
                },
            ));
            star_hits += 1;
            if star_hits >= 150 {
                break;
            }
        }
    }

    if (all_cats || cat_filter == "dso") && !req.only_variables {
        for d in &store.dsos {
            let m_id = d.messier.map(|m| format!("M{m}")).unwrap_or_else(|| d.id.clone());
            let text_match = q.is_empty()
                || m_id.to_ascii_lowercase().contains(&q)
                || d.id.to_ascii_lowercase().contains(&q)
                || d.name_en.to_ascii_lowercase().contains(&q)
                || d.name_ja
                    .as_ref()
                    .map(|j| j.to_ascii_lowercase().contains(&q))
                    .unwrap_or(false)
                || d.constellation.to_ascii_lowercase().contains(&q);
            let mag = d.mag.map(f64::from);
            if text_match && (d.messier.is_some() || !q.is_empty()) && matches_mag(mag) && matches_ra(d.ra_deg) {
                let (eq_app, hor) = app_hor(
                    Equatorial {
                        ra_deg: d.ra_deg,
                        dec_deg: d.dec_deg,
                    },
                    &mat,
                    req.lat_deg,
                    last,
                    req.refraction,
                );
                let name_ja = d
                    .name_ja
                    .clone()
                    .map(|j| format!("{m_id} {j}"))
                    .unwrap_or_else(|| m_id.clone());
                let exact = i32::from(!q.is_empty() && m_id.eq_ignore_ascii_case(req.query.trim()));
                out.push((
                    exact * 100 + if d.messier.is_some() { 20 } else { 10 },
                    mag.unwrap_or(14.0),
                    SearchResultItem {
                        kind: "dso".into(),
                        id: m_id,
                        name_ja,
                        name_en: d.name_en.clone(),
                        constellation: Some(d.constellation.clone()),
                        obj_type: d.obj_type.clone(),
                        mag,
                        ra_deg: eq_app.ra_deg,
                        dec_deg: eq_app.dec_deg,
                        az_deg: hor.az_deg,
                        alt_deg: hor.alt_deg,
                        extra: d
                            .maj_ax_arcmin
                            .map(|a| format!("{} / 視直径 {:.1}'", d.obj_type, a))
                            .unwrap_or_else(|| d.obj_type.clone()),
                    },
                ));
            }
        }
    }

    if (all_cats || cat_filter == "asterism") && !req.only_variables {
        for a in &store.asterisms {
            let text_match = q.is_empty()
                || a.name_ja.to_ascii_lowercase().contains(&q)
                || a.name_en.to_ascii_lowercase().contains(&q);
            if !text_match {
                continue;
            }
            if let Some(first_pt) = a.lines.first().and_then(|s| s.first()) {
                let (eq_app, hor) = app_hor(
                    Equatorial {
                        ra_deg: first_pt[0],
                        dec_deg: first_pt[1],
                    },
                    &mat,
                    req.lat_deg,
                    last,
                    req.refraction,
                );
                out.push((
                    16,
                    f64::from(a.priority),
                    SearchResultItem {
                        kind: "constellation".into(),
                        id: a.id.clone(),
                        name_ja: a.name_ja.clone(),
                        name_en: a.name_en.clone(),
                        constellation: None,
                        obj_type: "アステリズム".into(),
                        mag: None,
                        ra_deg: eq_app.ra_deg,
                        dec_deg: eq_app.dec_deg,
                        az_deg: hor.az_deg,
                        alt_deg: hor.alt_deg,
                        extra: "星空の目印".into(),
                    },
                ));
            }
        }
    }

    out.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.total_cmp(&b.1)));
    out.into_iter().take(limit).map(|x| x.2).collect()
}

#[tauri::command]
pub fn search_sky_objects(
    req: SearchRequest,
    store: State<'_, CatalogStore>,
    comet_db: State<'_, CometDb>,
) -> Vec<SearchResultItem> {
    let comets = comet_db.list_enabled_elements();
    search_sky_objects_impl(&req, &store, &comets)
}

#[derive(Debug, Clone, Deserialize)]
pub struct NearbyRequest {
    pub ra_deg: f64,
    pub dec_deg: f64,
    pub radius_deg: f64,
    pub jd_ut: f64,
    pub lat_deg: f64,
    pub lon_deg: f64,
    pub limiting_mag: f64,
    pub refraction: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct NearbyObjectItem {
    pub kind: String,
    pub id: String,
    pub name_ja: String,
    pub name_en: String,
    pub constellation: Option<String>,
    pub obj_type: String,
    pub mag: Option<f64>,
    pub angular_sep_deg: f64,
    pub ra_deg: f64,
    pub dec_deg: f64,
    pub az_deg: f64,
    pub alt_deg: f64,
}

pub fn find_nearby_objects_impl(
    req: &NearbyRequest,
    store: &CatalogStore,
    comets: &[CometElements],
) -> Vec<NearbyObjectItem> {
    let radius = req.radius_deg.clamp(0.5, 60.0);
    let jd_tt = ut_to_tt_jd(req.jd_ut);
    let last = last_deg(req.jd_ut, req.lon_deg);
    let (mat, _) = j2000_to_apparent_matrix_internal(jd_tt);
    let eq_center_app = Equatorial {
        ra_deg: req.ra_deg,
        dec_deg: req.dec_deg,
    };
    let eq_center_j2000 =
        vec3_to_equatorial(mat3_transpose_mul_vec(&mat, equatorial_to_vec3(eq_center_app)));

    let mut out: Vec<NearbyObjectItem> = Vec::new();
    let frame_req = SkyFrameRequest {
        jd_ut: Some(req.jd_ut),
        lat_deg: req.lat_deg,
        lon_deg: req.lon_deg,
        alt_m: 0.0,
        tz_offset_min: 540,
        limiting_mag: req.limiting_mag,
        realism_level: 0,
        night_vision: false,
        refraction: req.refraction,
        view_mode: SkyViewMode::Normal,
        observer_body: None,
        origin_star_hip: None,
    };
    for b in build_solar_system_bodies(&frame_req, jd_tt, last, comets) {
        let sep = angular_distance_deg(
            eq_center_app,
            Equatorial {
                ra_deg: b.ra_deg,
                dec_deg: b.dec_deg,
            },
        );
        if sep >= 0.002 && sep <= radius {
            let obj_type = if b.kind == "comet" {
                "彗星"
            } else {
                "太陽系"
            };
            out.push(NearbyObjectItem {
                kind: b.kind,
                id: b.id,
                name_ja: b.name_ja,
                name_en: b.name_en,
                constellation: None,
                obj_type: obj_type.into(),
                mag: Some(b.visual_magnitude),
                angular_sep_deg: sep,
                ra_deg: b.ra_deg,
                dec_deg: b.dec_deg,
                az_deg: b.az_deg,
                alt_deg: b.alt_deg,
            });
        }
    }

    let mut ja_by_hip: HashMap<u32, &str> = HashMap::new();
    for g in &store.star_guides {
        ja_by_hip.insert(g.hip, g.name_ja.as_str());
    }
    let mag_limit = req.limiting_mag + 0.5;
    for s in &store.stars.stars {
        let mag = f64::from(s.mag);
        if mag > mag_limit {
            continue;
        }
        let dec = f64::from(s.dec_rad).to_degrees();
        if (dec - eq_center_j2000.dec_deg).abs() > radius {
            continue;
        }
        let eq_j = Equatorial {
            ra_deg: wrap_deg_360(f64::from(s.ra_rad).to_degrees()),
            dec_deg: dec,
        };
        let sep = angular_distance_deg(eq_center_j2000, eq_j);
        if !(0.002..=radius).contains(&sep) {
            continue;
        }
        let (eq_app, hor) = app_hor(eq_j, &mat, req.lat_deg, last, req.refraction);
        let proper = store.stars.proper_name(s);
        let bayer = store.stars.bayer(s);
        let con = store.stars.constellation_code(s).unwrap_or("");
        let ja = (s.hip > 0).then(|| ja_by_hip.get(&s.hip).copied()).flatten();
        let name_en = if !proper.is_empty() {
            proper.to_owned()
        } else if !bayer.is_empty() {
            format!("{bayer} {con}")
        } else {
            format!("HIP {}", s.hip)
        };
        let name_ja = ja.map(str::to_owned).unwrap_or_else(|| name_en.clone());
        out.push(NearbyObjectItem {
            kind: "star".into(),
            id: if s.hip > 0 {
                format!("HIP {}", s.hip)
            } else {
                format!("STAR {}", s.id)
            },
            name_ja,
            name_en,
            constellation: (!con.is_empty()).then(|| con.to_owned()),
            obj_type: "恒星".into(),
            mag: Some(mag),
            angular_sep_deg: sep,
            ra_deg: eq_app.ra_deg,
            dec_deg: eq_app.dec_deg,
            az_deg: hor.az_deg,
            alt_deg: hor.alt_deg,
        });
    }

    for d in &store.dsos {
        if d.messier.is_none() && f64::from(d.mag.unwrap_or(99.0)) > req.limiting_mag + 3.5 {
            continue;
        }
        if (d.dec_deg - eq_center_j2000.dec_deg).abs() > radius {
            continue;
        }
        let eq_j = Equatorial {
            ra_deg: d.ra_deg,
            dec_deg: d.dec_deg,
        };
        let sep = angular_distance_deg(eq_center_j2000, eq_j);
        if !(0.002..=radius).contains(&sep) {
            continue;
        }
        let (eq_app, hor) = app_hor(eq_j, &mat, req.lat_deg, last, req.refraction);
        let m_id = d.messier.map(|m| format!("M{m}")).unwrap_or_else(|| d.id.clone());
        let name_ja = d
            .name_ja
            .clone()
            .map(|j| format!("{m_id} {j}"))
            .unwrap_or_else(|| m_id.clone());
        out.push(NearbyObjectItem {
            kind: "dso".into(),
            id: m_id,
            name_ja,
            name_en: d.name_en.clone(),
            constellation: Some(d.constellation.clone()),
            obj_type: d.obj_type.clone(),
            mag: d.mag.map(f64::from),
            angular_sep_deg: sep,
            ra_deg: eq_app.ra_deg,
            dec_deg: eq_app.dec_deg,
            az_deg: hor.az_deg,
            alt_deg: hor.alt_deg,
        });
    }

    out.sort_by(|a, b| a.angular_sep_deg.total_cmp(&b.angular_sep_deg));
    out.truncate(60);
    out
}

#[tauri::command]
pub fn find_nearby_objects(
    req: NearbyRequest,
    store: State<'_, CatalogStore>,
    comet_db: State<'_, CometDb>,
) -> Vec<NearbyObjectItem> {
    let comets = comet_db.list_enabled_elements();
    find_nearby_objects_impl(&req, &store, &comets)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::catalog::resolve_assets_dir;
    use crate::engine::time::ymd_hms_to_jd;

    fn test_store() -> CatalogStore {
        let dir = resolve_assets_dir(None).expect("assets dir");
        CatalogStore::load_from_dir(&dir).expect("load catalogs")
    }

    #[test]
    fn precession_other_planet_and_other_star_frames() {
        let store = test_store();
        let jd_2026 = ymd_hms_to_jd(2026, 1, 1, 12, 0, 0.0);

        let prec = compute_sky_frame_impl(
            SkyFrameRequest {
                jd_ut: Some(jd_2026),
                lat_deg: 34.6431,
                lon_deg: 134.9972,
                alt_m: 10.0,
                tz_offset_min: 540,
                limiting_mag: 6.5,
                realism_level: 2,
                night_vision: false,
                refraction: true,
                view_mode: SkyViewMode::Precession,
                observer_body: None,
                origin_star_hip: None,
            },
            Some(&store),
            &[],
        );
        assert_eq!(prec.pole_track_north.len(), 61);
        assert_eq!(prec.pole_track_south.len(), 61);

        let mars = compute_sky_frame_impl(
            SkyFrameRequest {
                jd_ut: Some(jd_2026),
                lat_deg: 0.0,
                lon_deg: 0.0,
                alt_m: 0.0,
                tz_offset_min: 540,
                limiting_mag: 6.5,
                realism_level: 2,
                night_vision: false,
                refraction: false,
                view_mode: SkyViewMode::OtherPlanet,
                observer_body: Some(ObserverBody::Mars),
                origin_star_hip: None,
            },
            Some(&store),
            &[],
        );
        assert!(mars.j2000_to_enu_override.is_some());
        assert!(mars.bodies.iter().any(|b| b.id == "earth"));
        assert!(!mars.bodies.iter().any(|b| b.id == "mars"));

        let acen = compute_sky_frame_impl(
            SkyFrameRequest {
                jd_ut: Some(jd_2026),
                lat_deg: 34.6431,
                lon_deg: 134.9972,
                alt_m: 10.0,
                tz_offset_min: 540,
                limiting_mag: 6.5,
                realism_level: 0,
                night_vision: false,
                refraction: true,
                view_mode: SkyViewMode::OtherStar,
                observer_body: None,
                origin_star_hip: Some(71_683),
            },
            Some(&store),
            &[],
        );
        let sol = acen.sol_from_other_star.expect("Sol visible from Alpha Cen");
        assert!(sol.mag < 1.0 && sol.mag > 0.0);
        assert!(sol.dist_ly > 4.0 && sol.dist_ly < 5.0);
    }

    #[test]
    fn special_times_details_search_and_nearby_work() {
        let store = test_store();
        let jd = ymd_hms_to_jd(2026, 1, 1, 13, 0, 0.0); // 22:00 JST

        let day = get_day_special_times_impl(DayTimesRequest {
            jd_ut: jd,
            lat_deg: 34.6431,
            lon_deg: 134.9972,
            alt_m: 10.0,
            tz_offset_min: 540,
            year: None,
            month: None,
            day: None,
        });
        assert_eq!(day.date_str, "2026-01-01");
        assert!(day.sunrise_str.as_deref() == Some("07:07"));
        assert!(day.astro_dawn_jd_ut.is_some());

        let search_ori = search_sky_objects_impl(
            &SearchRequest {
                query: "オリオン".into(),
                category: "all".into(),
                mag_max: None,
                ra_min_h: None,
                ra_max_h: None,
                only_variables: false,
                jd_ut: jd,
                lat_deg: 34.6431,
                lon_deg: 134.9972,
                refraction: true,
                limit: Some(20),
            },
            &store,
            &[],
        );
        assert!(search_ori.iter().any(|r| r.id == "Ori" || r.id == "M42"));

        let m42 = search_ori.iter().find(|r| r.id == "M42").expect("M42 found");
        let details = get_object_details_impl(
            ObjectDetailRequest {
                kind: m42.kind.clone(),
                id: m42.id.clone(),
                ra_deg: m42.ra_deg,
                dec_deg: m42.dec_deg,
                jd_ut: jd,
                lat_deg: 34.6431,
                lon_deg: 134.9972,
                alt_m: 10.0,
                tz_offset_min: 540,
            },
            Some(&store),
            None,
        );
        assert_eq!(details.altitude_curve.len(), 49);
        assert!(details.max_alt_deg > 45.0);

        let nearby = find_nearby_objects_impl(
            &NearbyRequest {
                ra_deg: m42.ra_deg,
                dec_deg: m42.dec_deg,
                radius_deg: 10.0,
                jd_ut: jd,
                lat_deg: 34.6431,
                lon_deg: 134.9972,
                limiting_mag: 6.5,
                refraction: true,
            },
            &store,
            &[],
        );
        assert!(!nearby.is_empty());
        assert!(nearby.windows(2).all(|w| w[0].angular_sep_deg <= w[1].angular_sep_deg));
    }
}
