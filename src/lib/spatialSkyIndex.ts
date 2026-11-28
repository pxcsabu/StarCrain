import type { CompiledProjectionContext } from "@/lib/projection";

/** Packed floats per star in binary IPC & spatial grid (`[x, y, z, mag, ci, idx_u32]`). */
export const STAR_STRIDE = 6;
/** Packed floats per DSO in binary IPC & spatial grid (`[x, y, z, mag, maj, axisRatio, pa, kind, messier, idx_u32]`). */
export const DSO_STRIDE = 10;

export interface SpatialSkyCell {
  start: number; // start entry index (multiply by stride for Float32Array offset)
  end: number; // exclusive entry index
  cx: number; // unit vector pointing to cell center (J2000)
  cy: number;
  cz: number;
  radiusRad: number;
  cosRadius: number;
  sinRadius: number;
  minMag: number; // brightest mag in cell (or -99 if cell has Messier DSOs)
}

export interface SpatialSkyGrid {
  stride: number;
  data: Float32Array;
  ids: Uint32Array;
  cells: SpatialSkyCell[];
}

export interface PanelCullCone {
  useCone: boolean;
  fxJ: number;
  fyJ: number;
  fzJ: number;
  halfConeRad: number;
  cosHalfCone: number;
  sinHalfCone: number;
}

const DEC_BANDS = 12;
const RA_SECTORS = 24;
const CELL_COUNT = DEC_BANDS * RA_SECTORS;

const starGridCache = new WeakMap<Float32Array, SpatialSkyGrid>();
const dsoGridCache = new WeakMap<Float32Array, SpatialSkyGrid>();

function cellIndexForUnitVec(x: number, y: number, z: number): number {
  const dec = Math.asin(Math.max(-1, Math.min(1, z)));
  let ra = Math.atan2(y, x);
  if (ra < 0) ra += Math.PI * 2;
  const decBand = Math.min(
    DEC_BANDS - 1,
    Math.max(0, Math.floor(((dec + Math.PI * 0.5) / Math.PI) * DEC_BANDS)),
  );
  const raSec = Math.min(
    RA_SECTORS - 1,
    Math.max(0, Math.floor((ra / (Math.PI * 2)) * RA_SECTORS)),
  );
  return decBand * RA_SECTORS + raSec;
}

function buildSpatialGrid(
  source: Float32Array,
  stride: number,
  messierAware: boolean,
): SpatialSkyGrid {
  const totalCount = Math.floor(source.length / stride);
  const srcIds = new Uint32Array(
    source.buffer,
    source.byteOffset,
    Math.floor(source.byteLength / 4),
  );
  const counts = new Int32Array(CELL_COUNT);
  const cellIds = new Uint16Array(totalCount);

  for (let i = 0; i < totalCount; i++) {
    const off = i * stride;
    const cid = cellIndexForUnitVec(source[off], source[off + 1], source[off + 2]);
    cellIds[i] = cid;
    counts[cid]++;
  }

  const buckets: number[][] = new Array(CELL_COUNT);
  for (let c = 0; c < CELL_COUNT; c++) {
    buckets[c] = counts[c] > 0 ? [] : [];
  }
  for (let i = 0; i < totalCount; i++) {
    buckets[cellIds[i]].push(i);
  }

  const packed = new Float32Array(totalCount * stride);
  const ids = new Uint32Array(totalCount);
  const messierSlot = 8; // [x, y, z, mag, maj, axisRatio, pa, kind, messier, idx]
  const cells: SpatialSkyCell[] = [];
  let cursor = 0;

  for (let c = 0; c < CELL_COUNT; c++) {
    const list = buckets[c];
    if (list.length === 0) continue;

    if (messierAware) {
      list.sort((a, b) => {
        const oa = a * stride;
        const ob = b * stride;
        const ma = source[oa + messierSlot] > 0 ? 0 : 1;
        const mb = source[ob + messierSlot] > 0 ? 0 : 1;
        if (ma !== mb) return ma - mb;
        return source[oa + 3] - source[ob + 3];
      });
    } else {
      list.sort((a, b) => source[a * stride + 3] - source[b * stride + 3]);
    }

    const start = cursor;
    let sx = 0;
    let sy = 0;
    let sz = 0;
    for (let k = 0; k < list.length; k++) {
      const srcOff = list[k] * stride;
      const dstOff = cursor * stride;
      for (let f = 0; f < stride; f++) {
        packed[dstOff + f] = source[srcOff + f];
      }
      ids[cursor] = srcIds[srcOff + stride - 1];
      sx += source[srcOff];
      sy += source[srcOff + 1];
      sz += source[srcOff + 2];
      cursor++;
    }
    const end = cursor;

    let norm = Math.hypot(sx, sy, sz);
    let cx = 0;
    let cy = 0;
    let cz = 1;
    if (norm > 1e-6) {
      cx = sx / norm;
      cy = sy / norm;
      cz = sz / norm;
    } else {
      const firstOff = start * stride;
      norm = Math.hypot(packed[firstOff], packed[firstOff + 1], packed[firstOff + 2]) || 1;
      cx = packed[firstOff] / norm;
      cy = packed[firstOff + 1] / norm;
      cz = packed[firstOff + 2] / norm;
    }

    let minDot = 1.0;
    for (let idx = start; idx < end; idx++) {
      const off = idx * stride;
      const d = packed[off] * cx + packed[off + 1] * cy + packed[off + 2] * cz;
      if (d < minDot) minDot = d;
    }
    const radiusRad = Math.min(Math.PI, Math.acos(Math.max(-1, Math.min(1, minDot))) + 0.004);
    const firstOff = start * stride;
    const minMag =
      messierAware && packed[firstOff + messierSlot] > 0 ? -99 : packed[firstOff + 3];

    cells.push({
      start,
      end,
      cx,
      cy,
      cz,
      radiusRad,
      cosRadius: Math.cos(radiusRad),
      sinRadius: Math.sin(radiusRad),
      minMag,
    });
  }

  return { stride, data: packed, ids, cells };
}

