import type {
  InversePoint,
  ProjectedPoint,
  ProjectionMode,
  ProjectionParams,
  Rgb,
  SkyFrame,
  SkyFrameRequest,
} from "@/types/sky";

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

export function wrapDeg360(deg: number): number {
  const m = deg % 360;
  return m < 0 ? m + 360 : m;
}

export function wrapDeg180(deg: number): number {
  let d = wrapDeg360(deg);
  if (d >= 180) d -= 360;
  return d;
}

export function effectiveFovDeg(mode: ProjectionMode, rawFovDeg: number): number {
  const f = Number.isFinite(rawFovDeg) && rawFovDeg > 0 ? rawFovDeg : 90;
  switch (mode) {
    case "free_direction":
      return Math.min(170, Math.max(1, f));
    case "horizon_zoom":
      return Math.min(100, Math.max(2, f));
    case "mid_sky":
      return Math.min(120, Math.max(5, f));
    case "zenith":
      return Math.min(160, Math.max(10, f));
    case "star_chart":
      return Math.min(140, Math.max(0.25, f));
    case "all_sky":
    case "hemisphere_single":
    case "hemisphere_dual":
      return 180;
    case "panorama":
      return 360;
  }
}

export function safeZoom(zoom: number): number {
  if (Number.isFinite(zoom) && zoom > 0) {
    return Math.min(64, Math.max(0.1, zoom));
  }
  return 1;
}

export interface CameraBasis {
  fx: number;
  fy: number;
  fz: number;
  rx: number;
  ry: number;
  rz: number;
  ux: number;
  uy: number;
  uz: number;
}

export function horizontalBasis(az0Deg: number, alt0Deg: number): CameraBasis {
  const az0 = az0Deg * DEG2RAD;
  const alt0 = alt0Deg * DEG2RAD;
  const sa = Math.sin(az0);
  const ca = Math.cos(az0);
  const sh = Math.sin(alt0);
  const ch = Math.cos(alt0);
  return {
    fx: ch * sa,
    fy: ch * ca,
    fz: sh,
    rx: ca,
    ry: -sa,
    rz: 0,
    ux: -sh * sa,
    uy: -sh * ca,
    uz: ch,
  };
}

export function equatorialBasis(ra0Deg: number, dec0Deg: number): CameraBasis {
  const ra0 = ra0Deg * DEG2RAD;
  const dec0 = dec0Deg * DEG2RAD;
  const sr = Math.sin(ra0);
  const cr = Math.cos(ra0);
  const sd = Math.sin(dec0);
  const cd = Math.cos(dec0);
  return {
    fx: cd * cr,
    fy: cd * sr,
    fz: sd,
    rx: sr,
    ry: -cr,
    rz: 0,
    ux: -sd * cr,
    uy: -sd * sr,
    uz: cd,
  };
}

export function horizontalToEnuVec(azDeg: number, altDeg: number): [number, number, number] {
  const az = azDeg * DEG2RAD;
  const alt = altDeg * DEG2RAD;
  const ch = Math.cos(alt);
  return [ch * Math.sin(az), ch * Math.cos(az), Math.sin(alt)];
}

export function enuVecToHorizontal(ex: number, ny: number, uz: number): { azDeg: number; altDeg: number } {
  const rXy = Math.hypot(ex, ny);
  const altDeg = Math.atan2(uz, rXy) * RAD2DEG;
  const azDeg = rXy < 1e-14 ? 0 : wrapDeg360(Math.atan2(ex, ny) * RAD2DEG);
  return { azDeg, altDeg };
}

export function raDecToVec3(raDeg: number, decDeg: number): [number, number, number] {
  const ra = raDeg * DEG2RAD;
  const dec = decDeg * DEG2RAD;
  const cd = Math.cos(dec);
  return [cd * Math.cos(ra), cd * Math.sin(ra), Math.sin(dec)];
}

