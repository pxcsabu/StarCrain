import {
  type CompiledProjectionContext,
  wrapDeg360,
} from "@/lib/projection";
import type {
  CustomPanoramaMaskMode,
  LandscapeConfig,
  LandscapePresetId,
  SkyFrame,
} from "@/types/sky";

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

const TEX_W = 1440;
const TEX_H = 720;

export interface EquirectTexture {
  width: number;
  height: number;
  data: Uint8ClampedArray;
  maxOpaqueAltDeg: number;
  version: number;
}

const proceduralCache = new Map<string, EquirectTexture>();

let customRawRgb: Uint8ClampedArray | null = null;
let customRawAlpha: Uint8ClampedArray | null = null;
let customHasAlpha = false;
let customTexture: EquirectTexture | null = null;
let customVersionSeq = 100;

const DB_NAME = "starcrane_landscape_db";
const DB_STORE = "custom_pano";
const DB_KEY = "active";

function openLandscapeDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IDB open failed"));
  });
}

async function saveCustomPanoramaBlob(blob: Blob): Promise<void> {
  try {
    const db = await openLandscapeDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readwrite");
      tx.objectStore(DB_STORE).put(blob, DB_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IDB write failed"));
    });
    db.close();
  } catch {
    // Ignore storage quota / private mode failures gracefully
  }
}

async function loadCustomPanoramaBlob(): Promise<Blob | null> {
  try {
    const db = await openLandscapeDb();
    const res = await new Promise<Blob | null>((resolve) => {
      const tx = db.transaction(DB_STORE, "readonly");
      const req = tx.objectStore(DB_STORE).get(DB_KEY);
      req.onsuccess = () => resolve(req.result instanceof Blob ? req.result : null);
      req.onerror = () => resolve(null);
    });
    db.close();
    return res;
  } catch {
    return null;
  }
}

export async function clearCustomPanoramaStorage(): Promise<void> {
  customRawRgb = null;
  customRawAlpha = null;
  customHasAlpha = false;
  customTexture = null;
  try {
    const db = await openLandscapeDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(DB_STORE, "readwrite");
      tx.objectStore(DB_STORE).delete(DB_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
    db.close();
  } catch {
    // Ignore storage cleanup errors
  }
}

function clampByte(v: number): number {
  return v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v);
}

function computeMaxOpaqueAlt(data: Uint8ClampedArray): number {
  for (let y = 0; y < TEX_H; y++) {
    const rowOff = y * TEX_W * 4;
    for (let x = 0; x < TEX_W; x += 2) {
      if (data[rowOff + x * 4 + 3] > 4) {
        const alt = 90 - ((y + 0.5) / TEX_H) * 180;
        return Math.max(-5, Math.min(89, alt + 0.75));
      }
    }
  }
  return 0;
}

