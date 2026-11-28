import {
  getDsoTextureSprite,
  getLunarTextureCanvas,
  getPlanetDiskPhotoCanvas,
  getRealDsoSkySprite,
  selectDsoTextureKey,
  selectShowcasePhotoKey,
} from "@/lib/celestialTextures";
import { CONSTELLATION_ARTWORK } from "@/lib/constellationArt";
import { computeFovDimensions } from "@/lib/fovMath";
import { getMilkyWaySpriteAtlas, getOrBuildMilkyWayClouds } from "@/lib/milkyWayCloud";
import { drawHipsSurveyLayer } from "@/lib/hipsSurvey";
import { LUNAR_FEATURES, projectLunarFeature } from "@/lib/lunarFeatures";
import { renderPanoramaLandscape } from "@/lib/panoramaLandscape";
import {
  applyStandardRefractionDeg,
  buildJ2000ToEnuMatrix,
  bvToRgb,
  type CompiledProjectionContext,
  compileProjectionContext,
  effectiveFovDeg,
  equatorialToHorizontalFast,
  flattenMat3,
  projectAppEqVectorForStarChart,
  projectEnuVectorOnPanel,
  projectEqToScreen,
  projectHorToScreen,
  rgbCss,
  wrapDeg360,
} from "@/lib/projection";
import {
  computePanelCullCone,
  DSO_STRIDE,
  getOrBuildDsoSpatialGrid,
  getOrBuildStarSpatialGrid,
  STAR_STRIDE,
  type PanelCullCone,
  type SpatialSkyCell,
} from "@/lib/spatialSkyIndex";
import {
  type CustomColorPalette,
  DEFAULT_HIPS_CONFIG,
  DEFAULT_LANDSCAPE_CONFIG,
  type DsoEntry,
  type FovPreset,
  type HipsSurveyConfig,
  type LandscapeConfig,
  type LocationPreset,
  type MeteorShower,
  type NightWeatherForecast,
  type ObjectTrail,
  type PickedObject,
  type PlanetTrackOverlay,
  type PrintColorMode,
  type ProjectionParams,
  type SatellitePass,
  type SatelliteSkyPos,
  type SimulationLockMode,
  type SkyFrame,
  type SkyLayerVisibility,
  type SkyStaticAssets,
  type SolarSystemBodyRender,
} from "@/types/sky";

function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace("#", "");
  if (clean.length === 6) {
    const r = Number.parseInt(clean.slice(0, 2), 16);
    const g = Number.parseInt(clean.slice(2, 4), 16);
    const b = Number.parseInt(clean.slice(4, 6), 16);
    if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
      return `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(2)})`;
    }
  }
  return hex;
}

const DEG2RAD = Math.PI / 180;
const FAINT_BV_BUCKETS = 24;
const FAINT_ALPHA_BUCKETS = 16;
const FAINT_COLOR_LUT_NORMAL: string[] = [];
const FAINT_COLOR_LUT_NV: string[] = [];
for (let b = 0; b < FAINT_BV_BUCKETS; b++) {
  const bv = -0.4 + (b / (FAINT_BV_BUCKETS - 1)) * 2.4;
  const nRgb = bvToRgb(bv, false);
  const rRgb = bvToRgb(bv, true);
  for (let a = 0; a < FAINT_ALPHA_BUCKETS; a++) {
    const alpha = (0.18 + (a / (FAINT_ALPHA_BUCKETS - 1)) * 0.82).toFixed(2);
    FAINT_COLOR_LUT_NORMAL.push(`rgba(${nRgb.r}, ${nRgb.g}, ${nRgb.b}, ${alpha})`);
    FAINT_COLOR_LUT_NV.push(`rgba(${rRgb.r}, ${rRgb.g}, ${rRgb.b}, ${alpha})`);
  }
}

function getFaintStarCss(bv: number, alpha: number, nightVision: boolean): string {
  const bIdx = Math.max(
    0,
    Math.min(FAINT_BV_BUCKETS - 1, Math.round(((bv + 0.4) / 2.4) * (FAINT_BV_BUCKETS - 1))),
  );
  const aIdx = Math.max(
    0,
    Math.min(FAINT_ALPHA_BUCKETS - 1, Math.round(((alpha - 0.18) / 0.82) * (FAINT_ALPHA_BUCKETS - 1))),
  );
  const idx = bIdx * FAINT_ALPHA_BUCKETS + aIdx;
  return nightVision ? FAINT_COLOR_LUT_NV[idx] : FAINT_COLOR_LUT_NORMAL[idx];
}

function isSpatialCellVisible(
  cell: SpatialSkyCell,
  magLimit: number,
  canCullHorizon: boolean,
  m20: number,
  m21: number,
  m22: number,
  cullCone: PanelCullCone,
): boolean {
  if (cell.minMag > magLimit) return false;
  if (canCullHorizon) {
    const zDot = cell.cx * m20 + cell.cy * m21 + cell.cz * m22;
    if (Math.asin(Math.max(-1, Math.min(1, zDot))) + cell.radiusRad < -0.045) {
      return false;
    }
  }
  if (cullCone.useCone && cullCone.halfConeRad + cell.radiusRad < Math.PI - 0.01) {
    const dot = cell.cx * cullCone.fxJ + cell.cy * cullCone.fyJ + cell.cz * cullCone.fzJ;
    const minDot = cullCone.cosHalfCone * cell.cosRadius - cullCone.sinHalfCone * cell.sinRadius;
    if (dot < minDot) return false;
  }
  return true;
}

function projectJ2000UnitVec(
  vx: number,
  vy: number,
  vz: number,
  mEnu: Float64Array,
  mApp: Float64Array,
  pCtx: CompiledProjectionContext,
  panel: number,
  isChart: boolean,
  refractionEnabled: boolean,
  canCullHorizon: boolean,
  scratch: Float64Array,
  marginPx = 0,
): boolean {
  const uz = mEnu[6] * vx + mEnu[7] * vy + mEnu[8] * vz;
  if (canCullHorizon && uz < -0.025) return false;
  let ok = false;
  if (isChart) {
    const ax = mApp[0] * vx + mApp[1] * vy + mApp[2] * vz;
    const ay = mApp[3] * vx + mApp[4] * vy + mApp[5] * vz;
    const az = mApp[6] * vx + mApp[7] * vy + mApp[8] * vz;
    ok = projectAppEqVectorForStarChart(ax, ay, az, uz, pCtx, scratch);
  } else {
    let adjEx = mEnu[0] * vx + mEnu[1] * vy + mEnu[2] * vz;
    let adjNy = mEnu[3] * vx + mEnu[4] * vy + mEnu[5] * vz;
    let adjUz = uz;
    if (refractionEnabled && uz > -0.032 && uz < 0.14) {
      const trueAlt = Math.asin(uz) * (180 / Math.PI);
      const appAlt = applyStandardRefractionDeg(trueAlt);
      const sc = Math.cos(appAlt * DEG2RAD) / Math.max(1e-5, Math.cos(trueAlt * DEG2RAD));
      adjEx *= sc;
      adjNy *= sc;
      adjUz = Math.sin(appAlt * DEG2RAD);
    }
    ok = projectEnuVectorOnPanel(adjEx, adjNy, adjUz, pCtx, panel, scratch);
  }
  if (!ok) return false;
  if (marginPx <= 0) return scratch[2] >= 0.5;
  return (
    scratch[0] >= -marginPx &&
    scratch[0] <= pCtx.params.width + marginPx &&
    scratch[1] >= -marginPx &&
    scratch[1] <= pCtx.params.height + marginPx
  );
}

const STAR_SPRITE_BUCKETS: { bv: number; center: number }[] = [
  { bv: -0.25, center: 0 },
  { bv: 0.05, center: 1 },
  { bv: 0.35, center: 2 },
  { bv: 0.65, center: 3 },
  { bv: 0.95, center: 4 },
  { bv: 1.25, center: 5 },
  { bv: 1.65, center: 6 },
];

export interface StarSpriteAtlas {
  normal: HTMLCanvasElement;
  nightVision: HTMLCanvasElement;
  cellSize: number;
}

export function createStarSpriteAtlas(): StarSpriteAtlas {
  const cell = 64;
  const build = (night: boolean): HTMLCanvasElement => {
    const c = document.createElement("canvas");
    c.width = cell * STAR_SPRITE_BUCKETS.length;
    c.height = cell;
    const g = c.getContext("2d");
    if (!g) return c;

    for (let i = 0; i < STAR_SPRITE_BUCKETS.length; i++) {
      const col = bvToRgb(STAR_SPRITE_BUCKETS[i].bv, night);
      const cx = i * cell + cell * 0.5;
      const cy = cell * 0.5;
      const grad = g.createRadialGradient(cx, cy, 0.5, cx, cy, cell * 0.5);
      if (night) {
        grad.addColorStop(0, "rgba(255, 165, 165, 1)");
        grad.addColorStop(0.14, "rgba(248, 72, 72, 0.96)");
        grad.addColorStop(0.35, "rgba(220, 38, 38, 0.52)");
        grad.addColorStop(0.68, "rgba(153, 27, 27, 0.14)");
        grad.addColorStop(1, "rgba(120, 0, 0, 0)");
      } else {
        grad.addColorStop(0, "rgba(255, 255, 255, 1)");
        grad.addColorStop(0.14, "rgba(255, 255, 255, 0.96)");
        grad.addColorStop(0.32, `rgba(${col.r}, ${col.g}, ${col.b}, 0.72)`);
        grad.addColorStop(0.62, `rgba(${col.r}, ${col.g}, ${col.b}, 0.22)`);
        grad.addColorStop(1, `rgba(${col.r}, ${col.g}, ${col.b}, 0)`);
      }
      g.fillStyle = grad;
      g.beginPath();
      g.arc(cx, cy, cell * 0.5, 0, Math.PI * 2);
      g.fill();
    }
    return c;
  };
  return { normal: build(false), nightVision: build(true), cellSize: cell };
}

function bvToSpriteBucket(bv: number): number {
  if (!Number.isFinite(bv)) return 3;
  if (bv < -0.1) return 0;
  if (bv < 0.2) return 1;
  if (bv < 0.5) return 2;
  if (bv < 0.8) return 3;
  if (bv < 1.1) return 4;
  if (bv < 1.45) return 5;
  return 6;
}

interface LabelBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

const labelWidthCache = new Map<string, number>();

class LabelPlacer {
  private boxes: LabelBox[] = [];

  tryPlace(
    ctx: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    color: string,
    font = '11px "Noto Sans JP", system-ui, sans-serif',
    align: CanvasTextAlign = "left",
    baseline: CanvasTextBaseline = "middle",
    pad = 4,
  ): boolean {
    if (!text) return false;
    const cacheKey = `${font}\0${text}`;
    let w = labelWidthCache.get(cacheKey);
    let fontApplied = false;
    if (w === undefined) {
      ctx.font = font;
      fontApplied = true;
      w = ctx.measureText(text).width;
      if (labelWidthCache.size >= 4096) {
        labelWidthCache.clear();
      }
      labelWidthCache.set(cacheKey, w);
    }
    const h = 13;
    const x1 = (align === "center" ? x - w * 0.5 : align === "right" ? x - w : x) - pad;
    const y1 =
      (baseline === "middle" ? y - h * 0.5 : baseline === "bottom" ? y - h : y) - pad;
    const x2 = x1 + w + pad * 2;
    const y2 = y1 + h + pad * 2;

    for (let i = 0; i < this.boxes.length; i++) {
      const b = this.boxes[i];
      if (x1 < b.x2 && x2 > b.x1 && y1 < b.y2 && y2 > b.y1) {
        return false;
      }
    }
    this.boxes.push({ x1, y1, x2, y2 });
    if (!fontApplied) {
      ctx.font = font;
    }
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = baseline;
    ctx.fillText(text, x, y);
    return true;
  }
}

export interface MeteorParticle {
  rx: number;
  ry: number;
  rz: number;
  dx: number;
  dy: number;
  dz: number;
  thetaStartRad: number;
  arcRad: number;
  trailRad: number;
  age: number;
  duration: number;
  trainDuration: number;
  brightness: number;
  isFireball: boolean;
  color: string;
}

const DOY_MONTH_OFFSETS = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];

function monthDayToDoy(month: number, day: number): number {
  const m = Math.max(1, Math.min(12, Math.round(month)));
  return (DOY_MONTH_OFFSETS[m - 1] ?? 0) + Math.max(1, Math.min(31, day));
}

function mmddToDoy(mmdd: string): number {
  const parts = mmdd.split("-");
  if (parts.length !== 2) return 180;
  return monthDayToDoy(Number(parts[0]) || 6, Number(parts[1]) || 15);
}

function circularDoyDiff(a: number, b: number): number {
  const d = Math.abs(a - b);
  return Math.min(d, 365 - d);
}

function spawnMeteorFromRaDec(
  raDeg: number,
  decDeg: number,
  velKmS: number,
  fireballChance = 0.08,
): MeteorParticle {
  const raR = raDeg * DEG2RAD;
  const decR = decDeg * DEG2RAD;
  const rx = Math.cos(decR) * Math.cos(raR);
  const ry = Math.cos(decR) * Math.sin(raR);
  const rz = Math.sin(decR);

  // Tangent basis around radiant vector R
  const ax = Math.abs(rz) < 0.9 ? 0 : 1;
  const ay = 0;
  const az = Math.abs(rz) < 0.9 ? 1 : 0;
  let ux = ay * rz - az * ry;
  let uy = az * rx - ax * rz;
  let uz = ax * ry - ay * rx;
  const uLen = Math.hypot(ux, uy, uz) || 1;
  ux /= uLen;
  uy /= uLen;
  uz /= uLen;

  const vx = ry * uz - rz * uy;
  const vy = rz * ux - rx * uz;
  const vz = rx * uy - ry * ux;

  const phi = Math.random() * Math.PI * 2;
  const cosP = Math.cos(phi);
  const sinP = Math.sin(phi);
  const dx = ux * cosP + vx * sinP;
  const dy = uy * cosP + vy * sinP;
  const dz = uz * cosP + vz * sinP;

  const isFireball = Math.random() < fireballChance;
  const thetaStartDeg = 6 + Math.random() * 48;
  const sinFactor = Math.max(0.24, Math.sin(thetaStartDeg * DEG2RAD));
  const arcDeg = (5 + Math.random() * 14 + (isFireball ? 9 : 0)) * (0.5 + sinFactor);
  const speedScale = Math.max(0.45, velKmS / 52);
  const duration = (0.34 + Math.random() * 0.52) / speedScale + (isFireball ? 0.34 : 0);
  const trainDuration = isFireball ? 1.35 : Math.random() < 0.25 ? 0.42 : 0;

  const color = isFireball
    ? "#fde68a"
    : velKmS >= 55
      ? "#bae6fd"
      : velKmS >= 35
        ? "#e0f2fe"
        : "#fef3c7";

  return {
    rx,
    ry,
    rz,
    dx,
    dy,
    dz,
    thetaStartRad: thetaStartDeg * DEG2RAD,
    arcRad: arcDeg * DEG2RAD,
    trailRad: (arcDeg * (0.45 + Math.random() * 0.28)) * DEG2RAD,
    age: 0,
    duration,
    trainDuration,
    brightness: isFireball ? 1.0 : 0.48 + Math.random() * 0.48,
    isFireball,
    color,
  };
}

function greatCirclePointRaDec(p: MeteorParticle, thetaRad: number): [number, number] {
  const c = Math.cos(thetaRad);
  const s = Math.sin(thetaRad);
  const px = c * p.rx + s * p.dx;
  const py = c * p.ry + s * p.dy;
  const pz = c * p.rz + s * p.dz;
  const raDeg = wrapDeg360((Math.atan2(py, px) * 180) / Math.PI);
  const decDeg = (Math.asin(Math.max(-1, Math.min(1, pz))) * 180) / Math.PI;
  return [raDeg, decDeg];
}

export interface StepMeteorOptions {
  month?: number;
  day?: number;
  latDeg?: number;
  lastDeg?: number;
  starVisibilityFactor?: number;
  preferSelected?: boolean;
}

