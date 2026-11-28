import {
  applyStandardRefractionDeg,
  buildJ2000ToEnuMatrix,
  compileProjectionContext,
  effectiveFovDeg,
  flattenMat3,
  projectAppEqVectorForStarChart,
  projectEnuVectorOnPanel,
  unprojectScreen,
} from "@/lib/projection";
import {
  DSO_STRIDE,
  STAR_STRIDE,
  getOrBuildDsoSpatialGrid,
  getOrBuildStarSpatialGrid,
} from "@/lib/spatialSkyIndex";
import type { LocationPreset, PickedObject, ProjectionParams, SkyFrame } from "@/types/sky";

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

export type LocalPickMatch =
  | { source: "body"; picked: PickedObject }
  | { source: "catalog"; kind: "star" | "dso"; index: number; angularSepDeg: number };

function raDecToUnitVec(raDeg: number, decDeg: number): [number, number, number] {
  const ra = raDeg * DEG2RAD;
  const dec = decDeg * DEG2RAD;
  const cd = Math.cos(dec);
  return [cd * Math.cos(ra), cd * Math.sin(ra), Math.sin(dec)];
}

/**
 * Resolve taps locally across Solar System bodies (immediate PickedObject, zero IPC) and
 * the 288-cell spherical spatial index for stars & DSOs (returns catalog index for O(1) Rust lookup).
 */