function buildProceduralPanorama(preset: Exclude<LandscapePresetId, "veil" | "custom">): EquirectTexture {
  const existing = proceduralCache.get(preset);
  if (existing) return existing;

  const data = new Uint8ClampedArray(TEX_W * TEX_H * 4);
  const horizonY = TEX_H * 0.5;

  const putPx = (x: number, y: number, r: number, g: number, b: number, a: number) => {
    const off = (y * TEX_W + x) * 4;
    data[off] = clampByte(r);
    data[off + 1] = clampByte(g);
    data[off + 2] = clampByte(b);
    data[off + 3] = clampByte(a);
  };

  for (let x = 0; x < TEX_W; x++) {
    const ang = (x / TEX_W) * Math.PI * 2;
    if (preset === "mountain") {
      // Far alpine range (higher peaks, bluish twilight rock + snow hints)
      const farAlt =
        2.8 +
        4.6 * Math.sin(ang + 0.35) +
        2.9 * Math.cos(2 * ang - 0.8) +
        2.2 * Math.sin(3 * ang + 1.55) +
        1.4 * Math.cos(5 * ang + 0.4) +
        0.9 * Math.sin(8 * ang - 0.6) +
        0.55 * Math.cos(15 * ang + 1.1) +
        0.28 * Math.sin(31 * ang);
      // Mid forested foothill ridge with jagged conifer tree tops
      const spire = Math.pow(Math.abs(Math.sin(ang * 96)), 3) * 0.65;
      const treeAlt =
        1.1 +
        1.3 * Math.cos(2 * ang + 1.1) +
        0.95 * Math.sin(4 * ang - 0.5) +
        0.55 * Math.cos(9 * ang) +
        spire;

      const farY = horizonY - (farAlt / 90) * horizonY;
      const treeY = horizonY - (treeAlt / 90) * horizonY;

      for (let y = 0; y < TEX_H; y++) {
        if (y < Math.min(farY, treeY) - 1.5) continue;
        if (y < treeY - 0.5) {
          const depth = Math.max(0, y - farY);
          const alpha = y < farY ? Math.max(0, 1 - (farY - y)) * 255 : 255;
          const snow = farAlt > 8.6 && depth < 10 ? (10 - depth) * 6.5 : 0;
          const grad = Math.min(1, depth / 48);
          putPx(
            x,
            y,
            52 - grad * 22 + snow,
            66 - grad * 26 + snow * 1.02,
            96 - grad * 32 + snow * 1.05,
            alpha,
          );
        } else {
          const alpha = y < treeY ? Math.max(0, 1 - (treeY - y)) * 255 : 255;
          const depth = Math.max(0, (y - treeY) / (TEX_H - treeY));
          const texNoise = (Math.sin(x * 0.47 + y * 0.31) * 0.5 + 0.5) * 4;
          if (y < horizonY + 8) {
            putPx(x, y, 22 + texNoise, 34 + texNoise, 36 + texNoise, alpha);
          } else {
            putPx(
              x,
              y,
              24 - depth * 12 + texNoise * 0.6,
              32 - depth * 18 + texNoise * 0.6,
              28 - depth * 14 + texNoise * 0.6,
              alpha,
            );
          }
        }
      }
    } else if (preset === "coast") {
      // Distant rocky cape spanning ~80 deg + calm dark ocean horizon + lighthouse beacon
      const capeMask = Math.max(0, Math.cos(ang - 2.95));
      const capeAlt =
        capeMask > 0.15
          ? (capeMask - 0.15) * 9.5 * (0.75 + 0.25 * Math.cos(ang * 7)) +
            0.35 * Math.sin(ang * 29)
          : -10;
      const lighthouseBearing = Math.abs(Math.atan2(Math.sin(ang - 3.08), Math.cos(ang - 3.08)));
      const lhAlt = lighthouseBearing < 0.008 ? 9.8 : lighthouseBearing < 0.015 ? 8.2 : -10;
      const topAlt = Math.max(0, capeAlt, lhAlt);
      const topY = horizonY - (topAlt / 90) * horizonY;

      for (let y = Math.max(0, Math.floor(topY - 2)); y < TEX_H; y++) {
        if (y < topY - 0.8) continue;
        const alpha = y < topY ? Math.max(0, 1 - (topY - y)) * 255 : 255;
        if (y < horizonY) {
          // Rocky headland / lighthouse + warm amber lantern near top
          const isLantern =
            lighthouseBearing < 0.006 && y >= topY + 2 && y <= topY + 6;
          if (isLantern) {
            putPx(x, y, 255, 220, 120, alpha);
          } else {
            putPx(x, y, 30, 36, 48, alpha);
          }
        } else {
          const seaRatio = Math.min(1, (y - horizonY) / 110);
          const ripple = Math.sin(x * 0.22 + (y - horizonY) * 0.9) * 3.5 * (1 - seaRatio * 0.6);
          if (seaRatio < 0.82) {
            // Deep tranquil ocean
            putPx(x, y, 22 + ripple, 38 + seaRatio * 8 + ripple, 62 - seaRatio * 14 + ripple, 255);
          } else {
            // Pebbled shore toward nadir
            const shore = (y - (horizonY + 90)) / (TEX_H - (horizonY + 90));
            putPx(x, y, 34 - shore * 16, 36 - shore * 16, 38 - shore * 14, 255);
          }
        }
      }
    } else if (preset === "observatory") {
      // Summit observatory deck: gentle distant mountains + observatory dome silhouette + low railing
      const bgAlt =
        1.8 + 1.9 * Math.sin(ang + 1.2) + 1.2 * Math.cos(3 * ang - 0.4) + 0.5 * Math.sin(7 * ang);
      const domeDelta = Math.atan2(Math.sin(ang - 4.05), Math.cos(ang - 4.05));
      const domeRadius = 0.22;
      const domeAlt =
        Math.abs(domeDelta) < domeRadius
          ? 3.8 + Math.sqrt(Math.max(0, 1 - Math.pow(domeDelta / domeRadius, 2))) * 11.5
          : -10;
      const domeWindow =
        Math.abs(domeDelta - 0.04) < 0.032 ? 11.5 : -10;
      const roofAlt = Math.max(bgAlt, domeAlt);
      const roofY = horizonY - (roofAlt / 90) * horizonY;
      const railTopY = horizonY + 11;
      const railBotY = horizonY + 14;
      const isPost = (x % 45) < 3;

      for (let y = Math.max(0, Math.floor(roofY - 2)); y < TEX_H; y++) {
        if (y < roofY - 0.8) continue;
        const alpha = y < roofY ? Math.max(0, 1 - (roofY - y)) * 255 : 255;
        if (y <= horizonY + 10) {
          if (domeAlt > bgAlt) {
            const litSlit =
              domeWindow > 0 &&
              y > horizonY - (9.2 / 90) * horizonY &&
              y < horizonY - (6.0 / 90) * horizonY;
            if (litSlit) {
              putPx(x, y, 195, 92, 58, alpha);
            } else {
              putPx(x, y, 48, 56, 74, alpha);
            }
          } else {
            putPx(x, y, 28, 36, 54, alpha);
          }
        } else if (y >= railTopY && y <= railBotY) {
          putPx(x, y, 64, 72, 92, 255);
        } else if (isPost && y <= horizonY + 34) {
          putPx(x, y, 58, 66, 84, 255);
        } else {
          const d = (y - horizonY) / horizonY;
          putPx(x, y, 24 - d * 10, 28 - d * 12, 36 - d * 12, 255);
        }
      }
    } else {
      // Desert mesas & wind-rippled dunes 2D fallback
      const m1 = Math.max(0, 1 - Math.abs(Math.atan2(Math.sin(ang - 1.15), Math.cos(ang - 1.15))) / 0.42);
      const m2 = Math.max(0, 1 - Math.abs(Math.atan2(Math.sin(ang - 3.65), Math.cos(ang - 3.65))) / 0.36);
      const mesaAlt = Math.max(
        m1 > 0.2 ? Math.min(5.2, m1 * 7.8) : 0,
        m2 > 0.2 ? Math.min(4.6, m2 * 7.0) : 0,
      );
      const duneAlt = 0.6 + 0.55 * Math.sin(ang * 5 + 0.8);
      const topAlt = Math.max(mesaAlt, duneAlt);
      const topY = horizonY - (topAlt / 90) * horizonY;
      for (let y = Math.max(0, Math.floor(topY - 2)); y < TEX_H; y++) {
        if (y < topY - 0.8) continue;
        const alpha = y < topY ? Math.max(0, 1 - (topY - y)) * 255 : 255;
        if (y < horizonY + 4 && mesaAlt > duneAlt) {
          putPx(x, y, 76, 44, 34, alpha);
        } else {
          const depth = Math.max(0, (y - horizonY) / horizonY);
          const ripple = Math.sin(x * 0.14 + y * 0.42) * 3;
          putPx(x, y, 66 - depth * 22 + ripple, 48 - depth * 18 + ripple, 35 - depth * 14 + ripple, alpha);
        }
      }
    }
  }

  const maxOpaqueAltDeg = computeMaxOpaqueAlt(data);
  const tex: EquirectTexture = {
    width: TEX_W,
    height: TEX_H,
    data,
    maxOpaqueAltDeg,
    version: preset === "mountain" ? 1 : preset === "coast" ? 2 : preset === "observatory" ? 3 : 4,
  };
  proceduralCache.set(preset, tex);
  return tex;
}

