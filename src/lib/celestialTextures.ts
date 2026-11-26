import { getBundledPhotoMeta } from "@/lib/celestialPhotos";
import type { DsoEntry } from "@/types/sky";

export type DsoTextureKey =
  | "M31"
  | "M42"
  | "M45"
  | "M51"
  | "M104"
  | "ring"
  | "dumbbell"
  | "crab"
  | "lagoon"
  | "globular";

const DSO_SIZE = 512;
const DSO_HALF = DSO_SIZE / 2;

const dsoCacheNormal = new Map<DsoTextureKey, HTMLCanvasElement>();
const dsoCacheNight = new Map<DsoTextureKey, HTMLCanvasElement>();
const realDsoNormal = new Map<string, HTMLCanvasElement>();
const realDsoNight = new Map<string, HTMLCanvasElement>();
const realDsoLoading = new Set<string>();
const planetDiskNormal = new Map<string, HTMLCanvasElement>();
const planetDiskNight = new Map<string, HTMLCanvasElement>();
const planetDiskLoading = new Set<string>();
let lunarNormal: HTMLCanvasElement | null = null;
let lunarNight: HTMLCanvasElement | null = null;

function makePrng(seedInit: number): () => number {
  let seed = seedInit >>> 0;
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

function toNightVisionCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = src.width;
  c.height = src.height;
  const ctx = c.getContext("2d");
  const sCtx = src.getContext("2d");
  if (!ctx || !sCtx) return c;
  const img = sCtx.getImageData(0, 0, src.width, src.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    d[i] = Math.min(255, Math.round(lum * 1.15));
    d[i + 1] = 0;
    d[i + 2] = 0;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function applySoftCircularMask(ctx: CanvasRenderingContext2D, size: number): void {
  const half = size * 0.5;
  ctx.save();
  ctx.globalCompositeOperation = "destination-in";
  const mask = ctx.createRadialGradient(half, half, half * 0.45, half, half, half * 0.98);
  mask.addColorStop(0, "rgba(255,255,255,1)");
  mask.addColorStop(0.75, "rgba(255,255,255,0.65)");
  mask.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = mask;
  ctx.fillRect(0, 0, size, size);
  ctx.restore();
}

function drawSoftBlob(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  rCol: number,
  gCol: number,
  bCol: number,
  alpha: number,
): void {
  const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
  grad.addColorStop(0, `rgba(${rCol},${gCol},${bCol},${alpha.toFixed(3)})`);
  grad.addColorStop(0.5, `rgba(${rCol},${gCol},${bCol},${(alpha * 0.45).toFixed(3)})`);
  grad.addColorStop(1, `rgba(${rCol},${gCol},${bCol},0)`);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

function buildDsoSprite(key: DsoTextureKey): HTMLCanvasElement {
  const scale = DSO_SIZE / 160;
  const c = document.createElement("canvas");
  c.width = DSO_SIZE;
  c.height = DSO_SIZE;
  const ctx = c.getContext("2d");
  if (!ctx) return c;
  ctx.save();
  ctx.scale(scale, scale);
  const cx = 80;
  const cy = 80;
  const rand = makePrng(key.charCodeAt(0) * 997 + key.length * 131);

  if (key === "M31") {
    // Inclined golden galactic bulge + slate-blue spiral disk + dark dust lanes
    drawSoftBlob(ctx, cx, cy, 74, 130, 168, 235, 0.36);
    ctx.save();
    ctx.translate(cx, cy);
    for (let ring = 0; ring < 3; ring++) {
      const rx = 64 - ring * 14;
      const ry = 54 - ring * 11;
      ctx.strokeStyle = `rgba(165, 200, 255, ${0.28 - ring * 0.05})`;
      ctx.lineWidth = 7 - ring * 1.4;
      ctx.beginPath();
      ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    // Dark dust arcs
    ctx.strokeStyle = "rgba(8, 12, 24, 0.55)";
    ctx.lineWidth = 4.5;
    ctx.beginPath();
    ctx.ellipse(-6, 4, 48, 36, 0.15, 0.2, Math.PI * 1.15);
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(-3, 2, 30, 22, 0.15, 0.3, Math.PI * 1.05);
    ctx.stroke();
    ctx.restore();
    drawSoftBlob(ctx, cx, cy, 34, 255, 235, 195, 0.85);
    drawSoftBlob(ctx, cx, cy, 12, 255, 248, 232, 0.95);
    // Companion dwarf spots (M32 & M110 feel)
    drawSoftBlob(ctx, cx - 28, cy + 44, 12, 255, 232, 195, 0.52);
    drawSoftBlob(ctx, cx + 44, cy - 36, 15, 230, 225, 215, 0.42);
  } else if (key === "M51") {
    // Face-on grand-design spiral galaxy with pinkish HII knots
    drawSoftBlob(ctx, cx, cy, 68, 120, 165, 245, 0.28);
    ctx.lineCap = "round";
    for (let arm = 0; arm < 2; arm++) {
      const baseAngle = arm * Math.PI;
      for (let t = 0.25; t < 4.6; t += 0.12) {
        const rad = 7 + t * 13.5;
        const th = baseAngle + t * 1.15;
        const px = cx + Math.cos(th) * rad;
        const py = cy + Math.sin(th) * rad;
        drawSoftBlob(ctx, px, py, 10 - t * 0.8, 165, 205, 255, 0.22);
        if (Math.random() < 0.35 || rand() < 0.35) {
          drawSoftBlob(ctx, px + (rand() - 0.5) * 4, py + (rand() - 0.5) * 4, 4.2, 244, 114, 182, 0.38);
        }
      }
    }
    drawSoftBlob(ctx, cx, cy, 24, 255, 236, 192, 0.9);
    drawSoftBlob(ctx, cx + 52, cy - 26, 14, 250, 228, 185, 0.52);
  } else if (key === "M104") {
    // Sombrero / edge-on bright bulge sliced by dark dust lane
    drawSoftBlob(ctx, cx, cy, 52, 255, 228, 180, 0.55);
    drawSoftBlob(ctx, cx, cy, 24, 255, 245, 220, 0.9);
    ctx.save();
    ctx.translate(cx, cy);
    const disk = ctx.createLinearGradient(-72, 0, 72, 0);
    disk.addColorStop(0, "rgba(180,210,255,0)");
    disk.addColorStop(0.25, "rgba(210,225,255,0.62)");
    disk.addColorStop(0.5, "rgba(255,245,220,0.88)");
    disk.addColorStop(0.75, "rgba(210,225,255,0.62)");
    disk.addColorStop(1, "rgba(180,210,255,0)");
    ctx.fillStyle = disk;
    ctx.beginPath();
    ctx.ellipse(0, 0, 70, 9.5, 0, 0, Math.PI * 2);
    ctx.fill();
    // Crisp dark dust band
    ctx.fillStyle = "rgba(4, 7, 16, 0.82)";
    ctx.fillRect(-66, 2, 132, 4.2);
    ctx.restore();
  } else if (key === "M42") {
    // Orion Nebula: glowing crimson H-alpha wings + electric cyan/teal heart + dark fish-mouth rift
    drawSoftBlob(ctx, cx, cy + 6, 74, 190, 62, 128, 0.42);
    drawSoftBlob(ctx, cx - 24, cy + 16, 46, 236, 72, 153, 0.45);
    drawSoftBlob(ctx, cx + 26, cy + 14, 44, 192, 84, 212, 0.42);
    drawSoftBlob(ctx, cx, cy - 12, 42, 139, 92, 246, 0.35);
    drawSoftBlob(ctx, cx, cy, 34, 56, 189, 248, 0.72);
    drawSoftBlob(ctx, cx - 2, cy - 2, 16, 224, 248, 255, 0.92);
    // Dark bay intrusion
    ctx.save();
    ctx.fillStyle = "rgba(4, 7, 16, 0.68)";
    ctx.beginPath();
    ctx.moveTo(cx + 8, cy - 4);
    ctx.quadraticCurveTo(cx + 28, cy - 16, cx + 56, cy - 28);
    ctx.quadraticCurveTo(cx + 46, cy - 6, cx + 16, cy + 4);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    // Trapezium pinpoint cluster highlights
    for (const [dx, dy] of [[-2, -2], [3, -1], [1, 3], [-3, 2]]) {
      ctx.fillStyle = "rgba(255,255,255,0.95)";
      ctx.beginPath();
      ctx.arc(cx + dx, cy + dy, 1.3, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (key === "M45") {
    // Pleiades delicate blue reflection nebula wisps
    const stars: [number, number, number][] = [
      [0, 0, 32],
      [-28, -18, 28],
      [26, -12, 24],
      [-18, 26, 26],
      [30, 22, 22],
      [8, -32, 20],
    ];
    for (const [dx, dy, rad] of stars) {
      drawSoftBlob(ctx, cx + dx, cy + dy, rad * 1.4, 96, 165, 250, 0.42);
      drawSoftBlob(ctx, cx + dx, cy + dy, rad * 0.45, 220, 240, 255, 0.58);
      ctx.strokeStyle = "rgba(147, 197, 253, 0.25)";
      ctx.lineWidth = 1.2;
      for (let w = -2; w <= 2; w++) {
        ctx.beginPath();
        ctx.moveTo(cx + dx - 14, cy + dy + w * 4);
        ctx.lineTo(cx + dx + 16, cy + dy + w * 4 + 3);
        ctx.stroke();
      }
    }
  } else if (key === "ring") {
    // Ring / Helix planetary nebula: aqua inner glow + coral/gold outer ring
    drawSoftBlob(ctx, cx, cy, 42, 45, 212, 191, 0.45);
    ctx.save();
    ctx.strokeStyle = "rgba(251, 113, 133, 0.85)";
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.ellipse(cx, cy, 44, 34, 0.4, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = "rgba(56, 189, 248, 0.72)";
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.ellipse(cx, cy, 36, 27, 0.4, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    drawSoftBlob(ctx, cx, cy, 6, 224, 248, 255, 0.88);
  } else if (key === "dumbbell") {
    // Bi-lobed teal core + crimson butterfly caps
    drawSoftBlob(ctx, cx - 22, cy, 44, 244, 63, 94, 0.52);
    drawSoftBlob(ctx, cx + 22, cy, 44, 244, 63, 94, 0.52);
    drawSoftBlob(ctx, cx, cy - 12, 34, 34, 211, 238, 0.62);
    drawSoftBlob(ctx, cx, cy + 12, 34, 34, 211, 238, 0.62);
    drawSoftBlob(ctx, cx, cy, 18, 205, 250, 255, 0.45);
  } else if (key === "crab") {
    // Crab SNR: blue synchrotron interior + crimson filamentary web
    drawSoftBlob(ctx, cx, cy, 52, 96, 165, 250, 0.62);
    drawSoftBlob(ctx, cx, cy, 28, 195, 228, 255, 0.58);
    ctx.strokeStyle = "rgba(251, 113, 133, 0.55)";
    ctx.lineWidth = 1.6;
    for (let i = 0; i < 24; i++) {
      const a0 = rand() * Math.PI * 2;
      const r0 = 10 + rand() * 20;
      const r1 = 36 + rand() * 24;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a0) * r0, cy + Math.sin(a0) * r0);
      ctx.quadraticCurveTo(
        cx + Math.cos(a0 + 0.35) * (r0 + r1) * 0.55,
        cy + Math.sin(a0 + 0.35) * (r0 + r1) * 0.55,
        cx + Math.cos(a0 + 0.1) * r1,
        cy + Math.sin(a0 + 0.1) * r1,
      );
      ctx.stroke();
    }
  } else if (key === "lagoon") {
    // Rich emission/reflection HII cloud with warm rose heart and dark dust rifts
    drawSoftBlob(ctx, cx, cy, 72, 236, 72, 153, 0.38);
    drawSoftBlob(ctx, cx - 18, cy - 12, 46, 244, 114, 182, 0.46);
    drawSoftBlob(ctx, cx + 22, cy + 14, 46, 56, 189, 248, 0.38);
    drawSoftBlob(ctx, cx, cy, 28, 253, 215, 238, 0.65);
    ctx.fillStyle = "rgba(6, 10, 20, 0.48)";
    ctx.beginPath();
    ctx.ellipse(cx + 4, cy + 10, 26, 6, -0.45, 0, Math.PI * 2);
    ctx.fill();
  } else {
    // Globular cluster: radiant warm golden core resolved into hundreds of sparkling points
    drawSoftBlob(ctx, cx, cy, 62, 253, 224, 150, 0.32);
    drawSoftBlob(ctx, cx, cy, 32, 255, 240, 200, 0.68);
    drawSoftBlob(ctx, cx, cy, 14, 255, 252, 242, 0.92);
    for (let i = 0; i < 360; i++) {
      const th = rand() * Math.PI * 2;
      const dist = Math.pow(rand(), 1.85) * 68;
      const x = cx + Math.cos(th) * dist;
      const y = cy + Math.sin(th) * dist;
      const lum = Math.max(0.25, 1 - dist / 70);
      const size = rand() < 0.14 ? 1.25 : 0.72;
      ctx.fillStyle =
        rand() < 0.28
          ? `rgba(191, 219, 254, ${lum.toFixed(2)})`
          : `rgba(255, 244, 214, ${lum.toFixed(2)})`;
      ctx.beginPath();
      ctx.arc(x, y, size, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.restore();
  applySoftCircularMask(ctx, DSO_SIZE);
  return c;
}

export function getDsoTextureSprite(key: DsoTextureKey, nightVision: boolean): HTMLCanvasElement {
  if (nightVision) {
    let nv = dsoCacheNight.get(key);
    if (!nv) {
      nv = toNightVisionCanvas(getDsoTextureSprite(key, false));
      dsoCacheNight.set(key, nv);
    }
    return nv;
  }
  let sprite = dsoCacheNormal.get(key);
  if (!sprite) {
    sprite = buildDsoSprite(key);
    dsoCacheNormal.set(key, sprite);
  }
  return sprite;
}

export function selectDsoTextureKey(dso: DsoEntry): DsoTextureKey {
  if (dso.messier != null) {
    switch (dso.messier) {
      case 31:
        return "M31";
      case 42:
      case 43:
        return "M42";
      case 45:
        return "M45";
      case 51:
      case 101:
      case 33:
      case 74:
      case 63:
      case 106:
      case 81:
        return "M51";
      case 104:
      case 82:
      case 65:
      case 66:
      case 108:
        return "M104";
      case 57:
      case 97:
        return "ring";
      case 27:
      case 76:
        return "dumbbell";
      case 1:
        return "crab";
      case 8:
      case 20:
      case 16:
      case 17:
      case 78:
        return "lagoon";
      case 13:
      case 3:
      case 5:
      case 15:
      case 22:
      case 92:
      case 2:
        return "globular";
      default:
        break;
    }
  }
  const uid = dso.id.toUpperCase();
  if (uid === "NGC7293") return "ring";
  if (uid === "NGC253" || uid === "NGC891" || uid === "NGC4565" || uid === "NGC5907") return "M104";
  if (uid === "NGC2070" || uid === "NGC3372") return "M42";
  if (uid === "NGC7000" || uid === "IC1805" || uid === "NGC2237") return "lagoon";

  const t = dso.obj_type.toUpperCase();
  if (t === "GC" || t === "GCL") return "globular";
  if (t === "PN") return "ring";
  if (t === "OC" || t === "OCL") return "M45";
  if (t.includes("G")) {
    const ratio =
      dso.maj_ax_arcmin && dso.min_ax_arcmin
        ? dso.min_ax_arcmin / Math.max(0.1, dso.maj_ax_arcmin)
        : 0.65;
    if (ratio < 0.38) return "M104";
    if (ratio < 0.72) return "M31";
    return "M51";
  }
  return "lagoon";
}

function buildLunarTexture(): HTMLCanvasElement {
  const size = 256;
  const r = size / 2;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d");
  if (!ctx) return c;

  ctx.save();
  ctx.beginPath();
  ctx.arc(r, r, r, 0, Math.PI * 2);
  ctx.clip();

  // Warm regolith highland base
  const baseGrad = ctx.createRadialGradient(r - 20, r - 20, 10, r, r, r);
  baseGrad.addColorStop(0, "#ede7d7");
  baseGrad.addColorStop(0.75, "#d4cec0");
  baseGrad.addColorStop(1, "#a8a397");
  ctx.fillStyle = baseGrad;
  ctx.fillRect(0, 0, size, size);

  // Authentic near-side lunar maria basalt basins (nx, ny in -1..1 where -y = North)
  const maria: [number, number, number, number, number, number][] = [
    [-0.25, -0.32, 0.34, 0.28, -0.2, 0.56], // Mare Imbrium
    [-0.55, -0.04, 0.30, 0.48, 0.15, 0.50], // Oceanus Procellarum
    [0.14, -0.32, 0.21, 0.21, 0.1, 0.54],   // Mare Serenitatis
    [0.34, -0.08, 0.24, 0.19, -0.3, 0.54],  // Mare Tranquillitatis
    [0.64, -0.22, 0.13, 0.11, 0.2, 0.58],   // Mare Crisium
    [0.54, 0.18, 0.18, 0.22, 0.1, 0.50],    // Mare Fecunditatis
    [0.24, 0.24, 0.16, 0.14, 0.0, 0.48],    // Mare Nectaris
    [-0.22, 0.36, 0.24, 0.18, 0.2, 0.44],   // Mare Nubium
    [-0.48, 0.36, 0.14, 0.14, 0.0, 0.48],   // Mare Humorum
    [-0.08, -0.66, 0.38, 0.09, 0.05, 0.46], // Mare Frigoris
  ];

  for (const [nx, ny, rx, ry, rot, alpha] of maria) {
    ctx.save();
    ctx.translate(r + nx * r, r + ny * r);
    ctx.rotate(rot);
    const mGrad = ctx.createRadialGradient(0, 0, 2, 0, 0, Math.max(rx, ry) * r);
    mGrad.addColorStop(0, `rgba(74, 80, 92, ${alpha})`);
    mGrad.addColorStop(0.65, `rgba(88, 94, 106, ${(alpha * 0.78).toFixed(2)})`);
    mGrad.addColorStop(1, "rgba(104, 108, 118, 0)");
    ctx.fillStyle = mGrad;
    ctx.beginPath();
    ctx.ellipse(0, 0, rx * r, ry * r, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Highland craters & rim shading
  const rand = makePrng(384400);
  for (let i = 0; i < 140; i++) {
    const px = rand() * size;
    const py = rand() * size;
    const cr = 1.6 + Math.pow(rand(), 2.2) * 9;
    ctx.strokeStyle = rand() < 0.5 ? "rgba(255,255,250,0.28)" : "rgba(65,68,78,0.22)";
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.arc(px, py, cr, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Prominent ray craters: Tycho (south), Copernicus (west-mid), Kepler, Aristarchus
  const drawRayCrater = (nx: number, ny: number, crR: number, rayLen: number, rays: number) => {
    const cx = r + nx * r;
    const cy = r + ny * r;
    ctx.save();
    ctx.strokeStyle = "rgba(255, 252, 240, 0.34)";
    ctx.lineWidth = 1.1;
    for (let k = 0; k < rays; k++) {
      const a = (k / rays) * Math.PI * 2 + rand() * 0.25;
      const len = rayLen * r * (0.65 + rand() * 0.55);
      const gr = ctx.createLinearGradient(cx, cy, cx + Math.cos(a) * len, cy + Math.sin(a) * len);
      gr.addColorStop(0, "rgba(255, 252, 242, 0.5)");
      gr.addColorStop(1, "rgba(255, 252, 242, 0)");
      ctx.strokeStyle = gr;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len);
      ctx.stroke();
    }
    drawSoftBlob(ctx, cx, cy, crR * 1.4, 255, 252, 244, 0.85);
    ctx.restore();
  };

  drawRayCrater(-0.14, 0.66, 5, 0.72, 16); // Tycho
  drawRayCrater(-0.32, -0.08, 4.5, 0.35, 12); // Copernicus
  drawRayCrater(-0.56, -0.05, 3.5, 0.24, 9); // Kepler
  drawRayCrater(-0.62, -0.34, 3.8, 0.16, 7); // Aristarchus

  // Subtle spherical limb darkening
  const limb = ctx.createRadialGradient(r, r, r * 0.72, r, r, r);
  limb.addColorStop(0, "rgba(0,0,0,0)");
  limb.addColorStop(1, "rgba(18, 20, 28, 0.36)");
  ctx.fillStyle = limb;
  ctx.fillRect(0, 0, size, size);

  ctx.restore();
  return c;
}

export function getLunarTextureCanvas(nightVision: boolean): HTMLCanvasElement {
  if (!lunarNormal) {
    lunarNormal = buildLunarTexture();
  }
  if (nightVision) {
    if (!lunarNight) {
      lunarNight = toNightVisionCanvas(lunarNormal);
    }
    return lunarNight;
  }
  return lunarNormal;
}

const SHOWCASE_NGC_KEYS = new Set([
  "NGC253",
  "NGC869",
  "NGC884",
  "NGC2237",
  "NGC3372",
  "NGC5139",
  "NGC7000",
  "NGC7293",
]);

export function selectShowcasePhotoKey(dso: DsoEntry): string | null {
  if (dso.messier != null) {
    const key = `m${dso.messier}`;
    if (getBundledPhotoMeta(key)) return key;
  }
  const cleanId = dso.id.trim().toUpperCase().replace(/\s+/g, "");
  if (SHOWCASE_NGC_KEYS.has(cleanId)) {
    return cleanId.toLowerCase();
  }
  return null;
}

function buildFeatherSkySpriteFromImage(img: HTMLImageElement): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = DSO_SIZE;
  c.height = DSO_SIZE;
  const ctx = c.getContext("2d");
  if (!ctx) return c;

  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  const side = Math.min(iw, ih);
  const sx = (iw - side) * 0.5;
  const sy = (ih - side) * 0.5;
  ctx.drawImage(img, sx, sy, side, side, 0, 0, DSO_SIZE, DSO_SIZE);

  const imgData = ctx.getImageData(0, 0, DSO_SIZE, DSO_SIZE);
  const d = imgData.data;

  // Estimate dark-sky background floor from border pixels so additive screen blend has pure black edges
  let lumSum = 0;
  let lumCount = 0;
  for (let i = 0; i < DSO_SIZE; i += 4) {
    for (const py of [4, DSO_SIZE - 5]) {
      const idx = (py * DSO_SIZE + i) * 4;
      const lum = Math.max(d[idx], d[idx + 1], d[idx + 2]);
      if (lum < 95) {
        lumSum += lum;
        lumCount++;
      }
    }
  }
  const floor = lumCount > 10 ? Math.min(48, (lumSum / lumCount) + 6) : 14;
  const invSpan = 255 / Math.max(64, 255 - floor);

  for (let y = 0; y < DSO_SIZE; y++) {
    const ny = (y - DSO_HALF) / DSO_HALF;
    for (let x = 0; x < DSO_SIZE; x++) {
      const nx = (x - DSO_HALF) / DSO_HALF;
      const r = Math.hypot(nx, ny);
      const idx = (y * DSO_SIZE + x) * 4;
      if (r >= 0.98) {
        d[idx] = 0;
        d[idx + 1] = 0;
        d[idx + 2] = 0;
        d[idx + 3] = 0;
        continue;
      }
      const radialFade = r <= 0.52 ? 1 : Math.pow(Math.max(0, 1 - (r - 0.52) / 0.46), 1.6);
      d[idx] = Math.min(255, Math.round(Math.max(0, d[idx] - floor) * invSpan * radialFade));
      d[idx + 1] = Math.min(255, Math.round(Math.max(0, d[idx + 1] - floor) * invSpan * radialFade));
      d[idx + 2] = Math.min(255, Math.round(Math.max(0, d[idx + 2] - floor) * invSpan * radialFade));
      d[idx + 3] = Math.round(255 * radialFade);
    }
  }

  ctx.putImageData(imgData, 0, 0);
  return c;
}

export function getRealDsoSkySprite(
  dso: DsoEntry,
  nightVision: boolean,
  onLoaded?: () => void,
): HTMLCanvasElement | null {
  const key = selectShowcasePhotoKey(dso);
  if (!key) return null;

  if (nightVision) {
    const cachedNv = realDsoNight.get(key);
    if (cachedNv) return cachedNv;
    const base = getRealDsoSkySprite(dso, false, onLoaded);
    if (!base) return null;
    const nv = toNightVisionCanvas(base);
    realDsoNight.set(key, nv);
    return nv;
  }

  const cached = realDsoNormal.get(key);
  if (cached) return cached;

  const meta = getBundledPhotoMeta(key);
  if (!meta) return null;

  if (!realDsoLoading.has(key)) {
    realDsoLoading.add(key);
    const img = new Image();
    img.onload = () => {
      realDsoNormal.set(key, buildFeatherSkySpriteFromImage(img));
      realDsoLoading.delete(key);
      onLoaded?.();
    };
    img.onerror = () => {
      realDsoLoading.delete(key);
    };
    img.src = meta.src;
  }
  return null;
}

const PLANET_DISK_PHOTO_IDS = new Set([
  "sun",
  "moon",
  "mercury",
  "venus",
  "mars",
  "jupiter",
  "saturn",
  "uranus",
  "neptune",
  "pluto",
  "eris",
]);

const EQUIRECT_PLANET_TEXTURE_MAP: Record<string, string> = {
  mercury: "/textures/planets/mercury.jpg",
  venus: "/textures/planets/venus.jpg",
  mars: "/textures/planets/mars.jpg",
  jupiter: "/textures/planets/jupiter.jpg",
  saturn: "/textures/planets/saturn.jpg",
  uranus: "/textures/planets/uranus.jpg",
  neptune: "/textures/planets/neptune.jpg",
  sun: "/textures/planets/sun.jpg",
};

function buildSphereDiskFromEquirect(img: HTMLImageElement, bodyId: string): HTMLCanvasElement {
  const size = 256;
  const r = size * 0.5;
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  const srcCanvas = document.createElement("canvas");
  srcCanvas.width = w;
  srcCanvas.height = h;
  const sCtx = srcCanvas.getContext("2d");

  const out = document.createElement("canvas");
  out.width = size;
  out.height = size;
  const ctx = out.getContext("2d");
  if (!ctx || !sCtx || w < 8 || h < 8) return out;

  sCtx.drawImage(img, 0, 0);
  const srcData = sCtx.getImageData(0, 0, w, h).data;
  const outImg = ctx.createImageData(size, size);
  const dst = outImg.data;
  const lonOffset = bodyId === "jupiter" ? 0.18 : bodyId === "mars" ? 0.35 : 0.1;

  for (let py = 0; py < size; py++) {
    const ny = (py + 0.5 - r) / (r - 1.5);
    for (let px = 0; px < size; px++) {
      const nx = (px + 0.5 - r) / (r - 1.5);
      const rSq = nx * nx + ny * ny;
      const oIdx = (py * size + px) * 4;
      if (rSq > 1.0) {
        dst[oIdx + 3] = 0;
        continue;
      }
      const nz = Math.sqrt(Math.max(0, 1.0 - rSq));
      // Spherical UV (central meridian facing viewer + slight 3D foreshortening)
      const u = ((Math.atan2(nx, nz) / (Math.PI * 2) + 0.5 + lonOffset) % 1 + 1) % 1;
      const v = Math.asin(Math.max(-1, Math.min(1, ny))) / Math.PI + 0.5;
      const sx = Math.min(w - 1, Math.max(0, Math.floor(u * (w - 1))));
      const sy = Math.min(h - 1, Math.max(0, Math.floor(v * (h - 1))));
      const sIdx = (sy * w + sx) * 4;

      // Soft limb darkening (flat for Sun) and anti-aliased edge
      const limb = bodyId === "sun" ? 0.85 + 0.15 * Math.pow(nz, 0.35) : 0.42 + 0.58 * Math.pow(nz, 0.45);
      const edgeDist = Math.sqrt(rSq);
      const aa = edgeDist > 0.98 ? Math.max(0, (1.0 - edgeDist) / 0.02) : 1.0;

      dst[oIdx] = Math.min(255, Math.round(srcData[sIdx] * limb));
      dst[oIdx + 1] = Math.min(255, Math.round(srcData[sIdx + 1] * limb));
      dst[oIdx + 2] = Math.min(255, Math.round(srcData[sIdx + 2] * limb));
      dst[oIdx + 3] = Math.round(255 * aa);
    }
  }
  ctx.putImageData(outImg, 0, 0);
  return out;
}

function buildTightPlanetDiskCanvas(img: HTMLImageElement): HTMLCanvasElement {
  const size = 256;
  const r = size * 0.5;
  const tmp = document.createElement("canvas");
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  tmp.width = w;
  tmp.height = h;
  const tCtx = tmp.getContext("2d");

  let minX = 0;
  let minY = 0;
  let maxX = w - 1;
  let maxY = h - 1;

  if (tCtx && w > 16 && h > 16) {
    tCtx.drawImage(img, 0, 0);
    const midY = Math.floor(h * 0.5);
    const midX = Math.floor(w * 0.5);
    const row = tCtx.getImageData(0, midY, w, 1).data;
    const col = tCtx.getImageData(midX, 0, 1, h).data;
    const thresh = 22;

    let lx = 0;
    while (lx < w - 1 && Math.max(row[lx * 4], row[lx * 4 + 1], row[lx * 4 + 2]) < thresh) lx++;
    let rx = w - 1;
    while (rx > lx && Math.max(row[rx * 4], row[rx * 4 + 1], row[rx * 4 + 2]) < thresh) rx--;
    let ty = 0;
    while (ty < h - 1 && Math.max(col[ty * 4], col[ty * 4 + 1], col[ty * 4 + 2]) < thresh) ty++;
    let by = h - 1;
    while (by > ty && Math.max(col[by * 4], col[by * 4 + 1], col[by * 4 + 2]) < thresh) by--;

    if (rx - lx > w * 0.35 && by - ty > h * 0.35) {
      minX = lx;
      maxX = rx;
      minY = ty;
      maxY = by;
    }
  }

  const out = document.createElement("canvas");
  out.width = size;
  out.height = size;
  const ctx = out.getContext("2d");
  if (!ctx) return out;
  ctx.save();
  ctx.beginPath();
  ctx.arc(r, r, r, 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(img, minX, minY, maxX - minX + 1, maxY - minY + 1, -2, -2, size + 4, size + 4);
  ctx.restore();
  return out;
}

export function getPlanetDiskPhotoCanvas(
  bodyId: string,
  nightVision: boolean,
  onLoaded?: () => void,
): HTMLCanvasElement | null {
  const key = bodyId.toLowerCase();
  if (!PLANET_DISK_PHOTO_IDS.has(key)) return null;

  if (nightVision) {
    const cachedNv = planetDiskNight.get(key);
    if (cachedNv) return cachedNv;
    const base = getPlanetDiskPhotoCanvas(key, false, onLoaded);
    if (!base) return null;
    const nv = toNightVisionCanvas(base);
    planetDiskNight.set(key, nv);
    return nv;
  }

  const cached = planetDiskNormal.get(key);
  if (cached) return cached;

  const equirectSrc = EQUIRECT_PLANET_TEXTURE_MAP[key];
  const photoKey = key === "eris" ? "pluto" : key;
  const meta = equirectSrc
    ? { src: equirectSrc }
    : getBundledPhotoMeta(photoKey);
  if (!meta) return null;

  if (!planetDiskLoading.has(key)) {
    planetDiskLoading.add(key);
    const img = new Image();
    img.onload = () => {
      planetDiskNormal.set(
        key,
        equirectSrc ? buildSphereDiskFromEquirect(img, key) : buildTightPlanetDiskCanvas(img),
      );
      planetDiskLoading.delete(key);
      onLoaded?.();
    };
    img.onerror = () => {
      planetDiskLoading.delete(key);
    };
    img.src = meta.src;
  }
  return null;
}