export function vec3ToRaDec(x: number, y: number, z: number): { raDeg: number; decDeg: number } {
  const r = Math.hypot(x, y, z);
  if (r < 1e-15) return { raDeg: 0, decDeg: 0 };
  return {
    raDeg: wrapDeg360(Math.atan2(y, x) * RAD2DEG),
    decDeg: Math.asin(Math.max(-1, Math.min(1, z / r))) * RAD2DEG,
  };
}

export function equatorialToHorizontalFast(
  raDeg: number,
  decDeg: number,
  latDeg: number,
  lastDeg: number,
): { azDeg: number; altDeg: number } {
  const ha = wrapDeg180(lastDeg - raDeg) * DEG2RAD;
  const lat = latDeg * DEG2RAD;
  const dec = decDeg * DEG2RAD;
  const sinHa = Math.sin(ha);
  const cosHa = Math.cos(ha);
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const sinDec = Math.sin(dec);
  const cosDec = Math.cos(dec);
  const sinAlt = Math.max(-1, Math.min(1, sinLat * sinDec + cosLat * cosDec * cosHa));
  const altDeg = Math.asin(sinAlt) * RAD2DEG;
  const y = -sinHa * cosDec;
  const x = cosLat * sinDec - sinLat * cosDec * cosHa;
  return { azDeg: wrapDeg360(Math.atan2(y, x) * RAD2DEG), altDeg };
}

export function horizontalToEquatorialFast(
  azDeg: number,
  altDeg: number,
  latDeg: number,
  lastDeg: number,
): { raDeg: number; decDeg: number } {
  const az = azDeg * DEG2RAD;
  const alt = altDeg * DEG2RAD;
  const lat = latDeg * DEG2RAD;
  const sinAz = Math.sin(az);
  const cosAz = Math.cos(az);
  const sinAlt = Math.sin(alt);
  const cosAlt = Math.cos(alt);
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const sinDec = Math.max(-1, Math.min(1, sinLat * sinAlt + cosLat * cosAlt * cosAz));
  const decDeg = Math.asin(sinDec) * RAD2DEG;
  const y = -sinAz * cosAlt;
  const x = cosLat * sinAlt - sinLat * cosAlt * cosAz;
  const haDeg = Math.atan2(y, x) * RAD2DEG;
  return { raDeg: wrapDeg360(lastDeg - haDeg), decDeg };
}

export function j2000ToHorWithMatrix(
  raDeg: number,
  decDeg: number,
  mat: number[][],
  latDeg: number,
  lastDeg: number,
): { azDeg: number; altDeg: number; appRaDeg: number; appDecDeg: number } {
  const r = raDeg * DEG2RAD;
  const d = decDeg * DEG2RAD;
  const vx = Math.cos(d) * Math.cos(r);
  const vy = Math.cos(d) * Math.sin(r);
  const vz = Math.sin(d);
  const ax = mat[0][0] * vx + mat[0][1] * vy + mat[0][2] * vz;
  const ay = mat[1][0] * vx + mat[1][1] * vy + mat[1][2] * vz;
  const az = mat[2][0] * vx + mat[2][1] * vy + mat[2][2] * vz;
  const appRaDeg = wrapDeg360(Math.atan2(ay, ax) * RAD2DEG);
  const appDecDeg = Math.asin(Math.max(-1, Math.min(1, az))) * RAD2DEG;
  const ha = ((wrapDeg360(lastDeg - appRaDeg + 180) - 180) * DEG2RAD);
  const lat = latDeg * DEG2RAD;
  const decR = appDecDeg * DEG2RAD;
  const sinAlt = Math.sin(lat) * Math.sin(decR) + Math.cos(lat) * Math.cos(decR) * Math.cos(ha);
  const altDeg = Math.asin(Math.max(-1, Math.min(1, sinAlt))) * RAD2DEG;
  const y = -Math.sin(ha) * Math.cos(decR);
  const x = Math.cos(lat) * Math.sin(decR) - Math.sin(lat) * Math.cos(decR) * Math.cos(ha);
  const azDeg = wrapDeg360(Math.atan2(y, x) * RAD2DEG);
  return { azDeg, altDeg, appRaDeg, appDecDeg };
}

