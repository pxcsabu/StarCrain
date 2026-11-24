import type { MilkyWayLevel } from "@/types/sky";

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

// IAU 1958 J2000 Equatorial -> Galactic rotation matrix (ESA Hipparcos Vol. 1 Sec 1.5.3)
const G00 = -0.0548755604;
const G01 = -0.8734370902;
const G02 = -0.4838350155;
const G10 = +0.4941094279;
const G11 = -0.4448296300;
const G12 = +0.7469822445;
const G20 = -0.8676661490;
const G21 = -0.1980763734;
const G22 = +0.4559837762;

interface GalacticRing {
  points: Float32Array; // interleaved [lDeg, bDeg, ...]
  minB: number;
  maxB: number;
  wrapsLon: boolean;
  centerL: number;
  halfSpanL: number;
}

const milkyWayCache = new WeakMap<MilkyWayLevel[], Float32Array>();

function wrapDeg180(deg: number): number {
  let d = ((deg % 360) + 360) % 360;
  if (d >= 180) d -= 360;
  return d;
}

export function j2000RaDecToGalactic(raDeg: number, decDeg: number): [number, number] {
  const ra = raDeg * DEG2RAD;
  const dec = decDeg * DEG2RAD;
  const cd = Math.cos(dec);
  const x = cd * Math.cos(ra);
  const y = cd * Math.sin(ra);
  const z = Math.sin(dec);

  const gx = G00 * x + G01 * y + G02 * z;
  const gy = G10 * x + G11 * y + G12 * z;
  const gz = G20 * x + G21 * y + G22 * z;

  let l = Math.atan2(gy, gx) * RAD2DEG;
  if (l < 0) l += 360;
  const b = Math.asin(Math.max(-1, Math.min(1, gz))) * RAD2DEG;
  return [l, b];
}

export function galacticDegToJ2000Vec(lDeg: number, bDeg: number): [number, number, number] {
  const l = lDeg * DEG2RAD;
  const b = bDeg * DEG2RAD;
  const cb = Math.cos(b);
  const gx = cb * Math.cos(l);
  const gy = cb * Math.sin(l);
  const gz = Math.sin(b);

  // Inverse = transpose of orthonormal matrix
  return [
    G00 * gx + G10 * gy + G20 * gz,
    G01 * gx + G11 * gy + G21 * gz,
    G02 * gx + G12 * gy + G22 * gz,
  ];
}

function buildGalacticLevelRings(level: MilkyWayLevel): GalacticRing[] {
  const out: GalacticRing[] = [];
  for (const poly of level.polygons) {
    for (const ring of poly) {
      if (ring.length < 3) continue;
      // Subsample dense contours (> 400 vertices) slightly for fast point-in-polygon tests
      const step = ring.length > 900 ? 3 : ring.length > 350 ? 2 : 1;
      const pts: number[] = [];
      let minB = 90;
      let maxB = -90;
      let hasFirst = false;
      let prevL = 0;
      let uL = 0;
      let minU = 0;
      let maxU = 0;
      for (let i = 0; i < ring.length; i += step) {
        const [l, b] = j2000RaDecToGalactic(ring[i][0], ring[i][1]);
        pts.push(l, b);
        if (b < minB) minB = b;
        if (b > maxB) maxB = b;
        if (!hasFirst) {
          hasFirst = true;
          uL = l;
          minU = l;
          maxU = l;
        } else {
          uL += wrapDeg180(l - prevL);
          if (uL < minU) minU = uL;
          if (uL > maxU) maxU = uL;
        }
        prevL = l;
      }
      if (pts.length >= 6) {
        const spanL = maxU - minU;
        const wrapsLon = spanL >= 175;
        const centerL = (((minU + maxU) * 0.5) % 360 + 360) % 360;
        const halfSpanL = spanL * 0.5 + 0.5;
        out.push({
          points: new Float32Array(pts),
          minB,
          maxB,
          wrapsLon,
          centerL,
          halfSpanL,
        });
      }
    }
  }
  return out;
}