function applyMaskToCustomRaw(
  maskMode: CustomPanoramaMaskMode,
  skyKeyThreshold: number,
): EquirectTexture | null {
  if (!customRawRgb || !customRawAlpha) return null;
  const rgb = customRawRgb;
  const origA = customRawAlpha;
  const out = new Uint8ClampedArray(TEX_W * TEX_H * 4);
  const stopY = Math.floor(TEX_H * 0.54);

  if (maskMode === "alpha_only") {
    for (let i = 0, p = 0; i < TEX_W * TEX_H; i++, p += 3) {
      const o4 = i * 4;
      out[o4] = rgb[p];
      out[o4 + 1] = rgb[p + 1];
      out[o4 + 2] = rgb[p + 2];
      out[o4 + 3] = customHasAlpha ? origA[i] : 255;
    }
  } else if (maskMode === "horizon_cut") {
    const cutTop = Math.floor(TEX_H * (0.5 - 0.8 / 180));
    const cutBot = Math.ceil(TEX_H * (0.5 + 0.8 / 180));
    const span = Math.max(1, cutBot - cutTop);
    for (let y = 0; y < TEX_H; y++) {
      const bandAlpha = y <= cutTop ? 0 : y >= cutBot ? 255 : Math.round(((y - cutTop) / span) * 255);
      for (let x = 0; x < TEX_W; x++) {
        const i = y * TEX_W + x;
        const p = i * 3;
        const o4 = i * 4;
        out[o4] = rgb[p];
        out[o4 + 1] = rgb[p + 1];
        out[o4 + 2] = rgb[p + 2];
        out[o4 + 3] = customHasAlpha ? Math.min(origA[i], bandAlpha) : bandAlpha;
      }
    }
  } else {
    // auto_sky_key: build sector sky reference (36 sectors = 10 deg each) in upper sky band
    const sectors = 36;
    const secW = TEX_W / sectors;
    const secR = new Float32Array(sectors);
    const secG = new Float32Array(sectors);
    const secB = new Float32Array(sectors);

    const yMin = Math.floor(TEX_H * 0.05);
    const yMax = Math.floor(TEX_H * 0.28);
    for (let s = 0; s < sectors; s++) {
      const x0 = Math.floor(s * secW);
      const x1 = Math.min(TEX_W, Math.floor((s + 1) * secW));
      const cand: { lum: number; r: number; g: number; b: number }[] = [];
      for (let y = yMin; y < yMax; y += 3) {
        for (let x = x0; x < x1; x += 4) {
          const i = y * TEX_W + x;
          if (origA[i] < 180) continue;
          const p = i * 3;
          const r = rgb[p];
          const g = rgb[p + 1];
          const b = rgb[p + 2];
          const lum = 0.299 * r + 0.587 * g + 0.114 * b;
          if (lum < 14) continue; // Ignore black zenith cap in incomplete Gcam photospheres
          cand.push({ lum, r, g, b });
        }
      }
      if (cand.length === 0) {
        secR[s] = 110;
        secG[s] = 145;
        secB[s] = 190;
      } else {
        cand.sort((a, b) => b.lum - a.lum);
        const take = Math.max(1, Math.floor(cand.length * 0.45));
        let sr = 0;
        let sg = 0;
        let sb = 0;
        for (let k = 0; k < take; k++) {
          sr += cand[k].r;
          sg += cand[k].g;
          sb += cand[k].b;
        }
        secR[s] = sr / take;
        secG[s] = sg / take;
        secB[s] = sb / take;
      }
    }

    // Track bottom valid ground color to cover incomplete black nadir caps gracefully
    let groundFillR = 26;
    let groundFillG = 30;
    let groundFillB = 34;
    let gfSum = 0;
    let gfR = 0;
    let gfG = 0;
    let gfB = 0;
    for (let y = Math.floor(TEX_H * 0.62); y < Math.floor(TEX_H * 0.78); y += 6) {
      for (let x = 0; x < TEX_W; x += 12) {
        const i = y * TEX_W + x;
        const p = i * 3;
        const r = rgb[p];
        const g = rgb[p + 1];
        const b = rgb[p + 2];
        if (origA[i] >= 180 && r + g + b > 24) {
          gfR += r;
          gfG += g;
          gfB += b;
          gfSum++;
        }
      }
    }
    if (gfSum > 0) {
      groundFillR = gfR / gfSum;
      groundFillG = gfG / gfSum;
      groundFillB = gfB / gfSum;
    }

    const baseTol = skyKeyThreshold * 1.45;
    for (let x = 0; x < TEX_W; x++) {
      // Smoothly interpolate sector sky reference
      const fSec = (x / secW) - 0.5;
      const s0 = ((Math.floor(fSec) % sectors) + sectors) % sectors;
      const s1 = (s0 + 1) % sectors;
      const ft = fSec - Math.floor(fSec);

      let tr = secR[s0] * (1 - ft) + secR[s1] * ft;
      let tg = secG[s0] * (1 - ft) + secG[s1] * ft;
      let tb = secB[s0] * (1 - ft) + secB[s1] * ft;
      let hitY = stopY;

      for (let y = 0; y < stopY; y++) {
        const i = y * TEX_W + x;
        const p = i * 3;
        const r = rgb[p];
        const g = rgb[p + 1];
        const b = rgb[p + 2];
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;

        if (origA[i] < 160 || (lum < 12 && y < TEX_H * 0.28)) {
          continue;
        }

        const tLum = 0.299 * tr + 0.587 * tg + 0.114 * tb;
        const dist = Math.hypot(r - tr, g - tg, b - tb) * 0.58;
        const tol = baseTol * (1 + 0.4 * (y / stopY));

        // Dark terrain silhouette triggers immediately once distinctly darker than tracked sky
        const isDarkSolid = tLum - lum > tol * 0.72 && dist > tol * 0.55;
        if (dist > tol || isDarkSolid) {
          hitY = y;
          break;
        }
        // Track gentle vertical atmospheric gradient down toward the horizon
        tr = tr * 0.94 + r * 0.06;
        tg = tg * 0.94 + g * 0.06;
        tb = tb * 0.94 + b * 0.06;
      }

      for (let y = 0; y < TEX_H; y++) {
        const i = y * TEX_W + x;
        const p = i * 3;
        const o4 = i * 4;
        let r = rgb[p];
        let g = rgb[p + 1];
        let b = rgb[p + 2];

        // Fill black nadir cap below alt -50° cleanly
        if (y > TEX_H * 0.80 && origA[i] >= 180 && r + g + b < 14) {
          r = groundFillR;
          g = groundFillG;
          b = groundFillB;
        }

        let alpha = 255;
        if (y < hitY - 2) {
          alpha = 0;
        } else if (y === hitY - 2) {
          alpha = 70;
        } else if (y === hitY - 1) {
          alpha = 165;
        } else if (customHasAlpha && y < TEX_H * 0.55) {
          alpha = origA[i];
        }

        out[o4] = r;
        out[o4 + 1] = g;
        out[o4 + 2] = b;
        out[o4 + 3] = alpha;
      }
    }
  }

  customVersionSeq += 1;
  customTexture = {
    width: TEX_W,
    height: TEX_H,
    data: out,
    maxOpaqueAltDeg: computeMaxOpaqueAlt(out),
    version: customVersionSeq,
  };
  return customTexture;
}