export function applyStandardRefractionDeg(trueAltDeg: number): number {
  if (trueAltDeg < -2.0) return trueAltDeg;
  const clamped = Math.max(-1.8, Math.min(90, trueAltDeg));
  const arg = (clamped + 10.3 / (clamped + 5.11)) * DEG2RAD;
  const rArcmin = 1.02 / Math.tan(arg) + 0.0019279;
  return trueAltDeg + Math.max(0, rArcmin) / 60;
}

/** Build flat 9-element row-major J2000->Apparent matrix from Rust 3x3 nested array. */
export function flattenMat3(m: number[][]): Float64Array {
  return new Float64Array([
    m[0][0], m[0][1], m[0][2],
    m[1][0], m[1][1], m[1][2],
    m[2][0], m[2][1], m[2][2],
  ]);
}

/** Build flat 9-element row-major J2000_Eq -> Horizontal_ENU matrix `(ex, ny, uz)`. */
export function buildJ2000ToEnuMatrix(
  j2000ToApp: number[][],
  lastDeg: number,
  latDeg: number,
): Float64Array {
  const th = lastDeg * DEG2RAD;
  const ph = latDeg * DEG2RAD;
  const sth = Math.sin(th);
  const cth = Math.cos(th);
  const sph = Math.sin(ph);
  const cph = Math.cos(ph);

  // Equatorial_App -> ENU
  const e00 = -sth;
  const e01 = cth;
  const e02 = 0;
  const e10 = -sph * cth;
  const e11 = -sph * sth;
  const e12 = cph;
  const e20 = cph * cth;
  const e21 = cph * sth;
  const e22 = sph;

  const out = new Float64Array(9);
  for (let col = 0; col < 3; col++) {
    const a0 = j2000ToApp[0][col];
    const a1 = j2000ToApp[1][col];
    const a2 = j2000ToApp[2][col];
    out[0 * 3 + col] = e00 * a0 + e01 * a1 + e02 * a2;
    out[1 * 3 + col] = e10 * a0 + e11 * a1 + e12 * a2;
    out[2 * 3 + col] = e20 * a0 + e21 * a1 + e22 * a2;
  }
  return out;
}

export interface CompiledProjectionContext {
  params: ProjectionParams;
  stereoScalePx: number;
  cx: number;
  cy: number;
  basis0: CameraBasis;
  basis1: CameraBasis | null;
  hemRadius0: number;
  hemCx0: number;
  hemCy0: number;
  hemRadius1: number;
  hemCx1: number;
  hemCy1: number;
  allSkyRadius: number;
  allSkySinAz0: number;
  allSkyCosAz0: number;
  panoScaleX: number;
  panoScaleY: number;
  eqBasis: CameraBasis;
}

export function compileProjectionContext(params: ProjectionParams): CompiledProjectionContext {
  const w = params.width;
  const h = params.height;
  const z = safeZoom(params.zoom);
  const fov = effectiveFovDeg(params.mode, params.fov_deg);
  const halfTan = Math.max(1e-6, Math.tan(0.25 * fov * DEG2RAD));
  const stereoScalePx = (0.5 * Math.min(w, h) * z) / halfTan;

  const alt0 =
    params.mode === "zenith" ? 90 : Math.min(89.9, Math.max(-89.9, params.center_alt_deg));
  const basis0 =
    params.mode === "hemisphere_single" || params.mode === "hemisphere_dual"
      ? horizontalBasis(params.center_az_deg, 0)
      : horizontalBasis(params.center_az_deg, alt0);

  const basis1 =
    params.mode === "hemisphere_dual"
      ? horizontalBasis(wrapDeg360(params.center_az_deg + 180), 0)
      : null;

  const hemRadius0 =
    params.mode === "hemisphere_dual"
      ? Math.min(w * 0.225, h * 0.62) * z
      : Math.min(w * 0.45, h * 0.80) * z;
  const hemCx0 = params.mode === "hemisphere_dual" ? 0.255 * w : 0.5 * w;
  const hemCy0 = params.mode === "hemisphere_dual" ? 0.78 * h : 0.86 * h;

  const az0Rad = params.center_az_deg * DEG2RAD;
  return {
    params,
    stereoScalePx,
    cx: 0.5 * w,
    cy: 0.5 * h,
    basis0,
    basis1,
    hemRadius0,
    hemCx0,
    hemCy0,
    hemRadius1: Math.min(w * 0.225, h * 0.62) * z,
    hemCx1: 0.745 * w,
    hemCy1: 0.78 * h,
    allSkyRadius: 0.46 * Math.min(w, h) * z,
    allSkySinAz0: Math.sin(az0Rad),
    allSkyCosAz0: Math.cos(az0Rad),
    panoScaleX: (w * 0.48 / 180) * z,
    panoScaleY: (h * 0.80 / 100) * z,
    eqBasis: equatorialBasis(
      params.center_ra_deg,
      Math.min(89.9, Math.max(-89.9, params.center_dec_deg)),
    ),
  };
}