export function stepMeteorParticles(
  current: MeteorParticle[],
  showers: MeteorShower[],
  selectedCode: string | null,
  active: boolean,
  dtSec: number,
  rateMultiplier: number,
  opts?: StepMeteorOptions,
): MeteorParticle[] {
  const next: MeteorParticle[] = [];
  for (const p of current) {
    const age = p.age + dtSec;
    if (age < p.duration + p.trainDuration) {
      next.push({ ...p, age });
    }
  }
  const starVis = opts?.starVisibilityFactor ?? 1;
  if (!active || starVis < 0.25) {
    return next;
  }

  const month = opts?.month ?? 8;
  const day = opts?.day ?? 13;
  const curDoy = monthDayToDoy(month, day);
  const hasHor = opts?.latDeg != null && opts?.lastDeg != null;

  const candidates: { shower: MeteorShower | null; weight: number }[] = [];
  let totalWeight = 0;

  for (const sh of showers) {
    let horizonWeight = 0.65;
    if (hasHor) {
      const hor = equatorialToHorizontalFast(
        sh.ra_deg,
        sh.dec_deg,
        opts!.latDeg!,
        opts!.lastDeg!,
      );
      const altSin = Math.sin(hor.altDeg * DEG2RAD);
      if (altSin <= -0.05) continue;
      horizonWeight = Math.max(0.18, altSin);
    }

    const diffDays = circularDoyDiff(mmddToDoy(sh.peak_date), curDoy);
    let w = 0;
    if (opts?.preferSelected && selectedCode && sh.code === selectedCode) {
      w = Math.max(24, sh.zhr * 1.15) * horizonWeight;
    } else if (diffDays <= 14) {
      w = Math.max(2, sh.zhr) * Math.exp(-0.5 * Math.pow(diffDays / 3.8, 2)) * horizonWeight;
    }
    if (w > 0.25) {
      candidates.push({ shower: sh, weight: w });
      totalWeight += w;
    }
  }

  // Always allow sporadic meteors on clear dark skies from any upper-hemisphere direction
  const sporadicWeight = 8.5;
  candidates.push({ shower: null, weight: sporadicWeight });
  totalWeight += sporadicWeight;

  const spawnRatePerSec = Math.max(
    0.32,
    Math.min(7.5, (totalWeight / 24) * Math.max(0.4, rateMultiplier)),
  );
  let expected = spawnRatePerSec * dtSec;
  const maxParticles = 24;

  while (expected > 0 && next.length < maxParticles) {
    if (expected >= 1 || Math.random() < expected) {
      let pick = Math.random() * totalWeight;
      let chosen: MeteorShower | null = null;
      for (const c of candidates) {
        pick -= c.weight;
        if (pick <= 0) {
          chosen = c.shower;
          break;
        }
      }
      if (chosen) {
        next.push(
          spawnMeteorFromRaDec(
            chosen.ra_deg + (Math.random() - 0.5) * 3.0,
            Math.max(-88, Math.min(88, chosen.dec_deg + (Math.random() - 0.5) * 3.0)),
            chosen.velocity_km_s,
            0.09,
          ),
        );
      } else {
        const ra = Math.random() * 360;
        const latCenter = opts?.latDeg ?? 35;
        const dec = Math.max(-80, Math.min(85, latCenter + (Math.random() - 0.5) * 90));
        next.push(spawnMeteorFromRaDec(ra, dec, 26 + Math.random() * 36, 0.06));
      }
    }
    expected -= 1;
  }

  return next;
}

export interface SkyRenderArgs {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  params: ProjectionParams;
  frame: SkyFrame;
  location: LocationPreset;
  staticAssets: SkyStaticAssets | null;
  starBuffer: Float32Array | null;
  starCount: number;
  dsoBuffer?: Float32Array | null;
  dsoCount?: number;
  limitingMag: number;
  refractionEnabled: boolean;
  layers: SkyLayerVisibility;
  customColors: CustomColorPalette;
  trails: Record<string, ObjectTrail>;
  simLockMode: SimulationLockMode;
  simStepMinutes: number;
  nightVision: boolean;
  selectedObject: PickedObject | null;
  atlas: StarSpriteAtlas;
  selectedMeteorShowerCode?: string | null;
  meteorShowAllRadiants?: boolean;
  meteorParticles?: MeteorParticle[];
  planetTracks?: Record<string, PlanetTrackOverlay>;
  fovPresets?: FovPreset[];
  satellites?: SatelliteSkyPos[];
  showSatellites?: boolean;
  highlightedSatPass?: SatellitePass | null;
  landscapeConfig?: LandscapeConfig;
  hipsConfig?: HipsSurveyConfig;
  offlineMode?: boolean;
  liveWeather?: NightWeatherForecast | null;
  showWeatherCloudsOverlay?: boolean;
  printColorMode?: PrintColorMode;
  skipMeteors?: boolean;
  fastInteractive?: boolean;
  renderPhase?: "all" | "background" | "foreground";
  includeDsoMarkersInForeground?: boolean;
  onTextureLoaded?: () => void;
}

const dsoTextureBucketCache = new WeakMap<
  DsoEntry[],
  { showcase: DsoEntry[]; zoomCandidates: DsoEntry[]; messierOnly: DsoEntry[] }
>();

function getDsoTextureBuckets(dsos: DsoEntry[]): {
  showcase: DsoEntry[];
  zoomCandidates: DsoEntry[];
  messierOnly: DsoEntry[];
} {
  const cached = dsoTextureBucketCache.get(dsos);
  if (cached) return cached;
  const showcase: DsoEntry[] = [];
  const zoomCandidates: DsoEntry[] = [];
  const messierOnly: DsoEntry[] = [];
  for (const dso of dsos) {
    if (dso.messier != null) {
      messierOnly.push(dso);
    }
    if (selectShowcasePhotoKey(dso) !== null) {
      showcase.push(dso);
      zoomCandidates.push(dso);
    } else if (dso.messier != null || (dso.mag ?? 99) <= 11.5) {
      zoomCandidates.push(dso);
    }
  }
  const result = { showcase, zoomCandidates, messierOnly };
  dsoTextureBucketCache.set(dsos, result);
  return result;
}

function drawMeteorParticlesOnPanel(
  c: CanvasRenderingContext2D,
  width: number,
  height: number,
  skyPCtx: CompiledProjectionContext,
  panel: number,
  mJ2000ToEnu: Float64Array,
  mJ2000ToApp: Float64Array,
  refractionEnabled: boolean,
  nightVision: boolean,
  meteorParticles: MeteorParticle[],
  scratch: Float64Array,
  enforceAboveHorizon: boolean,
): void {
  if (meteorParticles.length === 0) return;
  const jumpLim = Math.min(width, height) * 0.42;
  const m20 = mJ2000ToEnu[6];
  const m21 = mJ2000ToEnu[7];
  const m22 = mJ2000ToEnu[8];

  const isAboveHorizonEnu = (raDeg: number, decDeg: number): boolean => {
    if (!enforceAboveHorizon) return true;
    const raRad = raDeg * DEG2RAD;
    const decRad = decDeg * DEG2RAD;
    const cd = Math.cos(decRad);
    const uz = cd * Math.cos(raRad) * m20 + cd * Math.sin(raRad) * m21 + Math.sin(decRad) * m22;
    return uz >= 0.004;
  };

  for (const mp of meteorParticles) {
    const strokeHex = nightVision ? "#f87171" : mp.color;
    if (mp.age <= mp.duration) {
      const s = Math.min(1, mp.age / mp.duration);
      const fade = Math.sin(s * Math.PI);
      if (fade <= 0.02) continue;
      const thHead = mp.thetaStartRad + s * mp.arcRad;
      const thTail = Math.max(mp.thetaStartRad, thHead - mp.trailRad * (0.4 + 0.6 * fade));
      const [raHead, decHead] = greatCirclePointRaDec(mp, thHead);
      const [raTail, decTail] = greatCirclePointRaDec(mp, thTail);
      if (enforceAboveHorizon && !isAboveHorizonEnu(raHead, decHead) && !isAboveHorizonEnu(raTail, decTail)) {
        continue;
      }
      if (
        !projectJ2000RaDec(raTail, decTail, mJ2000ToEnu, mJ2000ToApp, skyPCtx, panel, refractionEnabled, scratch) ||
        scratch[2] < 0.5
      ) {
        continue;
      }
      const tx = scratch[0];
      const ty = scratch[1];
      if (
        !projectJ2000RaDec(raHead, decHead, mJ2000ToEnu, mJ2000ToApp, skyPCtx, panel, refractionEnabled, scratch) ||
        scratch[2] < 0.5
      ) {
        continue;
      }
      const hx = scratch[0];
      const hy = scratch[1];
      if (Math.hypot(hx - tx, hy - ty) > jumpLim) continue;

      const headRgba = hexToRgba(strokeHex, Math.min(1, fade * mp.brightness * 1.12));
      const grad = c.createLinearGradient(tx, ty, hx, hy);
      grad.addColorStop(0, "rgba(0, 0, 0, 0)");
      grad.addColorStop(0.55, hexToRgba(strokeHex, fade * mp.brightness * 0.48));
      grad.addColorStop(1, headRgba);

      c.save();
      c.strokeStyle = grad;
      c.lineWidth = mp.isFireball ? 2.8 : 1.5;
      c.lineCap = "round";
      c.beginPath();
      c.moveTo(tx, ty);
      c.lineTo(hx, hy);
      c.stroke();

      c.fillStyle = nightVision ? "rgba(252, 165, 165, 0.96)" : "#ffffff";
      c.beginPath();
      c.arc(hx, hy, mp.isFireball ? 2.5 : 1.35, 0, Math.PI * 2);
      c.fill();

      if (mp.isFireball && s > 0.72 && s < 0.92) {
        const burstAlpha = (1 - Math.abs(s - 0.82) / 0.1) * 0.72;
        const flare = c.createRadialGradient(hx, hy, 0.5, hx, hy, 11);
        flare.addColorStop(0, nightVision ? `rgba(254,202,202,${burstAlpha})` : `rgba(255,252,232,${burstAlpha})`);
        flare.addColorStop(1, "rgba(0,0,0,0)");
        c.fillStyle = flare;
        c.beginPath();
        c.arc(hx, hy, 11, 0, Math.PI * 2);
        c.fill();
      }
      c.restore();
    } else if (mp.trainDuration > 0) {
      const tFrac = Math.min(1, (mp.age - mp.duration) / mp.trainDuration);
      const tFade = Math.pow(Math.max(0, 1 - tFrac), 1.6);
      if (tFade <= 0.02) continue;
      const thEnd = mp.thetaStartRad + mp.arcRad;
      const thStart = Math.max(mp.thetaStartRad, thEnd - mp.trailRad * 0.88);
      const [ra0, dec0] = greatCirclePointRaDec(mp, thStart);
      const [ra1, dec1] = greatCirclePointRaDec(mp, thEnd);
      if (enforceAboveHorizon && !isAboveHorizonEnu(ra0, dec0) && !isAboveHorizonEnu(ra1, dec1)) {
        continue;
      }
      if (!projectJ2000RaDec(ra0, dec0, mJ2000ToEnu, mJ2000ToApp, skyPCtx, panel, refractionEnabled, scratch) || scratch[2] < 0.5) continue;
      const tx = scratch[0];
      const ty = scratch[1];
      if (!projectJ2000RaDec(ra1, dec1, mJ2000ToEnu, mJ2000ToApp, skyPCtx, panel, refractionEnabled, scratch) || scratch[2] < 0.5) continue;
      const hx = scratch[0];
      const hy = scratch[1];
      if (Math.hypot(hx - tx, hy - ty) > jumpLim) continue;
      c.save();
      c.strokeStyle = hexToRgba(strokeHex, tFade * (mp.isFireball ? 0.34 : 0.18));
      c.lineWidth = (mp.isFireball ? 4.4 : 2.5) * (1 + tFrac * 0.6);
      c.lineCap = "round";
      c.beginPath();
      c.moveTo(tx, ty);
      c.lineTo(hx, hy);
      c.stroke();
      c.restore();
    }
  }
}

export interface MeteorOverlayArgs {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  params: ProjectionParams;
  frame: SkyFrame;
  location: LocationPreset;
  refractionEnabled: boolean;
  nightVision: boolean;
  meteorParticles: MeteorParticle[];
}

export function renderMeteorOverlay({
  ctx: c,
  width,
  height,
  params,
  frame,
  location,
  refractionEnabled,
  nightVision,
  meteorParticles,
}: MeteorOverlayArgs): void {
  if (meteorParticles.length === 0 || frame.view_mode === "other_star") return;
  const pCtx = compileProjectionContext(params);
  const showOppositeGroundSky = !(
    params.mode === "all_sky" ||
    params.mode === "hemisphere_single" ||
    params.mode === "hemisphere_dual"
  );
  const skyPCtx =
    params.show_below_horizon || !showOppositeGroundSky
      ? pCtx
      : compileProjectionContext({ ...params, show_below_horizon: true });
  const mJ2000ToApp = flattenMat3(frame.j2000_to_apparent_matrix);
  const mJ2000ToEnu = frame.j2000_to_enu_override
    ? flattenMat3(frame.j2000_to_enu_override)
    : buildJ2000ToEnuMatrix(
        frame.j2000_to_apparent_matrix,
        frame.last_deg,
        location.lat_deg,
      );
  const scratch = new Float64Array(3);
  const panels = getPanelList(params.mode);
  const enforceAboveHorizon = !params.show_below_horizon && params.mode !== "star_chart";

  for (const panel of panels) {
    c.save();
    clipToPanel(c, pCtx, panel);
    drawMeteorParticlesOnPanel(
      c,
      width,
      height,
      skyPCtx,
      panel,
      mJ2000ToEnu,
      mJ2000ToApp,
      refractionEnabled,
      nightVision,
      meteorParticles,
      scratch,
      enforceAboveHorizon,
    );
    c.restore();
  }
}

function getPanelList(mode: ProjectionParams["mode"]): number[] {
  return mode === "hemisphere_dual" ? [0, 1] : [0];
}

function clipToPanel(
  c: CanvasRenderingContext2D,
  pCtx: CompiledProjectionContext,
  panel: number,
): void {
  const { params } = pCtx;
  c.beginPath();
  if (params.mode === "all_sky") {
    c.arc(pCtx.cx, pCtx.cy, pCtx.allSkyRadius, 0, Math.PI * 2);
  } else if (params.mode === "hemisphere_single") {
    if (params.show_below_horizon) {
      c.arc(pCtx.hemCx0, pCtx.hemCy0, pCtx.hemRadius0, 0, Math.PI * 2);
    } else {
      c.arc(pCtx.hemCx0, pCtx.hemCy0, pCtx.hemRadius0, Math.PI, 0, false);
      c.closePath();
    }
  } else if (params.mode === "hemisphere_dual") {
    const hcx = panel === 0 ? pCtx.hemCx0 : pCtx.hemCx1;
    const hcy = panel === 0 ? pCtx.hemCy0 : pCtx.hemCy1;
    const hr = panel === 0 ? pCtx.hemRadius0 : pCtx.hemRadius1;
    if (params.show_below_horizon) {
      c.arc(hcx, hcy, hr, 0, Math.PI * 2);
    } else {
      c.arc(hcx, hcy, hr, Math.PI, 0, false);
      c.closePath();
    }
  } else if (params.mode === "panorama") {
    const halfW = 180 * pCtx.panoScaleX;
    c.rect(pCtx.cx - halfW, 0, halfW * 2, params.height);
  } else {
    c.rect(0, 0, params.width, params.height);
  }
  c.clip();
}

function drawRealisticSkyBackground(
  c: CanvasRenderingContext2D,
  pCtx: CompiledProjectionContext,
  frame: SkyFrame,
  panel: number,
): void {
  const { sky_palette: pal, bodies } = frame;
  const { params } = pCtx;
  const w = params.width;
  const h = params.height;

  if (params.mode === "all_sky") {
    const r = pCtx.allSkyRadius;
    const grad = c.createRadialGradient(pCtx.cx, pCtx.cy, 0, pCtx.cx, pCtx.cy, r);
    grad.addColorStop(0, rgbCss(pal.zenith));
    grad.addColorStop(0.58, rgbCss(pal.mid_sky));
    grad.addColorStop(1, rgbCss(pal.horizon));
    c.fillStyle = grad;
    c.fillRect(0, 0, w, h);
  } else if (params.mode === "hemisphere_single" || params.mode === "hemisphere_dual") {
    const hcx = panel === 0 ? pCtx.hemCx0 : pCtx.hemCx1;
    const hcy = panel === 0 ? pCtx.hemCy0 : pCtx.hemCy1;
    const hr = panel === 0 ? pCtx.hemRadius0 : pCtx.hemRadius1;
    const grad = c.createLinearGradient(hcx, hcy - hr, hcx, hcy);
    grad.addColorStop(0, rgbCss(pal.zenith));
    grad.addColorStop(0.55, rgbCss(pal.mid_sky));
    grad.addColorStop(1, rgbCss(pal.horizon));
    c.fillStyle = grad;
    c.fillRect(hcx - hr - 2, hcy - hr - 2, hr * 2 + 4, hr * 2 + 4);
  } else {
    const zPt = projectHorToScreen(params.center_az_deg, 89.5, pCtx);
    const hPt = projectHorToScreen(params.center_az_deg, 0, pCtx);
    const yTop = zPt ? Math.min(h * 0.25, zPt.y) : 0;
    const yBot = hPt ? Math.max(yTop + h * 0.45, Math.min(h, hPt.y)) : h;
    const grad = c.createLinearGradient(0, yTop, 0, yBot);
    grad.addColorStop(0, rgbCss(pal.zenith));
    grad.addColorStop(0.52, rgbCss(pal.mid_sky));
    grad.addColorStop(1, rgbCss(pal.horizon));
    c.fillStyle = grad;
    c.fillRect(0, 0, w, h);
  }

  // Light pollution horizon dome halo (urban night sky)
  if (pal.light_pollution_strength > 0.04) {
    if (params.mode === "all_sky") {
      const r = pCtx.allSkyRadius;
      const g = c.createRadialGradient(pCtx.cx, pCtx.cy, r * 0.42, pCtx.cx, pCtx.cy, r);
      g.addColorStop(0, "rgba(0,0,0,0)");
      g.addColorStop(1, rgbCss(pal.light_pollution, 0.36 * pal.light_pollution_strength));
      c.fillStyle = g;
      c.beginPath();
      c.arc(pCtx.cx, pCtx.cy, r, 0, Math.PI * 2);
      c.fill();
    } else {
      const hPt = projectHorToScreen(params.center_az_deg, 0, pCtx, panel);
      const yHor = hPt ? hPt.y : h;
      const g = c.createLinearGradient(0, yHor - h * 0.52, 0, yHor + 20);
      g.addColorStop(0, "rgba(0,0,0,0)");
      g.addColorStop(1, rgbCss(pal.light_pollution, 0.34 * pal.light_pollution_strength));
      c.fillStyle = g;
      c.fillRect(0, 0, w, h);
    }
  }

  // Directional solar sunrise / sunset glow
  const sun = bodies[0];
  if (sun && pal.sun_glow_strength > 0.02) {
    const sunGlPt = projectHorToScreen(sun.az_deg, Math.max(-4, sun.alt_deg), pCtx, panel);
    if (sunGlPt) {
      const glowR = Math.max(w, h) * 0.48;
      const g = c.createRadialGradient(sunGlPt.x, sunGlPt.y, 4, sunGlPt.x, sunGlPt.y, glowR);
      g.addColorStop(0, rgbCss(pal.sun_glow, 0.65 * pal.sun_glow_strength));
      g.addColorStop(0.42, rgbCss(pal.sun_glow, 0.25 * pal.sun_glow_strength));
      g.addColorStop(1, "rgba(0,0,0,0)");
      c.fillStyle = g;
      c.fillRect(0, 0, w, h);
    }
    if (pal.anti_solar_strength > 0.02) {
      const antiPt = projectHorToScreen(wrapDeg360(sun.az_deg + 180), 4, pCtx, panel);
      if (antiPt) {
        const antiR = Math.max(w, h) * 0.38;
        const g = c.createRadialGradient(antiPt.x, antiPt.y, 4, antiPt.x, antiPt.y, antiR);
        g.addColorStop(0, rgbCss(pal.anti_solar_glow, 0.42 * pal.anti_solar_strength));
        g.addColorStop(1, "rgba(0,0,0,0)");
        c.fillStyle = g;
        c.fillRect(0, 0, w, h);
      }
    }
  }

  // Moonlight atmospheric glow around bright Moon
  const moon = bodies[1];
  if (moon && moon.alt_deg > -2 && pal.moonlight_strength > 0.03) {
    const mPt = projectHorToScreen(moon.az_deg, moon.alt_deg, pCtx, panel);
    if (mPt) {
      const mR = Math.min(w, h) * 0.35;
      const g = c.createRadialGradient(mPt.x, mPt.y, 6, mPt.x, mPt.y, mR);
      g.addColorStop(0, rgbCss(pal.moonlight_glow, 0.38 * pal.moonlight_strength));
      g.addColorStop(0.5, rgbCss(pal.moonlight_glow, 0.12 * pal.moonlight_strength));
      g.addColorStop(1, "rgba(0,0,0,0)");
      c.fillStyle = g;
      c.fillRect(0, 0, w, h);
    }
  }
}

