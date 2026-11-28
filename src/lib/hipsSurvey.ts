import { invoke, isTauri } from "@tauri-apps/api/core";
import type { PanelCullCone } from "@/lib/spatialSkyIndex";
import type { HipsSurveyConfig, HipsSurveyId } from "@/types/sky";

const JRLL = [2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4] as const;
const JPLL = [1, 3, 5, 7, 0, 2, 4, 6, 1, 3, 5, 7] as const;

const HIPS_PRIMARY_BASE: Record<HipsSurveyId, string> = {
  dss2_color: "https://alasky.cds.unistra.fr/DSS/DSSColor",
  dss2_red: "https://alasky.cds.unistra.fr/DSS/DSS2Merged",
  "2mass_color": "https://alasky.cds.unistra.fr/2MASS/Color",
};

const MAX_MEMORY_TILES = 220;
const MAX_CONCURRENT_FETCHES = 6;
const RETRY_FAILED_AFTER_MS = 25_000;

export interface HipsTileSpec {
  order: number;
  npix: number;
  face: number;
  ix: number;
  iy: number;
  distRad: number;
}

interface CachedTileEntry {
  key: string;
  normal: ImageBitmap | HTMLImageElement;
  nightVision: HTMLCanvasElement | null;
  width: number;
  height: number;
  lastUsed: number;
}

const tileCache = new Map<string, CachedTileEntry>();
const inFlightKeys = new Set<string>();
const failedAtMs = new Map<string, number>();
let activeFetchCount = 0;
let pendingQueue: {
  key: string;
  surveyId: HipsSurveyId;
  order: number;
  npix: number;
  offlineMode: boolean;
  priority: number;
}[] = [];

const tileLoadedListeners = new Set<() => void>();

export function onHipsTileLoaded(cb: () => void): () => void {
  tileLoadedListeners.add(cb);
  return () => {
    tileLoadedListeners.delete(cb);
  };
}

function notifyHipsTileLoaded(): void {
  for (const cb of tileLoadedListeners) {
    cb();
  }
}

export function clearHipsFailureCache(): void {
  failedAtMs.clear();
}

export function clearHipsMemoryCache(): void {
  for (const entry of tileCache.values()) {
    if (typeof ImageBitmap !== "undefined" && entry.normal instanceof ImageBitmap) {
      entry.normal.close();
    }
  }
  tileCache.clear();
  failedAtMs.clear();
}

export function pix2xyNest(npix: number, order: number): { face: number; ix: number; iy: number } {
  const facePixels = 1 << (2 * order);
  const face = Math.floor(npix / facePixels);
  let ipix = npix - face * facePixels;
  let ix = 0;
  let iy = 0;
  for (let bit = 0; bit < order; bit++) {
    ix |= (ipix & 1) << bit;
    ipix >>= 1;
    iy |= (ipix & 1) << bit;
    ipix >>= 1;
  }
  return { face, ix, iy };
}

export function xy2pixNest(face: number, ix: number, iy: number, order: number): number {
  let ipix = 0;
  for (let bit = 0; bit < order; bit++) {
    ipix |= ((ix >> bit) & 1) << (2 * bit);
    ipix |= ((iy >> bit) & 1) << (2 * bit + 1);
  }
  return face * (1 << (2 * order)) + ipix;
}

/**
 * Exact continuous HEALPix projection from face + local `(x, y)` in `[0, nside]^2`
 * to J2000 equatorial unit vector `(out[0], out[1], out[2])`.
 */