export function pickSkyObjectLocal(args: {
  x: number;
  y: number;
  params: ProjectionParams;
  frame: SkyFrame;
  location: LocationPreset;
  starBuffer: Float32Array | null;
  dsoBuffer: Float32Array | null;
  limitingMag: number;
  refractionEnabled: boolean;
}): LocalPickMatch | null {
  const {
    x,
    y,
    params,
    frame,
    location,
    starBuffer,
    dsoBuffer,
    limitingMag,
    refractionEnabled,
  } = args;

  const isOtherStar = frame.view_mode === "other_star";
  const isChart = params.mode === "star_chart";
  const showOppositeGroundSky = !(
    params.mode === "all_sky" ||
    params.mode === "hemisphere_single" ||
    params.mode === "hemisphere_dual"
  );
  const canCullHorizon = !params.show_below_horizon && !showOppositeGroundSky;
  const effFov = effectiveFovDeg(params.mode, params.fov_deg) / Math.max(0.2, params.zoom);
  const searchRadiusDeg = Math.min(3.5, Math.max(0.35, effFov / 34));
  const searchRadiusRad = searchRadiusDeg * DEG2RAD;

  const pCtx = compileProjectionContext(params);
  const skyPCtx =
    params.show_below_horizon || !showOppositeGroundSky
      ? pCtx
      : compileProjectionContext({ ...params, show_below_horizon: true });
  const mJ2000ToApp = flattenMat3(frame.j2000_to_apparent_matrix);
  const mJ2000ToEnu = frame.j2000_to_enu_override
    ? flattenMat3(frame.j2000_to_enu_override)
    : buildJ2000ToEnuMatrix(frame.j2000_to_apparent_matrix, frame.last_deg, location.lat_deg);
  const panels = params.mode === "hemisphere_dual" ? [0, 1] : [0];
  const pxPerDeg = Math.min(params.width, params.height) / Math.max(0.25, effFov);
  const scratch = new Float64Array(3);

  const inv = unprojectScreen(x, y, params, location.lat_deg, frame.last_deg);
  let clickAppVec: [number, number, number] | null = null;
  let clickJ2000Vec: [number, number, number] | null = null;

  if (inv && inv.ra_deg != null && inv.dec_deg != null) {
    clickAppVec = raDecToUnitVec(inv.ra_deg, inv.dec_deg);
    const [ax, ay, az] = clickAppVec;
    // Transpose of mJ2000ToApp converts Apparent -> J2000
    clickJ2000Vec = [
      mJ2000ToApp[0] * ax + mJ2000ToApp[3] * ay + mJ2000ToApp[6] * az,
      mJ2000ToApp[1] * ax + mJ2000ToApp[4] * ay + mJ2000ToApp[7] * az,
      mJ2000ToApp[2] * ax + mJ2000ToApp[5] * ay + mJ2000ToApp[8] * az,
    ];
  } else if (inv && inv.az_deg != null && inv.alt_deg != null && !isChart) {
    const altRad = inv.alt_deg * DEG2RAD;
    const azRad = inv.az_deg * DEG2RAD;
    const ca = Math.cos(altRad);
    const e = ca * Math.sin(azRad);
    const n = ca * Math.cos(azRad);
    const u = Math.sin(altRad);
    clickJ2000Vec = [
      mJ2000ToEnu[0] * e + mJ2000ToEnu[3] * n + mJ2000ToEnu[6] * u,
      mJ2000ToEnu[1] * e + mJ2000ToEnu[4] * n + mJ2000ToEnu[7] * u,
      mJ2000ToEnu[2] * e + mJ2000ToEnu[5] * n + mJ2000ToEnu[8] * u,
    ];
  }

  let bestScore = Infinity;
  let bestResult: LocalPickMatch | null = null;
  const hitMaxPx = Math.max(20, searchRadiusDeg * pxPerDeg * 1.15);

  // 1. Solar System Bodies (planet / Moon / Sun / comet -> zero IPC)
  if (!isOtherStar) {
    for (const b of frame.bodies) {
      if (!params.show_below_horizon && !showOppositeGroundSky && b.alt_deg < -0.5) {
        continue;
      }
      if (
        b.id !== "sun" &&
        b.id !== "moon" &&
        frame.sky_palette.star_visibility_factor < 0.12 &&
        b.visual_magnitude > -2.5
      ) {
        continue;
      }

      const bApp = raDecToUnitVec(b.ra_deg, b.dec_deg);
      let sepDeg = 999;
      if (clickAppVec) {
        const dot = Math.max(
          -1,
          Math.min(1, bApp[0] * clickAppVec[0] + bApp[1] * clickAppVec[1] + bApp[2] * clickAppVec[2]),
        );
        sepDeg = Math.acos(dot) * RAD2DEG;
      }

      let bestBodyPx = Infinity;
      const bAltRad = b.alt_deg * DEG2RAD;
      const bAzRad = b.az_deg * DEG2RAD;
      const bCa = Math.cos(bAltRad);
      const bE = bCa * Math.sin(bAzRad);
      const bN = bCa * Math.cos(bAzRad);
      const bU = Math.sin(bAltRad);

      for (const panel of panels) {
        const ok = isChart
          ? projectAppEqVectorForStarChart(bApp[0], bApp[1], bApp[2], bU, skyPCtx, scratch)
          : projectEnuVectorOnPanel(bE, bN, bU, skyPCtx, panel, scratch);
        if (!ok || scratch[2] < 0.5) continue;
        const dPx = Math.hypot(scratch[0] - x, scratch[1] - y);
        if (dPx < bestBodyPx) bestBodyPx = dPx;
      }
      if (!Number.isFinite(bestBodyPx)) continue;

      const bodyRadDeg = Math.min(1.5, b.angular_diameter_arcsec / 7200);
      const bodyRadPx = Math.min(28, bodyRadDeg * pxPerDeg);
      if (bestBodyPx > Math.max(hitMaxPx, bodyRadPx + 12)) continue;
      const effectiveSepDeg = sepDeg < 900 ? sepDeg : bestBodyPx / Math.max(1, pxPerDeg);
      if (effectiveSepDeg > searchRadiusDeg + bodyRadDeg) continue;

      const score = Math.max(0, effectiveSepDeg - bodyRadDeg) - 0.12;
      if (score < bestScore) {
        bestScore = score;
        const extra =
          b.id === "moon"
            ? `月齢 ${(b.moon_age_days ?? 0).toFixed(1)}日 / 輝面比 ${(b.illuminated_fraction * 100).toFixed(0)}% / 視直径 ${(b.angular_diameter_arcsec / 60).toFixed(1)}'`
            : b.id === "sun"
              ? `視直径 ${(b.angular_diameter_arcsec / 60).toFixed(1)}'`
              : b.kind === "comet"
                ? `日心 ${b.helio_au.toFixed(3)} AU / 地心 ${b.geo_au.toFixed(3)} AU / 離角 ${b.elongation_deg.toFixed(1)}°`
                : `離角 ${b.elongation_deg.toFixed(1)}° / 輝面比 ${(b.illuminated_fraction * 100).toFixed(0)}% / 視直径 ${b.angular_diameter_arcsec.toFixed(1)}"`;

        bestResult = {
          source: "body",
          picked: {
            kind: b.kind,
            id: b.id,
            name_ja: b.name_ja,
            name_en: b.name_en,
            constellation: null,
            mag: b.visual_magnitude,
            ra_deg: b.ra_deg,
            dec_deg: b.dec_deg,
            az_deg: b.az_deg,
            alt_deg: b.alt_deg,
            dist_text: `${b.geo_au.toFixed(4)} AU`,
            angular_sep_deg: effectiveSepDeg,
            extra_info: extra,
          },
        };
      }
    }
  }

  if (!clickJ2000Vec) {
    return bestResult;
  }

  const [cxJ, cyJ, czJ] = clickJ2000Vec;
  const vis = frame.sky_palette.star_visibility_factor;
  const effectiveStarLimit =
    vis < 0.25 ? Math.min(limitingMag, 2.2) : vis < 0.7 ? limitingMag - 1.5 : limitingMag;
  const starMagCeiling = effectiveStarLimit + 0.5;
  const cosSearch = Math.cos(searchRadiusRad);
  const sinSearch = Math.sin(searchRadiusRad);

  const isJ2000VisibleOnScreen = (vx: number, vy: number, vz: number): boolean => {
    if (isChart) {
      const ax = mJ2000ToApp[0] * vx + mJ2000ToApp[1] * vy + mJ2000ToApp[2] * vz;
      const ay = mJ2000ToApp[3] * vx + mJ2000ToApp[4] * vy + mJ2000ToApp[5] * vz;
      const az = mJ2000ToApp[6] * vx + mJ2000ToApp[7] * vy + mJ2000ToApp[8] * vz;
      const uzEnu = mJ2000ToEnu[6] * vx + mJ2000ToEnu[7] * vy + mJ2000ToEnu[8] * vz;
      return projectAppEqVectorForStarChart(ax, ay, az, uzEnu, skyPCtx, scratch) && scratch[2] > 0.5;
    }
    const e = mJ2000ToEnu[0] * vx + mJ2000ToEnu[1] * vy + mJ2000ToEnu[2] * vz;
    const n = mJ2000ToEnu[3] * vx + mJ2000ToEnu[4] * vy + mJ2000ToEnu[5] * vz;
    let u = mJ2000ToEnu[6] * vx + mJ2000ToEnu[7] * vy + mJ2000ToEnu[8] * vz;
    if (refractionEnabled) {
      const altDeg = Math.asin(Math.max(-1, Math.min(1, u))) * RAD2DEG;
      const refAltDeg = applyStandardRefractionDeg(altDeg);
      if (refAltDeg < -0.5 && canCullHorizon) return false;
      const refAltRad = refAltDeg * DEG2RAD;
      const horizLen = Math.hypot(e, n);
      if (horizLen > 1e-12) {
        const scale = Math.cos(refAltRad) / horizLen;
        const ee = e * scale;
        const nn = n * scale;
        const uu = Math.sin(refAltRad);
        for (const panel of panels) {
          if (projectEnuVectorOnPanel(ee, nn, uu, skyPCtx, panel, scratch) && scratch[2] > 0.5) {
            return true;
          }
        }
        return false;
      }
      u = Math.sin(refAltRad);
    } else if (canCullHorizon && u < -0.0087) {
      return false;
    }

    for (const panel of panels) {
      if (projectEnuVectorOnPanel(e, n, u, skyPCtx, panel, scratch) && scratch[2] > 0.5) {
        return true;
      }
    }
    return false;
  };

  // 2. Stars via 288-cell spherical index
  if (starBuffer && starBuffer.length >= STAR_STRIDE) {
    const starGrid = getOrBuildStarSpatialGrid(starBuffer);
    const data = starGrid.data;
    const ids = starGrid.ids;
    for (const cell of starGrid.cells) {
      if (cell.minMag > starMagCeiling) continue;
      const cellDot = cell.cx * cxJ + cell.cy * cyJ + cell.cz * czJ;
      const minCellDot = cosSearch * cell.cosRadius - sinSearch * cell.sinRadius;
      if (cellDot < minCellDot) continue;

      for (let i = cell.start; i < cell.end; i++) {
        const off = i * STAR_STRIDE;
        const mag = data[off + 3];
        if (mag > starMagCeiling) break;
        const vx = data[off];
        const vy = data[off + 1];
        const vz = data[off + 2];
        const dot = Math.max(-1, Math.min(1, vx * cxJ + vy * cyJ + vz * czJ));
        if (dot < cosSearch) continue;
        const sepDeg = Math.acos(dot) * RAD2DEG;
        if (sepDeg > searchRadiusDeg) continue;

        const catalogIdx = ids[i];
        if (catalogIdx === 0xffffffff) continue;
        if (!isJ2000VisibleOnScreen(vx, vy, vz)) continue;

        const score = sepDeg + 0.018 * Math.max(-1.5, mag);
        if (score < bestScore) {
          bestScore = score;
          bestResult = {
            source: "catalog",
            kind: "star",
            index: catalogIdx,
            angularSepDeg: sepDeg,
          };
        }
      }
    }
  }

  // 3. DSOs via 288-cell spherical index
  if (dsoBuffer && dsoBuffer.length >= DSO_STRIDE && !isOtherStar) {
    const dsoGrid = getOrBuildDsoSpatialGrid(dsoBuffer);
    const data = dsoGrid.data;
    const ids = dsoGrid.ids;
    const dsoMagCeiling = Math.min(12.8, limitingMag + 4.5);
    const dsoConeRad = Math.max(searchRadiusRad, 1.5 * DEG2RAD);
    const cosDsoCone = Math.cos(dsoConeRad);
    const sinDsoCone = Math.sin(dsoConeRad);

    for (const cell of dsoGrid.cells) {
      if (cell.minMag > dsoMagCeiling) continue;
      const cellDot = cell.cx * cxJ + cell.cy * cyJ + cell.cz * czJ;
      const minCellDot = cosDsoCone * cell.cosRadius - sinDsoCone * cell.sinRadius;
      if (cellDot < minCellDot) continue;

      for (let i = cell.start; i < cell.end; i++) {
        const off = i * DSO_STRIDE;
        const mag = data[off + 3];
        const messierNum = data[off + 8];
        if (messierNum === 0 && mag > dsoMagCeiling) break;

        const vx = data[off];
        const vy = data[off + 1];
        const vz = data[off + 2];
        const majArcmin = data[off + 4];
        const hitDeg = Math.min(3.5, Math.max(searchRadiusDeg, majArcmin / 120));
        const dot = Math.max(-1, Math.min(1, vx * cxJ + vy * cyJ + vz * czJ));
        const sepDeg = Math.acos(dot) * RAD2DEG;
        if (sepDeg > hitDeg) continue;

        if (!isJ2000VisibleOnScreen(vx, vy, vz)) continue;
        const score = sepDeg + (messierNum > 0 ? 0.02 : 0.08);
        if (score < bestScore) {
          bestScore = score;
          bestResult = {
            source: "catalog",
            kind: "dso",
            index: ids[i],
            angularSepDeg: sepDeg,
          };
        }
      }
    }
  }

  return bestResult;
}