function projectJ2000RaDec(
  raDeg: number,
  decDeg: number,
  mJ2000ToEnu: Float64Array,
  mJ2000ToApp: Float64Array,
  pCtx: CompiledProjectionContext,
  panel: number,
  refraction: boolean,
  scratch: Float64Array,
): boolean {
  const ra = raDeg * DEG2RAD;
  const dec = decDeg * DEG2RAD;
  const cd = Math.cos(dec);
  const vx = cd * Math.cos(ra);
  const vy = cd * Math.sin(ra);
  const vz = Math.sin(dec);

  const ex = mJ2000ToEnu[0] * vx + mJ2000ToEnu[1] * vy + mJ2000ToEnu[2] * vz;
  const ny = mJ2000ToEnu[3] * vx + mJ2000ToEnu[4] * vy + mJ2000ToEnu[5] * vz;
  let uz = mJ2000ToEnu[6] * vx + mJ2000ToEnu[7] * vy + mJ2000ToEnu[8] * vz;

  let adjEx = ex;
  let adjNy = ny;
  if (refraction && uz > -0.035 && uz < 0.9999) {
    const trueAlt = Math.asin(Math.max(-1, Math.min(1, uz))) * (180 / Math.PI);
    const appAlt = applyStandardRefractionDeg(trueAlt);
    const scale = Math.cos(appAlt * DEG2RAD) / Math.max(1e-5, Math.cos(trueAlt * DEG2RAD));
    adjEx *= scale;
    adjNy *= scale;
    uz = Math.sin(appAlt * DEG2RAD);
  }

  if (pCtx.params.mode === "star_chart") {
    const ax = mJ2000ToApp[0] * vx + mJ2000ToApp[1] * vy + mJ2000ToApp[2] * vz;
    const ay = mJ2000ToApp[3] * vx + mJ2000ToApp[4] * vy + mJ2000ToApp[5] * vz;
    const az = mJ2000ToApp[6] * vx + mJ2000ToApp[7] * vy + mJ2000ToApp[8] * vz;
    return projectAppEqVectorForStarChart(ax, ay, az, uz, pCtx, scratch);
  }

  return projectEnuVectorOnPanel(adjEx, adjNy, uz, pCtx, panel, scratch);
}

const polylineVecCache = new WeakMap<[number, number][], Float32Array>();

function getPolylineUnitVecs(pts: [number, number][]): Float32Array {
  let buf = polylineVecCache.get(pts);
  if (buf) return buf;
  buf = new Float32Array(pts.length * 3);
  for (let i = 0; i < pts.length; i++) {
    const ra = pts[i][0] * DEG2RAD;
    const dec = pts[i][1] * DEG2RAD;
    const cd = Math.cos(dec);
    const off = i * 3;
    buf[off] = cd * Math.cos(ra);
    buf[off + 1] = cd * Math.sin(ra);
    buf[off + 2] = Math.sin(dec);
  }
  polylineVecCache.set(pts, buf);
  return buf;
}

function drawJ2000Polyline(
  c: CanvasRenderingContext2D,
  pts: [number, number][],
  closePath: boolean,
  mEnu: Float64Array,
  mApp: Float64Array,
  pCtx: CompiledProjectionContext,
  panel: number,
  refraction: boolean,
  scratch: Float64Array,
): boolean {
  if (pts.length === 0) return false;
  const vecs = getPolylineUnitVecs(pts);
  const jumpThreshold = Math.min(pCtx.params.width, pCtx.params.height) * 0.42;
  const isChart = pCtx.params.mode === "star_chart";
  let penDown = false;
  let prevX = 0;
  let prevY = 0;
  let anyVisible = false;

  const total = closePath ? pts.length + 1 : pts.length;
  for (let i = 0; i < total; i++) {
    const off = (i % pts.length) * 3;
    const vx = vecs[off];
    const vy = vecs[off + 1];
    const vz = vecs[off + 2];

    let ok = false;
    const uz0 = mEnu[6] * vx + mEnu[7] * vy + mEnu[8] * vz;
    if (isChart) {
      const ax = mApp[0] * vx + mApp[1] * vy + mApp[2] * vz;
      const ay = mApp[3] * vx + mApp[4] * vy + mApp[5] * vz;
      const az = mApp[6] * vx + mApp[7] * vy + mApp[8] * vz;
      ok = projectAppEqVectorForStarChart(ax, ay, az, uz0, pCtx, scratch);
    } else {
      let adjEx = mEnu[0] * vx + mEnu[1] * vy + mEnu[2] * vz;
      let adjNy = mEnu[3] * vx + mEnu[4] * vy + mEnu[5] * vz;
      let adjUz = uz0;
      if (refraction && uz0 > -0.035 && uz0 < 0.9999) {
        const trueAlt = Math.asin(Math.max(-1, Math.min(1, uz0))) * (180 / Math.PI);
        const appAlt = applyStandardRefractionDeg(trueAlt);
        const sc = Math.cos(appAlt * DEG2RAD) / Math.max(1e-5, Math.cos(trueAlt * DEG2RAD));
        adjEx *= sc;
        adjNy *= sc;
        adjUz = Math.sin(appAlt * DEG2RAD);
      }
      ok = projectEnuVectorOnPanel(adjEx, adjNy, adjUz, pCtx, panel, scratch);
    }

    if (!ok) {
      penDown = false;
      continue;
    }
    const x = scratch[0];
    const y = scratch[1];
    if (scratch[2] > 0.5) anyVisible = true;
    if (!penDown || Math.hypot(x - prevX, y - prevY) > jumpThreshold) {
      c.moveTo(x, y);
      penDown = true;
    } else {
      c.lineTo(x, y);
    }
    prevX = x;
    prevY = y;
  }
  return anyVisible;
}

function drawHorizonCurve(
  c: CanvasRenderingContext2D,
  pCtx: CompiledProjectionContext,
  panel: number,
  pal: SkyFrame["sky_palette"],
  showBelowHorizon: boolean,
  labels: LabelPlacer,
  showCardinals: boolean,
  nightVision: boolean,
  isInverted: boolean,
  skipGroundMask = false,
): void {
  const { params } = pCtx;
  if (params.mode === "all_sky" || params.mode === "hemisphere_single" || params.mode === "hemisphere_dual") {
    return;
  }

  const groundAlpha = isInverted ? 0.84 : nightVision ? 0.72 : 0.62;
  const isStereoHorizontal =
    params.mode === "free_direction" ||
    params.mode === "horizon_zoom" ||
    params.mode === "mid_sky" ||
    params.mode === "zenith";

  if (isStereoHorizontal) {
    const alt0 =
      params.mode === "zenith" ? 90 : Math.min(89.9, Math.max(-89.9, params.center_alt_deg));
    if (Math.abs(alt0) <= 0.25) {
      const yHor = pCtx.cy + pCtx.stereoScalePx * Math.tan(alt0 * 0.5 * DEG2RAD);
      if (!showBelowHorizon && !skipGroundMask && yHor < params.height) {
        c.fillStyle = rgbCss(pal.ground, groundAlpha);
        c.fillRect(0, Math.max(0, yHor), params.width, params.height - Math.max(0, yHor));
      }
      if (showCardinals && yHor >= -2 && yHor <= params.height + 2) {
        c.strokeStyle = rgbCss(pal.horizon_line, 0.88);
        c.lineWidth = 1.3;
        c.beginPath();
        c.moveTo(0, yHor);
        c.lineTo(params.width, yHor);
        c.stroke();
      }
    } else {
      const altRad = alt0 * DEG2RAD;
      const yc = pCtx.cy - pCtx.stereoScalePx / Math.tan(altRad);
      const r = pCtx.stereoScalePx / Math.abs(Math.sin(altRad));
      if (!showBelowHorizon && !skipGroundMask) {
        c.save();
        c.fillStyle = rgbCss(pal.ground, groundAlpha);
        c.beginPath();
        if (alt0 > 0) {
          c.rect(0, 0, params.width, params.height);
          c.arc(pCtx.cx, yc, r, 0, Math.PI * 2);
          c.fill("evenodd");
        } else {
          c.arc(pCtx.cx, yc, r, 0, Math.PI * 2);
          c.fill();
        }
        c.restore();
      }
      if (showCardinals) {
        c.save();
        c.strokeStyle = rgbCss(pal.horizon_line, 0.88);
        c.lineWidth = 1.3;
        c.beginPath();
        c.arc(pCtx.cx, yc, r, 0, Math.PI * 2);
        c.stroke();
        c.restore();
      }
    }
  } else {
    const jumpLimit = params.width * 0.45;
    const pts: { x: number; y: number; ok: boolean }[] = [];
    const startAz = params.center_az_deg - 180;
    for (let k = 0; k <= 120; k++) {
      const az = wrapDeg360(startAz + k * 3);
      const p = projectHorToScreen(az, 0, pCtx, panel);
      pts.push(p ? { x: p.x, y: p.y, ok: true } : { x: 0, y: 0, ok: false });
    }

    if (!showBelowHorizon && !skipGroundMask && params.mode === "panorama") {
      const p0 = projectHorToScreen(params.center_az_deg, 0, pCtx, panel);
      if (p0 && p0.y < params.height) {
        c.fillStyle = rgbCss(pal.ground, groundAlpha);
        c.fillRect(0, p0.y, params.width, params.height - p0.y);
      }
    }

    if (!showCardinals) {
      return;
    }

    c.strokeStyle = rgbCss(pal.horizon_line, 0.88);
    c.lineWidth = 1.3;
    c.beginPath();
    let pen = false;
    let px = 0;
    let py = 0;
    for (const pt of pts) {
      if (!pt.ok) {
        pen = false;
        continue;
      }
      if (!pen || Math.hypot(pt.x - px, pt.y - py) > jumpLimit) {
        c.moveTo(pt.x, pt.y);
        pen = true;
      } else {
        c.lineTo(pt.x, pt.y);
      }
      px = pt.x;
      py = pt.y;
    }
    c.stroke();
  }

  if (!showCardinals) {
    return;
  }

  const dirs: [number, string][] = [
    [0, "北 N"],
    [45, "北東 NE"],
    [90, "東 E"],
    [135, "南東 SE"],
    [180, "南 S"],
    [225, "南西 SW"],
    [270, "西 W"],
    [315, "北西 NW"],
  ];
  const col = nightVision ? "rgba(239, 68, 68, 0.95)" : "rgba(251, 191, 36, 0.95)";
  for (const [az, text] of dirs) {
    const pt = projectHorToScreen(az, 0.5, pCtx, panel);
    if (pt && pt.x >= 16 && pt.x <= params.width - 16 && pt.y >= 16 && pt.y <= params.height - 10) {
      labels.tryPlace(
        c,
        text,
        pt.x,
        Math.min(params.height - 16, pt.y + 8),
        col,
        '600 11px "Noto Sans JP", system-ui, sans-serif',
        "center",
      );
    }
  }
}

function drawGridsAndCircles(
  c: CanvasRenderingContext2D,
  pCtx: CompiledProjectionContext,
  frame: SkyFrame,
  location: LocationPreset,
  layers: SkyLayerVisibility,
  customColors: CustomColorPalette,
  nightVision: boolean,
  panel: number,
  labels: LabelPlacer,
): void {
  const jump = Math.min(pCtx.params.width, pCtx.params.height) * 0.42;

  const drawCurve = (
    sampleCount: number,
    sampleFn: (i: number) => { x: number; y: number; visible: boolean } | null,
    color: string,
    lineWidth: number,
    dash: number[] = [],
  ) => {
    c.save();
    c.strokeStyle = color;
    c.lineWidth = lineWidth;
    c.setLineDash(dash);
    c.beginPath();
    let pen = false;
    let px = 0;
    let py = 0;
    for (let i = 0; i <= sampleCount; i++) {
      const pt = sampleFn(i);
      if (!pt) {
        pen = false;
        continue;
      }
      if (!pen || Math.hypot(pt.x - px, pt.y - py) > jump) {
        c.moveTo(pt.x, pt.y);
        pen = true;
      } else {
        c.lineTo(pt.x, pt.y);
      }
      px = pt.x;
      py = pt.y;
    }
    c.stroke();
    c.restore();
  };

  if (layers.horizontalGrid) {
    const col = nightVision ? "rgba(180, 40, 40, 0.30)" : hexToRgba(customColors.grids, 0.28);
    const textCol = nightVision ? "rgba(220, 60, 60, 0.8)" : hexToRgba(customColors.grids, 0.85);
    for (let alt = 15; alt <= 75; alt += 15) {
      drawCurve(90, (i) => projectHorToScreen(i * 4, alt, pCtx, panel), col, 0.8);
      if (layers.gridLabels) {
        const lp = projectHorToScreen(pCtx.params.center_az_deg, alt, pCtx, panel);
        if (lp && lp.visible) {
          labels.tryPlace(c, `+${alt}°`, lp.x + 4, lp.y, textCol, "10px ui-monospace, monospace");
        }
      }
    }
    for (let az = 0; az < 360; az += 30) {
      drawCurve(36, (i) => projectHorToScreen(az, -15 + i * 3, pCtx, panel), col, 0.8);
      if (layers.gridLabels && az % 90 !== 0) {
        const lp = projectHorToScreen(az, 8, pCtx, panel);
        if (lp && lp.visible) {
          labels.tryPlace(c, `${az}°`, lp.x, lp.y, textCol, "10px ui-monospace, monospace", "center");
        }
      }
    }
  }

  if (layers.equatorialGrid) {
    const col = nightVision ? "rgba(160, 30, 30, 0.28)" : hexToRgba(customColors.celestialEquator, 0.25);
    const textCol = nightVision ? "rgba(220, 60, 60, 0.82)" : hexToRgba(customColors.celestialEquator, 0.82);
    for (let dec = -75; dec <= 75; dec += 15) {
      drawCurve(
        90,
        (i) => projectEqToScreen(i * 4, dec, location.lat_deg, frame.last_deg, pCtx, panel),
        col,
        dec === 0 ? 1.1 : 0.75,
        [3, 3],
      );
      if (layers.gridLabels && dec !== 0) {
        const lp = projectEqToScreen(
          pCtx.params.center_ra_deg,
          dec,
          location.lat_deg,
          frame.last_deg,
          pCtx,
          panel,
        );
        if (lp && lp.visible && lp.panel === panel) {
          labels.tryPlace(c, `${dec > 0 ? "+" : ""}${dec}°`, lp.x + 4, lp.y, textCol, "10px ui-monospace, monospace");
        }
      }
    }
    for (let hRa = 0; hRa < 24; hRa += 2) {
      const ra = hRa * 15;
      drawCurve(
        40,
        (i) => projectEqToScreen(ra, -80 + i * 4, location.lat_deg, frame.last_deg, pCtx, panel),
        col,
        0.75,
        [3, 3],
      );
      if (layers.gridLabels) {
        const lp = projectEqToScreen(ra, 5, location.lat_deg, frame.last_deg, pCtx, panel);
        if (lp && lp.visible && lp.panel === panel) {
          labels.tryPlace(c, `${hRa}h`, lp.x, lp.y, textCol, "10px ui-monospace, monospace", "center");
        }
      }
    }
  }

  if (layers.celestialEquator) {
    const col = nightVision ? "rgba(200, 40, 40, 0.55)" : hexToRgba(customColors.celestialEquator, 0.6);
    drawCurve(
      120,
      (i) => projectEqToScreen(i * 3, 0, location.lat_deg, frame.last_deg, pCtx, panel),
      col,
      1.2,
    );
  }

  if (layers.ecliptic) {
    const eps = frame.obliquity_deg * DEG2RAD;
    const col = nightVision ? "rgba(215, 55, 55, 0.58)" : hexToRgba(customColors.ecliptic, 0.6);
    drawCurve(
      120,
      (i) => {
        const lam = (i * 3) * DEG2RAD;
        const ra = wrapDeg360(Math.atan2(Math.sin(lam) * Math.cos(eps), Math.cos(lam)) * (180 / Math.PI));
        const dec = Math.asin(Math.sin(eps) * Math.sin(lam)) * (180 / Math.PI);
        return projectEqToScreen(ra, dec, location.lat_deg, frame.last_deg, pCtx, panel);
      },
      col,
      1.2,
      [6, 4],
    );
  }
}