/**
 * Fast zero-allocation ENU vector projection for a chosen panel (`0` or `1` in `hemisphere_dual`).
 * Writes `[x, y, visibleFlag (1|0)]` into `out` and returns `true` if front-facing domain is valid.
 */
export function projectEnuVectorOnPanel(
  ex: number,
  ny: number,
  uz: number,
  ctx: CompiledProjectionContext,
  panel: number,
  out: Float64Array,
): boolean {
  const { params } = ctx;
  const w = params.width;
  const h = params.height;
  if (w <= 1 || h <= 1) return false;
  const altOk = params.show_below_horizon || uz >= -0.0001;

  switch (params.mode) {
    case "free_direction":
    case "horizon_zoom":
    case "mid_sky":
    case "zenith": {
      const b = ctx.basis0;
      const zc = ex * b.fx + ny * b.fy + uz * b.fz;
      const denom = 1 + zc;
      if (zc < -0.82 || denom <= 1e-6) return false;
      const xc = ex * b.rx + ny * b.ry + uz * b.rz;
      const yc = ex * b.ux + ny * b.uy + uz * b.uz;
      const x = ctx.cx + (xc / denom) * ctx.stereoScalePx;
      const y = ctx.cy - (yc / denom) * ctx.stereoScalePx;
      out[0] = x;
      out[1] = y;
      out[2] = altOk && x >= 0 && x <= w && y >= 0 && y <= h ? 1 : 0;
      return true;
    }
    case "all_sky": {
      if (!params.show_below_horizon && uz < -0.258) return false;
      const altDeg = Math.asin(Math.max(-1, Math.min(1, uz))) * RAD2DEG;
      const rho = ctx.allSkyRadius * ((90 - altDeg) / 90);
      const rXy = Math.hypot(ex, ny);
      let x = ctx.cx;
      let y = ctx.cy;
      if (rXy > 1e-12) {
        const sd = (ex * ctx.allSkyCosAz0 - ny * ctx.allSkySinAz0) / rXy;
        const cd = (ex * ctx.allSkySinAz0 + ny * ctx.allSkyCosAz0) / rXy;
        x = ctx.cx + rho * sd;
        y = ctx.cy + rho * cd;
      } else {
        y = ctx.cy + rho;
      }
      out[0] = x;
      out[1] = y;
      out[2] = altOk && x >= 0 && x <= w && y >= 0 && y <= h ? 1 : 0;
      return true;
    }
    case "hemisphere_single": {
      if (panel !== 0) return false;
      const b = ctx.basis0;
      const zc = ex * b.fx + ny * b.fy + uz * b.fz;
      const denom = 1 + zc;
      if (zc < -0.2 || denom <= 1e-6) return false;
      const xc = ex * b.rx + ny * b.ry + uz * b.rz;
      const yc = ex * b.ux + ny * b.uy + uz * b.uz;
      const sx = xc / denom;
      const sy = yc / denom;
      out[0] = ctx.hemCx0 + sx * ctx.hemRadius0;
      out[1] = ctx.hemCy0 - sy * ctx.hemRadius0;
      out[2] = altOk && zc >= -1e-6 && sx * sx + sy * sy <= 1 + 1e-6 ? 1 : 0;
      return true;
    }
    case "hemisphere_dual": {
      const b = panel === 0 ? ctx.basis0 : ctx.basis1;
      if (!b) return false;
      const hcx = panel === 0 ? ctx.hemCx0 : ctx.hemCx1;
      const hcy = panel === 0 ? ctx.hemCy0 : ctx.hemCy1;
      const hr = panel === 0 ? ctx.hemRadius0 : ctx.hemRadius1;
      const zc = ex * b.fx + ny * b.fy + uz * b.fz;
      const denom = 1 + zc;
      if (zc < -0.2 || denom <= 1e-6) return false;
      const xc = ex * b.rx + ny * b.ry + uz * b.rz;
      const yc = ex * b.ux + ny * b.uy + uz * b.uz;
      const sx = xc / denom;
      const sy = yc / denom;
      out[0] = hcx + sx * hr;
      out[1] = hcy - sy * hr;
      out[2] = altOk && zc >= -1e-6 && sx * sx + sy * sy <= 1 + 1e-6 ? 1 : 0;
      return true;
    }
    case "panorama": {
      const altDeg = Math.asin(Math.max(-1, Math.min(1, uz))) * RAD2DEG;
      const azDeg = Math.hypot(ex, ny) < 1e-14 ? 0 : wrapDeg360(Math.atan2(ex, ny) * RAD2DEG);
      const dAz = wrapDeg180(azDeg - params.center_az_deg);
      const x = ctx.cx + dAz * ctx.panoScaleX;
      const y = ctx.cy - (altDeg - params.center_alt_deg) * ctx.panoScaleY;
      out[0] = x;
      out[1] = y;
      out[2] = altOk && x >= 0 && x <= w && y >= 0 && y <= h ? 1 : 0;
      return true;
    }
    case "star_chart":
      return false;
  }
}