export function healpixContinuousToJ2000(
  face: number,
  x: number,
  y: number,
  nside: number,
  out: Float64Array,
): void {
  const jr = JRLL[face] * nside - x - y;
  let z: number;
  let nr: number;

  if (jr < nside) {
    nr = jr;
    const tmp = nr / nside;
    z = 1.0 - (tmp * tmp) / 3.0;
  } else if (jr > 3 * nside) {
    nr = 4 * nside - jr;
    const tmp = nr / nside;
    z = -1.0 + (tmp * tmp) / 3.0;
  } else {
    nr = nside;
    z = ((2 * nside - jr) * 2.0) / (3.0 * nside);
  }

  let phi: number;
  if (nr <= 1e-12) {
    phi = (JPLL[face] * Math.PI) / 4.0;
  } else {
    phi = ((JPLL[face] * nr + (x - y)) * Math.PI) / (4.0 * nr);
  }

  z = Math.max(-1, Math.min(1, z));
  const sinTheta = Math.sqrt(Math.max(0, 1.0 - z * z));
  out[0] = sinTheta * Math.cos(phi);
  out[1] = sinTheta * Math.sin(phi);
  out[2] = z;
}

const cullVecTmp = new Float64Array(3);

function isHealpixCellVisible(
  face: number,
  ix: number,
  iy: number,
  order: number,
  cullCone: PanelCullCone,
  canCullHorizon: boolean,
  m20: number,
  m21: number,
  m22: number,
): { visible: boolean; distRad: number } {
  const nside = 1 << order;
  healpixContinuousToJ2000(face, ix + 0.5, iy + 0.5, nside, cullVecTmp);
  const vx = cullVecTmp[0];
  const vy = cullVecTmp[1];
  const vz = cullVecTmp[2];

  // Conservative angular radius of a HEALPix diamond cell (~48 deg / 2^order)
  const halfDiagRad = Math.min(Math.PI, 0.88 / nside);

  if (canCullHorizon) {
    const zEnu = m20 * vx + m21 * vy + m22 * vz;
    const altRad = Math.asin(Math.max(-1, Math.min(1, zEnu)));
    if (altRad + halfDiagRad < -0.06) {
      return { visible: false, distRad: Math.PI };
    }
  }

  let distRad = 0;
  if (cullCone.useCone) {
    const dot = Math.max(
      -1,
      Math.min(1, vx * cullCone.fxJ + vy * cullCone.fyJ + vz * cullCone.fzJ),
    );
    distRad = Math.acos(dot);
    if (distRad > cullCone.halfConeRad + halfDiagRad) {
      return { visible: false, distRad };
    }
  }

  return { visible: true, distRad };
}

/**
 * Hierarchical quadtree traversal returning visible HEALPix NESTED tiles at `order`
 * sorted closest-to-center first.
 */
export function enumerateVisibleHipsTiles(
  targetOrder: number,
  cullCone: PanelCullCone,
  canCullHorizon: boolean,
  m20: number,
  m21: number,
  m22: number,
  maxTiles = 160,
): HipsTileSpec[] {
  const clampedOrder = Math.max(0, Math.min(7, targetOrder));
  let levelNodes: HipsTileSpec[] = [];
  for (let face = 0; face < 12; face++) {
    const check = isHealpixCellVisible(face, 0, 0, 0, cullCone, canCullHorizon, m20, m21, m22);
    if (check.visible) {
      levelNodes.push({ order: 0, npix: face, face, ix: 0, iy: 0, distRad: check.distRad });
    }
  }

  for (let ord = 1; ord <= clampedOrder; ord++) {
    const nextNodes: HipsTileSpec[] = [];
    for (const parent of levelNodes) {
      for (let sub = 0; sub < 4; sub++) {
        const cix = (parent.ix << 1) | (sub & 1);
        const ciy = (parent.iy << 1) | ((sub >> 1) & 1);
        const cnpix = (parent.npix << 2) | sub;
        const check = isHealpixCellVisible(
          parent.face,
          cix,
          ciy,
          ord,
          cullCone,
          canCullHorizon,
          m20,
          m21,
          m22,
        );
        if (check.visible) {
          nextNodes.push({
            order: ord,
            npix: cnpix,
            face: parent.face,
            ix: cix,
            iy: ciy,
            distRad: check.distRad,
          });
        }
      }
    }
    levelNodes = nextNodes;
    if (levelNodes.length > maxTiles * 2 && ord < clampedOrder) {
      // Viewport covers a large fraction of sky; stay at this manageable resolution order.
      break;
    }
  }

  levelNodes.sort((a, b) => a.distRad - b.distRad);
  if (levelNodes.length > maxTiles) {
    return levelNodes.slice(0, maxTiles);
  }
  return levelNodes;
}