/** Cacheable 288-cell spherical spatial index over packed star Float32Array (stride 6). */
export function getOrBuildStarSpatialGrid(starBuffer: Float32Array): SpatialSkyGrid {
  let cached = starGridCache.get(starBuffer);
  if (!cached) {
    cached = buildSpatialGrid(starBuffer, STAR_STRIDE, false);
    starGridCache.set(starBuffer, cached);
  }
  return cached;
}

/** Cacheable 288-cell spherical spatial index over packed DSO Float32Array (stride 10). */
export function getOrBuildDsoSpatialGrid(dsoBuffer: Float32Array): SpatialSkyGrid {
  let cached = dsoGridCache.get(dsoBuffer);
  if (!cached) {
    cached = buildSpatialGrid(dsoBuffer, DSO_STRIDE, true);
    dsoGridCache.set(dsoBuffer, cached);
  }
  return cached;
}

/** Compute J2000 bounding view cone for fast spherical cell culling on a projection panel. */
export function computePanelCullCone(
  pCtx: CompiledProjectionContext,
  panel: number,
  mJ2000ToEnu: Float64Array,
  mJ2000ToApp: Float64Array,
): PanelCullCone {
  const { mode, width, height } = pCtx.params;
  if (mode === "all_sky" || mode === "panorama") {
    return {
      useCone: false,
      fxJ: 0,
      fyJ: 0,
      fzJ: 1,
      halfConeRad: Math.PI,
      cosHalfCone: -1,
      sinHalfCone: 0,
    };
  }

  let fxJ = 0;
  let fyJ = 0;
  let fzJ = 1;
  let halfConeRad = Math.PI;

  if (mode === "star_chart") {
    const b = pCtx.eqBasis;
    fxJ = mJ2000ToApp[0] * b.fx + mJ2000ToApp[3] * b.fy + mJ2000ToApp[6] * b.fz;
    fyJ = mJ2000ToApp[1] * b.fx + mJ2000ToApp[4] * b.fy + mJ2000ToApp[7] * b.fz;
    fzJ = mJ2000ToApp[2] * b.fx + mJ2000ToApp[5] * b.fy + mJ2000ToApp[8] * b.fz;
    const cornerR = Math.hypot(width * 0.5, height * 0.5);
    halfConeRad = 2 * Math.atan(cornerR / Math.max(1e-3, pCtx.stereoScalePx)) + 0.08;
  } else if (mode === "hemisphere_single" || mode === "hemisphere_dual") {
    const b = panel === 1 && pCtx.basis1 ? pCtx.basis1 : pCtx.basis0;
    fxJ = mJ2000ToEnu[0] * b.fx + mJ2000ToEnu[3] * b.fy + mJ2000ToEnu[6] * b.fz;
    fyJ = mJ2000ToEnu[1] * b.fx + mJ2000ToEnu[4] * b.fy + mJ2000ToEnu[7] * b.fz;
    fzJ = mJ2000ToEnu[2] * b.fx + mJ2000ToEnu[5] * b.fy + mJ2000ToEnu[8] * b.fz;
    halfConeRad = Math.PI * 0.5 + 0.08;
  } else {
    const b = pCtx.basis0;
    fxJ = mJ2000ToEnu[0] * b.fx + mJ2000ToEnu[3] * b.fy + mJ2000ToEnu[6] * b.fz;
    fyJ = mJ2000ToEnu[1] * b.fx + mJ2000ToEnu[4] * b.fy + mJ2000ToEnu[7] * b.fz;
    fzJ = mJ2000ToEnu[2] * b.fx + mJ2000ToEnu[5] * b.fy + mJ2000ToEnu[8] * b.fz;
    const cornerR = Math.hypot(width * 0.5, height * 0.5);
    halfConeRad = 2 * Math.atan(cornerR / Math.max(1e-3, pCtx.stereoScalePx)) + 0.08;
  }

  const len = Math.hypot(fxJ, fyJ, fzJ) || 1;
  fxJ /= len;
  fyJ /= len;
  fzJ /= len;

  if (halfConeRad >= Math.PI - 0.04) {
    return {
      useCone: false,
      fxJ,
      fyJ,
      fzJ,
      halfConeRad: Math.PI,
      cosHalfCone: -1,
      sinHalfCone: 0,
    };
  }

  return {
    useCone: true,
    fxJ,
    fyJ,
    fzJ,
    halfConeRad,
    cosHalfCone: Math.cos(halfConeRad),
    sinHalfCone: Math.sin(halfConeRad),
  };
}

/** O(1) cell visibility test combining magnitude ceiling, horizon culling, and view cone overlap. */
export function isSpatialCellVisible(
  cell: SpatialSkyCell,
  magLimit: number,
  canCullHorizon: boolean,
  m20: number,
  m21: number,
  m22: number,
  cone: PanelCullCone,
): boolean {
  if (cell.minMag > magLimit) return false;
  if (canCullHorizon) {
    const czEnu = cell.cx * m20 + cell.cy * m21 + cell.cz * m22;
    if (czEnu < -cell.sinRadius - 0.06) return false;
  }
  if (cone.useCone) {
    const dot = cell.cx * cone.fxJ + cell.cy * cone.fyJ + cell.cz * cone.fzJ;
    const minDot = cone.cosHalfCone * cell.cosRadius - cone.sinHalfCone * cell.sinRadius;
    if (dot < minDot) return false;
  }
  return true;
}
