//! Mathematical forward/inverse sky projections for 9 modes (Phase 2).

use serde::{Deserialize, Serialize};

use crate::engine::coords::{
    Equatorial, Horizontal, Vec3, equatorial_to_horizontal, equatorial_to_vec3,
    horizontal_to_equatorial, vec3_to_equatorial, wrap_deg_180, wrap_deg_360,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectionMode {
    /// 1. 好きな方向 (Conformal stereographic, arbitrary Az/Alt center & zoomable FOV)
    FreeDirection,
    /// 2. 全球プラネタリウム (Azimuthal equidistant planisphere, zenith centered)
    AllSky,
    /// 3. 半球プラネタリウム（大1個） (Single conformal front hemisphere dome)
    HemisphereSingle,
    /// 4. 半球プラネタリウム（小2個） (Split left/right conformal hemisphere domes)
    HemisphereDual,
    /// 5. 全体表示 (360° equirectangular panorama)
    Panorama,
    /// 6. 星図形式 (Equatorial stereographic centered on RA/Dec)
    StarChart,
    /// 7. 地平線方向拡大 (Zoomed stereographic near the horizon)
    HorizonZoom,
    /// 8. 空の中ほど (Medium-elevation stereographic ~30°–60° altitude)
    MidSky,
    /// 9. 天頂方向 (Stereographic centered on the zenith)
    Zenith,
}

impl ProjectionMode {
    pub const ALL: [Self; 9] = [
        Self::FreeDirection,
        Self::AllSky,
        Self::HemisphereSingle,
        Self::HemisphereDual,
        Self::Panorama,
        Self::StarChart,
        Self::HorizonZoom,
        Self::MidSky,
        Self::Zenith,
    ];

    #[inline]
    pub fn is_equatorial(self) -> bool {
        matches!(self, Self::StarChart)
    }

    #[inline]
    pub fn default_fov_deg(self) -> f64 {
        match self {
            Self::FreeDirection | Self::Zenith => 90.0,
            Self::StarChart => 60.0,
            Self::HorizonZoom => 45.0,
            Self::MidSky => 65.0,
            Self::AllSky | Self::HemisphereSingle | Self::HemisphereDual => 180.0,
            Self::Panorama => 360.0,
        }
    }

    #[inline]
    pub fn effective_fov_deg(self, raw_fov_deg: f64) -> f64 {
        let f = if raw_fov_deg.is_finite() && raw_fov_deg > 0.0 {
            raw_fov_deg
        } else {
            self.default_fov_deg()
        };
        match self {
            Self::FreeDirection => f.clamp(1.0, 170.0),
            Self::HorizonZoom => f.clamp(2.0, 100.0),
            Self::MidSky => f.clamp(5.0, 120.0),
            Self::Zenith => f.clamp(10.0, 160.0),
            Self::StarChart => f.clamp(0.25, 140.0),
            Self::AllSky | Self::HemisphereSingle | Self::HemisphereDual => 180.0,
            Self::Panorama => 360.0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ProjectionParams {
    pub mode: ProjectionMode,
    pub width: f64,
    pub height: f64,
    pub center_az_deg: f64,
    pub center_alt_deg: f64,
    pub center_ra_deg: f64,
    pub center_dec_deg: f64,
    pub fov_deg: f64,
    pub zoom: f64,
    pub show_below_horizon: bool,
}

impl Default for ProjectionParams {
    fn default() -> Self {
        Self {
            mode: ProjectionMode::FreeDirection,
            width: 1280.0,
            height: 800.0,
            center_az_deg: 180.0,
            center_alt_deg: 30.0,
            center_ra_deg: 0.0,
            center_dec_deg: 20.0,
            fov_deg: 90.0,
            zoom: 1.0,
            show_below_horizon: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ProjectedPoint {
    pub x: f64,
    pub y: f64,
    pub panel: u8,
    pub visible: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct InversePoint {
    pub az_deg: Option<f64>,
    pub alt_deg: Option<f64>,
    pub ra_deg: Option<f64>,
    pub dec_deg: Option<f64>,
    pub panel: u8,
}

#[derive(Clone, Copy)]
struct CameraBasis {
    fwd: Vec3,
    right: Vec3,
    up: Vec3,
}

#[inline]
fn horizontal_basis(az0_deg: f64, alt0_deg: f64) -> CameraBasis {
    let az0 = az0_deg.to_radians();
    let alt0 = alt0_deg.to_radians();
    let (sa, ca) = az0.sin_cos();
    let (sh, ch) = alt0.sin_cos();
    CameraBasis {
        fwd: Vec3::new(ch * sa, ch * ca, sh),
        right: Vec3::new(ca, -sa, 0.0),
        up: Vec3::new(-sh * sa, -sh * ca, ch),
    }
}

#[inline]
fn equatorial_basis(ra0_deg: f64, dec0_deg: f64) -> CameraBasis {
    let ra0 = ra0_deg.to_radians();
    let dec0 = dec0_deg.to_radians();
    let (sr, cr) = ra0.sin_cos();
    let (sd, cd) = dec0.sin_cos();
    // +RA goes to the left (-x), so right (+x) corresponds to decreasing RA.
    CameraBasis {
        fwd: Vec3::new(cd * cr, cd * sr, sd),
        right: Vec3::new(sr, -cr, 0.0),
        up: Vec3::new(-sd * cr, -sd * sr, cd),
    }
}

#[inline]
pub fn horizontal_to_enu_vec(hor: Horizontal) -> Vec3 {
    let az = hor.az_deg.to_radians();
    let alt = hor.alt_deg.to_radians();
    let (sa, ca) = az.sin_cos();
    let (sh, ch) = alt.sin_cos();
    Vec3::new(ch * sa, ch * ca, sh)
}

#[inline]
pub fn enu_vec_to_horizontal(v: Vec3) -> Horizontal {
    let r_xy = v.x.hypot(v.y);
    let alt_deg = v.z.atan2(r_xy).to_degrees();
    let az_deg = if r_xy < 1e-14 {
        0.0
    } else {
        wrap_deg_360(v.x.atan2(v.y).to_degrees())
    };
    Horizontal { az_deg, alt_deg }
}

#[inline]
fn safe_zoom(zoom: f64) -> f64 {
    if zoom.is_finite() && zoom > 0.0 {
        zoom.clamp(0.1, 64.0)
    } else {
        1.0
    }
}

#[inline]
fn stereo_scale_px(params: &ProjectionParams) -> f64 {
    let fov_deg = params.mode.effective_fov_deg(params.fov_deg);
    let half_tan = (0.25 * fov_deg.to_radians()).tan().max(1e-6);
    0.5 * params.width.min(params.height) * safe_zoom(params.zoom) / half_tan
}

#[inline]
fn project_stereographic_basis(
    p: Vec3,
    basis: CameraBasis,
    cx: f64,
    cy: f64,
    scale_px: f64,
    min_zc: f64,
) -> Option<(f64, f64, f64)> {
    let xc = p.dot(basis.right);
    let yc = p.dot(basis.up);
    let zc = p.dot(basis.fwd);
    let denom = 1.0 + zc;
    if zc < min_zc || denom <= 1e-6 {
        return None;
    }
    let us = xc / denom;
    let vs = yc / denom;
    let x = cx + us * scale_px;
    let y = cy - vs * scale_px;
    Some((x, y, zc))
}

#[inline]
fn unproject_stereographic_basis(
    x: f64,
    y: f64,
    cx: f64,
    cy: f64,
    scale_px: f64,
    basis: CameraBasis,
) -> Vec3 {
    let us = (x - cx) / scale_px;
    let vs = (cy - y) / scale_px;
    let s2 = us * us + vs * vs;
    let inv = 1.0 / (1.0 + s2);
    let xc = 2.0 * us * inv;
    let yc = 2.0 * vs * inv;
    let zc = (1.0 - s2) * inv;
    (basis.right.scale(xc) + basis.up.scale(yc) + basis.fwd.scale(zc)).normalize()
}

#[inline]
fn hemisphere_single_geom(w: f64, h: f64, zoom: f64) -> (f64, f64, f64) {
    let r = (w * 0.45).min(h * 0.80) * safe_zoom(zoom);
    (0.5 * w, 0.86 * h, r)
}

#[inline]
fn hemisphere_dual_geom(w: f64, h: f64, zoom: f64, panel: u8) -> (f64, f64, f64) {
    let r = (w * 0.225).min(h * 0.62) * safe_zoom(zoom);
    let cx = if panel == 0 { 0.255 * w } else { 0.745 * w };
    (cx, 0.78 * h, r)
}

#[inline]
fn all_sky_geom(w: f64, h: f64, zoom: f64) -> (f64, f64, f64) {
    let r_hor = 0.46 * w.min(h) * safe_zoom(zoom);
    (0.5 * w, 0.5 * h, r_hor)
}

#[inline]
fn panorama_geom(w: f64, h: f64, zoom: f64) -> (f64, f64, f64, f64) {
    let z = safe_zoom(zoom);
    let scale_x = (w * 0.48 / 180.0) * z;
    let scale_y = (h * 0.80 / 100.0) * z;
    (0.5 * w, 0.5 * h, scale_x, scale_y)
}

/// Project a sky point specifically onto panel `0` (facing `center_az_deg`) or panel `1`
/// (facing `center_az_deg + 180°`) for dome / dual-hemisphere rendering.
pub fn project_horizontal_on_panel(
    hor: Horizontal,
    params: &ProjectionParams,
    panel: u8,
) -> Option<ProjectedPoint> {
    let w = params.width;
    let h = params.height;
    if w <= 1.0 || h <= 1.0 {
        return None;
    }

    let alt_ok = params.show_below_horizon || hor.alt_deg >= -0.001;
    match params.mode {
        ProjectionMode::HemisphereSingle => {
            if panel != 0 {
                return None;
            }
            let p = horizontal_to_enu_vec(hor);
            let basis = horizontal_basis(params.center_az_deg, 0.0);
            let (cx, cy, r) = hemisphere_single_geom(w, h, params.zoom);
            let (x, y, zc) = project_stereographic_basis(p, basis, cx, cy, r, -0.2)?;
            let sx = (x - cx) / r;
            let sy = (cy - y) / r;
            let visible = alt_ok && zc >= -1e-6 && (sx * sx + sy * sy) <= 1.0 + 1e-6;
            Some(ProjectedPoint {
                x,
                y,
                panel: 0,
                visible,
            })
        }
        ProjectionMode::HemisphereDual => {
            let az_face = if panel == 0 {
                params.center_az_deg
            } else {
                wrap_deg_360(params.center_az_deg + 180.0)
            };
            let p = horizontal_to_enu_vec(hor);
            let basis = horizontal_basis(az_face, 0.0);
            let (cx, cy, r) = hemisphere_dual_geom(w, h, params.zoom, panel);
            let (x, y, zc) = project_stereographic_basis(p, basis, cx, cy, r, -0.2)?;
            let sx = (x - cx) / r;
            let sy = (cy - y) / r;
            let visible = alt_ok && zc >= -1e-6 && (sx * sx + sy * sy) <= 1.0 + 1e-6;
            Some(ProjectedPoint {
                x,
                y,
                panel: u8::from(panel != 0),
                visible,
            })
        }
        _ => project_horizontal(hor, params),
    }
}

/// Forward projection for horizontal-based sky modes (modes 1–5 and 7–9).
pub fn project_horizontal(hor: Horizontal, params: &ProjectionParams) -> Option<ProjectedPoint> {
    let w = params.width;
    let h = params.height;
    if w <= 1.0 || h <= 1.0 {
        return None;
    }

    let alt_ok = params.show_below_horizon || hor.alt_deg >= -0.001;
    match params.mode {
        ProjectionMode::FreeDirection
        | ProjectionMode::HorizonZoom
        | ProjectionMode::MidSky
        | ProjectionMode::Zenith => {
            let alt0 = if matches!(params.mode, ProjectionMode::Zenith) {
                90.0
            } else {
                params.center_alt_deg.clamp(-89.9, 89.9)
            };
            let p = horizontal_to_enu_vec(hor);
            let basis = horizontal_basis(params.center_az_deg, alt0);
            let scale_px = stereo_scale_px(params);
            let (x, y, _) =
                project_stereographic_basis(p, basis, 0.5 * w, 0.5 * h, scale_px, -0.82)?;
            let in_rect = x >= 0.0 && x <= w && y >= 0.0 && y <= h;
            Some(ProjectedPoint {
                x,
                y,
                panel: 0,
                visible: in_rect && alt_ok,
            })
        }
        ProjectionMode::AllSky => {
            if !params.show_below_horizon && hor.alt_deg < -15.0 {
                return None;
            }
            let (cx, cy, r_hor) = all_sky_geom(w, h, params.zoom);
            let rho = r_hor * ((90.0 - hor.alt_deg) / 90.0);
            let d_az = (hor.az_deg - params.center_az_deg).to_radians();
            let (sd, cd) = d_az.sin_cos();
            let x = cx + rho * sd;
            let y = cy + rho * cd;
            let visible = alt_ok && x >= 0.0 && x <= w && y >= 0.0 && y <= h;
            Some(ProjectedPoint {
                x,
                y,
                panel: 0,
                visible,
            })
        }
        ProjectionMode::HemisphereSingle => project_horizontal_on_panel(hor, params, 0),
        ProjectionMode::HemisphereDual => {
            let p = horizontal_to_enu_vec(hor);
            let basis0 = horizontal_basis(params.center_az_deg, 0.0);
            let panel = u8::from(p.dot(basis0.fwd) < 0.0);
            project_horizontal_on_panel(hor, params, panel)
        }
        ProjectionMode::Panorama => {
            let (cx, cy, scale_x, scale_y) = panorama_geom(w, h, params.zoom);
            let d_az = wrap_deg_180(hor.az_deg - params.center_az_deg);
            let x = cx + d_az * scale_x;
            let y = cy - (hor.alt_deg - params.center_alt_deg) * scale_y;
            let in_rect = x >= 0.0 && x <= w && y >= 0.0 && y <= h;
            Some(ProjectedPoint {
                x,
                y,
                panel: 0,
                visible: in_rect && alt_ok,
            })
        }
        ProjectionMode::StarChart => None,
    }
}

/// Forward projection for Mode 6 (`StarChart`, equatorial stereographic).
pub fn project_equatorial(eq: Equatorial, params: &ProjectionParams) -> Option<ProjectedPoint> {
    if !params.mode.is_equatorial() {
        return None;
    }
    let w = params.width;
    let h = params.height;
    if w <= 1.0 || h <= 1.0 {
        return None;
    }
    let p = equatorial_to_vec3(eq);
    let basis = equatorial_basis(params.center_ra_deg, params.center_dec_deg.clamp(-89.9, 89.9));
    let scale_px = stereo_scale_px(params);
    let (x, y, _) =
        project_stereographic_basis(p, basis, 0.5 * w, 0.5 * h, scale_px, -0.82)?;
    let visible = x >= 0.0 && x <= w && y >= 0.0 && y <= h;
    Some(ProjectedPoint {
        x,
        y,
        panel: 0,
        visible,
    })
}

/// Forward projection supporting all 9 modes given both horizontal and equatorial coordinates.
pub fn project_sky_point(
    hor: Horizontal,
    eq: Equatorial,
    params: &ProjectionParams,
) -> Option<ProjectedPoint> {
    if params.mode.is_equatorial() {
        let mut pt = project_equatorial(eq, params)?;
        if !params.show_below_horizon && hor.alt_deg < 0.0 {
            pt.visible = false;
        }
        Some(pt)
    } else {
        project_horizontal(hor, params)
    }
}

/// Exact inverse projection from pixel `(x, y)` back to both Horizontal and Equatorial sky coordinates.
pub fn unproject_screen(
    x: f64,
    y: f64,
    params: &ProjectionParams,
    lat_deg: f64,
    lst_deg: f64,
) -> Option<InversePoint> {
    let w = params.width;
    let h = params.height;
    if w <= 1.0 || h <= 1.0 || !x.is_finite() || !y.is_finite() {
        return None;
    }

    if params.mode.is_equatorial() {
        let basis = equatorial_basis(params.center_ra_deg, params.center_dec_deg.clamp(-89.9, 89.9));
        let scale_px = stereo_scale_px(params);
        let p = unproject_stereographic_basis(x, y, 0.5 * w, 0.5 * h, scale_px, basis);
        let eq = vec3_to_equatorial(p);
        let hor = equatorial_to_horizontal(eq, lat_deg, lst_deg);
        return Some(InversePoint {
            az_deg: Some(hor.az_deg),
            alt_deg: Some(hor.alt_deg),
            ra_deg: Some(eq.ra_deg),
            dec_deg: Some(eq.dec_deg),
            panel: 0,
        });
    }

    let (hor, panel) = match params.mode {
        ProjectionMode::FreeDirection
        | ProjectionMode::HorizonZoom
        | ProjectionMode::MidSky
        | ProjectionMode::Zenith => {
            let alt0 = if matches!(params.mode, ProjectionMode::Zenith) {
                90.0
            } else {
                params.center_alt_deg.clamp(-89.9, 89.9)
            };
            let basis = horizontal_basis(params.center_az_deg, alt0);
            let scale_px = stereo_scale_px(params);
            let p =
                unproject_stereographic_basis(x, y, 0.5 * w, 0.5 * h, scale_px, basis);
            (enu_vec_to_horizontal(p), 0)
        }
        ProjectionMode::AllSky => {
            let (cx, cy, r_hor) = all_sky_geom(w, h, params.zoom);
            let dx = x - cx;
            let dy = y - cy;
            let rho = dx.hypot(dy);
            let alt_deg = 90.0 * (1.0 - rho / r_hor);
            if alt_deg < -90.0 || (!params.show_below_horizon && alt_deg < -0.5) {
                return None;
            }
            let az_deg = if rho < 1e-12 {
                params.center_az_deg
            } else {
                wrap_deg_360(params.center_az_deg + dx.atan2(dy).to_degrees())
            };
            (Horizontal { az_deg, alt_deg }, 0)
        }
        ProjectionMode::HemisphereSingle => {
            let (cx, cy, r) = hemisphere_single_geom(w, h, params.zoom);
            let sx = (x - cx) / r;
            let sy = (cy - y) / r;
            if sx * sx + sy * sy > 1.0 + 1e-4 {
                return None;
            }
            let basis = horizontal_basis(params.center_az_deg, 0.0);
            let p = unproject_stereographic_basis(x, y, cx, cy, r, basis);
            let hor = enu_vec_to_horizontal(p);
            if !params.show_below_horizon && hor.alt_deg < -0.5 {
                return None;
            }
            (hor, 0)
        }
        ProjectionMode::HemisphereDual => {
            let (cx0, cy0, r0) = hemisphere_dual_geom(w, h, params.zoom, 0);
            let sx0 = (x - cx0) / r0;
            let sy0 = (cy0 - y) / r0;
            if sx0 * sx0 + sy0 * sy0 <= 1.0 + 1e-4 {
                let basis = horizontal_basis(params.center_az_deg, 0.0);
                let p = unproject_stereographic_basis(x, y, cx0, cy0, r0, basis);
                let hor = enu_vec_to_horizontal(p);
                if !params.show_below_horizon && hor.alt_deg < -0.5 {
                    return None;
                }
                (hor, 0)
            } else {
                let (cx1, cy1, r1) = hemisphere_dual_geom(w, h, params.zoom, 1);
                let sx1 = (x - cx1) / r1;
                let sy1 = (cy1 - y) / r1;
                if sx1 * sx1 + sy1 * sy1 > 1.0 + 1e-4 {
                    return None;
                }
                let az1 = wrap_deg_360(params.center_az_deg + 180.0);
                let basis = horizontal_basis(az1, 0.0);
                let p = unproject_stereographic_basis(x, y, cx1, cy1, r1, basis);
                let hor = enu_vec_to_horizontal(p);
                if !params.show_below_horizon && hor.alt_deg < -0.5 {
                    return None;
                }
                (hor, 1)
            }
        }
        ProjectionMode::Panorama => {
            let (cx, cy, scale_x, scale_y) = panorama_geom(w, h, params.zoom);
            let d_az = (x - cx) / scale_x;
            let alt_deg = params.center_alt_deg + (cy - y) / scale_y;
            if d_az.abs() > 180.0 + 1e-6 || alt_deg.abs() > 90.0 {
                return None;
            }
            if !params.show_below_horizon && alt_deg < -0.5 {
                return None;
            }
            let az_deg = wrap_deg_360(params.center_az_deg + d_az);
            (Horizontal { az_deg, alt_deg }, 0)
        }
        ProjectionMode::StarChart => unreachable!(),
    };

    if !params.show_below_horizon && hor.alt_deg < -0.5 {
        return None;
    }

    let eq = horizontal_to_equatorial(hor, lat_deg, lst_deg);
    Some(InversePoint {
        az_deg: Some(hor.az_deg),
        alt_deg: Some(hor.alt_deg),
        ra_deg: Some(eq.ra_deg),
        dec_deg: Some(eq.dec_deg),
        panel,
    })
}

#[cfg(test)]
mod tests {
    use crate::engine::coords::{angular_distance_deg, wrap_deg_180};

    use super::*;

    #[test]
    fn roundtrip_all_nine_projections_under_1e5_deg() {
        let lat = 34.6431;
        let lst = 123.45;
        let mut base = ProjectionParams {
            width: 1280.0,
            height: 800.0,
            center_az_deg: 180.0,
            center_alt_deg: 35.0,
            center_ra_deg: 83.82,
            center_dec_deg: -5.39,
            fov_deg: 90.0,
            zoom: 1.0,
            show_below_horizon: false,
            mode: ProjectionMode::FreeDirection,
        };

        let samples = [
            Horizontal { az_deg: 180.0, alt_deg: 35.0 },
            Horizontal { az_deg: 155.0, alt_deg: 22.0 },
            Horizontal { az_deg: 205.0, alt_deg: 50.0 },
            Horizontal { az_deg: 15.0, alt_deg: 30.0 },
            Horizontal { az_deg: 330.0, alt_deg: 65.0 },
            Horizontal { az_deg: 90.0, alt_deg: 15.0 },
            Horizontal { az_deg: 270.0, alt_deg: 12.0 },
            Horizontal { az_deg: 180.0, alt_deg: 80.0 },
        ];

        for &mode in &ProjectionMode::ALL {
            base.mode = mode;
            base.center_alt_deg = match mode {
                ProjectionMode::HorizonZoom => 12.0,
                ProjectionMode::MidSky => 45.0,
                ProjectionMode::Zenith => 90.0,
                ProjectionMode::Panorama => 40.0,
                _ => 35.0,
            };
            base.fov_deg = mode.default_fov_deg();

            let mut tested = 0usize;
            if mode.is_equatorial() {
                for &(ra, dec) in &[(83.82, -5.39), (95.0, 5.0), (70.0, -15.0)] {
                    let eq = Equatorial { ra_deg: ra, dec_deg: dec };
                    let pt = project_equatorial(eq, &base).unwrap();
                    assert!(pt.visible);
                    let inv = unproject_screen(pt.x, pt.y, &base, lat, lst).unwrap();
                    let eq_back = Equatorial {
                        ra_deg: inv.ra_deg.unwrap(),
                        dec_deg: inv.dec_deg.unwrap(),
                    };
                    let sep = angular_distance_deg(eq, eq_back);
                    assert!(sep < 1e-5, "mode={mode:?} eq sep={sep}");
                    tested += 1;
                }
            } else {
                let mut seen_panels = [false; 2];
                for &hor in &samples {
                    if let Some(pt) = project_horizontal(hor, &base) {
                        if !pt.visible {
                            continue;
                        }
                        seen_panels[pt.panel as usize] = true;
                        let inv = unproject_screen(pt.x, pt.y, &base, lat, lst).unwrap();
                        let daz = wrap_deg_180(hor.az_deg - inv.az_deg.unwrap()).abs();
                        let dalt = (hor.alt_deg - inv.alt_deg.unwrap()).abs();
                        assert!(
                            daz < 1e-5 && dalt < 1e-5,
                            "mode={mode:?} panel={} hor={hor:?} daz={daz} dalt={dalt}",
                            pt.panel
                        );
                        tested += 1;
                    }
                }
                if matches!(mode, ProjectionMode::HemisphereDual) {
                    assert!(seen_panels[0] && seen_panels[1], "both panels must be tested");
                }
            }
            assert!(tested > 0, "no visible sample tested for {mode:?}");
        }
    }

    #[test]
    fn sky_handedness_east_left_west_right_when_facing_south() {
        let mut params = ProjectionParams {
            mode: ProjectionMode::FreeDirection,
            center_az_deg: 180.0,
            center_alt_deg: 20.0,
            ..ProjectionParams::default()
        };

        let east = project_horizontal(
            Horizontal { az_deg: 150.0, alt_deg: 20.0 },
            &params,
        )
        .unwrap();
        let west = project_horizontal(
            Horizontal { az_deg: 210.0, alt_deg: 20.0 },
            &params,
        )
        .unwrap();
        let high = project_horizontal(
            Horizontal { az_deg: 180.0, alt_deg: 40.0 },
            &params,
        )
        .unwrap();
        assert!(east.x < west.x, "East should be left (-x) when facing South");
        assert!(high.y < east.y, "Higher altitude should be up (-y)");

        // AllSky: N top (-y), S bottom (+y), E left (-x), W right (+x)
        params.mode = ProjectionMode::AllSky;
        let n = project_horizontal(Horizontal { az_deg: 0.0, alt_deg: 10.0 }, &params).unwrap();
        let s = project_horizontal(Horizontal { az_deg: 180.0, alt_deg: 10.0 }, &params).unwrap();
        let e = project_horizontal(Horizontal { az_deg: 90.0, alt_deg: 10.0 }, &params).unwrap();
        let w = project_horizontal(Horizontal { az_deg: 270.0, alt_deg: 10.0 }, &params).unwrap();
        assert!(n.y < s.y, "North must be above South in AllSky");
        assert!(e.x < w.x, "East must be left of West in AllSky");

        // StarChart: higher Dec up (-y), higher RA left (-x)
        params.mode = ProjectionMode::StarChart;
        params.center_ra_deg = 90.0;
        params.center_dec_deg = 10.0;
        let north_star = project_equatorial(Equatorial { ra_deg: 90.0, dec_deg: 25.0 }, &params).unwrap();
        let south_star = project_equatorial(Equatorial { ra_deg: 90.0, dec_deg: -5.0 }, &params).unwrap();
        let east_star = project_equatorial(Equatorial { ra_deg: 105.0, dec_deg: 10.0 }, &params).unwrap();
        let west_star = project_equatorial(Equatorial { ra_deg: 75.0, dec_deg: 10.0 }, &params).unwrap();
        assert!(north_star.y < south_star.y);
        assert!(east_star.x < west_star.x);
    }
}