function decodeImageElementFromBlob(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("画像の読み込みに失敗しました"));
    };
    img.src = url;
  });
}

async function decodeAndCacheCustomBlob(
  blob: Blob,
  maskMode: CustomPanoramaMaskMode,
  skyKeyThreshold: number,
  persistBlob: boolean,
): Promise<EquirectTexture | null> {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = TEX_W;
  canvas.height = TEX_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  let srcW = TEX_W;
  let srcH = TEX_H;
  let drawable: CanvasImageSource;
  let closeBitmap: (() => void) | null = null;

  if (typeof createImageBitmap === "function") {
    const bmp = await createImageBitmap(blob);
    srcW = bmp.width;
    srcH = bmp.height;
    drawable = bmp;
    closeBitmap = () => bmp.close();
  } else {
    const img = await decodeImageElementFromBlob(blob);
    srcW = img.naturalWidth || img.width;
    srcH = img.naturalHeight || img.height;
    drawable = img;
  }

  try {
    ctx.clearRect(0, 0, TEX_W, TEX_H);
    const aspect = srcW / Math.max(1, srcH);

    if (aspect > 2.45) {
      // Cylindrical horizon strip (wider than 2:1 equirectangular): map vertical band centered on horizon
      const spanDeg = Math.min(170, Math.max(18, 360 / aspect));
      const drawH = (spanDeg / 180) * TEX_H;
      const drawY = (TEX_H - drawH) * 0.5;
      ctx.drawImage(drawable, 0, drawY, TEX_W, drawH);

      // Fill opaque ground strip below the cylindrical bottom edge
      const bottomY = Math.min(TEX_H - 1, Math.floor(drawY + drawH) - 1);
      const bottomRow = ctx.getImageData(0, bottomY, TEX_W, 1).data;
      const lowerRow = ctx.getImageData(0, bottomY, TEX_W, 1);
      for (let y = bottomY + 1; y < TEX_H; y++) {
        const shade = Math.max(0.22, 1 - ((y - bottomY) / Math.max(1, TEX_H - bottomY)) * 0.78);
        for (let x = 0; x < TEX_W; x++) {
          const o = x * 4;
          lowerRow.data[o] = clampByte(bottomRow[o] * shade);
          lowerRow.data[o + 1] = clampByte(bottomRow[o + 1] * shade);
          lowerRow.data[o + 2] = clampByte(bottomRow[o + 2] * shade);
          lowerRow.data[o + 3] = bottomRow[o + 3];
        }
        ctx.putImageData(lowerRow, 0, y);
      }
    } else {
      // Standard 2:1 Equirectangular (Gcam Photo Sphere / Ricoh Theta / 360 HDRI) or general wide image
      ctx.drawImage(drawable, 0, 0, TEX_W, TEX_H);
    }

    const imgData = ctx.getImageData(0, 0, TEX_W, TEX_H).data;
    const rgb = new Uint8ClampedArray(TEX_W * TEX_H * 3);
    const alpha = new Uint8ClampedArray(TEX_W * TEX_H);
    let upperTranspCount = 0;
    const upperSamples = Math.floor(TEX_H * 0.42) * TEX_W;

    for (let i = 0, p = 0; i < TEX_W * TEX_H; i++, p += 3) {
      const o = i * 4;
      rgb[p] = imgData[o];
      rgb[p + 1] = imgData[o + 1];
      rgb[p + 2] = imgData[o + 2];
      alpha[i] = imgData[o + 3];
      if (i < upperSamples && imgData[o + 3] < 200) {
        upperTranspCount++;
      }
    }

    customRawRgb = rgb;
    customRawAlpha = alpha;
    customHasAlpha = upperSamples > 0 && upperTranspCount / upperSamples > 0.05;

    if (persistBlob) {
      const storedBlob = await new Promise<Blob>((res) => {
        canvas.toBlob((b) => res(b ?? blob), "image/png");
      });
      await saveCustomPanoramaBlob(storedBlob);
    }

    return applyMaskToCustomRaw(maskMode, skyKeyThreshold);
  } finally {
    closeBitmap?.();
  }
}