export function projectAppEqVectorForStarChart(
  xa: number,
  ya: number,
  za: number,
  uzEnu: number,
  ctx: CompiledProjectionContext,
  out: Float64Array,
): boolean {
  const { params, eqBasis: b } = ctx;
  const w = params.width;
  const h = params.height;
  if (w <= 1 || h <= 1) return false;
  const zc = xa * b.fx + ya * b.fy + za * b.fz;
  const denom = 1 + zc;
  if (zc < -0.82 || denom <= 1e-6) return false;
  const xc = xa * b.rx + ya * b.ry + za * b.rz;
  const yc = xa * b.ux + ya * b.uy + za * b.uz;
  const x = ctx.cx + (xc / denom) * ctx.stereoScalePx;
  const y = ctx.cy - (yc / denom) * ctx.stereoScalePx;
  const altOk = params.show_below_horizon || uzEnu >= -0.0001;
  out[0] = x;
  out[1] = y;
  out[2] = altOk && x >= 0 && x <= w && y >= 0 && y <= h ? 1 : 0;
  return true;
}

export function projectHorToScreen(
  azDeg: number,
  altDeg: number,
  ctx: CompiledProjectionContext,
  panel?: number,
): ProjectedPoint | null {
  const [ex, ny, uz] = horizontalToEnuVec(azDeg, altDeg);
  const scratch = new Float64Array(3);
  if (ctx.params.mode === "hemisphere_dual") {
    const p =
      panel !== undefined
        ? panel
        : ex * ctx.basis0.fx + ny * ctx.basis0.fy + uz * ctx.basis0.fz >= 0
          ? 0
          : 1;
    if (!projectEnuVectorOnPanel(ex, ny, uz, ctx, p, scratch)) return null;
    return { x: scratch[0], y: scratch[1], panel: p, visible: scratch[2] > 0.5 };
  }
  if (!projectEnuVectorOnPanel(ex, ny, uz, ctx, 0, scratch)) return null;
  return { x: scratch[0], y: scratch[1], panel: 0, visible: scratch[2] > 0.5 };
}