/** Northward-meridian even-odd ray-cast in Galactic coordinates (handles 0/360° wrap & rifts cleanly). */
function isInsideGalacticRings(rings: GalacticRing[], lDeg: number, bDeg: number): boolean {
  let inside = false;
  for (let rIdx = 0; rIdx < rings.length; rIdx++) {
    const ring = rings[rIdx];
    if (bDeg > ring.maxB) continue;
    if (!ring.wrapsLon) {
      if (bDeg < ring.minB) continue;
      if (Math.abs(wrapDeg180(lDeg - ring.centerL)) > ring.halfSpanL) continue;
    }
    const pts = ring.points;
    const len = pts.length;
    if (len < 6) continue;

    let prevL = pts[len - 2];
    let prevB = pts[len - 1];
    for (let i = 0; i < len; i += 2) {
      const curL = pts[i];
      const curB = pts[i + 1];
      const d1 = wrapDeg180(prevL - lDeg);
      const d2 = d1 + wrapDeg180(curL - prevL);
      if ((d1 <= 0 && d2 > 0) || (d2 <= 0 && d1 > 0)) {
        const t = -d1 / (d2 - d1);
        const crossB = prevB + t * (curB - prevB);
        if (crossB > bDeg) {
          inside = !inside;
        }
      }
      prevL = curL;
      prevB = curB;
    }
  }
  return inside;
}

const LEVEL_WEIGHTS = [0.26, 0.21, 0.19, 0.17, 0.22];

/**
 * Convert raw contour rings into packed J2000 Galactic cloud puffs:
 * Float32Array stride 6: `[vx, vy, vz, radiusDeg, intensity, warmth]`.
 */
export function getOrBuildMilkyWayClouds(levels: MilkyWayLevel[]): Float32Array {
  const cached = milkyWayCache.get(levels);
  if (cached) return cached;

  const ringsPerLevel = levels.map(buildGalacticLevelRings);
  const buf: number[] = [];

  // Sample Galactic band (|b| <= 26 deg), covering full 360 deg longitude with jittered tiles
  const lStep = 3.2;
  const bStep = 2.6;
  let seed = 1337;
  const nextRand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  for (let b = -25.0; b <= 25.0; b += bStep) {
    for (let l = 0; l < 360; l += lStep) {
      const jl = (l + (nextRand() - 0.5) * 1.6 + 360) % 360;
      const jb = b + (nextRand() - 0.5) * 1.4;

      let intensity = 0;
      let highestIdx = -1;
      for (let lv = 0; lv < ringsPerLevel.length; lv++) {
        if (isInsideGalacticRings(ringsPerLevel[lv], jl, jb)) {
          intensity += LEVEL_WEIGHTS[lv] ?? 0.16;
          highestIdx = lv;
        }
      }

      if (intensity <= 0.02) continue;
      intensity = Math.min(1.0, intensity);

      const [vx, vy, vz] = galacticDegToJ2000Vec(jl, jb);
      const lonDistCenter = Math.abs(wrapDeg180(jl));
      const coreBoost = Math.max(0, 1 - lonDistCenter / 55) * Math.max(0, 1 - Math.abs(jb) / 16);
      const warmth = Math.min(1, (highestIdx >= 2 ? (highestIdx - 1) * 0.25 : 0) + coreBoost * 0.55);
      const radiusDeg = (4.1 + nextRand() * 1.4) * (1.0 - highestIdx * 0.04);

      buf.push(vx, vy, vz, radiusDeg, intensity, warmth);
    }
  }

  const out = new Float32Array(buf);
  milkyWayCache.set(levels, out);
  return out;
}

export interface MilkyWaySpriteAtlas {
  cool: HTMLCanvasElement;
  warm: HTMLCanvasElement;
  nightVision: HTMLCanvasElement;
  inverted: HTMLCanvasElement;
}

let cachedMwSprites: MilkyWaySpriteAtlas | null = null;

function makePuffCanvas(r: number, g: number, b: number, peakAlpha: number): HTMLCanvasElement {
  const size = 64;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d");
  if (!ctx) return c;
  const half = size * 0.5;
  const grad = ctx.createRadialGradient(half, half, 0, half, half, half);
  grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${peakAlpha.toFixed(3)})`);
  grad.addColorStop(0.42, `rgba(${r}, ${g}, ${b}, ${(peakAlpha * 0.52).toFixed(3)})`);
  grad.addColorStop(0.76, `rgba(${r}, ${g}, ${b}, ${(peakAlpha * 0.14).toFixed(3)})`);
  grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  return c;
}

export function getMilkyWaySpriteAtlas(): MilkyWaySpriteAtlas {
  if (!cachedMwSprites) {
    cachedMwSprites = {
      cool: makePuffCanvas(168, 200, 255, 0.13),
      warm: makePuffCanvas(238, 214, 184, 0.15),
      nightVision: makePuffCanvas(210, 32, 32, 0.11),
      inverted: makePuffCanvas(100, 116, 139, 0.11),
    };
  }
  return cachedMwSprites;
}