export function chooseHipsOrder(
  pxPerDeg: number,
  maxOrder: number,
  _fastInteractive: boolean,
): number {
  // Base order 0 tile spans ~58.6 deg; aim for ~170..340 screen px per tile
  const ideal = Math.round(Math.log2(Math.max(1, (58.63 * pxPerDeg) / 230)));
  return Math.max(0, Math.min(Math.min(7, maxOrder), ideal));
}

export function collectAllSkyHipsTiles(maxOrder = 2): [number, number][] {
  const clamped = Math.max(0, Math.min(3, maxOrder));
  const out: [number, number][] = [];
  for (let ord = 0; ord <= clamped; ord++) {
    const count = 12 * (1 << (2 * ord));
    for (let npix = 0; npix < count; npix++) {
      out.push([ord, npix]);
    }
  }
  return out;
}

export function collectRegionHipsTiles(
  centerJ2000: [number, number, number],
  halfConeRad: number,
  minOrder: number,
  maxOrder: number,
  cap = 260,
): [number, number][] {
  const cone: PanelCullCone = {
    useCone: true,
    fxJ: centerJ2000[0],
    fyJ: centerJ2000[1],
    fzJ: centerJ2000[2],
    halfConeRad: Math.min(Math.PI, Math.max(0.02, halfConeRad)),
    cosHalfCone: Math.cos(halfConeRad),
    sinHalfCone: Math.sin(halfConeRad),
  };
  const out: [number, number][] = [];
  for (let ord = Math.max(0, minOrder); ord <= Math.min(6, maxOrder); ord++) {
    const tiles = enumerateVisibleHipsTiles(ord, cone, false, 0, 0, 1, cap);
    for (const t of tiles) {
      out.push([t.order, t.npix]);
      if (out.length >= cap) return out;
    }
  }
  return out;
}

function tileCacheKey(surveyId: HipsSurveyId, order: number, npix: number): string {
  return `${surveyId}:${order}:${npix}`;
}

function evictLruIfNeeded(): void {
  if (tileCache.size <= MAX_MEMORY_TILES) return;
  let oldestKey: string | null = null;
  let oldestTime = Infinity;
  for (const [k, entry] of tileCache.entries()) {
    if (entry.lastUsed < oldestTime) {
      oldestTime = entry.lastUsed;
      oldestKey = k;
    }
  }
  if (oldestKey) {
    const removed = tileCache.get(oldestKey);
    if (removed && typeof ImageBitmap !== "undefined" && removed.normal instanceof ImageBitmap) {
      removed.normal.close();
    }
    tileCache.delete(oldestKey);
  }
}

function getNightVisionTileCanvas(entry: CachedTileEntry): HTMLCanvasElement {
  if (entry.nightVision) return entry.nightVision;
  const c = document.createElement("canvas");
  c.width = entry.width;
  c.height = entry.height;
  const g = c.getContext("2d");
  if (g) {
    g.drawImage(entry.normal, 0, 0);
    try {
      const img = g.getImageData(0, 0, entry.width, entry.height);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const lum = Math.round(0.32 * d[i] + 0.56 * d[i + 1] + 0.12 * d[i + 2]);
        d[i] = Math.min(255, Math.round(lum * 1.1));
        d[i + 1] = 0;
        d[i + 2] = 0;
      }
      g.putImageData(img, 0, 0);
    } catch {
      // Ignore if cross-origin browser image forbids getImageData
    }
  }
  entry.nightVision = c;
  return c;
}

function loadTileViaBrowserImage(
  surveyId: HipsSurveyId,
  order: number,
  npix: number,
): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const dir = Math.floor(npix / 10000) * 10000;
    const url = `${HIPS_PRIMARY_BASE[surveyId]}/Norder${order}/Dir${dir}/Npix${npix}.jpg`;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("HiPS browser load failed"));
    img.src = url;
  });
}