function drawDsoKindSymbol(
  c: CanvasRenderingContext2D,
  kindCode: number,
  majAxArcmin: number,
  ratio: number,
  posAngDeg: number,
  x: number,
  y: number,
  scalePxPerDeg: number,
  color: string,
): void {
  const angR = (majAxArcmin / 120) * scalePxPerDeg;
  const r = Math.min(28, Math.max(4.5, angR));
  c.strokeStyle = color;
  c.lineWidth = 1.1;

  if (kindCode === 0) {
    c.beginPath();
    c.ellipse(x, y, r * ratio, r, -posAngDeg * DEG2RAD, 0, Math.PI * 2);
    c.stroke();
  } else if (kindCode === 1) {
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.moveTo(x - r, y);
    c.lineTo(x + r, y);
    c.moveTo(x, y - r);
    c.lineTo(x, y + r);
    c.stroke();
  } else if (kindCode === 2) {
    c.setLineDash([2, 2]);
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.stroke();
    c.setLineDash([]);
  } else if (kindCode === 3) {
    c.beginPath();
    c.arc(x, y, r * 0.75, 0, Math.PI * 2);
    c.moveTo(x - r * 1.3, y);
    c.lineTo(x - r * 0.75, y);
    c.moveTo(x + r * 0.75, y);
    c.lineTo(x + r * 1.3, y);
    c.moveTo(x, y - r * 1.3);
    c.lineTo(x, y - r * 0.75);
    c.moveTo(x, y + r * 0.75);
    c.lineTo(x, y + r * 1.3);
    c.stroke();
  } else {
    c.setLineDash([3, 2]);
    c.strokeRect(x - r, y - r, r * 2, r * 2);
    c.setLineDash([]);
  }
}

function drawDsoMarker(
  c: CanvasRenderingContext2D,
  dso: DsoEntry,
  x: number,
  y: number,
  scalePxPerDeg: number,
  dsoHex: string,
  nightVision: boolean,
): void {
  const color = nightVision ? "rgba(220, 50, 50, 0.85)" : hexToRgba(dsoHex, 0.85);
  const kindCode =
    dso.obj_type === "GC" || dso.obj_type === "GCl"
      ? 1
      : dso.obj_type === "OC" || dso.obj_type === "OCl"
        ? 2
        : dso.obj_type === "PN"
          ? 3
          : dso.obj_type.includes("G")
            ? 0
            : 4;
  const ratio =
    dso.maj_ax_arcmin && dso.min_ax_arcmin
      ? Math.max(0.35, dso.min_ax_arcmin / dso.maj_ax_arcmin)
      : 0.55;
  drawDsoKindSymbol(
    c,
    kindCode,
    dso.maj_ax_arcmin ?? 6,
    ratio,
    dso.pos_ang_deg ?? 30,
    x,
    y,
    scalePxPerDeg,
    color,
  );
}

function drawMoonPhase(
  c: CanvasRenderingContext2D,
  moon: SolarSystemBodyRender,
  sun: SolarSystemBodyRender | undefined,
  mx: number,
  my: number,
  pCtx: CompiledProjectionContext,
  panel: number,
  nightVision: boolean,
  mJ2000ToEnu: Float64Array,
  mJ2000ToApp: Float64Array,
  refractionEnabled: boolean,
  scratch: Float64Array,
  zoomTextures: boolean,
  lunarLabels: boolean,
  isInverted: boolean,
  onTextureLoaded?: () => void,
): number {
  const effFov = effectiveFovDeg(pCtx.params.mode, pCtx.params.fov_deg) / pCtx.params.zoom;
  const pxPerDeg = Math.min(pCtx.params.width, pCtx.params.height) / Math.max(0.25, effFov);
  const trueR = (moon.angular_diameter_arcsec / 7200) * pxPerDeg;
  const maxMoonR = Math.min(pCtx.params.width, pCtx.params.height) * 0.75;
  const r = Math.max(9.5, Math.min(maxMoonR, trueR));

  // Orient lit limb directly toward projected Sun vector (falls back to celestial PA if needed)
  let sunAngle = -Math.PI * 0.5;
  if (sun) {
    const sPt =
      pCtx.params.mode === "star_chart"
        ? projectEqToScreen(sun.ra_deg, sun.dec_deg, 0, 0, pCtx)
        : projectHorToScreen(sun.az_deg, sun.alt_deg, pCtx, panel);
    const stepRa = moon.ra_deg + Math.sin(((moon.bright_limb_pa_deg ?? 90) * Math.PI) / 180) * 0.5;
    const stepDec = moon.dec_deg + Math.cos(((moon.bright_limb_pa_deg ?? 90) * Math.PI) / 180) * 0.5;
    if (sPt && Math.hypot(sPt.x - mx, sPt.y - my) > 4) {
      sunAngle = Math.atan2(sPt.y - my, sPt.x - mx);
    } else {
      const lPt = projectEqToScreen(stepRa, stepDec, 0, 0, pCtx);
      if (lPt) sunAngle = Math.atan2(lPt.y - my, lPt.x - mx);
    }
  }

  // Smooth cubic fade-in of lunar surface texture across r = 8.5..26 px (no sudden pop-in)
  const tMoon = zoomTextures && !isInverted ? Math.max(0, Math.min(1, (r - 8.5) / 17.5)) : 0;
  const texBlend = tMoon * tMoon * (3 - 2 * tMoon);
  const computeNorthRot = zoomTextures && !isInverted && r >= 8.5;
  let northRot = 0;
  if (
    computeNorthRot &&
    projectJ2000RaDec(
      moon.ra_deg,
      Math.min(89.9, moon.dec_deg + 0.5),
      mJ2000ToEnu,
      mJ2000ToApp,
      pCtx,
      panel,
      refractionEnabled,
      scratch,
    )
  ) {
    const ndx = scratch[0] - mx;
    const ndy = scratch[1] - my;
    if (Math.hypot(ndx, ndy) > 0.5) {
      northRot = Math.atan2(ndy, ndx) + Math.PI * 0.5;
    }
  }

  // Pre-warm moon texture smoothly as soon as r >= 5.5
  const lunarTex =
    zoomTextures && !isInverted && r >= 5.5
      ? getPlanetDiskPhotoCanvas("moon", nightVision, onTextureLoaded) ??
        getLunarTextureCanvas(nightVision)
      : null;

  c.save();
  c.translate(mx, my);

  // Dark unlit disc (earthshine)
  c.fillStyle = nightVision ? "rgba(65, 8, 8, 0.92)" : "rgba(24, 32, 48, 0.92)";
  c.beginPath();
  c.arc(0, 0, r, 0, Math.PI * 2);
  c.fill();

  if (lunarTex && texBlend > 0.01) {
    c.save();
    c.rotate(northRot);
    c.globalAlpha = 0.16 * texBlend;
    c.drawImage(lunarTex, -r, -r, r * 2, r * 2);
    c.restore();
  }

  // Lit half (-PI..0 is toward Sun after rotate(sunAngle + PI/2)) + elliptical terminator
  const k = Math.max(0, Math.min(1, moon.illuminated_fraction));
  const rxTerm = r * Math.abs(2 * k - 1);

  c.save();
  c.rotate(sunAngle + Math.PI / 2);
  c.beginPath();
  c.arc(0, 0, r, Math.PI, 0, false);
  if (k >= 0.5) {
    c.ellipse(0, 0, r, rxTerm, 0, 0, Math.PI, false);
  } else {
    c.ellipse(0, 0, r, rxTerm, 0, 0, Math.PI, true);
  }
  c.closePath();

  c.fillStyle = nightVision ? "#dc2626" : "#f8efc8";
  c.fill();

  if (lunarTex && texBlend > 0.01) {
    c.clip();
    c.rotate(northRot - (sunAngle + Math.PI / 2));
    c.globalAlpha = 0.95 * texBlend;
    c.drawImage(lunarTex, -r, -r, r * 2, r * 2);
  }
  c.restore();

  // Selenographic lunar maria & crater labels fade in smoothly over r = 30..48
  if (lunarLabels && r >= 30) {
    const tLbl = Math.max(0, Math.min(1, (r - 30) / 18));
    const lblFade = tLbl * tLbl * (3 - 2 * tLbl);
    const uxSun = Math.cos(sunAngle);
    const uySun = Math.sin(sunAngle);
    const threshold = 1 - 2 * k - 0.08;
    const boxes: [number, number, number, number][] = [];
    const fontSize = Math.max(8.5, Math.min(11, r * 0.14));

    c.save();
    c.font = `600 ${fontSize.toFixed(1)}px "Noto Sans JP", system-ui, sans-serif`;
    c.textAlign = "center";
    c.textBaseline = "middle";

    for (const feat of LUNAR_FEATURES) {
      if (feat.rank === 1 && feat.kind !== "mare" && r < 54) continue;
      if (feat.rank === 2 && r < 105) continue;
      const proj = projectLunarFeature(feat, 0, 0, r, northRot);
      if (!proj.isVisibleLimb) continue;

      const uSun = (proj.x * uxSun + proj.y * uySun) / r;
      const isLit = k >= 0.96 || uSun >= threshold;
      const alpha = (isLit ? 0.94 : 0.34) * lblFade;
      const tw = c.measureText(feat.nameJa).width + 6;
      const th = fontSize + 4;
      const ly = proj.y - (feat.kind === "mare" ? 0 : 7);
      const bx1 = proj.x - tw * 0.5;
      const bx2 = proj.x + tw * 0.5;
      const by1 = ly - th * 0.5;
      const by2 = ly + th * 0.5;

      let overlaps = false;
      for (const b of boxes) {
        if (bx1 < b[2] && bx2 > b[0] && by1 < b[3] && by2 > b[1]) {
          overlaps = true;
          break;
        }
      }
      if (overlaps) continue;
      boxes.push([bx1, by1, bx2, by2]);

      if (feat.kind !== "mare") {
        c.fillStyle = nightVision
          ? `rgba(248, 113, 113, ${alpha})`
          : isInverted
            ? `rgba(15, 23, 42, ${alpha})`
            : feat.kind === "mountain"
              ? `rgba(125, 211, 252, ${alpha})`
              : `rgba(253, 224, 71, ${alpha})`;
        c.beginPath();
        c.arc(proj.x, proj.y, 1.8, 0, Math.PI * 2);
        c.fill();
      }

      c.globalAlpha = alpha;
      c.lineWidth = 2.4;
      c.strokeStyle = isInverted ? "rgba(255,255,255,0.85)" : "rgba(4, 8, 20, 0.85)";
      c.strokeText(feat.nameJa, proj.x, ly);
      c.fillStyle = nightVision
        ? "#fca5a5"
        : isInverted
          ? "#0f172a"
          : feat.kind === "mare"
            ? "#cbd5e1"
            : feat.kind === "mountain"
              ? "#7dd3fc"
              : "#fef08a";
      c.fillText(feat.nameJa, proj.x, ly);
    }
    c.restore();
  }

  c.strokeStyle = nightVision ? "rgba(239, 68, 68, 0.65)" : "rgba(255, 250, 220, 0.65)";
  c.lineWidth = 0.85;
  c.beginPath();
  c.arc(0, 0, r, 0, Math.PI * 2);
  c.stroke();
  c.restore();
  return r;
}