export async function importCustomPanoramaFile(
  file: File,
  maskMode: CustomPanoramaMaskMode,
  skyKeyThreshold: number,
): Promise<{ fileName: string; hasNativeAlpha: boolean }> {
  await decodeAndCacheCustomBlob(file, maskMode, skyKeyThreshold, true);
  return { fileName: file.name, hasNativeAlpha: customHasAlpha };
}

export function rebuildCustomPanoramaMask(
  maskMode: CustomPanoramaMaskMode,
  skyKeyThreshold: number,
): void {
  if (customRawRgb) {
    applyMaskToCustomRaw(maskMode, skyKeyThreshold);
  }
}

export function hasLoadedCustomPanorama(): boolean {
  return customTexture !== null;
}

let customInitStarted = false;
export function initCustomPanoramaFromStorage(
  maskMode: CustomPanoramaMaskMode,
  skyKeyThreshold: number,
  onLoaded: () => void,
): void {
  if (customInitStarted) return;
  customInitStarted = true;
  void loadCustomPanoramaBlob().then(async (blob) => {
    if (!blob) return;
    try {
      await decodeAndCacheCustomBlob(blob, maskMode, skyKeyThreshold, false);
      onLoaded();
    } catch {
      // Ignore corrupt persisted image
    }
  });
}

