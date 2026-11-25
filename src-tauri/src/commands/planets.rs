use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::calendar::format_local_hm;
use crate::engine::catalog::CatalogStore;
use crate::engine::comet::{CometElements, comet_ephemeris, sample_comet_orbit_j2000_au};
use crate::engine::comet_db::CometDb;
use crate::engine::coords::{
    Equatorial, apply_standard_refraction, equatorial_to_horizontal, wrap_deg_180, wrap_deg_360,
};
use crate::engine::ephemeris::{
    DwarfPlanet, Planet, body_ephemeris, dwarf_planet_ephemeris, earth_helio_j2000_au,
    ecliptic_vec_to_equatorial_vec, geocentric_to_topocentric, moon_apparent_ecliptic_lon_deg,
    moon_ephemeris, planet_ephemeris, saturn_ring_tilt_deg, sun_apparent_ecliptic_lon_deg,
    sun_ephemeris,
};
use crate::engine::precession::OBLIQUITY_J2000_DEG;
use crate::engine::jupiter_sat::{
    GalileanMoonPosition, GrsTransitEvent, JupiterPhysicalEphemeris, galilean_moons_at,
    jupiter_physical_ephemeris, upcoming_grs_transits,
};
use crate::engine::saturn_sat::{
    SaturnMoonPosition, SaturnPhysicalEphemeris, TitanElongationEvent, saturn_moon_x_at,
    saturn_moons_at, upcoming_titan_elongations,
};
use crate::engine::phenomena::{
    search_planet_clusters, search_planet_planet_conjunctions, search_planet_star_conjunctions,
    search_planetary_phenomena,
};
use crate::engine::rise_set::{
    ObserverLocation, RiseSetStatus, equatorial_j2000_rise_set, moon_rise_set, planet_rise_set,
    sun_rise_set,
};
use crate::engine::time::{jd_to_ymd_hms, last_deg, ut_to_tt_jd};