export function projectEqToScreen(
  raDeg: number,
  decDeg: number,
  latDeg: number,
  lastDeg: number,
  ctx: CompiledProjectionContext,
  panel?: number,
): ProjectedPoint | null {
  const hor = equatorialToHorizontalFast(raDeg, decDeg, latDeg, lastDeg);
  if (ctx.params.mode === "star_chart") {
    const [xa, ya, za] = raDecToVec3(raDeg, decDeg);
    const scratch = new Float64Array(3);
    const uz = Math.sin(hor.altDeg * DEG2RAD);
    if (!projectAppEqVectorForStarChart(xa, ya, za, uz, ctx, scratch)) return null;
    return { x: scratch[0], y: scratch[1], panel: 0, visible: scratch[2] > 0.5 };
  }
  return projectHorToScreen(hor.azDeg, hor.altDeg, ctx, panel);
}

export function unprojectScreen(
  x: number,
  y: number,
  params: ProjectionParams,
  latDeg: number,
  lastDeg: number,
): InversePoint | null {
  const ctx = compileProjectionContext(params);
  const w = params.width;
  const h = params.height;
  if (w <= 1 || h <= 1 || !Number.isFinite(x) || !Number.isFinite(y)) return null;

  const invertStereo = (cx: number, cy: number, scale: number, b: CameraBasis): [number, number, number] => {
    const us = (x - cx) / scale;
    const vs = (cy - y) / scale;
    const s2 = us * us + vs * vs;
    const inv = 1 / (1 + s2);
    const xc = 2 * us * inv;
    const yc = 2 * vs * inv;
    const zc = (1 - s2) * inv;
    const vx = b.rx * xc + b.ux * yc + b.fx * zc;
    const vy = b.ry * xc + b.uy * yc + b.fy * zc;
    const vz = b.rz * xc + b.uz * yc + b.fz * zc;
    const n = Math.hypot(vx, vy, vz) || 1;
    return [vx / n, vy / n, vz / n];
  };

  if (params.mode === "star_chart") {
    const [vx, vy, vz] = invertStereo(ctx.cx, ctx.cy, ctx.stereoScalePx, ctx.eqBasis);
    const eq = vec3ToRaDec(vx, vy, vz);
    const hor = equatorialToHorizontalFast(eq.raDeg, eq.decDeg, latDeg, lastDeg);
    return {
      az_deg: hor.azDeg,
      alt_deg: hor.altDeg,
      ra_deg: eq.raDeg,
      dec_deg: eq.decDeg,
      panel: 0,
    };
  }

  let azDeg = 0;
  let altDeg = 0;
  let panel = 0;

  switch (params.mode) {
    case "free_direction":
    case "horizon_zoom":
    case "mid_sky":
    case "zenith": {
      const [vx, vy, vz] = invertStereo(ctx.cx, ctx.cy, ctx.stereoScalePx, ctx.basis0);
      const hor = enuVecToHorizontal(vx, vy, vz);
      azDeg = hor.azDeg;
      altDeg = hor.altDeg;
      break;
    }
    case "all_sky": {
      const dx = x - ctx.cx;
      const dy = y - ctx.cy;
      const rho = Math.hypot(dx, dy);
      altDeg = 90 * (1 - rho / ctx.allSkyRadius);
      if (altDeg < -90 || (!params.show_below_horizon && altDeg < -0.5)) return null;
      azDeg = rho < 1e-12 ? params.center_az_deg : wrapDeg360(params.center_az_deg + Math.atan2(dx, dy) * RAD2DEG);
      break;
    }
    case "hemisphere_single": {
      const sx = (x - ctx.hemCx0) / ctx.hemRadius0;
      const sy = (ctx.hemCy0 - y) / ctx.hemRadius0;
      if (sx * sx + sy * sy > 1 + 1e-4) return null;
      const [vx, vy, vz] = invertStereo(ctx.hemCx0, ctx.hemCy0, ctx.hemRadius0, ctx.basis0);
      const hor = enuVecToHorizontal(vx, vy, vz);
      azDeg = hor.azDeg;
      altDeg = hor.altDeg;
      break;
    }
    case "hemisphere_dual": {
      const sx0 = (x - ctx.hemCx0) / ctx.hemRadius0;
      const sy0 = (ctx.hemCy0 - y) / ctx.hemRadius0;
      if (sx0 * sx0 + sy0 * sy0 <= 1 + 1e-4) {
        const [vx, vy, vz] = invertStereo(ctx.hemCx0, ctx.hemCy0, ctx.hemRadius0, ctx.basis0);
        const hor = enuVecToHorizontal(vx, vy, vz);
        azDeg = hor.azDeg;
        altDeg = hor.altDeg;
        panel = 0;
      } else {
        const sx1 = (x - ctx.hemCx1) / ctx.hemRadius1;
        const sy1 = (ctx.hemCy1 - y) / ctx.hemRadius1;
        if (sx1 * sx1 + sy1 * sy1 > 1 + 1e-4 || !ctx.basis1) return null;
        const [vx, vy, vz] = invertStereo(ctx.hemCx1, ctx.hemCy1, ctx.hemRadius1, ctx.basis1);
        const hor = enuVecToHorizontal(vx, vy, vz);
        azDeg = hor.azDeg;
        altDeg = hor.altDeg;
        panel = 1;
      }
      break;
    }
    case "panorama": {
      const dAz = (x - ctx.cx) / ctx.panoScaleX;
      altDeg = params.center_alt_deg + (ctx.cy - y) / ctx.panoScaleY;
      if (Math.abs(dAz) > 180 + 1e-6 || Math.abs(altDeg) > 90) return null;
      azDeg = wrapDeg360(params.center_az_deg + dAz);
      break;
    }
  }

  if (!params.show_below_horizon && altDeg < -0.5) return null;
  const eq = horizontalToEquatorialFast(azDeg, altDeg, latDeg, lastDeg);
  return {
    az_deg: azDeg,
    alt_deg: altDeg,
    ra_deg: eq.raDeg,
    dec_deg: eq.decDeg,
    panel,
  };
}