function pumpFetchQueue(): void {
  while (activeFetchCount < MAX_CONCURRENT_FETCHES && pendingQueue.length > 0) {
    pendingQueue.sort((a, b) => a.priority - b.priority);
    const job = pendingQueue.shift();
    if (!job) break;
    if (tileCache.has(job.key)) {
      inFlightKeys.delete(job.key);
      continue;
    }

    activeFetchCount++;
    void (async () => {
      try {
        let imgSource: ImageBitmap | HTMLImageElement;
        let w: number;
        let h: number;

        if (isTauri()) {
          const buf = await invoke<ArrayBuffer>("fetch_cached_survey_tile_cmd", {
            surveyId: job.surveyId,
            order: job.order,
            npix: job.npix,
            offlineMode: job.offlineMode,
          });
          const blob = new Blob([buf], { type: "image/jpeg" });
          if (typeof createImageBitmap === "function") {
            imgSource = await createImageBitmap(blob);
            w = imgSource.width;
            h = imgSource.height;
          } else {
            const url = URL.createObjectURL(blob);
            try {
              imgSource = await new Promise<HTMLImageElement>((resolve, reject) => {
                const im = new Image();
                im.onload = () => resolve(im);
                im.onerror = () => reject(new Error("decode failed"));
                im.src = url;
              });
              w = imgSource.naturalWidth || 512;
              h = imgSource.naturalHeight || 512;
            } finally {
              URL.revokeObjectURL(url);
            }
          }
        } else {
          if (job.offlineMode) {
            throw new Error("OFFLINE");
          }
          const im = await loadTileViaBrowserImage(job.surveyId, job.order, job.npix);
          imgSource = im;
          w = im.naturalWidth || 512;
          h = im.naturalHeight || 512;
        }

        failedAtMs.delete(job.key);
        tileCache.set(job.key, {
          key: job.key,
          normal: imgSource,
          nightVision: null,
          width: w,
          height: h,
          lastUsed: performance.now(),
        });
        evictLruIfNeeded();
        notifyHipsTileLoaded();
      } catch {
        failedAtMs.set(job.key, performance.now());
      } finally {
        inFlightKeys.delete(job.key);
        activeFetchCount--;
        pumpFetchQueue();
      }
    })();
  }
}

function requestTileIfNeeded(
  surveyId: HipsSurveyId,
  order: number,
  npix: number,
  offlineMode: boolean,
  priority: number,
): void {
  const key = tileCacheKey(surveyId, order, npix);
  if (tileCache.has(key) || inFlightKeys.has(key)) return;
  const lastFail = failedAtMs.get(key);
  if (lastFail !== undefined && performance.now() - lastFail < RETRY_FAILED_AFTER_MS) {
    return;
  }
  inFlightKeys.add(key);
  pendingQueue.push({ key, surveyId, order, npix, offlineMode, priority });
  pumpFetchQueue();
}

function findTileOrAncestor(
  surveyId: HipsSurveyId,
  tile: HipsTileSpec,
): { entry: CachedTileEntry; ancestorOrder: number; localIx: number; localIy: number; scale: number } | null {
  let curOrder = tile.order;
  let curNpix = tile.npix;
  while (curOrder >= 0) {
    const key = tileCacheKey(surveyId, curOrder, curNpix);
    const entry = tileCache.get(key);
    if (entry) {
      entry.lastUsed = performance.now();
      const shift = tile.order - curOrder;
      const scale = 1 << shift;
      const mask = scale - 1;
      return {
        entry,
        ancestorOrder: curOrder,
        localIx: tile.ix & mask,
        localIy: tile.iy & mask,
        scale,
      };
    }
    if (curOrder === 0) break;
    curOrder -= 1;
    curNpix = curNpix >>> 2;
  }
  return null;
}

const meshVecTmp = new Float64Array(3);
const projOutTmp = new Float64Array(3);
const gridX = new Float64Array(9 * 9);
const gridY = new Float64Array(9 * 9);
const gridOk = new Uint8Array(9 * 9);