fn parse_planet_id(id: &str) -> Option<Planet> {
    match id.trim().to_ascii_lowercase().as_str() {
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

fn format_local_datetime(jd_ut: f64, tz_offset_min: i32) -> String {
    let local_jd = jd_ut + f64::from(tz_offset_min) / 1440.0 + (0.5 / 1440.0);
    let (y, m, d, h, min, _) = jd_to_ymd_hms(local_jd);
    format!("{y:04}-{m:02}-{d:02} {h:02}:{min:02}")
}

fn format_local_md(jd_ut: f64, tz_offset_min: i32) -> String {
    let local_jd = jd_ut + f64::from(tz_offset_min) / 1440.0;
    let (_, m, d, _, _, _) = jd_to_ymd_hms(local_jd);
    format!("{m}/{d}")
}

fn parallactic_angle_deg(eq: Equatorial, lat_deg: f64, last_deg_val: f64) -> f64 {
    let ha = wrap_deg_180(last_deg_val - eq.ra_deg).to_radians();
    let phi = lat_deg.to_radians();
    let dec = eq.dec_deg.to_radians();
    let y = ha.sin();
    let x = phi.tan() * dec.cos() - dec.sin() * ha.cos();
    y.atan2(x).to_degrees()
}

fn bright_limb_position_angle_deg(body_eq: Equatorial, sun_eq: Equatorial) -> f64 {
    let a_b = body_eq.ra_deg.to_radians();
    let d_b = body_eq.dec_deg.to_radians();
    let a_s = sun_eq.ra_deg.to_radians();
    let d_s = sun_eq.dec_deg.to_radians();
    let y = d_s.cos() * (a_s - a_b).sin();
    let x = d_b.cos() * d_s.sin() - d_b.sin() * d_s.cos() * (a_s - a_b).cos();
    wrap_deg_360(y.atan2(x).to_degrees())
}

fn pole_pa_for_coords(ra_pole_deg: f64, dec_pole_deg: f64, body_j2000: Equatorial) -> f64 {
    let ap = ra_pole_deg.to_radians();
    let dp = dec_pole_deg.to_radians();
    let aj = body_j2000.ra_deg.to_radians();
    let dj = body_j2000.dec_deg.to_radians();
    wrap_deg_360(
        (dp.cos() * (ap - aj).sin())
            .atan2(dp.sin() * dj.cos() - dp.cos() * dj.sin() * (ap - aj).cos())
            .to_degrees(),
    )
}

// =========================================================================
// 1. Overview table
// =========================================================================

#[derive(Debug, Clone, Deserialize)]
pub struct PlanetOverviewRequest {
    pub jd_ut: f64,
    pub lat_deg: f64,
    pub lon_deg: f64,
    pub alt_m: f64,
    pub tz_offset_min: i32,
}

#[derive(Debug, Clone, Serialize)]
pub struct PlanetOverviewItem {
    pub id: String,
    pub kind: String,
    pub name_ja: String,
    pub name_en: String,
    pub ra_deg: f64,
    pub dec_deg: f64,
    pub az_deg: f64,
    pub alt_deg: f64,
    pub mag: f64,
    pub geo_au: f64,
    pub helio_au: f64,
    pub elongation_deg: f64,
    pub phase_angle_deg: f64,
    pub illuminated_fraction: f64,
    pub angular_diameter_arcsec: f64,
    pub saturn_ring_tilt_deg: Option<f64>,
    pub rise_str: Option<String>,
    pub transit_str: Option<String>,
    pub set_str: Option<String>,
    pub status_ja: String,
}

fn rs_status_ja(status: RiseSetStatus) -> &'static str {
    match status {
        RiseSetStatus::Normal => "出没",
        RiseSetStatus::Circumpolar => "周極",
        RiseSetStatus::NeverRises => "不昇",
    }
}

pub fn get_planets_overview_impl(req: &PlanetOverviewRequest) -> Vec<PlanetOverviewItem> {
    let jd_tt = ut_to_tt_jd(req.jd_ut);
    let lst = last_deg(req.jd_ut, req.lon_deg);
    let local_jd = req.jd_ut + f64::from(req.tz_offset_min) / 1440.0;
    let (y, m, d, _, _, _) = jd_to_ymd_hms(local_jd);
    let loc = ObserverLocation {
        lat_deg: req.lat_deg,
        lon_deg: req.lon_deg,
        alt_m: req.alt_m,
        tz_offset_min: req.tz_offset_min,
    };

    let sun = sun_ephemeris(jd_tt);
    let sun_rs = sun_rise_set(&loc, y, m, d);
    let sun_hor = equatorial_to_horizontal(
        geocentric_to_topocentric(sun.eq_apparent, sun.geo_au, req.lat_deg, req.alt_m, lst),
        req.lat_deg,
        lst,
    );

    let moon = moon_ephemeris(jd_tt);
    let moon_rs = moon_rise_set(&loc, y, m, d);
    let moon_hor = equatorial_to_horizontal(
        geocentric_to_topocentric(moon.eq_apparent, moon.geo_au, req.lat_deg, req.alt_m, lst),
        req.lat_deg,
        lst,
    );

    let mut out = vec![
        PlanetOverviewItem {
            id: "sun".into(),
            kind: "sun".into(),
            name_ja: "太陽".into(),
            name_en: "Sun".into(),
            ra_deg: sun.eq_apparent.ra_deg,
            dec_deg: sun.eq_apparent.dec_deg,
            az_deg: sun_hor.az_deg,
            alt_deg: apply_standard_refraction(sun_hor.alt_deg),
            mag: sun.visual_magnitude,
            geo_au: sun.geo_au,
            helio_au: 0.0,
            elongation_deg: 0.0,
            phase_angle_deg: 0.0,
            illuminated_fraction: 1.0,
            angular_diameter_arcsec: sun.angular_diameter_arcsec,
            saturn_ring_tilt_deg: None,
            rise_str: format_local_hm(sun_rs.rise_jd_ut, req.tz_offset_min),
            transit_str: format_local_hm(sun_rs.transit_jd_ut, req.tz_offset_min),
            set_str: format_local_hm(sun_rs.set_jd_ut, req.tz_offset_min),
            status_ja: rs_status_ja(sun_rs.status).into(),
        },
        PlanetOverviewItem {
            id: "moon".into(),
            kind: "moon".into(),
            name_ja: "月".into(),
            name_en: "Moon".into(),
            ra_deg: moon.eq_apparent.ra_deg,
            dec_deg: moon.eq_apparent.dec_deg,
            az_deg: moon_hor.az_deg,
            alt_deg: apply_standard_refraction(moon_hor.alt_deg),
            mag: moon.visual_magnitude,
            geo_au: moon.geo_au,
            helio_au: sun.geo_au,
            elongation_deg: moon.elongation_deg,
            phase_angle_deg: moon.phase_angle_deg,
            illuminated_fraction: moon.illuminated_fraction,
            angular_diameter_arcsec: moon.angular_diameter_arcsec,
            saturn_ring_tilt_deg: None,
            rise_str: format_local_hm(moon_rs.rise_jd_ut, req.tz_offset_min),
            transit_str: format_local_hm(moon_rs.transit_jd_ut, req.tz_offset_min),
            set_str: format_local_hm(moon_rs.set_jd_ut, req.tz_offset_min),
            status_ja: rs_status_ja(moon_rs.status).into(),
        },
    ];

    for p in Planet::ALL {
        let eph = planet_ephemeris(p, jd_tt);
        let rs = planet_rise_set(p, &loc, y, m, d);
        let hor = equatorial_to_horizontal(
            geocentric_to_topocentric(eph.eq_apparent, eph.geo_au, req.lat_deg, req.alt_m, lst),
            req.lat_deg,
            lst,
        );
        let name_en = match p {
            Planet::Mercury => "Mercury",
            Planet::Venus => "Venus",
            Planet::Mars => "Mars",
            Planet::Jupiter => "Jupiter",
            Planet::Saturn => "Saturn",
            Planet::Uranus => "Uranus",
            Planet::Neptune => "Neptune",
        };
        let ring = (p == Planet::Saturn).then(|| saturn_ring_tilt_deg(eph.geo_xyz_j2000_au));
        out.push(PlanetOverviewItem {
            id: crate::engine::phenomena::planet_id_str(p).into(),
            kind: "planet".into(),
            name_ja: p.name_ja().into(),
            name_en: name_en.into(),
            ra_deg: eph.eq_apparent.ra_deg,
            dec_deg: eph.eq_apparent.dec_deg,
            az_deg: hor.az_deg,
            alt_deg: apply_standard_refraction(hor.alt_deg),
            mag: eph.visual_magnitude,
            geo_au: eph.geo_au,
            helio_au: eph.helio_au,
            elongation_deg: eph.elongation_deg,
            phase_angle_deg: eph.phase_angle_deg,
            illuminated_fraction: eph.illuminated_fraction,
            angular_diameter_arcsec: eph.angular_diameter_arcsec,
            saturn_ring_tilt_deg: ring,
            rise_str: format_local_hm(rs.rise_jd_ut, req.tz_offset_min),
            transit_str: format_local_hm(rs.transit_jd_ut, req.tz_offset_min),
            set_str: format_local_hm(rs.set_jd_ut, req.tz_offset_min),
            status_ja: rs_status_ja(rs.status).into(),
        });
    }

    for (dp, id, en) in [
        (DwarfPlanet::Pluto, "pluto", "Pluto"),
        (DwarfPlanet::Eris, "eris", "Eris"),
    ] {
        let eph = dwarf_planet_ephemeris(dp, jd_tt);
        let rs = equatorial_j2000_rise_set(eph.eq_j2000, &loc, y, m, d);
        let hor = equatorial_to_horizontal(
            geocentric_to_topocentric(eph.eq_apparent, eph.geo_au, req.lat_deg, req.alt_m, lst),
            req.lat_deg,
            lst,
        );
        out.push(PlanetOverviewItem {
            id: id.into(),
            kind: "dwarf_planet".into(),
            name_ja: dp.name_ja().into(),
            name_en: en.into(),
            ra_deg: eph.eq_apparent.ra_deg,
            dec_deg: eph.eq_apparent.dec_deg,
            az_deg: hor.az_deg,
            alt_deg: apply_standard_refraction(hor.alt_deg),
            mag: eph.visual_magnitude,
            geo_au: eph.geo_au,
            helio_au: eph.helio_au,
            elongation_deg: eph.elongation_deg,
            phase_angle_deg: eph.phase_angle_deg,
            illuminated_fraction: eph.illuminated_fraction,
            angular_diameter_arcsec: eph.angular_diameter_arcsec,
            saturn_ring_tilt_deg: None,
            rise_str: format_local_hm(rs.rise_jd_ut, req.tz_offset_min),
            transit_str: format_local_hm(rs.transit_jd_ut, req.tz_offset_min),
            set_str: format_local_hm(rs.set_jd_ut, req.tz_offset_min),
            status_ja: rs_status_ja(rs.status).into(),
        });
    }

    out
}

#[tauri::command]
pub fn get_planets_overview(req: PlanetOverviewRequest) -> Vec<PlanetOverviewItem> {
    get_planets_overview_impl(&req)
}

// =========================================================================
// 2. Detailed disk appearance (Planet Shape tab)
// =========================================================================

#[derive(Debug, Clone, Deserialize)]
pub struct PlanetAppearanceRequest {
    pub planet_id: String,
    pub jd_ut: f64,
    pub lat_deg: f64,
    pub lon_deg: f64,
    pub alt_m: f64,
    #[serde(default = "default_grs_lon")]
    pub grs_sys2_lon_deg: f64,
}

fn default_grs_lon() -> f64 {
    65.0
}

#[derive(Debug, Clone, Serialize)]
pub struct PlanetAppearanceData {
    pub id: String,
    pub name_ja: String,
    pub jd_ut: f64,
    pub ra_deg: f64,
    pub dec_deg: f64,
    pub az_deg: f64,
    pub alt_deg: f64,
    pub mag: f64,
    pub geo_au: f64,
    pub angular_diameter_arcsec: f64,
    pub phase_angle_deg: f64,
    pub illuminated_fraction: f64,
    pub elongation_deg: f64,
    pub waxing: bool,
    pub bright_limb_pa_deg: f64,
    pub parallactic_angle_deg: f64,
    pub pole_pa_deg: Option<f64>,
    pub saturn_ring_tilt_deg: Option<f64>,
    pub jupiter_phys: Option<JupiterPhysicalEphemeris>,
    pub galilean_moons: Vec<GalileanMoonPosition>,
    pub moon_age_days: Option<f64>,
}

pub fn get_planet_appearance_impl(req: &PlanetAppearanceRequest) -> PlanetAppearanceData {
    let jd_tt = ut_to_tt_jd(req.jd_ut);
    let lst = last_deg(req.jd_ut, req.lon_deg);
    let sun = sun_ephemeris(jd_tt);
    let id = req.planet_id.trim().to_ascii_lowercase();

    if id == "moon" {
        let m = moon_ephemeris(jd_tt);
        let hor = equatorial_to_horizontal(
            geocentric_to_topocentric(m.eq_apparent, m.geo_au, req.lat_deg, req.alt_m, lst),
            req.lat_deg,
            lst,
        );
        let lon_diff =
            wrap_deg_360(moon_apparent_ecliptic_lon_deg(jd_tt) - sun_apparent_ecliptic_lon_deg(jd_tt));
        return PlanetAppearanceData {
            id: "moon".into(),
            name_ja: "月".into(),
            jd_ut: req.jd_ut,
            ra_deg: m.eq_apparent.ra_deg,
            dec_deg: m.eq_apparent.dec_deg,
            az_deg: hor.az_deg,
            alt_deg: apply_standard_refraction(hor.alt_deg),
            mag: m.visual_magnitude,
            geo_au: m.geo_au,
            angular_diameter_arcsec: m.angular_diameter_arcsec,
            phase_angle_deg: m.phase_angle_deg,
            illuminated_fraction: m.illuminated_fraction,
            elongation_deg: m.elongation_deg,
            waxing: lon_diff < 180.0,
            bright_limb_pa_deg: m.position_angle_bright_limb_deg,
            parallactic_angle_deg: parallactic_angle_deg(m.eq_apparent, req.lat_deg, lst),
            pole_pa_deg: Some(0.0),
            saturn_ring_tilt_deg: None,
            jupiter_phys: None,
            galilean_moons: Vec::new(),
            moon_age_days: Some(m.age_days),
        };
    }

    let planet = parse_planet_id(&id).unwrap_or(Planet::Jupiter);
    let eph = planet_ephemeris(planet, jd_tt);
    let hor = equatorial_to_horizontal(
        geocentric_to_topocentric(eph.eq_apparent, eph.geo_au, req.lat_deg, req.alt_m, lst),
        req.lat_deg,
        lst,
    );
    let sun_lon = sun_apparent_ecliptic_lon_deg(jd_tt);
    let waxing = wrap_deg_360(eph.ecliptic_apparent.lon_deg - sun_lon) < 180.0;
    let bright_limb_pa_deg = bright_limb_position_angle_deg(eph.eq_apparent, sun.eq_apparent);
    let parallactic = parallactic_angle_deg(eph.eq_apparent, req.lat_deg, lst);

    let (pole_pa_deg, saturn_ring_tilt, jup_phys, moons) = match planet {
        Planet::Mars => (
            Some(pole_pa_for_coords(317.681, 52.886, eph.eq_j2000)),
            None,
            None,
            Vec::new(),
        ),
        Planet::Saturn => (
            Some(pole_pa_for_coords(40.589, 83.537, eph.eq_j2000)),
            Some(saturn_ring_tilt_deg(eph.geo_xyz_j2000_au)),
            None,
            Vec::new(),
        ),
        Planet::Jupiter => {
            let jp = jupiter_physical_ephemeris(jd_tt, req.grs_sys2_lon_deg);
            let gm = galilean_moons_at(jd_tt).to_vec();
            (Some(jp.pole_pa_deg), None, Some(jp), gm)
        }
        _ => (Some(0.0), None, None, Vec::new()),
    };

    PlanetAppearanceData {
        id: crate::engine::phenomena::planet_id_str(planet).into(),
        name_ja: planet.name_ja().into(),
        jd_ut: req.jd_ut,
        ra_deg: eph.eq_apparent.ra_deg,
        dec_deg: eph.eq_apparent.dec_deg,
        az_deg: hor.az_deg,
        alt_deg: apply_standard_refraction(hor.alt_deg),
        mag: eph.visual_magnitude,
        geo_au: eph.geo_au,
        angular_diameter_arcsec: eph.angular_diameter_arcsec,
        phase_angle_deg: eph.phase_angle_deg,
        illuminated_fraction: eph.illuminated_fraction,
        elongation_deg: eph.elongation_deg,
        waxing,
        bright_limb_pa_deg,
        parallactic_angle_deg: parallactic,
        pole_pa_deg,
        saturn_ring_tilt_deg: saturn_ring_tilt,
        jupiter_phys: jup_phys,
        galilean_moons: moons,
        moon_age_days: None,
    }
}

#[tauri::command]
pub fn get_planet_appearance(req: PlanetAppearanceRequest) -> PlanetAppearanceData {
    get_planet_appearance_impl(&req)
}

// =========================================================================
// 3. Planet Sky Track
// =========================================================================

#[derive(Debug, Clone, Deserialize)]
pub struct PlanetTrackRequest {
    pub planet_id: String,
    pub start_jd_ut: f64,
    pub days: f64,
    pub step_hours: f64,
    pub lat_deg: f64,
    pub lon_deg: f64,
    pub alt_m: f64,
    pub tz_offset_min: i32,
}

#[derive(Debug, Clone, Serialize)]
pub struct PlanetTrackPoint {
    pub jd_ut: f64,
    pub date_label: String,
    pub ra_deg: f64,
    pub dec_deg: f64,
    pub az_deg: f64,
    pub alt_deg: f64,
    pub mag: f64,
    pub elongation_deg: f64,
    pub illuminated_fraction: f64,
    pub angular_diameter_arcsec: f64,
    pub waxing: bool,
    pub is_retrograde: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct PlanetTrackResult {
    pub id: String,
    pub name_ja: String,
    pub points: Vec<PlanetTrackPoint>,
}

pub fn get_planet_track_impl(req: &PlanetTrackRequest) -> PlanetTrackResult {
    let span = req.days.clamp(1.0, 1500.0);
    let step_days = (req.step_hours.clamp(1.0, 240.0)) / 24.0;
    let count = ((span / step_days).ceil() as usize).clamp(2, 420);
    let id = req.planet_id.trim().to_ascii_lowercase();
    let planet = parse_planet_id(&id);

    let name_ja = if id == "moon" {
        "月".to_owned()
    } else if id == "pluto" {
        "冥王星".to_owned()
    } else {
        planet.unwrap_or(Planet::Mars).name_ja().to_owned()
    };

    let eval = |jd_ut: f64| {
        let tt = ut_to_tt_jd(jd_ut);
        let eph = if id == "moon" {
            let m = moon_ephemeris(tt);
            let sun = sun_ephemeris(tt);
            let mut b = body_ephemeris(crate::engine::ephemeris::SolarSystemBody::Moon, tt);
            let _ = sun;
            b.eq_apparent = m.eq_apparent;
            b
        } else if id == "pluto" {
            dwarf_planet_ephemeris(DwarfPlanet::Pluto, tt)
        } else {
            planet_ephemeris(planet.unwrap_or(Planet::Mars), tt)
        };
        let sun_lon = sun_apparent_ecliptic_lon_deg(tt);
        let waxing = wrap_deg_360(eph.ecliptic_apparent.lon_deg - sun_lon) < 180.0;
        (eph, waxing)
    };

    let points: Vec<PlanetTrackPoint> = (0..=count)
        .into_par_iter()
        .map(|i| {
            let jd = req.start_jd_ut + (i as f64) * step_days;
            let (eph, waxing) = eval(jd);
            let (eph_prev, _) = eval(jd - 0.15);
            let (eph_next, _) = eval(jd + 0.15);
            let dra = wrap_deg_180(eph_next.eq_apparent.ra_deg - eph_prev.eq_apparent.ra_deg);

            let lst = last_deg(jd, req.lon_deg);
            let topo = geocentric_to_topocentric(
                eph.eq_apparent,
                eph.geo_au,
                req.lat_deg,
                req.alt_m,
                lst,
            );
            let hor = equatorial_to_horizontal(topo, req.lat_deg, lst);
            PlanetTrackPoint {
                jd_ut: jd,
                date_label: format_local_md(jd, req.tz_offset_min),
                ra_deg: eph.eq_apparent.ra_deg,
                dec_deg: eph.eq_apparent.dec_deg,
                az_deg: hor.az_deg,
                alt_deg: apply_standard_refraction(hor.alt_deg),
                mag: eph.visual_magnitude,
                elongation_deg: eph.elongation_deg,
                illuminated_fraction: eph.illuminated_fraction,
                angular_diameter_arcsec: eph.angular_diameter_arcsec,
                waxing,
                is_retrograde: dra < 0.0,
            }
        })
        .collect();

    PlanetTrackResult { id, name_ja, points }
}

#[tauri::command]
pub fn get_planet_track(req: PlanetTrackRequest) -> PlanetTrackResult {
    get_planet_track_impl(&req)
}

// =========================================================================
// 4. Inner Planet Solar Offset (ΔRA, ΔDec relative to Sun)
// =========================================================================

#[derive(Debug, Clone, Deserialize)]
pub struct InnerOffsetRequest {
    pub planet_id: String,
    pub start_jd_ut: f64,
    pub days: f64,
    pub step_days: f64,
    pub tz_offset_min: i32,
}

#[derive(Debug, Clone, Serialize)]
pub struct InnerPlanetOffsetSample {
    pub jd_ut: f64,
    pub date_label: String,
    pub delta_ra_deg: f64,
    pub delta_dec_deg: f64,
    pub elongation_deg: f64,
    pub illuminated_fraction: f64,
    pub angular_diameter_arcsec: f64,
    pub waxing: bool,
    pub mag: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct InnerPlanetOffsetResult {
    pub planet_id: String,
    pub name_ja: String,
    pub samples: Vec<InnerPlanetOffsetSample>,
}

pub fn get_inner_planet_sun_offset_impl(req: &InnerOffsetRequest) -> InnerPlanetOffsetResult {
    let planet = match req.planet_id.trim().to_ascii_lowercase().as_str() {
        "mercury" => Planet::Mercury,
        _ => Planet::Venus,
    };
    let span = req.days.clamp(10.0, 900.0);
    let step = req.step_days.clamp(0.5, 10.0);
    let count = ((span / step).ceil() as usize).clamp(10, 320);

    let samples: Vec<InnerPlanetOffsetSample> = (0..=count)
        .into_par_iter()
        .map(|i| {
            let jd = req.start_jd_ut + (i as f64) * step;
            let tt = ut_to_tt_jd(jd);
            let eph = planet_ephemeris(planet, tt);
            let sun = sun_ephemeris(tt);
            let sun_lon = sun.ecliptic_apparent.lon_deg;
            let waxing = wrap_deg_360(eph.ecliptic_apparent.lon_deg - sun_lon) < 180.0;
            InnerPlanetOffsetSample {
                jd_ut: jd,
                date_label: format_local_md(jd, req.tz_offset_min),
                delta_ra_deg: wrap_deg_180(eph.eq_apparent.ra_deg - sun.eq_apparent.ra_deg),
                delta_dec_deg: eph.eq_apparent.dec_deg - sun.eq_apparent.dec_deg,
                elongation_deg: eph.elongation_deg,
                illuminated_fraction: eph.illuminated_fraction,
                angular_diameter_arcsec: eph.angular_diameter_arcsec,
                waxing,
                mag: eph.visual_magnitude,
            }
        })
        .collect();

    InnerPlanetOffsetResult {
        planet_id: crate::engine::phenomena::planet_id_str(planet).into(),
        name_ja: planet.name_ja().into(),
        samples,
    }
}

#[tauri::command]
pub fn get_inner_planet_sun_offset(req: InnerOffsetRequest) -> InnerPlanetOffsetResult {
    get_inner_planet_sun_offset_impl(&req)
}

// =========================================================================
// 5. Magnitude Curve (Planets & Notable Comets)
// =========================================================================

#[derive(Debug, Clone, Deserialize)]
pub struct MagnitudeCurveRequest {
    pub body_ids: Vec<String>,
    pub start_jd_ut: f64,
    pub days: f64,
    pub tz_offset_min: i32,
}

#[derive(Debug, Clone, Serialize)]
pub struct MagnitudePoint {
    pub jd_ut: f64,
    pub date_label: String,
    pub mag: f64,
    pub elongation_deg: f64,
    pub geo_au: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct MagnitudeCurveSeries {
    pub id: String,
    pub name_ja: String,
    pub color: String,
    pub points: Vec<MagnitudePoint>,
}

pub fn get_magnitude_curve_impl(
    req: &MagnitudeCurveRequest,
    comets: &[CometElements],
) -> Vec<MagnitudeCurveSeries> {
    let span = req.days.clamp(14.0, 420.0);
    let sample_count = if span <= 40.0 {
        40
    } else if span <= 120.0 {
        60
    } else {
        90
    };
    let step = span / sample_count as f64;

    let series_color = |id: &str| -> &'static str {
        match id {
            "mercury" => "#cbd5e1",
            "venus" => "#fef08a",
            "mars" => "#fb7154",
            "jupiter" => "#fdba74",
            "saturn" => "#fde68a",
            "uranus" => "#67e8f9",
            "neptune" => "#60a5fa",
            "pluto" => "#a8a29e",
            _ => "#34d399",
        }
    };

    req.body_ids
        .par_iter()
        .filter_map(|raw_id| {
            let id = raw_id.trim();
            let lower = id.to_ascii_lowercase();
            let color = series_color(&lower).to_owned();

            if let Some(p) = parse_planet_id(&lower) {
                let pts = (0..=sample_count)
                    .map(|i| {
                        let jd = req.start_jd_ut + i as f64 * step;
                        let eph = planet_ephemeris(p, ut_to_tt_jd(jd));
                        MagnitudePoint {
                            jd_ut: jd,
                            date_label: format_local_md(jd, req.tz_offset_min),
                            mag: eph.visual_magnitude,
                            elongation_deg: eph.elongation_deg,
                            geo_au: eph.geo_au,
                        }
                    })
                    .collect();
                Some(MagnitudeCurveSeries {
                    id: lower,
                    name_ja: p.name_ja().into(),
                    color,
                    points: pts,
                })
            } else if lower == "pluto" {
                let pts = (0..=sample_count)
                    .map(|i| {
                        let jd = req.start_jd_ut + i as f64 * step;
                        let eph = dwarf_planet_ephemeris(DwarfPlanet::Pluto, ut_to_tt_jd(jd));
                        MagnitudePoint {
                            jd_ut: jd,
                            date_label: format_local_md(jd, req.tz_offset_min),
                            mag: eph.visual_magnitude,
                            elongation_deg: eph.elongation_deg,
                            geo_au: eph.geo_au,
                        }
                    })
                    .collect();
                Some(MagnitudeCurveSeries {
                    id: "pluto".into(),
                    name_ja: "冥王星".into(),
                    color,
                    points: pts,
                })
            } else if let Some(comet) = comets.iter().find(|c| c.id.eq_ignore_ascii_case(id)) {
                let pts = (0..=sample_count)
                    .map(|i| {
                        let jd = req.start_jd_ut + i as f64 * step;
                        let eph = comet_ephemeris(comet, ut_to_tt_jd(jd));
                        MagnitudePoint {
                            jd_ut: jd,
                            date_label: format_local_md(jd, req.tz_offset_min),
                            mag: eph.visual_magnitude,
                            elongation_deg: eph.elongation_deg,
                            geo_au: eph.geo_au,
                        }
                    })
                    .collect();
                Some(MagnitudeCurveSeries {
                    id: comet.id.clone(),
                    name_ja: comet.name.clone(),
                    color,
                    points: pts,
                })
            } else {
                None
            }
        })
        .collect()
}

#[tauri::command]
pub fn get_magnitude_curve(
    req: MagnitudeCurveRequest,
    comet_db: State<'_, CometDb>,
) -> Vec<MagnitudeCurveSeries> {
    let comets = comet_db.list_all_elements();
    get_magnitude_curve_impl(&req, &comets)
}

// =========================================================================
// 6. Planetary Phenomena Search Command
// =========================================================================

#[derive(Debug, Clone, Deserialize)]
pub struct SearchPhenomenaCmdRequest {
    pub start_jd_ut: f64,
    pub end_jd_ut: f64,
    pub planet_id: Option<String>,
    pub lat_deg: f64,
    pub lon_deg: f64,
    pub alt_m: f64,
    pub tz_offset_min: i32,
}

#[derive(Debug, Clone, Serialize)]
pub struct PlanetaryPhenomenonRow {
    pub planet_id: String,
    pub planet_name_ja: String,
    pub kind: String,
    pub kind_ja: String,
    pub jd_ut: f64,
    pub time_str: String,
    pub ra_deg: f64,
    pub dec_deg: f64,
    pub az_deg: f64,
    pub alt_deg: f64,
    pub mag: f64,
    pub elongation_deg: f64,
    pub detail_ja: String,
}

pub fn search_planet_phenomena_cmd_impl(
    req: &SearchPhenomenaCmdRequest,
) -> Vec<PlanetaryPhenomenonRow> {
    let filter = req.planet_id.as_deref().and_then(parse_planet_id);
    let raw = search_planetary_phenomena(req.start_jd_ut, req.end_jd_ut, filter);
    raw.into_iter()
        .map(|ev| {
            let lst = last_deg(ev.jd_ut, req.lon_deg);
            let hor = equatorial_to_horizontal(
                Equatorial {
                    ra_deg: ev.ra_deg,
                    dec_deg: ev.dec_deg,
                },
                req.lat_deg,
                lst,
            );
            PlanetaryPhenomenonRow {
                planet_id: ev.planet_id,
                planet_name_ja: ev.planet_name_ja,
                kind: ev.kind,
                kind_ja: ev.kind_ja,
                jd_ut: ev.jd_ut,
                time_str: format_local_datetime(ev.jd_ut, req.tz_offset_min),
                ra_deg: ev.ra_deg,
                dec_deg: ev.dec_deg,
                az_deg: hor.az_deg,
                alt_deg: apply_standard_refraction(hor.alt_deg),
                mag: ev.mag,
                elongation_deg: ev.elongation_deg,
                detail_ja: ev.detail_ja,
            }
        })
        .collect()
}

#[tauri::command]
pub fn search_planet_phenomena_cmd(req: SearchPhenomenaCmdRequest) -> Vec<PlanetaryPhenomenonRow> {
    search_planet_phenomena_cmd_impl(&req)
}

// =========================================================================
// 7. Conjunctions & Clusters Search Command
// =========================================================================

#[derive(Debug, Clone, Deserialize)]
pub struct SearchConjunctionsRequest {
    pub mode: String, // "planet_planet" | "planet_cluster" | "planet_star"
    pub start_jd_ut: f64,
    pub end_jd_ut: f64,
    pub max_sep_deg: f64,
    pub include_moon: bool,
    pub min_cluster_count: usize,
    pub star_hip: Option<u32>,
    pub lat_deg: f64,
    pub lon_deg: f64,
    pub tz_offset_min: i32,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConjunctionRow {
    pub kind: String,
    pub title_ja: String,
    pub jd_ut: f64,
    pub time_str: String,
    pub separation_deg: f64,
    pub ra_deg: f64,
    pub dec_deg: f64,
    pub az_deg: f64,
    pub alt_deg: f64,
    pub bodies: Vec<String>,
    pub detail_ja: String,
}

pub fn search_conjunctions_cmd_impl(
    req: &SearchConjunctionsRequest,
    store: &CatalogStore,
) -> Vec<ConjunctionRow> {
    let raw = match req.mode.trim() {
        "planet_cluster" => search_planet_clusters(
            req.start_jd_ut,
            req.end_jd_ut,
            req.max_sep_deg.max(5.0),
            req.min_cluster_count.max(3),
        ),
        "planet_star" => search_planet_star_conjunctions(
            req.start_jd_ut,
            req.end_jd_ut,
            req.max_sep_deg.max(0.5),
            req.star_hip,
            store,
        ),
        _ => search_planet_planet_conjunctions(
            req.start_jd_ut,
            req.end_jd_ut,
            req.max_sep_deg.max(0.5),
            req.include_moon,
        ),
    };

    raw.into_iter()
        .map(|c| {
            let lst = last_deg(c.jd_ut, req.lon_deg);
            let hor = equatorial_to_horizontal(
                Equatorial {
                    ra_deg: c.center_ra_deg,
                    dec_deg: c.center_dec_deg,
                },
                req.lat_deg,
                lst,
            );
            ConjunctionRow {
                kind: c.kind,
                title_ja: c.title_ja,
                jd_ut: c.jd_ut,
                time_str: format_local_datetime(c.jd_ut, req.tz_offset_min),
                separation_deg: c.separation_deg,
                ra_deg: c.center_ra_deg,
                dec_deg: c.center_dec_deg,
                az_deg: hor.az_deg,
                alt_deg: apply_standard_refraction(hor.alt_deg),
                bodies: c.bodies,
                detail_ja: c.detail_ja,
            }
        })
        .collect()
}

#[tauri::command]
pub fn search_conjunctions_cmd(
    req: SearchConjunctionsRequest,
    store: State<'_, CatalogStore>,
) -> Vec<ConjunctionRow> {
    search_conjunctions_cmd_impl(&req, &store)
}

// =========================================================================
// 8. Galilean Moons Wave Curve & GRS Transits
// =========================================================================

#[derive(Debug, Clone, Deserialize)]
pub struct GalileanViewRequest {
    pub jd_ut: f64,
    pub span_days: f64,
    #[serde(default = "default_grs_lon")]
    pub grs_sys2_lon_deg: f64,
    pub lat_deg: f64,
    pub lon_deg: f64,
    pub alt_m: f64,
    pub tz_offset_min: i32,
}

#[derive(Debug, Clone, Serialize)]
pub struct GalileanWaveSample {
    pub jd_ut: f64,
    pub time_label: String,
    pub io_x: f64,
    pub europa_x: f64,
    pub ganymede_x: f64,
    pub callisto_x: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct GalileanViewData {
    pub jd_ut: f64,
    pub physical: JupiterPhysicalEphemeris,
    pub moons: Vec<GalileanMoonPosition>,
    pub wave_samples: Vec<GalileanWaveSample>,
    pub grs_transits: Vec<GrsTransitEvent>,
}

pub fn get_galilean_moons_view_impl(req: &GalileanViewRequest) -> GalileanViewData {
    let jd_tt = ut_to_tt_jd(req.jd_ut);
    let physical = jupiter_physical_ephemeris(jd_tt, req.grs_sys2_lon_deg);
    let moons = galilean_moons_at(jd_tt).to_vec();

    let span = req.span_days.clamp(2.0, 35.0);
    let wave_start = req.jd_ut - span * 0.15;
    let total_hours = span * 24.0;
    let step_hours = if span <= 7.0 {
        1.5
    } else if span <= 16.0 {
        3.0
    } else {
        5.0
    };
    let steps = (total_hours / step_hours).ceil() as usize;

    let wave_samples: Vec<GalileanWaveSample> = (0..=steps)
        .into_par_iter()
        .map(|i| {
            let jd = wave_start + (f64::from(i as u32) * step_hours) / 24.0;
            let ms = galilean_moons_at(ut_to_tt_jd(jd));
            GalileanWaveSample {
                jd_ut: jd,
                time_label: format_local_md(jd, req.tz_offset_min),
                io_x: ms[0].x_rj,
                europa_x: ms[1].x_rj,
                ganymede_x: ms[2].x_rj,
                callisto_x: ms[3].x_rj,
            }
        })
        .collect();

    let loc = ObserverLocation {
        lat_deg: req.lat_deg,
        lon_deg: req.lon_deg,
        alt_m: req.alt_m,
        tz_offset_min: req.tz_offset_min,
    };
    let grs_transits = upcoming_grs_transits(req.jd_ut, 12, req.grs_sys2_lon_deg, &loc);

    GalileanViewData {
        jd_ut: req.jd_ut,
        physical,
        moons,
        wave_samples,
        grs_transits,
    }
}

#[tauri::command]
pub fn get_galilean_moons_view(req: GalileanViewRequest) -> GalileanViewData {
    get_galilean_moons_view_impl(&req)
}

// =========================================================================
// 8b. Saturnian Moons Wave Curve & Titan Elongations
// =========================================================================

#[derive(Debug, Clone, Deserialize)]
pub struct SaturnMoonsViewRequest {
    pub jd_ut: f64,
    pub span_days: f64,
    pub lat_deg: f64,
    pub lon_deg: f64,
    pub alt_m: f64,
    pub tz_offset_min: i32,
}

#[derive(Debug, Clone, Serialize)]
pub struct SaturnWaveSample {
    pub jd_ut: f64,
    pub time_label: String,
    pub mimas_x: f64,
    pub enceladus_x: f64,
    pub tethys_x: f64,
    pub dione_x: f64,
    pub rhea_x: f64,
    pub titan_x: f64,
    pub hyperion_x: f64,
    pub iapetus_x: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct SaturnMoonsViewData {
    pub jd_ut: f64,
    pub physical: SaturnPhysicalEphemeris,
    pub moons: Vec<SaturnMoonPosition>,
    pub wave_samples: Vec<SaturnWaveSample>,
    pub titan_elongations: Vec<TitanElongationEvent>,
}

pub fn get_saturn_moons_view_impl(req: &SaturnMoonsViewRequest) -> SaturnMoonsViewData {
    let jd_tt = ut_to_tt_jd(req.jd_ut);
    let (physical, moons) = saturn_moons_at(jd_tt);

    let span = req.span_days.clamp(2.0, 40.0);
    let wave_start = req.jd_ut - span * 0.15;
    let total_hours = span * 24.0;
    let step_hours = if span <= 8.0 {
        1.5
    } else if span <= 18.0 {
        3.0
    } else {
        6.0
    };
    let steps = (total_hours / step_hours).ceil() as usize;

    let wave_samples: Vec<SaturnWaveSample> = (0..=steps)
        .into_par_iter()
        .map(|i| {
            let jd = wave_start + (f64::from(i as u32) * step_hours) / 24.0;
            let xs = saturn_moon_x_at(ut_to_tt_jd(jd));
            SaturnWaveSample {
                jd_ut: jd,
                time_label: format_local_md(jd, req.tz_offset_min),
                mimas_x: xs[0],
                enceladus_x: xs[1],
                tethys_x: xs[2],
                dione_x: xs[3],
                rhea_x: xs[4],
                titan_x: xs[5],
                hyperion_x: xs[6],
                iapetus_x: xs[7],
            }
        })
        .collect();

    let loc = ObserverLocation {
        lat_deg: req.lat_deg,
        lon_deg: req.lon_deg,
        alt_m: req.alt_m,
        tz_offset_min: req.tz_offset_min,
    };
    let titan_elongations = upcoming_titan_elongations(req.jd_ut, 6, &loc);

    SaturnMoonsViewData {
        jd_ut: req.jd_ut,
        physical,
        moons,
        wave_samples,
        titan_elongations,
    }
}

#[tauri::command]
pub fn get_saturn_moons_view(req: SaturnMoonsViewRequest) -> SaturnMoonsViewData {
    get_saturn_moons_view_impl(&req)
}

// =========================================================================
// 9. Phase 6: 3D Solar System State (Planets, Dwarf Planets, Comets, Orbits)
// =========================================================================

#[derive(Debug, Clone, Deserialize)]
pub struct SolarSystem3DRequest {
    pub jd_ut: f64,
    pub include_orbits: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct SolarSystem3DBody {
    pub id: String,
    pub kind: String,
    pub name_ja: String,
    pub color: String,
    pub pos_xyz_au: [f64; 3],
    pub helio_au: f64,
    pub geo_au: f64,
    pub mag: f64,
    pub elongation_deg: f64,
    pub ra_deg: f64,
    pub dec_deg: f64,
    pub radius_hint: f64,
    pub orbit_xyz_au: Vec<[f64; 3]>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SolarSystem3DState {
    pub jd_ut: f64,
    pub bodies: Vec<SolarSystem3DBody>,
}

fn planet_orbital_period_days(p: Planet) -> f64 {
    match p {
        Planet::Mercury => 87.97,
        Planet::Venus => 224.70,
        Planet::Mars => 686.98,
        Planet::Jupiter => 4332.59,
        Planet::Saturn => 10_759.22,
        Planet::Uranus => 30_688.5,
        Planet::Neptune => 60_182.0,
    }
}

pub fn get_solar_system_3d_state_impl(
    req: &SolarSystem3DRequest,
    comets: &[CometElements],
) -> SolarSystem3DState {
    let tt = ut_to_tt_jd(req.jd_ut);
    let earth_xyz = earth_helio_j2000_au(tt);
    let sun_eph = sun_ephemeris(tt);
    let moon_eph = moon_ephemeris(tt);
    let moon_geo_eq = crate::engine::coords::spherical_to_vec3(
        moon_eph.eq_j2000.ra_deg,
        moon_eph.eq_j2000.dec_deg,
        moon_eph.geo_au,
    );
    let moon_geo_ecl = ecliptic_vec_to_equatorial_vec(moon_geo_eq, -OBLIQUITY_J2000_DEG);
    let moon_helio = earth_xyz + moon_geo_ecl;

    let mut bodies = vec![
        SolarSystem3DBody {
            id: "sun".into(),
            kind: "star".into(),
            name_ja: "太陽".into(),
            color: "#fbbf24".into(),
            pos_xyz_au: [0.0, 0.0, 0.0],
            helio_au: 0.0,
            geo_au: sun_eph.geo_au,
            mag: sun_eph.visual_magnitude,
            elongation_deg: 0.0,
            ra_deg: sun_eph.eq_apparent.ra_deg,
            dec_deg: sun_eph.eq_apparent.dec_deg,
            radius_hint: 2.8,
            orbit_xyz_au: Vec::new(),
        },
        SolarSystem3DBody {
            id: "earth".into(),
            kind: "planet".into(),
            name_ja: "地球".into(),
            color: "#38bdf8".into(),
            pos_xyz_au: [earth_xyz.x, earth_xyz.y, earth_xyz.z],
            helio_au: earth_xyz.norm(),
            geo_au: 0.0,
            mag: -3.8,
            elongation_deg: 0.0,
            ra_deg: 0.0,
            dec_deg: 0.0,
            radius_hint: 1.0,
            orbit_xyz_au: if req.include_orbits {
                (0..=180)
                    .map(|i| {
                        let t = tt + (f64::from(i) / 180.0) * 365.256;
                        let v = earth_helio_j2000_au(t);
                        [v.x, v.y, v.z]
                    })
                    .collect()
            } else {
                Vec::new()
            },
        },
        SolarSystem3DBody {
            id: "moon".into(),
            kind: "moon".into(),
            name_ja: "月".into(),
            color: "#e2e8f0".into(),
            pos_xyz_au: [moon_helio.x, moon_helio.y, moon_helio.z],
            helio_au: moon_helio.norm(),
            geo_au: moon_eph.geo_au,
            mag: moon_eph.visual_magnitude,
            elongation_deg: moon_eph.elongation_deg,
            ra_deg: moon_eph.eq_apparent.ra_deg,
            dec_deg: moon_eph.eq_apparent.dec_deg,
            radius_hint: 0.35,
            orbit_xyz_au: Vec::new(),
        },
    ];

    let specs = [
        (Planet::Mercury, "mercury", "#cbd5e1", 0.55),
        (Planet::Venus, "venus", "#fef08a", 0.92),
        (Planet::Mars, "mars", "#fb7154", 0.72),
        (Planet::Jupiter, "jupiter", "#fdba74", 1.75),
        (Planet::Saturn, "saturn", "#fde68a", 1.48),
        (Planet::Uranus, "uranus", "#67e8f9", 1.15),
        (Planet::Neptune, "neptune", "#60a5fa", 1.12),
    ];

    let planet_items: Vec<SolarSystem3DBody> = specs
        .into_par_iter()
        .map(|(p, id, col, rad)| {
            let e = planet_ephemeris(p, tt);
            let orbit_xyz_au = if req.include_orbits {
                let period = planet_orbital_period_days(p);
                let segs = 180;
                (0..=segs)
                    .map(|i| {
                        let t = tt + (f64::from(i) / f64::from(segs)) * period;
                        let v = planet_ephemeris(p, t).helio_xyz_j2000_au;
                        [v.x, v.y, v.z]
                    })
                    .collect()
            } else {
                Vec::new()
            };
            SolarSystem3DBody {
                id: id.into(),
                kind: "planet".into(),
                name_ja: p.name_ja().into(),
                color: col.into(),
                pos_xyz_au: [e.helio_xyz_j2000_au.x, e.helio_xyz_j2000_au.y, e.helio_xyz_j2000_au.z],
                helio_au: e.helio_au,
                geo_au: e.geo_au,
                mag: e.visual_magnitude,
                elongation_deg: e.elongation_deg,
                ra_deg: e.eq_apparent.ra_deg,
                dec_deg: e.eq_apparent.dec_deg,
                radius_hint: rad,
                orbit_xyz_au,
            }
        })
        .collect();
    bodies.extend(planet_items);

    for (dp, id, col, period) in [
        (DwarfPlanet::Pluto, "pluto", "#d6d3d1", 90_560.0),
        (DwarfPlanet::Eris, "eris", "#a5b4fc", 203_800.0),
    ] {
        let e = dwarf_planet_ephemeris(dp, tt);
        let orbit_xyz_au = if req.include_orbits {
            let segs = 200;
            (0..=segs)
                .map(|i| {
                    let t = tt + (f64::from(i) / f64::from(segs)) * period;
                    let v = dwarf_planet_ephemeris(dp, t).helio_xyz_j2000_au;
                    [v.x, v.y, v.z]
                })
                .collect()
        } else {
            Vec::new()
        };
        bodies.push(SolarSystem3DBody {
            id: id.into(),
            kind: "dwarf_planet".into(),
            name_ja: dp.name_ja().into(),
            color: col.into(),
            pos_xyz_au: [e.helio_xyz_j2000_au.x, e.helio_xyz_j2000_au.y, e.helio_xyz_j2000_au.z],
            helio_au: e.helio_au,
            geo_au: e.geo_au,
            mag: e.visual_magnitude,
            elongation_deg: e.elongation_deg,
            ra_deg: e.eq_apparent.ra_deg,
            dec_deg: e.eq_apparent.dec_deg,
            radius_hint: 0.45,
            orbit_xyz_au,
        });
    }

    for comet in comets {
        let ce = comet_ephemeris(comet, tt);
        let orbit_xyz_au = if req.include_orbits {
            sample_comet_orbit_j2000_au(comet, 480, 45.0)
        } else {
            Vec::new()
        };
        bodies.push(SolarSystem3DBody {
            id: comet.id.clone(),
            kind: "comet".into(),
            name_ja: comet.name.clone(),
            color: "#34d399".into(),
            pos_xyz_au: [
                ce.helio_xyz_j2000_au.x,
                ce.helio_xyz_j2000_au.y,
                ce.helio_xyz_j2000_au.z,
            ],
            helio_au: ce.helio_au,
            geo_au: ce.geo_au,
            mag: ce.visual_magnitude,
            elongation_deg: ce.elongation_deg,
            ra_deg: ce.eq_apparent.ra_deg,
            dec_deg: ce.eq_apparent.dec_deg,
            radius_hint: 0.48,
            orbit_xyz_au,
        });
    }

    SolarSystem3DState {
        jd_ut: req.jd_ut,
        bodies,
    }
}

#[tauri::command]
pub fn get_solar_system_3d_state(
    req: SolarSystem3DRequest,
    comet_db: State<'_, CometDb>,
) -> SolarSystem3DState {
    let comets = comet_db.list_enabled_elements();
    get_solar_system_3d_state_impl(&req, &comets)
}

#[cfg(test)]
mod tests {
    use crate::engine::catalog::resolve_assets_dir;
    use crate::engine::comet_db::default_comets;
    use crate::engine::time::ymd_hms_to_jd;

    use super::*;

    #[test]
    fn planet_commands_all_work_cleanly() {
        let jd = ymd_hms_to_jd(2026, 2, 1, 12, 0, 0.0);
        let ov = get_planets_overview_impl(&PlanetOverviewRequest {
            jd_ut: jd,
            lat_deg: 34.6431,
            lon_deg: 134.9972,
            alt_m: 10.0,
            tz_offset_min: 540,
        });
        assert_eq!(ov.len(), 11);

        let app = get_planet_appearance_impl(&PlanetAppearanceRequest {
            planet_id: "saturn".into(),
            jd_ut: jd,
            lat_deg: 34.6431,
            lon_deg: 134.9972,
            alt_m: 10.0,
            grs_sys2_lon_deg: 65.0,
        });
        assert!(app.saturn_ring_tilt_deg.is_some());

        let tr = get_planet_track_impl(&PlanetTrackRequest {
            planet_id: "mars".into(),
            start_jd_ut: jd,
            days: 60.0,
            step_hours: 48.0,
            lat_deg: 34.6431,
            lon_deg: 134.9972,
            alt_m: 10.0,
            tz_offset_min: 540,
        });
        assert!(tr.points.len() >= 30);

        let off = get_inner_planet_sun_offset_impl(&InnerOffsetRequest {
            planet_id: "venus".into(),
            start_jd_ut: jd,
            days: 90.0,
            step_days: 3.0,
            tz_offset_min: 540,
        });
        assert!(off.samples.len() >= 30);

        let default_comet_els: Vec<CometElements> =
            default_comets().into_iter().map(|c| c.to_elements()).collect();
        let mags = get_magnitude_curve_impl(
            &MagnitudeCurveRequest {
                body_ids: vec!["venus".into(), "mars".into(), "comet:2P".into()],
                start_jd_ut: jd,
                days: 90.0,
                tz_offset_min: 540,
            },
            &default_comet_els,
        );
        assert_eq!(mags.len(), 3);

        let g = get_galilean_moons_view_impl(&GalileanViewRequest {
            jd_ut: jd,
            span_days: 7.0,
            grs_sys2_lon_deg: 65.0,
            lat_deg: 34.6431,
            lon_deg: 134.9972,
            alt_m: 10.0,
            tz_offset_min: 540,
        });
        assert_eq!(g.moons.len(), 4);
        assert_eq!(g.grs_transits.len(), 12);
        assert!(!g.wave_samples.is_empty());

        let s = get_saturn_moons_view_impl(&SaturnMoonsViewRequest {
            jd_ut: jd,
            span_days: 16.0,
            lat_deg: 34.6431,
            lon_deg: 134.9972,
            alt_m: 10.0,
            tz_offset_min: 540,
        });
        assert_eq!(s.moons.len(), 8);
        assert!(!s.wave_samples.is_empty());
        assert!(!s.titan_elongations.is_empty());

        let dir = resolve_assets_dir(None).expect("assets dir");
        let store = CatalogStore::load_from_dir(&dir).expect("catalog load");
        let conj = search_conjunctions_cmd_impl(
            &SearchConjunctionsRequest {
                mode: "planet_planet".into(),
                start_jd_ut: jd,
                end_jd_ut: jd + 365.0,
                max_sep_deg: 5.0,
                include_moon: false,
                min_cluster_count: 3,
                star_hip: None,
                lat_deg: 34.6431,
                lon_deg: 134.9972,
                tz_offset_min: 540,
            },
            &store,
        );
        assert!(!conj.is_empty());

        let state_3d = get_solar_system_3d_state_impl(
            &SolarSystem3DRequest {
                jd_ut: jd,
                include_orbits: true,
            },
            &default_comet_els,
        );
        assert!(state_3d.bodies.len() >= 15);
        assert!(state_3d.bodies.iter().any(|b| b.id == "earth" && !b.orbit_xyz_au.is_empty()));
        assert!(state_3d.bodies.iter().any(|b| b.kind == "comet" && !b.orbit_xyz_au.is_empty()));
    }
}