function drawPlanetOrSun(
  c: CanvasRenderingContext2D,
  body: SolarSystemBodyRender,
  sun: SolarSystemBodyRender | undefined,
  x: number,
  y: number,
  pCtx: CompiledProjectionContext,
  panel: number,
  nightVision: boolean,
  pxPerDeg: number,
  effFov: number,
  zoomTextures: boolean,
  onTextureLoaded?: () => void,
): number {
  const palette: Record<string, { fill: string; radius: number }> = {
    sun: { fill: nightVision ? "#ef4444" : "#fff4bf", radius: 11 },
    mercury: { fill: nightVision ? "#b91c1c" : "#cbd5e1", radius: 4.2 },
    venus: { fill: nightVision ? "#ef4444" : "#fef08a", radius: 6.2 },
    mars: { fill: nightVision ? "#dc2626" : "#fb7154", radius: 5.2 },
    jupiter: { fill: nightVision ? "#ef4444" : "#fdba74", radius: 6.8 },
    saturn: { fill: nightVision ? "#dc2626" : "#fde68a", radius: 5.6 },
    uranus: { fill: nightVision ? "#b91c1c" : "#67e8f9", radius: 4.5 },
    neptune: { fill: nightVision ? "#991b1b" : "#60a5fa", radius: 4.2 },
    pluto: { fill: nightVision ? "#7f1d1d" : "#d6d3d1", radius: 3.4 },
    eris: { fill: nightVision ? "#7f1d1d" : "#e2e8f0", radius: 3.2 },
  };
  const style = palette[body.id] ?? { fill: "#ffffff", radius: 4.2 };

  const trueR = (body.angular_diameter_arcsec / 7200) * pxPerDeg;
  const boost = zoomTextures && body.id !== "sun" && effFov < 24
    ? effFov < 14
      ? 1 + (14 - effFov) * 0.25
      : 1
    : 1;
  const r = zoomTextures && body.id !== "sun"
    ? Math.max(style.radius, Math.min(72, trueR * boost))
    : style.radius;
  const detailed = zoomTextures && r >= 6.0;
  const tPlanet = zoomTextures ? Math.max(0, Math.min(1, (r - 4.4) / 6.5)) : 0;
  const texBlend = tPlanet * tPlanet * (3 - 2 * tPlanet);

  c.save();
  if (body.id === "sun") {
    const sr = Math.max(11, Math.min(pCtx.params.width * 0.3, trueR));
    const corona = c.createRadialGradient(x, y, 2, x, y, sr * 2.5);
    corona.addColorStop(0, nightVision ? "rgba(239,68,68,0.9)" : "rgba(255,248,200,0.95)");
    corona.addColorStop(0.45, nightVision ? "rgba(185,28,28,0.4)" : "rgba(253,224,71,0.35)");
    corona.addColorStop(1, "rgba(0,0,0,0)");
    c.fillStyle = corona;
    c.beginPath();
    c.arc(x, y, sr * 2.5, 0, Math.PI * 2);
    c.fill();

    c.fillStyle = style.fill;
    c.beginPath();
    c.arc(x, y, sr, 0, Math.PI * 2);
    c.fill();
    if (zoomTextures && sr >= 11) {
      const sunTex = getPlanetDiskPhotoCanvas("sun", nightVision, onTextureLoaded);
      if (sunTex) {
        const tSun = Math.max(0, Math.min(1, (sr - 10) / 14));
        const sunBlend = tSun * tSun * (3 - 2 * tSun);
        c.save();
        c.beginPath();
        c.arc(x, y, sr, 0, Math.PI * 2);
        c.clip();
        c.globalAlpha = 0.94 * sunBlend;
        c.drawImage(sunTex, x - sr, y - sr, sr * 2, sr * 2);
        c.restore();
      }
    }
    c.restore();
    return sr;
  }

  const halo = c.createRadialGradient(x, y, 0.5, x, y, r * 2.1);
  halo.addColorStop(0, style.fill);
  halo.addColorStop(1, "rgba(0,0,0,0)");
  c.fillStyle = halo;
  c.beginPath();
  c.arc(x, y, r * 2.1, 0, Math.PI * 2);
  c.fill();

  const diskTex = zoomTextures ? getPlanetDiskPhotoCanvas(body.id, nightVision, onTextureLoaded) : null;

  if (body.id === "saturn") {
    const tiltRad = ((body.saturn_ring_tilt_deg ?? 12) * Math.PI) / 180;
    const ryOuter = Math.max(1.8, Math.abs(Math.sin(tiltRad)) * r * 1.15);
    const rxOuter = r * 2.25;
    const rxInner = r * 1.45;
    const ryInner = ryOuter * (1.45 / 2.25);

    // Back half of Saturn rings
    c.save();
    c.translate(x, y);
    c.rotate(-0.32);
    c.strokeStyle = nightVision ? "rgba(220,38,38,0.85)" : "rgba(253, 230, 138, 0.85)";
    c.lineWidth = detailed ? Math.max(2, r * 0.28) : 1.6;
    c.beginPath();
    c.ellipse(0, 0, rxOuter * 0.92, ryOuter * 0.92, 0, Math.PI, Math.PI * 2);
    c.stroke();
    if (detailed) {
      c.strokeStyle = nightVision ? "rgba(120,10,10,0.85)" : "rgba(24, 22, 18, 0.72)";
      c.lineWidth = Math.max(1.0, r * 0.09);
      c.beginPath();
      c.ellipse(0, 0, (rxOuter + rxInner) * 0.5, (ryOuter + ryInner) * 0.5, 0, Math.PI, Math.PI * 2);
      c.stroke();
    }
    c.restore();

    // Saturn globe with real photographic bands inside rings
    c.save();
    c.beginPath();
    c.ellipse(x, y, r, r * 0.902, -0.32, 0, Math.PI * 2);
    c.fillStyle = style.fill;
    c.fill();
    if (detailed && diskTex && texBlend > 0.01) {
      c.save();
      c.clip();
      c.translate(x, y);
      c.rotate(-0.32);
      c.globalAlpha = 0.95 * texBlend;
      c.drawImage(diskTex, -r, -r * 0.902, r * 2, r * 1.804);
      c.restore();
    } else if (detailed) {
      c.clip();
      c.translate(x, y);
      c.rotate(-0.32);
      c.fillStyle = nightVision ? "rgba(185,28,28,0.38)" : "rgba(196, 150, 92, 0.45)";
      c.fillRect(-r, -r * 0.25, r * 2, r * 0.16);
      c.fillRect(-r, r * 0.18, r * 2, r * 0.18);
    }
    c.restore();

    // Front half of Saturn rings
    c.save();
    c.translate(x, y);
    c.rotate(-0.32);
    c.strokeStyle = nightVision ? "rgba(248,113,113,0.9)" : "rgba(254, 240, 180, 0.92)";
    c.lineWidth = detailed ? Math.max(2, r * 0.28) : 1.6;
    c.beginPath();
    c.ellipse(0, 0, rxOuter * 0.92, ryOuter * 0.92, 0, 0, Math.PI);
    c.stroke();
    if (detailed) {
      c.strokeStyle = nightVision ? "rgba(120,10,10,0.85)" : "rgba(24, 22, 18, 0.72)";
      c.lineWidth = Math.max(1.0, r * 0.09);
      c.beginPath();
      c.ellipse(0, 0, (rxOuter + rxInner) * 0.5, (ryOuter + ryInner) * 0.5, 0, 0, Math.PI);
      c.stroke();
    }
    c.restore();

    c.restore();
    return r;
  }

  // Phase planets (Mercury & Venus) with real photo textures clipped to sunlit phase
  if (body.id === "venus" || body.id === "mercury") {
    let sunAng = -Math.PI * 0.5;
    if (sun) {
      const sPt =
        pCtx.params.mode === "star_chart"
          ? projectEqToScreen(sun.ra_deg, sun.dec_deg, 0, 0, pCtx)
          : projectHorToScreen(sun.az_deg, sun.alt_deg, pCtx, panel);
      if (sPt && Math.hypot(sPt.x - x, sPt.y - y) > 4) {
        sunAng = Math.atan2(sPt.y - y, sPt.x - x);
      }
    }
    const k = Math.max(0.05, Math.min(1, body.illuminated_fraction));
    const rxTerm = r * Math.abs(2 * k - 1);
    c.save();
    c.translate(x, y);
    c.rotate(sunAng + Math.PI * 0.5);
    c.fillStyle = nightVision ? "rgba(65, 8, 8, 0.82)" : "rgba(18, 22, 34, 0.82)";
    c.beginPath();
    c.arc(0, 0, r, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = style.fill;
    c.beginPath();
    c.arc(0, 0, r, Math.PI, 0, false);
    if (k >= 0.5) {
      c.ellipse(0, 0, r, rxTerm, 0, 0, Math.PI, false);
    } else {
      c.ellipse(0, 0, r, rxTerm, 0, 0, Math.PI, true);
    }
    c.closePath();
    c.fill();
    if (diskTex && texBlend > 0.01) {
      c.save();
      c.clip();
      c.rotate(-(sunAng + Math.PI * 0.5));
      c.globalAlpha = 0.94 * texBlend;
      c.drawImage(diskTex, -r, -r, r * 2, r * 2);
      c.restore();
    }
    c.restore();
    c.restore();
    return r;
  }

  // Mars, Jupiter, Uranus, Neptune, Pluto, Eris: real spherical textures with smooth crossfade
  const ry = body.id === "jupiter" ? r * 0.935 : r;
  c.fillStyle = style.fill;
  c.beginPath();
  c.ellipse(x, y, r, ry, 0, 0, Math.PI * 2);
  c.fill();
  if (diskTex && texBlend > 0.01) {
    c.save();
    c.beginPath();
    c.ellipse(x, y, r, ry, 0, 0, Math.PI * 2);
    c.clip();
    c.globalAlpha = 0.96 * texBlend;
    c.drawImage(diskTex, x - r, y - ry, r * 2, ry * 2);
    c.restore();
  }
  c.restore();
  return r;
}

function drawComet(
  c: CanvasRenderingContext2D,
  body: SolarSystemBodyRender,
  sun: SolarSystemBodyRender | undefined,
  x: number,
  y: number,
  latDeg: number,
  lastDeg: number,
  pCtx: CompiledProjectionContext,
  panel: number,
  nightVision: boolean,
): number {
  let tx = 0.7;
  let ty = -0.7;
  if (sun) {
    const sunPt =
      pCtx.params.mode === "star_chart"
        ? projectEqToScreen(sun.ra_deg, sun.dec_deg, latDeg, lastDeg, pCtx, panel)
        : projectHorToScreen(sun.az_deg, sun.alt_deg, pCtx, panel);
    if (sunPt) {
      const dx = x - sunPt.x;
      const dy = y - sunPt.y;
      const len = Math.hypot(dx, dy);
      if (len > 4) {
        tx = dx / len;
        ty = dy / len;
      }
    }
  }
  const tailLen = Math.max(16, Math.min(44, 34 / Math.max(0.4, body.helio_au)));
  const px = -ty;
  const py = tx;

  c.save();
  const tailGrad = c.createLinearGradient(x, y, x + tx * tailLen, y + ty * tailLen);
  tailGrad.addColorStop(0, nightVision ? "rgba(248, 113, 113, 0.65)" : "rgba(52, 211, 153, 0.7)");
  tailGrad.addColorStop(0.55, nightVision ? "rgba(220, 38, 38, 0.28)" : "rgba(45, 212, 191, 0.25)");
  tailGrad.addColorStop(1, "rgba(0,0,0,0)");
  c.fillStyle = tailGrad;
  c.beginPath();
  c.moveTo(x - px * 2.2, y - py * 2.2);
  c.lineTo(x + tx * tailLen + px * 7.5, y + ty * tailLen + py * 7.5);
  c.lineTo(x + tx * tailLen - px * 7.5, y + ty * tailLen - py * 7.5);
  c.lineTo(x + px * 2.2, y + py * 2.2);
  c.closePath();
  c.fill();

  const coma = c.createRadialGradient(x, y, 0.8, x, y, 11);
  coma.addColorStop(0, nightVision ? "#fca5a5" : "#ecfdf5");
  coma.addColorStop(0.4, nightVision ? "rgba(239, 68, 68, 0.72)" : "rgba(52, 211, 153, 0.72)");
  coma.addColorStop(1, "rgba(0,0,0,0)");
  c.fillStyle = coma;
  c.beginPath();
  c.arc(x, y, 11, 0, Math.PI * 2);
  c.fill();

  c.fillStyle = nightVision ? "#fecaca" : "#ffffff";
  c.beginPath();
  c.arc(x, y, 2.6, 0, Math.PI * 2);
  c.fill();
  c.restore();
  return 6;
}

function drawFovOverlays(
  c: CanvasRenderingContext2D,
  fovPresets: FovPreset[],
  pxPerDeg: number,
  width: number,
  height: number,
  nightVision: boolean,
  isInverted: boolean,
): void {
  const active = fovPresets.filter((p) => p.enabled);
  if (active.length === 0) return;

  const cx = width * 0.5;
  const cy = height * 0.5;

  for (const preset of active) {
    const dims = computeFovDimensions(preset);
    const col = nightVision ? "#ef4444" : isInverted ? "#0f172a" : preset.color;
    const rad = (preset.rotationDeg * DEG2RAD);

    c.save();
    c.translate(cx, cy);
    c.rotate(rad);
    c.strokeStyle = col;
    c.fillStyle = col;
    c.lineWidth = 1.4;

    if (preset.kind === "camera") {
      const tw = dims.widthDeg * pxPerDeg;
      const th = dims.heightDeg * pxPerDeg;
      const cols = Math.max(1, Math.min(5, Math.round(preset.mosaicCols ?? 1)));
      const rows = Math.max(1, Math.min(5, Math.round(preset.mosaicRows ?? 1)));
      const overlapFrac = Math.max(0, Math.min(0.45, (preset.mosaicOverlapPct ?? 15) / 100));
      const stepX = tw * (1 - overlapFrac);
      const stepY = th * (1 - overlapFrac);
      const totalW = tw + (cols - 1) * stepX;
      const totalH = th + (rows - 1) * stepY;

      if (cols > 1 || rows > 1) {
        c.save();
        c.globalAlpha = 0.62;
        c.setLineDash([4, 3]);
        const xStart = -totalW * 0.5;
        const yStart = -totalH * 0.5;
        for (let rIdx = 0; rIdx < rows; rIdx++) {
          for (let cIdx = 0; cIdx < cols; cIdx++) {
            const tx = xStart + cIdx * stepX;
            const ty = yStart + rIdx * stepY;
            c.strokeRect(tx, ty, tw, th);
            if (tw >= 26 && th >= 18) {
              c.font = '500 9px "Noto Sans JP", system-ui, sans-serif';
              c.textAlign = "center";
              c.textBaseline = "middle";
              c.fillText(`${cIdx + 1}-${rIdx + 1}`, tx + tw * 0.5, ty + th * 0.5);
            }
          }
        }
        c.restore();
      }

      c.strokeRect(-totalW * 0.5, -totalH * 0.5, totalW, totalH);

      // Center cross & mosaic/camera label
      const arm = Math.min(8, Math.min(totalW, totalH) * 0.15);
      c.beginPath();
      c.moveTo(-arm, 0);
      c.lineTo(arm, 0);
      c.moveTo(0, -arm);
      c.lineTo(0, arm);
      c.stroke();

      const effW = dims.widthDeg + (cols - 1) * dims.widthDeg * (1 - overlapFrac);
      const effH = dims.heightDeg + (rows - 1) * dims.heightDeg * (1 - overlapFrac);
      const label =
        cols > 1 || rows > 1
          ? `${preset.name} [${cols}×${rows} ${effW.toFixed(1)}°×${effH.toFixed(1)}°]`
          : `${preset.name} (${dims.widthDeg.toFixed(1)}°×${dims.heightDeg.toFixed(1)}°)`;

      c.font = '600 10px "Noto Sans JP", system-ui, sans-serif';
      c.textAlign = "left";
      c.textBaseline = "bottom";
      c.fillText(label, -totalW * 0.5 + 3, -totalH * 0.5 - 3);
    } else if (preset.kind === "telrad") {
      c.setLineDash([4, 3]);
      for (const diam of [0.5, 2.0, 4.0]) {
        const r = Math.max(2, diam * 0.5 * pxPerDeg);
        c.beginPath();
        c.arc(0, 0, r, 0, Math.PI * 2);
        c.stroke();
      }
      c.setLineDash([]);
      c.font = '600 10px "Noto Sans JP", system-ui, sans-serif';
      c.textAlign = "left";
      c.fillText("Telrad 0.5°/2°/4°", 4, -(2.0 * pxPerDeg + 4));
    } else {
      const r = Math.max(4, dims.widthDeg * 0.5 * pxPerDeg);
      c.setLineDash([6, 4]);
      c.beginPath();
      c.arc(0, 0, r, 0, Math.PI * 2);
      c.stroke();
      c.setLineDash([]);
      c.font = '600 10px "Noto Sans JP", system-ui, sans-serif';
      c.textAlign = "center";
      c.fillText(`${preset.name} (Ø${dims.widthDeg.toFixed(1)}°)`, 0, -r - 6);
    }
    c.restore();
  }
}

function drawWeatherCloudOverlay(
  c: CanvasRenderingContext2D,
  width: number,
  height: number,
  pCtx: CompiledProjectionContext,
  panel: number,
  frame: SkyFrame,
  weather: NightWeatherForecast,
  nightVision: boolean,
): void {
  const targetPrefix = `${frame.local_dt.year}-${String(frame.local_dt.month).padStart(
    2,
    "0",
  )}-${String(frame.local_dt.day).padStart(2, "0")}T${String(frame.local_dt.hour).padStart(
    2,
    "0",
  )}:`;
  const matched =
    weather.hours.find((h) => h.time_iso.startsWith(targetPrefix)) ??
    weather.hours[0];

  const totalPct = matched?.cloud_cover_pct ?? weather.current?.cloud_cover_pct ?? 0;
  const lowPct = matched?.cloud_low_pct ?? totalPct * 0.4;
  const highPct = matched?.cloud_high_pct ?? totalPct * 0.3;
  const visKm = matched?.visibility_km ?? 24;

  if (totalPct < 3 && visKm >= 16) return;

  const { params } = pCtx;
  let horizonY = height * 0.85;
  const hPt = projectHorToScreen(params.center_az_deg, 0, pCtx, panel);
  if (hPt) {
    horizonY = Math.max(height * 0.25, Math.min(height, hPt.y));
  }

  const baseAlpha = Math.min(0.76, (totalPct / 100) * 0.72);
  const mistAlpha = Math.min(0.42, (Math.max(0, 14 - visKm) / 14) * 0.32 + (lowPct / 100) * 0.16);
  const dayLit = Math.max(0.22, 1 - frame.sky_palette.star_visibility_factor * 0.78);
  const cloudR = nightVision ? 140 : Math.round(92 + dayLit * 125);
  const cloudG = nightVision ? 26 : Math.round(106 + dayLit * 118);
  const cloudB = nightVision ? 22 : Math.round(128 + dayLit * 108);

  c.save();

  // Subtle horizon mist / low cloud veil
  if (mistAlpha > 0.015) {
    const g = c.createLinearGradient(0, horizonY - height * 0.42, 0, horizonY + 24);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, `rgba(${cloudR}, ${cloudG}, ${cloudB}, ${mistAlpha.toFixed(3)})`);
    c.fillStyle = g;
    c.fillRect(0, 0, width, height);
  }

  // Deterministic soft billowing cloud puffs shifted slowly by Azimuth + Hour
  const puffCount = Math.min(26, Math.max(3, Math.round((totalPct / 100) * 26)));
  const azShift = (params.center_az_deg / 360) * width * 0.9;
  const hrShift = frame.local_dt.hour * 37;

  for (let i = 0; i < puffCount; i++) {
    const s1 = Math.sin(i * 12.9898 + 4.1414) * 43758.5453;
    const f1 = s1 - Math.floor(s1);
    const s2 = Math.sin(i * 78.233 + 1.23) * 19341.21;
    const f2 = s2 - Math.floor(s2);

    const px = (((f1 * width * 1.4 - azShift + hrShift) % (width * 1.2)) + width * 1.2) % (width * 1.2) - width * 0.1;
    const altBand = i % 3 === 0 ? 0.15 + f2 * 0.35 : 0.35 + f2 * 0.48;
    const py = horizonY * altBand;
    const rx = width * (0.14 + f1 * 0.22);
    const layerOpacity =
      baseAlpha * (i % 3 === 0 ? 0.42 + (highPct / 100) * 0.3 : 0.6 + (lowPct / 100) * 0.35);

    const g = c.createRadialGradient(px, py, rx * 0.1, px, py, rx);
    g.addColorStop(0, `rgba(${cloudR}, ${cloudG}, ${cloudB}, ${Math.min(0.65, layerOpacity).toFixed(3)})`);
    g.addColorStop(0.55, `rgba(${cloudR}, ${cloudG}, ${cloudB}, ${(layerOpacity * 0.42).toFixed(3)})`);
    g.addColorStop(1, "rgba(0,0,0,0)");
    c.fillStyle = g;
    c.beginPath();
    c.arc(px, py, rx, 0, Math.PI * 2);
    c.fill();
  }

  c.restore();
}