function getActiveTexture(config: LandscapeConfig): EquirectTexture | null {
  if (config.preset === "veil") return null;
  if (config.preset === "custom") {
    return customTexture ?? buildProceduralPanorama("mountain");
  }
  return buildProceduralPanorama(config.preset);
}

interface LandscapeScreenCache {
  key: string;
  canvas: HTMLCanvasElement;
  img: ImageData | null;
}

const panelRenderCache = new Map<number, LandscapeScreenCache>();

export function renderPanoramaLandscape(
  c: CanvasRenderingContext2D,
  pCtx: CompiledProjectionContext,
  panel: number,
  frame: SkyFrame,
  config: LandscapeConfig,
  nightVision: boolean,
  isInverted: boolean,
  fastMode = false,
): boolean {
  const { params } = pCtx;
  if (
    config.preset === "veil" ||
    params.mode === "star_chart" ||
    frame.view_mode === "other_planet" ||
    frame.view_mode === "other_star"
  ) {
    return false;
  }

  const tex = getActiveTexture(config);
  if (!tex) return false;

  const w = params.width;
  const h = params.height;
  if (w < 4 || h < 4) return false;

  const effOpacity = params.show_below_horizon ? config.opacity * 0.34 : config.opacity;
  const illum = isInverted
    ? 0.25
    : config.nightDimming
      ? Math.max(
          0.16,
          Math.min(
            1,
            0.16 +
              0.84 * Math.pow(Math.max(0, 1 - frame.sky_palette.star_visibility_factor * 0.85), 0.72) +
              frame.sky_palette.moonlight_strength * 0.22,
          ),
        )
      : 1.0;

  const scale = fastMode ? Math.min(0.24, 420 / Math.max(w, h)) : 0.48;
  const invScale = 1 / scale;
  const bw = Math.max(1, Math.ceil(w * scale));
  const bh = Math.max(1, Math.ceil(h * scale));
  const illumBucket = Math.round(illum * 64);

  const key = `${params.mode}|${panel}|${fastMode ? 1 : 0}|${bw}x${bh}|${params.center_az_deg.toFixed(3)}|${params.center_alt_deg.toFixed(3)}|${params.fov_deg.toFixed(2)}|${params.zoom.toFixed(3)}|${params.show_below_horizon ? 1 : 0}|${tex.version}|${config.azOffsetDeg.toFixed(2)}|${config.altOffsetDeg.toFixed(2)}|${Math.round(effOpacity * 100)}|${illumBucket}|${nightVision ? 1 : 0}|${isInverted ? 1 : 0}`;

  let entry = panelRenderCache.get(panel);
  if (!entry) {
    const canvas = document.createElement("canvas");
    entry = { key: "", canvas, img: null };
    panelRenderCache.set(panel, entry);
  }

  if (entry.key !== key) {
    if (entry.canvas.width !== bw || entry.canvas.height !== bh) {
      entry.canvas.width = bw;
      entry.canvas.height = bh;
      entry.img = null;
    }
    const offCtx = entry.canvas.getContext("2d");
    if (!offCtx) return false;
    if (!entry.img) {
      entry.img = offCtx.createImageData(bw, bh);
    }

    const out = entry.img.data;
    const tData = tex.data;
    const tw = tex.width;
    const th = tex.height;
    const maxAlt = Math.min(89.9, tex.maxOpaqueAltDeg + config.altOffsetDeg + 1.0);
    const maxSinAlt = Math.sin(maxAlt * DEG2RAD);
    const azOff = config.azOffsetDeg;
    const altOff = config.altOffsetDeg;
    const opacityScale = effOpacity;

    const isStereo =
      params.mode === "free_direction" ||
      params.mode === "horizon_zoom" ||
      params.mode === "mid_sky" ||
      params.mode === "zenith";
    const basis =
      params.mode === "hemisphere_dual" && panel === 1 ? pCtx.basis1 ?? pCtx.basis0 : pCtx.basis0;
    const scX =
      params.mode === "hemisphere_single"
        ? pCtx.hemCx0
        : params.mode === "hemisphere_dual"
          ? panel === 1
            ? pCtx.hemCx1
            : pCtx.hemCx0
          : pCtx.cx;
    const scY =
      params.mode === "hemisphere_single"
        ? pCtx.hemCy0
        : params.mode === "hemisphere_dual"
          ? panel === 1
            ? pCtx.hemCy1
            : pCtx.hemCy0
          : pCtx.cy;
    const scR =
      params.mode === "hemisphere_single"
        ? pCtx.hemRadius0
        : params.mode === "hemisphere_dual"
          ? panel === 1
            ? pCtx.hemRadius1
            : pCtx.hemRadius0
          : pCtx.stereoScalePx;
    const invScR = 1 / Math.max(1e-6, scR);
    const isHemi = params.mode === "hemisphere_single" || params.mode === "hemisphere_dual";
    const isAllSky = params.mode === "all_sky";
    const isPano = params.mode === "panorama";
    const invAllSkyR = 1 / Math.max(1e-6, pCtx.allSkyRadius);

    for (let py = 0; py < bh; py++) {
      const y = (py + 0.5) * invScale;
      const rowBase = py * bw * 4;
      for (let px = 0; px < bw; px++) {
        const x = (px + 0.5) * invScale;
        const o4 = rowBase + px * 4;

        let azDeg = 0;
        let altDeg = 90;

        if (isStereo || isHemi) {
          const us = (x - scX) * invScR;
          const vs = (scY - y) * invScR;
          const s2 = us * us + vs * vs;
          if (isHemi && s2 > 1) {
            out[o4 + 3] = 0;
            continue;
          }
          const inv = 1 / (1 + s2);
          const xc = 2 * us * inv;
          const yc = 2 * vs * inv;
          const zc = (1 - s2) * inv;
          const uz = basis.rz * xc + basis.uz * yc + basis.fz * zc;
          if (uz > maxSinAlt) {
            out[o4 + 3] = 0;
            continue;
          }
          const vx = basis.rx * xc + basis.ux * yc + basis.fx * zc;
          const vy = basis.ry * xc + basis.uy * yc + basis.fy * zc;
          const rXy = Math.hypot(vx, vy);
          altDeg = Math.atan2(uz, rXy) * RAD2DEG;
          if (rXy < 1e-14) {
            azDeg = 0;
          } else {
            let a = Math.atan2(vx, vy) * RAD2DEG;
            if (a < 0) a += 360;
            azDeg = a;
          }
        } else if (isAllSky) {
          const dx = x - pCtx.cx;
          const dy = y - pCtx.cy;
          const rho = Math.hypot(dx, dy);
          if (rho > pCtx.allSkyRadius) {
            out[o4 + 3] = 0;
            continue;
          }
          altDeg = 90 * (1 - rho * invAllSkyR);
          if (altDeg > maxAlt) {
            out[o4 + 3] = 0;
            continue;
          }
          azDeg =
            rho < 1e-9
              ? params.center_az_deg
              : wrapDeg360(params.center_az_deg + Math.atan2(dx, dy) * RAD2DEG);
        } else if (isPano) {
          const dAz = (x - pCtx.cx) / pCtx.panoScaleX;
          if (Math.abs(dAz) > 180) {
            out[o4 + 3] = 0;
            continue;
          }
          altDeg = params.center_alt_deg + (pCtx.cy - y) / pCtx.panoScaleY;
          if (altDeg > maxAlt || altDeg < -90) {
            out[o4 + 3] = 0;
            continue;
          }
          azDeg = wrapDeg360(params.center_az_deg + dAz);
        }

        let azDiff = (azDeg - azOff) % 360;
        if (azDiff < 0) azDiff += 360;
        const u = azDiff / 360;
        const v = Math.max(0, Math.min(0.999999, (90 - (altDeg - altOff)) / 180));
        const fx = u * tw;
        const fy = v * (th - 1);

        let sr: number;
        let sg: number;
        let sb: number;
        let sa: number;
        if (fastMode) {
          const ix = Math.floor(fx) % tw;
          const iy = Math.min(th - 1, Math.max(0, Math.floor(fy)));
          const ii = (iy * tw + ix) * 4;
          sa = tData[ii + 3];
          if (sa <= 2) {
            out[o4 + 3] = 0;
            continue;
          }
          sr = tData[ii];
          sg = tData[ii + 1];
          sb = tData[ii + 2];
        } else {
          const ix0 = Math.floor(fx) % tw;
          const ix1 = (ix0 + 1) % tw;
          const iy0 = Math.min(th - 1, Math.max(0, Math.floor(fy)));
          const iy1 = Math.min(th - 1, iy0 + 1);
          const tx = fx - Math.floor(fx);
          const ty = fy - iy0;

          const i00 = (iy0 * tw + ix0) * 4;
          const i10 = (iy0 * tw + ix1) * 4;
          const i01 = (iy1 * tw + ix0) * 4;
          const i11 = (iy1 * tw + ix1) * 4;

          const w00 = (1 - tx) * (1 - ty);
          const w10 = tx * (1 - ty);
          const w01 = (1 - tx) * ty;
          const w11 = tx * ty;

          sa =
            tData[i00 + 3] * w00 +
            tData[i10 + 3] * w10 +
            tData[i01 + 3] * w01 +
            tData[i11 + 3] * w11;
          if (sa <= 2) {
            out[o4 + 3] = 0;
            continue;
          }

          sr = tData[i00] * w00 + tData[i10] * w10 + tData[i01] * w01 + tData[i11] * w11;
          sg =
            tData[i00 + 1] * w00 +
            tData[i10 + 1] * w10 +
            tData[i01 + 1] * w01 +
            tData[i11 + 1] * w11;
          sb =
            tData[i00 + 2] * w00 +
            tData[i10 + 2] * w10 +
            tData[i01 + 2] * w01 +
            tData[i11 + 2] * w11;
        }

        if (isInverted) {
          const luma = 0.299 * sr + 0.587 * sg + 0.114 * sb;
          const val = 180 + luma * 0.25;
          out[o4] = val;
          out[o4 + 1] = val;
          out[o4 + 2] = val + 8;
        } else if (nightVision) {
          const luma = (0.299 * sr + 0.587 * sg + 0.114 * sb) * illum;
          out[o4] = Math.min(255, luma * 1.15);
          out[o4 + 1] = 0;
          out[o4 + 2] = 0;
        } else {
          out[o4] = sr * illum;
          out[o4 + 1] = sg * illum;
          out[o4 + 2] = sb * illum;
        }
        out[o4 + 3] = sa * opacityScale;
      }
    }

    offCtx.putImageData(entry.img, 0, 0);
    entry.key = key;
  }

  c.save();
  c.imageSmoothingEnabled = true;
  c.drawImage(entry.canvas, 0, 0, w, h);
  c.restore();
  return true;
}