function drawAffineTriangle(
  ctx: CanvasRenderingContext2D,
  tex: ImageBitmap | HTMLImageElement | HTMLCanvasElement,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  u0: number,
  v0: number,
  u1: number,
  v1: number,
  u2: number,
  v2: number,
): void {
  const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
  if (Math.abs(area) < 0.35) return;

  const du1 = u1 - u0;
  const dv1 = v1 - v0;
  const du2 = u2 - u0;
  const dv2 = v2 - v0;
  const denom = du1 * dv2 - dv1 * du2;
  if (Math.abs(denom) < 1e-6) return;

  const dx1 = x1 - x0;
  const dy1 = y1 - y0;
  const dx2 = x2 - x0;
  const dy2 = y2 - y0;
  const inv = 1 / denom;

  const a = (dx1 * dv2 - dx2 * dv1) * inv;
  const b = (dy1 * dv2 - dy2 * dv1) * inv;
  const c = (dx2 * du1 - dx1 * du2) * inv;
  const d = (dy2 * du1 - dy1 * du2) * inv;
  const e = x0 - a * u0 - c * v0;
  const f = y0 - b * u0 - d * v0;

  // Slightly expand clip triangle around its centroid by 0.65 px to seal raster seams
  const gx = (x0 + x1 + x2) / 3;
  const gy = (y0 + y1 + y2) / 3;
  const expand = (px: number, py: number): [number, number] => {
    const vx = px - gx;
    const vy = py - gy;
    const len = Math.hypot(vx, vy) || 1;
    return [px + (vx / len) * 0.65, py + (vy / len) * 0.65];
  };
  const [cx0, cy0] = expand(x0, y0);
  const [cx1, cy1] = expand(x1, y1);
  const [cx2, cy2] = expand(x2, y2);

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(cx0, cy0);
  ctx.lineTo(cx1, cy1);
  ctx.lineTo(cx2, cy2);
  ctx.closePath();
  ctx.clip();
  ctx.transform(a, b, c, d, e, f);
  ctx.drawImage(tex, 0, 0);
  ctx.restore();
}

export interface DrawHipsLayerArgs {
  ctx: CanvasRenderingContext2D;
  config: HipsSurveyConfig;
  offlineMode: boolean;
  nightVision: boolean;
  starVisibilityFactor: number;
  pxPerDeg: number;
  width: number;
  height: number;
  fastInteractive: boolean;
  cullCone: PanelCullCone;
  canCullHorizon: boolean;
  m20: number;
  m21: number;
  m22: number;
  projectJ2000: (vx: number, vy: number, vz: number, out: Float64Array) => boolean;
}