/** Fast B-V color index to sRGB tuple; converts cleanly to deep red in night-vision mode. */
export function bvToRgb(bv: number, nightVision: boolean): Rgb {
  const c = Number.isFinite(bv) ? Math.min(2.0, Math.max(-0.4, bv)) : 0.65;
  let r = 0;
  let g = 0;
  let b = 0;
  if (c < -0.1) {
    r = 165;
    g = 198;
    b = 255;
  } else if (c < 0.2) {
    const t = (c + 0.1) / 0.3;
    r = Math.round(165 + t * 55);
    g = Math.round(198 + t * 38);
    b = 255;
  } else if (c < 0.55) {
    const t = (c - 0.2) / 0.35;
    r = Math.round(220 + t * 35);
    g = Math.round(236 + t * 14);
    b = Math.round(255 - t * 22);
  } else if (c < 0.95) {
    const t = (c - 0.55) / 0.4;
    r = 255;
    g = Math.round(250 - t * 34);
    b = Math.round(233 - t * 78);
  } else if (c < 1.45) {
    const t = (c - 0.95) / 0.5;
    r = 255;
    g = Math.round(216 - t * 48);
    b = Math.round(155 - t * 58);
  } else {
    r = 255;
    g = 148;
    b = 88;
  }

  if (nightVision) {
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    return { r: Math.max(90, Math.min(255, Math.round(luma))), g: 0, b: 0 };
  }
  return { r, g, b };
}