export function renderSkyCanvas(args: SkyRenderArgs): void {
  const {
    ctx: c,
    width,
    height,
    params,
    frame,
    location,
    staticAssets,
    starBuffer,
    starCount,
    dsoBuffer = null,
    dsoCount = 0,
    limitingMag,
    refractionEnabled,
    layers,
    customColors,
    trails,
    simLockMode,
    simStepMinutes,
    nightVision,
    selectedObject,
    atlas,
    selectedMeteorShowerCode = null,
    meteorShowAllRadiants = false,
    meteorParticles = [],
    planetTracks = {},
    fovPresets = [],
    satellites = [],
    showSatellites = true,
    highlightedSatPass = null,
    landscapeConfig = DEFAULT_LANDSCAPE_CONFIG,
    hipsConfig = DEFAULT_HIPS_CONFIG,
    offlineMode = false,
    liveWeather = null,
    showWeatherCloudsOverlay = false,
    printColorMode = "normal",
    skipMeteors = false,
    fastInteractive = false,
    renderPhase = "all",
    includeDsoMarkersInForeground = false,
    onTextureLoaded,
  } = args;

  const isInverted = printColorMode === "inverted";
  const effectivePalette = isInverted
    ? {
        ...frame.sky_palette,
        zenith: { r: 255, g: 255, b: 255 },
        mid_sky: { r: 255, g: 255, b: 255 },
        horizon: { r: 248, g: 250, b: 252 },
        sun_glow: { r: 255, g: 255, b: 255 },
        sun_glow_strength: 0,
        light_pollution: { r: 255, g: 255, b: 255 },
        light_pollution_strength: 0,
        ground: { r: 241, g: 245, b: 249 },
        horizon_line: { r: 15, g: 23, b: 42 },
        star_visibility_factor: 1.0,
      }
    : frame.sky_palette;
  const effectiveFrame = isInverted ? { ...frame, sky_palette: effectivePalette } : frame;
  const effColors: CustomColorPalette = isInverted
    ? {
        constellationLines: "#334155",
        constellationNames: "#0f172a",
        constellationBoundaries: "#64748b",
        asterisms: "#0284c7",
        ecliptic: "#b45309",
        celestialEquator: "#0369a1",
        grids: "#475569",
        dso: "#0284c7",
      }
    : customColors;

  const pCtx = compileProjectionContext(params);
  const showOppositeGroundSky = !(
    params.mode === "all_sky" ||
    params.mode === "hemisphere_single" ||
    params.mode === "hemisphere_dual"
  );
  const skyPCtx =
    params.show_below_horizon || !showOppositeGroundSky
      ? pCtx
      : compileProjectionContext({ ...params, show_below_horizon: true });
  const mJ2000ToApp = flattenMat3(frame.j2000_to_apparent_matrix);
  const mJ2000ToEnu = frame.j2000_to_enu_override
    ? flattenMat3(frame.j2000_to_enu_override)
    : buildJ2000ToEnuMatrix(
        frame.j2000_to_apparent_matrix,
        frame.last_deg,
        location.lat_deg,
      );
  const scratch = new Float64Array(3);
  const labels = new LabelPlacer();
  const panels = getPanelList(params.mode);
  const isOtherStar = frame.view_mode === "other_star";
  const isProperMotion = frame.view_mode === "proper_motion";

  // Outer matte backdrop (for circular all-sky, hemisphere dome(s), and panorama side margins)
  if (renderPhase === "foreground") {
    c.clearRect(0, 0, width, height);
  } else {
    c.fillStyle = isInverted ? "#ffffff" : nightVision ? "#030000" : "#02050d";
    c.fillRect(0, 0, width, height);
  }

  const effFov = effectiveFovDeg(params.mode, params.fov_deg) / params.zoom;
  const pxPerDeg = Math.min(width, height) / Math.max(0.25, effFov);

  for (const panel of panels) {
    c.save();
    clipToPanel(c, pCtx, panel);

    const m20 = mJ2000ToEnu[6];
    const m21 = mJ2000ToEnu[7];
    const m22 = mJ2000ToEnu[8];
    const isChart = params.mode === "star_chart";
    const canCullHorizon = !params.show_below_horizon && !showOppositeGroundSky;
    const cullCone = computePanelCullCone(skyPCtx, panel, mJ2000ToEnu, mJ2000ToApp);

    if (renderPhase !== "foreground") {
      drawRealisticSkyBackground(c, pCtx, effectiveFrame, panel);

    // Seamless All-Sky Real-Sky Survey (HiPS / DSS2 / 2MASS)
    if (hipsConfig.enabled && !isOtherStar && !isInverted) {
      drawHipsSurveyLayer({
        ctx: c,
        config: hipsConfig,
        offlineMode,
        nightVision,
        starVisibilityFactor: effectivePalette.star_visibility_factor,
        pxPerDeg,
        width,
        height,
        fastInteractive,
        cullCone,
        canCullHorizon,
        m20,
        m21,
        m22,
        projectJ2000: (vx, vy, vz, out) =>
          projectJ2000UnitVec(
            vx,
            vy,
            vz,
            mJ2000ToEnu,
            mJ2000ToApp,
            skyPCtx,
            panel,
            isChart,
            refractionEnabled,
            false,
            out,
            0,
          ),
      });
    }

    // Milky Way (Galactic cloud puff splatting across all 9 projections without contour seam bugs)
    if (layers.milkyWay && staticAssets && !isOtherStar && effectivePalette.star_visibility_factor > 0.14) {
      const clouds = getOrBuildMilkyWayClouds(staticAssets.milky_way);
      const mwSprites = getMilkyWaySpriteAtlas();
      const hipsAtten = hipsConfig.enabled ? 0.35 : 1.0;
      const visScale =
        (0.28 + 0.72 * effectivePalette.star_visibility_factor) *
        (effFov < 25 ? 0.6 : 0.88) *
        hipsAtten;
      const minMwDot =
        cullCone.useCone && cullCone.halfConeRad + 0.16 < Math.PI
          ? Math.cos(cullCone.halfConeRad + 0.16)
          : -2;

      const mwStep = 6;
      const mwScale = 1.0;

      c.save();
      for (let idx = 0, len = clouds.length; idx + 5 < len; idx += mwStep) {
        const vx = clouds[idx];
        const vy = clouds[idx + 1];
        const vz = clouds[idx + 2];
        if (cullCone.useCone) {
          const dot = vx * cullCone.fxJ + vy * cullCone.fyJ + vz * cullCone.fzJ;
          if (dot < minMwDot) continue;
        }
        const radDeg = clouds[idx + 3];
        const radPx = Math.max(8, Math.min(Math.max(width, height) * 0.48, radDeg * pxPerDeg * 1.15 * mwScale));
        if (
          !projectJ2000UnitVec(
            vx,
            vy,
            vz,
            mJ2000ToEnu,
            mJ2000ToApp,
            skyPCtx,
            panel,
            isChart,
            false,
            canCullHorizon,
            scratch,
            radPx,
          )
        ) {
          continue;
        }
        const intensity = clouds[idx + 4];
        const warmth = clouds[idx + 5];
        const img = isInverted
          ? mwSprites.inverted
          : nightVision
            ? mwSprites.nightVision
            : warmth > 0.35
              ? mwSprites.warm
              : mwSprites.cool;
        c.globalAlpha = Math.min(1, intensity * visScale);
        c.drawImage(img, scratch[0] - radPx, scratch[1] - radPx, radPx * 2, radPx * 2);
      }
      c.restore();
    }

    // Coordinate grids & reference circles
    drawGridsAndCircles(c, skyPCtx, effectiveFrame, location, layers, effColors, nightVision, panel, labels);

    // Constellation artwork
    if (layers.constellationArtwork && !isOtherStar) {
      c.save();
      c.fillStyle = nightVision
        ? "rgba(185, 28, 28, 0.09)"
        : hexToRgba(effColors.constellationLines, 0.1);
      c.strokeStyle = nightVision
        ? "rgba(220, 38, 38, 0.28)"
        : hexToRgba(effColors.constellationNames, 0.3);
      c.lineWidth = 1.0;
      for (const art of CONSTELLATION_ARTWORK) {
        c.beginPath();
        for (const poly of art.polygons) {
          drawJ2000Polyline(c, poly, true, mJ2000ToEnu, mJ2000ToApp, skyPCtx, panel, false, scratch);
        }
        c.fill();
        c.beginPath();
        for (const stroke of art.strokes) {
          drawJ2000Polyline(c, stroke, false, mJ2000ToEnu, mJ2000ToApp, skyPCtx, panel, false, scratch);
        }
        c.stroke();
      }
      c.restore();
    }

    // Constellation boundaries
    if (layers.constellationBoundaries && staticAssets && !isOtherStar) {
      c.save();
      c.strokeStyle = nightVision
        ? "rgba(185, 28, 28, 0.32)"
        : hexToRgba(effColors.constellationBoundaries, 0.38);
      c.lineWidth = 0.8;
      c.setLineDash([4, 4]);
      c.beginPath();
      for (const con of staticAssets.constellations) {
        for (const b of con.bounds) {
          drawJ2000Polyline(c, b, true, mJ2000ToEnu, mJ2000ToApp, skyPCtx, panel, false, scratch);
        }
      }
      c.stroke();
      c.restore();
    }

    // Constellation lines (dimmed J2000 ghost reference in proper_motion mode)
    if (layers.constellationLines !== "off" && staticAssets && !isOtherStar) {
      c.save();
      c.strokeStyle = nightVision
        ? isProperMotion
          ? "rgba(220, 38, 38, 0.22)"
          : "rgba(220, 38, 38, 0.45)"
        : hexToRgba(effColors.constellationLines, isProperMotion ? 0.22 : isInverted ? 0.62 : 0.45);
      c.lineWidth = 1.0;
      c.beginPath();
      for (const con of staticAssets.constellations) {
        const segs =
          layers.constellationLines === "simple"
            ? con.lines_simple
            : layers.constellationLines === "detailed"
              ? con.lines_detailed
              : con.lines_standard;
        for (const seg of segs) {
          drawJ2000Polyline(c, seg, false, mJ2000ToEnu, mJ2000ToApp, skyPCtx, panel, refractionEnabled, scratch);
        }
      }
      c.stroke();
      c.restore();
    }

    // Asterisms (大三角・四辺形)
    if (layers.asterisms && staticAssets && !isOtherStar) {
      c.save();
      c.strokeStyle = nightVision
        ? "rgba(239, 68, 68, 0.65)"
        : hexToRgba(effColors.asterisms, 0.58);
      c.lineWidth = 1.25;
      c.setLineDash([5, 4]);
      c.beginPath();
      for (const ast of staticAssets.asterisms) {
        for (const seg of ast.lines) {
          drawJ2000Polyline(c, seg, false, mJ2000ToEnu, mJ2000ToApp, skyPCtx, panel, refractionEnabled, scratch);
        }
      }
      c.stroke();
      c.restore();
    }

    // Precession NCP / SCP circular pole track & epochs (±15,000 years)
    if (frame.view_mode === "precession") {
      const tracks = [
        { pts: frame.pole_track_north, col: nightVision ? "#ef4444" : "#34d399", curDec: 90, curName: "現在の天の北極" },
        { pts: frame.pole_track_south, col: nightVision ? "#dc2626" : "#fb7185", curDec: -90, curName: "現在の天の南極" },
      ];
      for (const tr of tracks) {
        if (tr.pts.length === 0) continue;
        c.save();
        c.strokeStyle = nightVision ? "rgba(239, 68, 68, 0.65)" : hexToRgba(tr.col, 0.65);
        c.lineWidth = 1.3;
        c.setLineDash([4, 3]);
        c.beginPath();
        const ring: [number, number][] = tr.pts.map((pt) => [pt.ra_deg, pt.dec_deg]);
        drawJ2000Polyline(c, ring, false, mJ2000ToEnu, mJ2000ToApp, skyPCtx, panel, false, scratch);
        c.stroke();
        c.restore();

        for (const pt of tr.pts) {
          if (!projectJ2000RaDec(pt.ra_deg, pt.dec_deg, mJ2000ToEnu, mJ2000ToApp, skyPCtx, panel, false, scratch)) {
            continue;
          }
          if (scratch[2] < 0.5) continue;
          c.fillStyle = tr.col;
          c.beginPath();
          c.arc(scratch[0], scratch[1], pt.label ? 3.2 : 1.8, 0, Math.PI * 2);
          c.fill();
          if (pt.label) {
            labels.tryPlace(c, pt.label, scratch[0] + 6, scratch[1], tr.col, '10px "Noto Sans JP", system-ui, sans-serif');
          }
        }

        const curPole = projectEqToScreen(0, tr.curDec, location.lat_deg, frame.last_deg, skyPCtx, panel);
        if (curPole && curPole.visible && curPole.panel === panel) {
          c.save();
          c.strokeStyle = nightVision ? "#f87171" : "#38bdf8";
          c.lineWidth = 1.6;
          c.beginPath();
          c.arc(curPole.x, curPole.y, 7, 0, Math.PI * 2);
          c.moveTo(curPole.x - 10, curPole.y);
          c.lineTo(curPole.x + 10, curPole.y);
          c.moveTo(curPole.x, curPole.y - 10);
          c.lineTo(curPole.x, curPole.y + 10);
          c.stroke();
          c.restore();
          labels.tryPlace(
            c,
            `${tr.curName} (${frame.local_dt.year})`,
            curPole.x + 10,
            curPole.y - 6,
            nightVision ? "#f87171" : "#38bdf8",
            '600 11px "Noto Sans JP", system-ui, sans-serif',
          );
        }
      }
    }

    // High-Definition Real-Photo & HD Vector Deep-Sky Textures (M31, M42, M45, etc.)
    if (
      layers.zoomTextures &&
      !hipsConfig.enabled &&
      !isOtherStar &&
      staticAssets &&
      effFov < 130 &&
      effectivePalette.star_visibility_factor > 0.2
    ) {
      c.save();
      c.globalCompositeOperation = isInverted ? "multiply" : "screen";
      const dsoTexMaxMag = Math.min(11.5, limitingMag + 3.2);
      const maxDim = Math.max(width, height);
      const buckets = getDsoTextureBuckets(staticAssets.dsos);
      const texCandidates = effFov >= 65 ? buckets.showcase : buckets.zoomCandidates;
      for (const dso of texCandidates) {
        if (dso.messier === 43) continue;
        const cleanId = dso.id.trim().toUpperCase().replace(/\s+/g, "");
        if (cleanId === "NGC884" || cleanId === "NGC0884") continue;

        const showcaseKey = selectShowcasePhotoKey(dso);
        const isShowcase = showcaseKey !== null;
        if (!isShowcase) {
          if (dso.messier == null && (dso.mag ?? 99) > dsoTexMaxMag) continue;
        }

        if (
          !projectJ2000RaDec(
            dso.ra_deg,
            dso.dec_deg,
            mJ2000ToEnu,
            mJ2000ToApp,
            skyPCtx,
            panel,
            refractionEnabled,
            scratch,
          )
        ) {
          continue;
        }
        const dx = scratch[0];
        const dy = scratch[1];
        if (canCullHorizon) {
          const dRa = dso.ra_deg * DEG2RAD;
          const dDec = dso.dec_deg * DEG2RAD;
          const cd = Math.cos(dDec);
          const uz = cd * Math.cos(dRa) * m20 + cd * Math.sin(dRa) * m21 + Math.sin(dDec) * m22;
          if (uz < -0.14) continue;
        }

        let northRot = 0;
        let localPxPerDeg = pxPerDeg;
        const stepDeg = dso.dec_deg > 89 ? -0.15 : 0.15;
        if (
          projectJ2000RaDec(
            dso.ra_deg,
            dso.dec_deg + stepDeg,
            mJ2000ToEnu,
            mJ2000ToApp,
            skyPCtx,
            panel,
            refractionEnabled,
            scratch,
          )
        ) {
          const sign = stepDeg > 0 ? 1 : -1;
          const ndx = (scratch[0] - dx) * sign;
          const ndy = (scratch[1] - dy) * sign;
          const northDist = Math.hypot(ndx, ndy);
          if (northDist > 0.05) {
            northRot = Math.atan2(ndy, ndx) + Math.PI * 0.5;
            localPxPerDeg = northDist / Math.abs(stepDeg);
          }
        }

        const majArcmin =
          dso.messier === 45
            ? Math.max(dso.maj_ax_arcmin ?? 110, 110)
            : Math.max(dso.maj_ax_arcmin ?? 12, dso.messier ? 16 : 8);
        const rawAngR = (majArcmin / 120) * localPxPerDeg;
        const angR = isShowcase ? Math.max(rawAngR, 7.5) : rawAngR;
        if (angR < 4.5) continue;

        const texSize = angR * 2.35;
        const halfDraw = texSize * 0.5;
        if (dx < -halfDraw || dx > width + halfDraw || dy < -halfDraw || dy > height + halfDraw) {
          continue;
        }

        const realSprite =
          !isInverted && isShowcase
            ? getRealDsoSkySprite(dso, nightVision, onTextureLoaded)
            : null;
        const fadeStart = realSprite ? maxDim * 3.5 : maxDim * 2.4;
        const fadeEnd = realSprite ? maxDim * 7.5 : maxDim * 5.2;
        const overZoomFade =
          texSize <= fadeStart
            ? 1
            : Math.max(0, 1 - (texSize - fadeStart) / (fadeEnd - fadeStart));
        if (overZoomFade <= 0.01) continue;

        const texKey = selectDsoTextureKey(dso);
        const isEdgeOnSprite = texKey === "M104";
        const paRad = -((dso.pos_ang_deg ?? 25) * DEG2RAD);
        const minRatio =
          dso.maj_ax_arcmin && dso.min_ax_arcmin
            ? Math.max(0.28, Math.min(1, dso.min_ax_arcmin / Math.max(0.1, dso.maj_ax_arcmin)))
            : dso.messier === 31
              ? 0.34
              : dso.messier === 104
                ? 0.38
                : 0.78;
        const fade =
          Math.min(1, (angR - 4.2) / 10) *
          effectivePalette.star_visibility_factor *
          overZoomFade;
        const sprite = realSprite ?? getDsoTextureSprite(texKey, nightVision);

        c.save();
        c.translate(dx, dy);
        if (realSprite) {
          c.rotate(northRot);
        } else {
          c.rotate(northRot + paRad + (isEdgeOnSprite ? Math.PI * 0.5 : 0));
          if (!isEdgeOnSprite) {
            c.scale(minRatio, 1);
          }
        }
        c.globalAlpha = fade * (isInverted ? 0.62 : realSprite ? 0.92 : 0.88);
        c.drawImage(sprite, -texSize * 0.5, -texSize * 0.5, texSize, texSize);
        c.restore();
      }
      c.restore();
    }
    }

    // Stars (Canvas 2D full star pass in "all" mode; only mag < 1.65 spikes in WebGL "foreground" mode)
    if (renderPhase !== "background" && starBuffer && starCount > 0) {
      const vis = frame.sky_palette.star_visibility_factor;
      const effectiveLimit =
        vis < 0.25 ? Math.min(limitingMag, 2.2) : vis < 0.7 ? limitingMag - 1.5 : limitingMag;
      const grid = getOrBuildStarSpatialGrid(starBuffer);
      const data = grid.data;

      const drawBrightStarSpikes = (
        px: number,
        py: number,
        spriteSize: number,
        mag: number,
        ci: number,
        alpha: number,
      ) => {
        const starRgb = bvToRgb(ci, nightVision);
        const spikeScale = mag < 0 ? 1.15 : Math.max(0.45, (1.85 - mag) / 1.85);
        const sLen = spriteSize * (0.72 + spikeScale * 0.58);
        const spikeAlpha = Math.min(1, (0.35 + spikeScale * 0.42) * alpha);
        const coreLen = sLen * 0.45;
        c.strokeStyle = `rgba(${starRgb.r}, ${starRgb.g}, ${starRgb.b}, ${(spikeAlpha * 0.42).toFixed(2)})`;
        c.lineWidth = mag < 0.2 ? 1.35 : 0.95;
        c.beginPath();
        c.moveTo(px - sLen, py);
        c.lineTo(px + sLen, py);
        c.moveTo(px, py - sLen);
        c.lineTo(px, py + sLen);
        c.stroke();

        c.strokeStyle = nightVision
          ? `rgba(255, 160, 160, ${(spikeAlpha * 0.82).toFixed(2)})`
          : `rgba(255, 255, 255, ${(spikeAlpha * 0.85).toFixed(2)})`;
        c.lineWidth = mag < 0.2 ? 1.05 : 0.75;
        c.beginPath();
        c.moveTo(px - coreLen, py);
        c.lineTo(px + coreLen, py);
        c.moveTo(px, py - coreLen);
        c.lineTo(px, py + coreLen);
        c.stroke();

        if (mag < 0.5) {
          const dLen = sLen * 0.48;
          c.strokeStyle = `rgba(${starRgb.r}, ${starRgb.g}, ${starRgb.b}, ${(spikeAlpha * 0.36).toFixed(2)})`;
          c.lineWidth = 0.7;
          c.beginPath();
          c.moveTo(px - dLen, py - dLen);
          c.lineTo(px + dLen, py + dLen);
          c.moveTo(px - dLen, py + dLen);
          c.lineTo(px + dLen, py - dLen);
          c.stroke();
        }
      };

      if (renderPhase === "foreground") {
        if (!isInverted) {
          const spikeCeiling = Math.min(effectiveLimit, 1.65);
          for (const cell of grid.cells) {
            if (!isSpatialCellVisible(cell, spikeCeiling, canCullHorizon, m20, m21, m22, cullCone)) {
              continue;
            }
            for (let idx = cell.start; idx < cell.end; idx++) {
              const off = idx * STAR_STRIDE;
              const mag = data[off + 3];
              if (mag >= 1.65 || mag > effectiveLimit) break;
              if (
                !projectJ2000UnitVec(
                  data[off],
                  data[off + 1],
                  data[off + 2],
                  mJ2000ToEnu,
                  mJ2000ToApp,
                  skyPCtx,
                  panel,
                  isChart,
                  refractionEnabled,
                  canCullHorizon,
                  scratch,
                )
              ) {
                continue;
              }
              const ci = data[off + 4];
              const alpha = Math.min(
                1,
                Math.max(0.18, (1.15 - (mag + 1.5) / (limitingMag + 2.5)) * Math.max(0.25, vis)),
              );
              const spriteSize = Math.max(8, Math.min(30, (4.2 - mag) * 4.6));
              drawBrightStarSpikes(scratch[0], scratch[1], spriteSize, mag, ci, alpha);
            }
          }
        }
      } else {
        const spriteImg = nightVision ? atlas.nightVision : atlas.normal;
        const cellPx = atlas.cellSize;
        let lastFillStyle = "";

        for (const cell of grid.cells) {
          if (!isSpatialCellVisible(cell, effectiveLimit, canCullHorizon, m20, m21, m22, cullCone)) {
            continue;
          }
          for (let idx = cell.start; idx < cell.end; idx++) {
            const off = idx * STAR_STRIDE;
            const mag = data[off + 3];
            if (mag > effectiveLimit) break;

            if (
              !projectJ2000UnitVec(
                data[off],
                data[off + 1],
                data[off + 2],
                mJ2000ToEnu,
                mJ2000ToApp,
                skyPCtx,
                panel,
                isChart,
                refractionEnabled,
                canCullHorizon,
                scratch,
              )
            ) {
              continue;
            }

            const px = scratch[0];
            const py = scratch[1];
            const ci = data[off + 4];
            const alpha = Math.min(
              1,
              Math.max(0.18, (1.15 - (mag + 1.5) / (limitingMag + 2.5)) * Math.max(0.25, vis)),
            );

            if (isInverted) {
              const r = Math.max(0.75, Math.min(4.8, 3.6 - mag * 0.48));
              if (lastFillStyle !== "#020617") {
                c.fillStyle = "#020617";
                lastFillStyle = "#020617";
              }
              c.beginPath();
              c.arc(px, py, r, 0, Math.PI * 2);
              c.fill();
            } else if (mag <= 2.4) {
              const spriteSize = Math.max(8, Math.min(30, (4.2 - mag) * 4.6));
              const bucket = bvToSpriteBucket(ci);
              c.globalAlpha = alpha;
              c.drawImage(
                spriteImg,
                bucket * cellPx,
                0,
                cellPx,
                cellPx,
                px - spriteSize * 0.5,
                py - spriteSize * 0.5,
                spriteSize,
                spriteSize,
              );
              if (mag < 1.65) {
                drawBrightStarSpikes(px, py, spriteSize, mag, ci, alpha);
              }
              c.globalAlpha = 1;
            } else {
              const r = Math.max(0.65, Math.min(2.6, 2.75 - mag * 0.28));
              const style = getFaintStarCss(ci, alpha, nightVision);
              if (style !== lastFillStyle) {
                c.fillStyle = style;
                lastFillStyle = style;
              }
              if (r <= 1.2) {
                c.fillRect(px - r * 0.5, py - r * 0.5, r * 1.35, r * 1.35);
              } else {
                c.beginPath();
                c.arc(px, py, r, 0, Math.PI * 2);
                c.fill();
              }
            }
          }
        }
      }
    }

    // DSO markers (spherical spatial culling over binary 13k+ DSOs, or staticAssets fallback)
    if (
      (renderPhase === "all" || (renderPhase === "foreground" && includeDsoMarkersInForeground)) &&
      layers.dsoMarkers &&
      !isOtherStar &&
      effectivePalette.star_visibility_factor > 0.25
    ) {
      c.save();
      if (layers.zoomTextures && effFov < 30) {
        c.globalAlpha = 0.42;
      }
      const dsoMagMax = Math.min(12.8, limitingMag + 3.6);
      if (dsoBuffer && dsoCount > 0) {
        const dsoColor = nightVision ? "rgba(220, 50, 50, 0.85)" : hexToRgba(effColors.dso, 0.85);
        const dsoGrid = getOrBuildDsoSpatialGrid(dsoBuffer);
        const dsoData = dsoGrid.data;
        for (const cell of dsoGrid.cells) {
          if (!isSpatialCellVisible(cell, dsoMagMax, canCullHorizon, m20, m21, m22, cullCone)) {
            continue;
          }
          for (let idx = cell.start; idx < cell.end; idx++) {
            const off = idx * DSO_STRIDE;
            const mag = dsoData[off + 3];
            const majArcmin = dsoData[off + 4];
            const axisRatio = dsoData[off + 5];
            const posAngDeg = dsoData[off + 6];
            const kindCode = dsoData[off + 7];
            const messierNum = dsoData[off + 8];
            if (messierNum === 0 && mag > dsoMagMax) break;
            if (
              !projectJ2000UnitVec(
                dsoData[off],
                dsoData[off + 1],
                dsoData[off + 2],
                mJ2000ToEnu,
                mJ2000ToApp,
                skyPCtx,
                panel,
                isChart,
                refractionEnabled,
                canCullHorizon,
                scratch,
              )
            ) {
              continue;
            }
            drawDsoKindSymbol(
              c,
              kindCode,
              majArcmin,
              axisRatio,
              posAngDeg,
              scratch[0],
              scratch[1],
              pxPerDeg,
              dsoColor,
            );
          }
        }
      } else if (staticAssets) {
        for (const dso of staticAssets.dsos) {
          if (dso.messier == null && (dso.mag ?? 99) > dsoMagMax) continue;
          if (!projectJ2000RaDec(dso.ra_deg, dso.dec_deg, mJ2000ToEnu, mJ2000ToApp, skyPCtx, panel, refractionEnabled, scratch)) {
            continue;
          }
          if (scratch[2] < 0.5) continue;
          drawDsoMarker(c, dso, scratch[0], scratch[1], pxPerDeg, effColors.dso, nightVision);
        }
      }
      c.restore();
    }

    if (renderPhase === "background") {
      c.restore();
      continue;
    }

    // Object Trails Overlay (planetary retrograde / diurnal / seasonal sunrise-sunset analemma)
    const trailList = Object.values(trails);
    if (trailList.length > 0 && !isOtherStar) {
      const useHorizonTrail =
        simLockMode === "sunrise" ||
        simLockMode === "sunset" ||
        (Math.abs(simStepMinutes) < 1440 && simLockMode !== "constellation");
      const jumpTrail = Math.min(width, height) * 0.42;

      for (const trail of trailList) {
        if (trail.points.length < 2) continue;
        const tCol = nightVision ? "rgba(239, 68, 68, 0.78)" : trail.color;
        c.save();
        c.strokeStyle = tCol;
        c.lineWidth = 1.6;
        c.beginPath();
        let pen = false;
        let px = 0;
        let py = 0;
        let lastPt: { x: number; y: number } | null = null;
        for (const tp of trail.points) {
          const p =
            useHorizonTrail && params.mode !== "star_chart"
              ? projectHorToScreen(tp.az_deg, tp.alt_deg, skyPCtx, panel)
              : projectEqToScreen(tp.ra_deg, tp.dec_deg, location.lat_deg, frame.last_deg, skyPCtx, panel);
          if (!p || p.panel !== panel) {
            pen = false;
            continue;
          }
          if (!pen || Math.hypot(p.x - px, p.y - py) > jumpTrail) {
            c.moveTo(p.x, p.y);
            pen = true;
          } else {
            c.lineTo(p.x, p.y);
          }
          px = p.x;
          py = p.y;
          if (p.visible) lastPt = { x: p.x, y: p.y };
        }
        c.stroke();

        // Trail sample dots
        c.fillStyle = tCol;
        const stepDot = Math.max(1, Math.floor(trail.points.length / 40));
        for (let idx = 0; idx < trail.points.length; idx += stepDot) {
          const tp = trail.points[idx];
          const p =
            useHorizonTrail && params.mode !== "star_chart"
              ? projectHorToScreen(tp.az_deg, tp.alt_deg, skyPCtx, panel)
              : projectEqToScreen(tp.ra_deg, tp.dec_deg, location.lat_deg, frame.last_deg, skyPCtx, panel);
          if (p && p.visible && p.panel === panel) {
            c.beginPath();
            c.arc(p.x, p.y, 2.0, 0, Math.PI * 2);
            c.fill();
          }
        }
        if (lastPt) {
          labels.tryPlace(
            c,
            `${trail.label} 軌跡`,
            lastPt.x + 8,
            lastPt.y - 8,
            tCol,
            '10px "Noto Sans JP", system-ui, sans-serif',
          );
        }
        c.restore();
      }
    }

    // Solar System Bodies (reverse draw order so Moon & Sun render on top; suppressed in other_star)
    const sun = frame.bodies[0];
    const bodyScreenPositions: { body: SolarSystemBodyRender; x: number; y: number; r: number; belowHorizon: boolean }[] = [];
    if (!isOtherStar) {
      for (let i = frame.bodies.length - 1; i >= 0; i--) {
        const b = frame.bodies[i];
        const belowHorizon = b.alt_deg < -0.5;
        if (!params.show_below_horizon && !showOppositeGroundSky && belowHorizon) continue;
        if (b.id !== "sun" && b.id !== "moon" && frame.sky_palette.star_visibility_factor < 0.12 && b.visual_magnitude > -2.5) {
          continue;
        }
        const pt =
          params.mode === "star_chart"
            ? projectEqToScreen(b.ra_deg, b.dec_deg, location.lat_deg, frame.last_deg, skyPCtx, panel)
            : projectHorToScreen(b.az_deg, b.alt_deg, skyPCtx, panel);
        if (!pt || !pt.visible || pt.panel !== panel) continue;
        const r =
          b.id === "moon"
            ? drawMoonPhase(
                c,
                b,
                sun,
                pt.x,
                pt.y,
                skyPCtx,
                panel,
                nightVision,
                mJ2000ToEnu,
                mJ2000ToApp,
                refractionEnabled,
                scratch,
                layers.zoomTextures,
                layers.lunarLabels,
                isInverted,
                onTextureLoaded,
              )
            : b.kind === "comet"
              ? drawComet(c, b, sun, pt.x, pt.y, location.lat_deg, frame.last_deg, skyPCtx, panel, nightVision)
              : drawPlanetOrSun(
                  c,
                  b,
                  sun,
                  pt.x,
                  pt.y,
                  skyPCtx,
                  panel,
                  nightVision,
                  pxPerDeg,
                  effFov,
                  layers.zoomTextures,
                  onTextureLoaded,
                );
        bodyScreenPositions.push({ body: b, x: pt.x, y: pt.y, r, belowHorizon: belowHorizon && !params.show_below_horizon });
      }
    }

    // Live Shooting Stars & Fireball Persistent Trains (drawn behind horizon terrain & panoramas)
    if (!skipMeteors && meteorParticles.length > 0 && !isOtherStar) {
      drawMeteorParticlesOnPanel(
        c,
        width,
        height,
        skyPCtx,
        panel,
        mJ2000ToEnu,
        mJ2000ToApp,
        refractionEnabled,
        nightVision,
        meteorParticles,
        scratch,
        false,
      );
    }

    // Highlight our Sun (Sol) when viewing from another star system
    if (isOtherStar && frame.sol_from_other_star) {
      const sol = frame.sol_from_other_star;
      if (projectJ2000RaDec(sol.ra_deg, sol.dec_deg, mJ2000ToEnu, mJ2000ToApp, skyPCtx, panel, false, scratch) && scratch[2] > 0.5) {
        const solCol = nightVision ? "#f87171" : "#fbbf24";
        c.save();
        c.strokeStyle = solCol;
        c.lineWidth = 1.6;
        c.beginPath();
        c.arc(scratch[0], scratch[1], 11, 0, Math.PI * 2);
        c.stroke();
        c.restore();
        labels.tryPlace(
          c,
          `太陽 (Sol · ${sol.mag.toFixed(1)}等 · ${sol.dist_ly.toFixed(1)}光年)`,
          scratch[0] + 14,
          scratch[1],
          solCol,
          '600 11px "Noto Sans JP", system-ui, sans-serif',
        );
      }
    }

    // Live Weather Cloud & Atmospheric Haze Overlay (driven by Open-Meteo hourly forecast)
    if (showWeatherCloudsOverlay && liveWeather && !isInverted && !isOtherStar) {
      drawWeatherCloudOverlay(c, width, height, pCtx, panel, frame, liveWeather, nightVision);
    }

    // 360° Horizon Panorama Landscape (built-in presets or Gcam Photo Sphere) + Horizon Line & Cardinals
    const drewPano = renderPanoramaLandscape(
      c,
      pCtx,
      panel,
      frame,
      landscapeConfig,
      nightVision,
      isInverted,
      fastInteractive,
    );
    drawHorizonCurve(
      c,
      pCtx,
      panel,
      effectivePalette,
      params.show_below_horizon,
      labels,
      layers.horizonAndCardinals,
      nightVision,
      isInverted,
      drewPano,
    );

    // Artificial Satellites & Highlighted Pass Arc (Phase 8)
    if (showSatellites && !isOtherStar) {
      if (highlightedSatPass && highlightedSatPass.track.length >= 2) {
        const arcCol = nightVision
          ? "rgba(239, 68, 68, 0.85)"
          : isInverted
            ? "#0369a1"
            : "#22d3ee";
        c.save();
        c.strokeStyle = arcCol;
        c.lineWidth = 1.6;
        c.setLineDash([5, 4]);
        c.beginPath();
        let pen = false;
        let lastPt: { x: number; y: number } | null = null;
        for (const tp of highlightedSatPass.track) {
          const pt = projectHorToScreen(tp.az_deg, tp.alt_deg, pCtx, panel);
          if (!pt || pt.panel !== panel) {
            pen = false;
            continue;
          }
          if (!pen) {
            c.moveTo(pt.x, pt.y);
            pen = true;
          } else {
            c.lineTo(pt.x, pt.y);
          }
          lastPt = pt;
        }
        c.stroke();
        c.setLineDash([]);
        for (const tp of highlightedSatPass.track) {
          const pt = projectHorToScreen(tp.az_deg, tp.alt_deg, pCtx, panel);
          if (!pt || pt.panel !== panel) continue;
          c.fillStyle = tp.is_sunlit ? arcCol : "#94a3b8";
          c.beginPath();
          c.arc(pt.x, pt.y, 2.2, 0, Math.PI * 2);
          c.fill();
        }
        if (lastPt) {
          labels.tryPlace(
            c,
            `${highlightedSatPass.sat_name} (${highlightedSatPass.max_alt_deg.toFixed(0)}°)`,
            lastPt.x + 6,
            lastPt.y - 6,
            arcCol,
            '600 10.5px "Noto Sans JP", system-ui, sans-serif',
          );
        }
        c.restore();
      }

      for (const sat of satellites) {
        if (!sat.enabled) continue;
        if (!params.show_below_horizon && sat.alt_deg < -0.5) continue;
        const pt =
          params.mode === "star_chart"
            ? projectEqToScreen(sat.ra_deg, sat.dec_deg, location.lat_deg, frame.last_deg, pCtx, panel)
            : projectHorToScreen(sat.az_deg, sat.alt_deg, pCtx, panel);
        if (!pt || !pt.visible || pt.panel !== panel) continue;

        const satCol = nightVision
          ? "#ef4444"
          : isInverted
            ? "#0369a1"
            : sat.is_visible
              ? "#fbbf24"
              : sat.is_sunlit
                ? "#22d3ee"
                : "#94a3b8";
        c.save();
        c.strokeStyle = satCol;
        c.fillStyle = satCol;
        c.lineWidth = 1.4;
        // Solar-wing satellite diamond glyph
        c.beginPath();
        c.moveTo(pt.x - 7, pt.y);
        c.lineTo(pt.x - 2, pt.y);
        c.moveTo(pt.x + 2, pt.y);
        c.lineTo(pt.x + 7, pt.y);
        c.stroke();
        c.beginPath();
        c.arc(pt.x, pt.y, 2.6, 0, Math.PI * 2);
        c.fill();
        c.restore();

        labels.tryPlace(
          c,
          sat.name,
          pt.x + 8,
          pt.y - 4,
          satCol,
          '600 10.5px "Noto Sans JP", system-ui, sans-serif',
        );
      }
    }

    // Zenith marker
    if (layers.zenithMark) {
      const zp = projectHorToScreen(params.center_az_deg, 90, pCtx, panel);
      if (zp && zp.visible) {
        c.strokeStyle = nightVision ? "rgba(239, 68, 68, 0.75)" : "rgba(56, 189, 248, 0.75)";
        c.lineWidth = 1.1;
        c.beginPath();
        c.moveTo(zp.x - 6, zp.y);
        c.lineTo(zp.x + 6, zp.y);
        c.moveTo(zp.x, zp.y - 6);
        c.lineTo(zp.x, zp.y + 6);
        c.stroke();
        labels.tryPlace(
          c,
          "天頂",
          zp.x + 9,
          zp.y - 4,
          nightVision ? "rgba(239, 68, 68, 0.85)" : "rgba(56, 189, 248, 0.85)",
          '10px "Noto Sans JP", system-ui, sans-serif',
        );
      }
    }

    // Priority-ordered collision-free labels:
    // Planets / Sun / Moon / Comets
    if (layers.planetNames) {
      const col = nightVision ? "#f87171" : isInverted ? "#0f172a" : "#fef08a";
      const cometCol = nightVision ? "#fca5a5" : isInverted ? "#047857" : "#6ee7b7";
      for (const item of bodyScreenPositions) {
        if (item.belowHorizon) {
          c.save();
          c.globalAlpha = 0.42;
        }
        labels.tryPlace(
          c,
          item.body.name_ja,
          item.x + item.r + 5,
          item.y,
          item.body.kind === "comet" ? cometCol : col,
          '600 12px "Noto Sans JP", system-ui, sans-serif',
        );
        if (item.belowHorizon) {
          c.restore();
        }
      }
    }

    // Bright Named Stars (static catalog stars aren't 1:1 in 3D other_star mode)
    if (layers.starNames && staticAssets && !isOtherStar && !isProperMotion && effectivePalette.star_visibility_factor > 0.2) {
      const labelMagMax = Math.min(limitingMag - 0.5, effFov < 25 ? 4.8 : effFov < 55 ? 3.2 : 2.1);
      const col = nightVision ? "rgba(248, 113, 113, 0.9)" : isInverted ? "#1e293b" : "rgba(226, 232, 240, 0.9)";
      for (const s of staticAssets.named_stars) {
        if (s.mag > labelMagMax) break;
        const text = s.name_ja || s.proper_name || (effFov < 35 && s.bayer ? `${s.bayer} ${s.con}` : "");
        if (!text) continue;
        if (!projectJ2000RaDec(s.ra_deg, s.dec_deg, mJ2000ToEnu, mJ2000ToApp, pCtx, panel, refractionEnabled, scratch)) {
          continue;
        }
        if (scratch[2] < 0.5) continue;
        labels.tryPlace(c, text, scratch[0] + 6, scratch[1] - 4, col, '11px "Noto Sans JP", system-ui, sans-serif');
      }
    }

    // Asterisms labels
    if (layers.asterisms && staticAssets && !isOtherStar && effectivePalette.star_visibility_factor > 0.2) {
      const col = nightVision ? "rgba(239, 68, 68, 0.85)" : hexToRgba(effColors.asterisms, 0.92);
      for (const ast of staticAssets.asterisms) {
        if (ast.priority > 2 && effFov > 75) continue;
        let raSum = 0;
        let decSum = 0;
        let n = 0;
        let raRef: number | null = null;
        for (const seg of ast.lines) {
          for (const [ra, dec] of seg) {
            if (raRef === null) raRef = ra;
            let r = ra;
            if (r - raRef > 180) r -= 360;
            if (raRef - r > 180) r += 360;
            raSum += r;
            decSum += dec;
            n++;
          }
        }
        if (n === 0) continue;
        if (projectJ2000RaDec(wrapDeg360(raSum / n), decSum / n, mJ2000ToEnu, mJ2000ToApp, pCtx, panel, refractionEnabled, scratch) && scratch[2] > 0.5) {
          labels.tryPlace(c, ast.name_ja, scratch[0], scratch[1], col, '600 11px "Noto Sans JP", system-ui, sans-serif', "center");
        }
      }
    }

    // Constellation names (sorted by rank 1 -> 3)
    if (layers.constellationNames && staticAssets && !isOtherStar && effectivePalette.star_visibility_factor > 0.15) {
      const col = nightVision ? "rgba(220, 38, 38, 0.82)" : hexToRgba(effColors.constellationNames, 0.88);
      for (const con of staticAssets.constellations) {
        if (!projectJ2000RaDec(con.center_ra_deg, con.center_dec_deg, mJ2000ToEnu, mJ2000ToApp, pCtx, panel, false, scratch)) {
          continue;
        }
        if (scratch[2] < 0.5) continue;
        labels.tryPlace(c, con.name_ja, scratch[0], scratch[1], col, '500 11px "Noto Sans JP", system-ui, sans-serif', "center");
      }
    }

    // DSO names (Messier first)
    if (layers.dsoNames && layers.dsoMarkers && staticAssets && !isOtherStar && effectivePalette.star_visibility_factor > 0.25) {
      const col = nightVision ? "rgba(220, 60, 60, 0.85)" : hexToRgba(effColors.dso, 0.9);
      const labelDsos =
        effFov > 25 ? getDsoTextureBuckets(staticAssets.dsos).messierOnly : staticAssets.dsos;
      for (const dso of labelDsos) {
        if (!projectJ2000RaDec(dso.ra_deg, dso.dec_deg, mJ2000ToEnu, mJ2000ToApp, pCtx, panel, refractionEnabled, scratch)) {
          continue;
        }
        if (scratch[2] < 0.5) continue;
        const text = dso.messier ? `M${dso.messier}` : dso.id;
        labels.tryPlace(c, text, scratch[0] + 8, scratch[1], col, '10px "Noto Sans JP", system-ui, sans-serif');
      }
    }

    // Meteor Shower Radiant Markers & Great-Circle Shooting Star Animation
    if (
      !isOtherStar &&
      staticAssets?.meteor_showers &&
      (layers.meteorRadiants || meteorShowAllRadiants || selectedMeteorShowerCode)
    ) {
      const radiantsToDraw = meteorShowAllRadiants
        ? staticAssets.meteor_showers
        : staticAssets.meteor_showers.filter(
            (m) => m.code === selectedMeteorShowerCode || (!selectedMeteorShowerCode && layers.meteorRadiants),
          );
      for (const sh of radiantsToDraw) {
        if (!projectJ2000RaDec(sh.ra_deg, sh.dec_deg, mJ2000ToEnu, mJ2000ToApp, pCtx, panel, false, scratch)) {
          continue;
        }
        if (scratch[2] < 0.5) continue;
        const rx = scratch[0];
        const ry = scratch[1];
        const isSel = sh.code === selectedMeteorShowerCode;
        const rCol = nightVision
          ? isSel
            ? "rgba(248, 113, 113, 0.95)"
            : "rgba(220, 38, 38, 0.65)"
          : isSel
            ? "rgba(56, 189, 248, 0.95)"
            : "rgba(125, 211, 252, 0.72)";
        c.save();
        c.strokeStyle = rCol;
        c.lineWidth = isSel ? 1.5 : 1.0;
        c.setLineDash([3, 3]);
        c.beginPath();
        c.arc(rx, ry, isSel ? 12 : 8, 0, Math.PI * 2);
        c.stroke();
        c.setLineDash([]);
        for (let k = 0; k < 6; k++) {
          const ang = (k * Math.PI) / 3;
          const rIn = isSel ? 5 : 3;
          const rOut = isSel ? 19 : 13;
          c.beginPath();
          c.moveTo(rx + Math.cos(ang) * rIn, ry + Math.sin(ang) * rIn);
          c.lineTo(rx + Math.cos(ang) * rOut, ry + Math.sin(ang) * rOut);
          c.stroke();
        }
        c.restore();
        labels.tryPlace(
          c,
          `✦ ${sh.name_ja} 放射点`,
          rx + 14,
          ry - 6,
          rCol,
          '600 10px "Noto Sans JP", system-ui, sans-serif',
        );
      }
    }

    // Planetary Path Overlay (Phase 5: custom period planetary tracks + retrograde highlights + inner planet shapes)
    const pTrackList = Object.values(planetTracks);
    if (pTrackList.length > 0 && !isOtherStar) {
      const jumpLimTrack = Math.min(width, height) * 0.42;
      for (const track of pTrackList) {
        if (track.points.length < 2) continue;
        const baseCol = nightVision ? "rgba(239, 68, 68, 0.85)" : track.color;
        c.save();
        c.strokeStyle = baseCol;
        c.lineWidth = 1.9;
        c.beginPath();
        let pen = false;
        let px = 0;
        let py = 0;
        let lastVisible: { x: number; y: number } | null = null;
        for (const pt of track.points) {
          const proj = projectEqToScreen(
            pt.ra_deg,
            pt.dec_deg,
            location.lat_deg,
            frame.last_deg,
            pCtx,
            panel,
          );
          if (!proj || proj.panel !== panel || (!params.show_below_horizon && pt.alt_deg < -1.0)) {
            pen = false;
            continue;
          }
          if (!pen || Math.hypot(proj.x - px, proj.y - py) > jumpLimTrack) {
            c.moveTo(proj.x, proj.y);
            pen = true;
          } else {
            c.lineTo(proj.x, proj.y);
          }
          px = proj.x;
          py = proj.y;
          if (proj.visible) lastVisible = { x: proj.x, y: proj.y };
        }
        c.stroke();

        // Highlight retrograde segments + sample markers/date labels
        const labelStep = Math.max(1, Math.floor(track.points.length / 8));
        for (let idx = 0; idx < track.points.length; idx++) {
          const pt = track.points[idx];
          if (!params.show_below_horizon && pt.alt_deg < -1.0) continue;
          const proj = projectEqToScreen(
            pt.ra_deg,
            pt.dec_deg,
            location.lat_deg,
            frame.last_deg,
            pCtx,
            panel,
          );
          if (!proj || !proj.visible || proj.panel !== panel) continue;

          if (pt.is_retrograde) {
            c.fillStyle = nightVision ? "#fca5a5" : "#fb7185";
            c.beginPath();
            c.arc(proj.x, proj.y, 2.2, 0, Math.PI * 2);
            c.fill();
          }

          if (idx % labelStep === 0 || idx === track.points.length - 1) {
            if (track.showInnerShapes) {
              const pr = 5.0;
              const k = Math.max(0.03, Math.min(0.97, pt.illuminated_fraction));
              c.fillStyle = "#1e293b";
              c.beginPath();
              c.arc(proj.x, proj.y, pr, 0, Math.PI * 2);
              c.fill();
              c.fillStyle = nightVision ? "#fca5a5" : "#fef08a";
              // Lit semicircle on waxing (right) or waning (left) side
              c.beginPath();
              if (pt.waxing) {
                c.arc(proj.x, proj.y, pr, -Math.PI * 0.5, Math.PI * 0.5, false);
              } else {
                c.arc(proj.x, proj.y, pr, Math.PI * 0.5, Math.PI * 1.5, false);
              }
              c.fill();
              // Terminator half-ellipse: adds bright bulge when gibbous, carves dark bulge when crescent
              const rx = Math.abs(2 * k - 1) * pr;
              c.fillStyle =
                k >= 0.5 ? (nightVision ? "#fca5a5" : "#fef08a") : "#1e293b";
              c.beginPath();
              if (pt.waxing) {
                const startA = k >= 0.5 ? Math.PI * 0.5 : -Math.PI * 0.5;
                c.ellipse(proj.x, proj.y, Math.max(0.2, rx), pr, 0, startA, startA + Math.PI, false);
              } else {
                const startA = k >= 0.5 ? -Math.PI * 0.5 : Math.PI * 0.5;
                c.ellipse(proj.x, proj.y, Math.max(0.2, rx), pr, 0, startA, startA + Math.PI, false);
              }
              c.fill();
            } else {
              c.fillStyle = baseCol;
              c.beginPath();
              c.arc(proj.x, proj.y, 2.8, 0, Math.PI * 2);
              c.fill();
            }
            labels.tryPlace(
              c,
              pt.date_label,
              proj.x + 6,
              proj.y - 5,
              baseCol,
              '9.5px "Noto Sans JP", system-ui, sans-serif',
            );
          }
        }
        if (lastVisible) {
          labels.tryPlace(
            c,
            `${track.name_ja} 経路`,
            lastVisible.x + 10,
            lastVisible.y + 8,
            baseCol,
            '600 10.5px "Noto Sans JP", system-ui, sans-serif',
          );
        }
        c.restore();
      }
    }

    // Selection reticle
    if (selectedObject) {
      const sp =
        params.mode === "star_chart"
          ? projectEqToScreen(selectedObject.ra_deg, selectedObject.dec_deg, location.lat_deg, frame.last_deg, pCtx)
          : projectHorToScreen(selectedObject.az_deg, selectedObject.alt_deg, pCtx, panel);
      if (sp && sp.visible && sp.panel === panel) {
        c.strokeStyle = nightVision ? "#ef4444" : "#38bdf8";
        c.lineWidth = 1.5;
        c.beginPath();
        c.arc(sp.x, sp.y, 13, 0, Math.PI * 2);
        c.moveTo(sp.x - 19, sp.y);
        c.lineTo(sp.x - 9, sp.y);
        c.moveTo(sp.x + 9, sp.y);
        c.lineTo(sp.x + 19, sp.y);
        c.moveTo(sp.x, sp.y - 19);
        c.lineTo(sp.x, sp.y - 9);
        c.moveTo(sp.x, sp.y + 9);
        c.lineTo(sp.x, sp.y + 19);
        c.stroke();
      }
    }

    c.restore();
  }

  // Dome bezel / circular framing, cardinals & FOV overlays belong on foreground/all passes
  if (renderPhase !== "background") {
    c.save();
    const bezelCol = nightVision ? "rgba(185, 28, 28, 0.55)" : "rgba(148, 163, 184, 0.45)";
    const dirCol = nightVision ? "rgba(239, 68, 68, 0.92)" : "rgba(251, 191, 36, 0.92)";
    c.strokeStyle = bezelCol;
    c.lineWidth = 1.5;

    if (params.mode === "all_sky") {
      c.beginPath();
      c.arc(pCtx.cx, pCtx.cy, pCtx.allSkyRadius, 0, Math.PI * 2);
      c.stroke();
      if (layers.horizonAndCardinals) {
        const dirs: [number, string][] = [
          [0, "北 N"], [45, "北東"], [90, "東 E"], [135, "南東"],
          [180, "南 S"], [225, "南西"], [270, "西 W"], [315, "北西"],
        ];
        c.font = '600 12px "Noto Sans JP", system-ui, sans-serif';
        c.fillStyle = dirCol;
        c.textAlign = "center";
        c.textBaseline = "middle";
        for (const [az, label] of dirs) {
          const dAz = (az - params.center_az_deg) * DEG2RAD;
          const lx = pCtx.cx + (pCtx.allSkyRadius + 16) * Math.sin(dAz);
          const ly = pCtx.cy + (pCtx.allSkyRadius + 16) * Math.cos(dAz);
          c.fillText(label, lx, ly);
        }
      }
    } else if (params.mode === "hemisphere_single" || params.mode === "hemisphere_dual") {
      const drawDomeBezel = (hcx: number, hcy: number, hr: number, azFace: number) => {
        c.beginPath();
        if (params.show_below_horizon) {
          c.arc(hcx, hcy, hr, 0, Math.PI * 2);
        } else {
          c.arc(hcx, hcy, hr, Math.PI, 0, false);
          c.closePath();
        }
        c.stroke();
        if (layers.horizonAndCardinals) {
          c.font = '600 11px "Noto Sans JP", system-ui, sans-serif';
          c.fillStyle = dirCol;
          c.textAlign = "center";
          c.textBaseline = "top";
          c.fillText(`正面 ${azName(azFace)} (${Math.round(azFace)}°)`, hcx, hcy + 10);
          c.fillText(azName(wrapDeg360(azFace - 90)), hcx - hr, hcy + 10);
          c.fillText(azName(wrapDeg360(azFace + 90)), hcx + hr, hcy + 10);
        }
      };

      drawDomeBezel(pCtx.hemCx0, pCtx.hemCy0, pCtx.hemRadius0, params.center_az_deg);
      if (params.mode === "hemisphere_dual") {
        drawDomeBezel(pCtx.hemCx1, pCtx.hemCy1, pCtx.hemRadius1, wrapDeg360(params.center_az_deg + 180));
      }
    }
    c.restore();

    // FOV Frames Overlay (Camera Sensor + FL, Telescope + Eyepiece, Binoculars, Telrad)
    if (fovPresets.length > 0) {
      drawFovOverlays(c, fovPresets, pxPerDeg, width, height, nightVision, isInverted);
    }

    // Optional Grayscale conversion for ink-saving prints
    if (printColorMode === "grayscale") {
      try {
        const img = c.getImageData(0, 0, Math.round(width), Math.round(height));
        const d = img.data;
        for (let i = 0; i < d.length; i += 4) {
          const lum = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
          d[i] = lum;
          d[i + 1] = lum;
          d[i + 2] = lum;
        }
        c.putImageData(img, 0, 0);
      } catch {
        // Ignore if canvas dimensions exceed readback limits
      }
    }
  }
}

function azName(az: number): string {
  const dirs = ["北", "北東", "東", "南東", "南", "南西", "西", "北西"];
  return dirs[Math.round(wrapDeg360(az) / 45) % 8];
}