export function drawHipsSurveyLayer(args: DrawHipsLayerArgs): number {
  const {
    ctx,
    config,
    offlineMode,
    nightVision,
    starVisibilityFactor,
    pxPerDeg,
    width,
    height,
    fastInteractive,
    cullCone,
    canCullHorizon,
    m20,
    m21,
    m22,
    projectJ2000,
  } = args;

  if (!config.enabled || starVisibilityFactor <= 0.14) return 0;

  const targetOrder = chooseHipsOrder(pxPerDeg, config.maxOrder, fastInteractive);
  const tiles = enumerateVisibleHipsTiles(
    targetOrder,
    cullCone,
    canCullHorizon,
    m20,
    m21,
    m22,
    140,
  );
  if (tiles.length === 0) return 0;

  // Limit per-frame queue priority strictly to visible tiles
  const alpha = Math.max(0.05, Math.min(1, config.opacity * starVisibilityFactor));
  const maxEdgePx = Math.max(width, height) * 0.48;
  let renderedCount = 0;

  ctx.save();
  ctx.globalAlpha = alpha;

  for (const tile of tiles) {
    // Also prefetch Order 0 base faces opportunistically as smooth fallback
    if (tile.order > 0) {
      requestTileIfNeeded(config.surveyId, 0, tile.face, offlineMode, 10 + tile.distRad);
    }
    requestTileIfNeeded(config.surveyId, tile.order, tile.npix, offlineMode, tile.distRad);

    const found = findTileOrAncestor(config.surveyId, tile);
    if (!found) continue;

    renderedCount++;
    const tex = nightVision ? getNightVisionTileCanvas(found.entry) : found.entry.normal;
    const tw = found.entry.width;
    const th = found.entry.height;

    const sub =
      tile.order === 0
        ? 8
        : tile.order === 1
          ? 6
          : tile.order === 2
            ? 4
            : tile.order === 3
              ? 3
              : tile.order === 4
                ? 2
                : 1;
    const stride = sub + 1;
    const nside = 1 << tile.order;

    for (let i = 0; i <= sub; i++) {
      const v = i / sub;
      const fx = v;
      for (let j = 0; j <= sub; j++) {
        const u = j / sub;
        const fy = u;
        const idx = i * stride + j;
        healpixContinuousToJ2000(tile.face, tile.ix + fx, tile.iy + fy, nside, meshVecTmp);
        const ok = projectJ2000(meshVecTmp[0], meshVecTmp[1], meshVecTmp[2], projOutTmp);
        if (ok) {
          gridOk[idx] = 1;
          gridX[idx] = projOutTmp[0];
          gridY[idx] = projOutTmp[1];
        } else {
          gridOk[idx] = 0;
        }
      }
    }

    for (let i = 0; i < sub; i++) {
      const v0 = i / sub;
      const v1 = (i + 1) / sub;
      const fx0 = v0;
      const fx1 = v1;
      for (let j = 0; j < sub; j++) {
        const u0 = j / sub;
        const u1 = (j + 1) / sub;
        const fy0 = u0;
        const fy1 = u1;

        const i00 = i * stride + j;
        const i10 = i * stride + (j + 1);
        const i01 = (i + 1) * stride + j;
        const i11 = (i + 1) * stride + (j + 1);

        // Map local (fx, fy) -> ancestor image coordinates (pxU, pxV); empirically verified u=fy, v=fx
        const ancU0 = ((found.localIy + fy0) / found.scale) * tw;
        const ancU1 = ((found.localIy + fy1) / found.scale) * tw;
        const ancV0 = ((found.localIx + fx0) / found.scale) * th;
        const ancV1 = ((found.localIx + fx1) / found.scale) * th;

        // Triangle 1: (00, 10, 11)
        if (gridOk[i00] && gridOk[i10] && gridOk[i11]) {
          const d01 = Math.hypot(gridX[i10] - gridX[i00], gridY[i10] - gridY[i00]);
          const d12 = Math.hypot(gridX[i11] - gridX[i10], gridY[i11] - gridY[i10]);
          const d20 = Math.hypot(gridX[i00] - gridX[i11], gridY[i00] - gridY[i11]);
          if (d01 < maxEdgePx && d12 < maxEdgePx && d20 < maxEdgePx) {
            drawAffineTriangle(
              ctx,
              tex,
              gridX[i00],
              gridY[i00],
              gridX[i10],
              gridY[i10],
              gridX[i11],
              gridY[i11],
              ancU0,
              ancV0,
              ancU1,
              ancV0,
              ancU1,
              ancV1,
            );
          }
        }

        // Triangle 2: (00, 11, 01)
        if (gridOk[i00] && gridOk[i11] && gridOk[i01]) {
          const d01 = Math.hypot(gridX[i11] - gridX[i00], gridY[i11] - gridY[i00]);
          const d12 = Math.hypot(gridX[i01] - gridX[i11], gridY[i01] - gridY[i11]);
          const d20 = Math.hypot(gridX[i00] - gridX[i01], gridY[i00] - gridY[i01]);
          if (d01 < maxEdgePx && d12 < maxEdgePx && d20 < maxEdgePx) {
            drawAffineTriangle(
              ctx,
              tex,
              gridX[i00],
              gridY[i00],
              gridX[i11],
              gridY[i11],
              gridX[i01],
              gridY[i01],
              ancU0,
              ancV0,
              ancU1,
              ancV1,
              ancU0,
              ancV1,
            );
          }
        }
      }
    }
  }

  ctx.restore();
  return renderedCount;
}