export function rgbCss(c: Rgb, alpha = 1): string {
  if (alpha >= 0.999) return `rgb(${c.r}, ${c.g}, ${c.b})`;
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${alpha.toFixed(3)})`;
}

/** Browser-preview lightweight fallback frame used only when running outside Tauri desktop runtime. */
export function buildBrowserPreviewFrame(req: SkyFrameRequest): SkyFrame {
  const nowMs = req.jd_ut != null ? (req.jd_ut - 2440587.5) * 86400000 : Date.now();
  const jdUt = 2440587.5 + nowMs / 86400000;
  const jdTt = jdUt + 69.2 / 86400;
  const t = (jdUt - 2451545.0) / 36525.0;
  const gmstDeg = wrapDeg360(
    280.46061837 + 360.98564736629 * (jdUt - 2451545.0) + 0.000387933 * t * t,
  );
  const lstDeg = wrapDeg360(gmstDeg + req.lon_deg);
  const dLocal = new Date(nowMs + req.tz_offset_min * 60000);
  const dDays = jdTt - 2451545.0;
  const sunLon = wrapDeg360(280.46 + 0.9856474 * dDays + 1.915 * Math.sin((357.528 + 0.9856 * dDays) * DEG2RAD));
  const eps = 23.4393 * DEG2RAD;
  const sunRa = wrapDeg360(Math.atan2(Math.cos(eps) * Math.sin(sunLon * DEG2RAD), Math.cos(sunLon * DEG2RAD)) * RAD2DEG);
  const sunDec = Math.asin(Math.sin(eps) * Math.sin(sunLon * DEG2RAD)) * RAD2DEG;
  const sunHor = equatorialToHorizontalFast(sunRa, sunDec, req.lat_deg, lstDeg);
  const night = req.night_vision;
  const nv = (r: number, g: number, b: number): Rgb =>
    night ? { r: Math.round((0.299 * r + 0.587 * g + 0.114 * b) * 0.85), g: 0, b: 0 } : { r, g, b };

  return {
    jd_ut: jdUt,
    jd_tt: jdTt,
    gmst_deg: gmstDeg,
    lst_deg: lstDeg,
    last_deg: lstDeg,
    obliquity_deg: 23.4393,
    local_dt: {
      year: dLocal.getUTCFullYear(),
      month: dLocal.getUTCMonth() + 1,
      day: dLocal.getUTCDate(),
      hour: dLocal.getUTCHours(),
      minute: dLocal.getUTCMinutes(),
      second: dLocal.getUTCSeconds(),
    },
    j2000_to_apparent_matrix: [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    view_mode: req.view_mode ?? "normal",
    j2000_to_enu_override: null,
    pole_track_north: [],
    pole_track_south: [],
    sol_from_other_star: null,
    bodies: [
      {
        id: "sun",
        kind: "sun",
        name_ja: "太陽",
        name_en: "Sun",
        ra_deg: sunRa,
        dec_deg: sunDec,
        az_deg: sunHor.azDeg,
        alt_deg: sunHor.altDeg,
        geo_au: 1.0,
        helio_au: 0.0,
        visual_magnitude: -26.74,
        angular_diameter_arcsec: 1920,
        illuminated_fraction: 1,
        phase_angle_deg: 0,
        elongation_deg: 0,
      },
    ],
    sky_palette: {
      zenith: nv(4, 7, 17),
      mid_sky: nv(7, 14, 34),
      horizon: nv(16, 28, 56),
      sun_glow: nv(240, 120, 50),
      sun_glow_strength: sunHor.altDeg > -14 && sunHor.altDeg < 10 ? 0.55 : 0,
      anti_solar_glow: nv(180, 100, 130),
      anti_solar_strength: 0,
      moonlight_glow: nv(142, 174, 224),
      moonlight_strength: 0,
      light_pollution: nv(168, 120, 74),
      light_pollution_strength: 0.15,
      ground: nv(4, 8, 14),
      horizon_line: nv(45, 70, 105),
      star_visibility_factor: sunHor.altDeg > 4 ? 0.1 : 1.0,
      estimated_bortle: 3,
    },
  };
}
