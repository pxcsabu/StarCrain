import * as THREE from "three";
import type { CompiledProjectionContext } from "@/lib/projection";
import type { LandscapeConfig, SkyFrame } from "@/types/sky";

export type Terrain3dPresetId = "mountain" | "coast" | "observatory" | "desert";

const DEG2RAD = Math.PI / 180;
const MAX_CUBE_CACHE = 6;

const PROJ_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// Native-resolution GPU cubemap projection matching projection.ts formulas across:
//   uProjMode = 0: Stereographic & Hemisphere (using uBasisR, uBasisU, uBasisF, uScCenter, uInvScR, uIsHemi)
//   uProjMode = 1: All-sky Polar (using uScCenter, uAllSkyR, uCenterAzRad)
//   uProjMode = 2: Panorama Equirectangular (using uScCenter, uPanoScale, uCenterAzDeg, uCenterAltDeg)
const PROJ_FRAG = /* glsl */ `
uniform samplerCube uCubeMap;
uniform int uProjMode;
uniform vec2 uCanvasSize;
uniform vec2 uScCenter;
uniform float uInvScR;
uniform float uIsHemi;
uniform vec3 uBasisR;
uniform vec3 uBasisU;
uniform vec3 uBasisF;
uniform float uAllSkyR;
uniform float uCenterAzRad;
uniform vec2 uPanoScale;
uniform float uCenterAzDeg;
uniform float uCenterAltDeg;
uniform float uAzOffRad;
uniform float uAltOffRad;
uniform float uOpacity;
uniform float uNightVision;
uniform float uInverted;

varying vec2 vUv;

vec3 acesFilmic(vec3 x) {
  float a = 2.51;
  float b = 0.03;
  float c = 2.43;
  float d = 0.59;
  float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

void main() {
  float x = vUv.x * uCanvasSize.x;
  float y = (1.0 - vUv.y) * uCanvasSize.y;

  float vx = 0.0; // East
  float vy = 0.0; // North
  float vz = 1.0; // Up

  if (uProjMode == 0) {
    float us = (x - uScCenter.x) * uInvScR;
    float vs = (uScCenter.y - y) * uInvScR;
    float s2 = us * us + vs * vs;
    if (uIsHemi > 0.5 && s2 > 1.0) {
      discard;
    }
    float inv = 1.0 / (1.0 + s2);
    float xc = 2.0 * us * inv;
    float yc = 2.0 * vs * inv;
    float zc = (1.0 - s2) * inv;
    vx = uBasisR.x * xc + uBasisU.x * yc + uBasisF.x * zc;
    vy = uBasisR.y * xc + uBasisU.y * yc + uBasisF.y * zc;
    vz = uBasisR.z * xc + uBasisU.z * yc + uBasisF.z * zc;
  } else if (uProjMode == 1) {
    float dx = x - uScCenter.x;
    float dy = y - uScCenter.y;
    float rho = length(vec2(dx, dy));
    if (rho > uAllSkyR) {
      discard;
    }
    float alt = 1.57079632679 * (1.0 - rho / max(1.0, uAllSkyR));
    float az = rho < 1e-4 ? uCenterAzRad : uCenterAzRad + atan(dx, dy);
    float ca = cos(alt);
    vx = ca * sin(az);
    vy = ca * cos(az);
    vz = sin(alt);
  } else {
    float dAzDeg = (x - uScCenter.x) / max(0.01, uPanoScale.x);
    if (abs(dAzDeg) > 180.0) {
      discard;
    }
    float altDeg = uCenterAltDeg + (uScCenter.y - y) / max(0.01, uPanoScale.y);
    if (altDeg < -90.0 || altDeg > 90.0) {
      discard;
    }
    float az = (uCenterAzDeg + dAzDeg) * 0.01745329252;
    float alt = altDeg * 0.01745329252;
    float ca = cos(alt);
    vx = ca * sin(az);
    vy = ca * cos(az);
    vz = sin(alt);
  }

  vec3 dir;
  if (abs(uAzOffRad) > 1e-4 || abs(uAltOffRad) > 1e-4) {
    float rXy = length(vec2(vx, vy));
    float az = (rXy < 1e-6 ? 0.0 : atan(vx, vy)) - uAzOffRad;
    float alt = clamp(asin(clamp(vz, -1.0, 1.0)) - uAltOffRad, -1.5707, 1.5707);
    float ca = cos(alt);
    dir = vec3(ca * sin(az), sin(alt), -ca * cos(az));
  } else {
    // Fast direct vector conversion: (East=+X, Up=+Y, North=-Z)
    dir = normalize(vec3(vx, vz, -vy));
  }

  vec4 c = textureCube(uCubeMap, dir);
  if (c.a <= 0.008) {
    discard;
  }

  vec3 straightLin = clamp(c.rgb / c.a, 0.0, 6.0);
  vec3 mapped = acesFilmic(straightLin * 1.16);
  vec3 col = pow(mapped, vec3(1.0 / 2.2));

  if (uInverted > 0.5) {
    float lum = dot(col, vec3(0.299, 0.587, 0.114));
    float val = clamp(0.72 + lum * 0.24, 0.0, 1.0);
    col = vec3(val, val, min(1.0, val + 0.03));
  } else if (uNightVision > 0.5) {
    float lum = dot(col, vec3(0.299, 0.587, 0.114));
    col = vec3(min(1.0, lum * 1.15), 0.0, 0.0);
  }

  float outA = clamp(c.a * uOpacity, 0.0, 1.0);
  gl_FragColor = vec4(col * outA, outA);
}
`;

interface PbrTexturePair {
  map: THREE.CanvasTexture;
  normalMap: THREE.CanvasTexture;
}

interface PbrTextureSuite {
  meadow: PbrTexturePair;
  rock: PbrTexturePair;
  foliage: PbrTexturePair;
  bark: PbrTexturePair;
  sand: PbrTexturePair;
  woodDeck: PbrTexturePair;
  waterNormal: THREE.CanvasTexture;
}

interface BakedCubeEntry {
  rt: THREE.WebGLCubeRenderTarget;
}

interface TerrainEngineState {
  renderer: THREE.WebGLRenderer;
  cubeSize: number;
  projScene: THREE.Scene;
  projCam: THREE.OrthographicCamera;
  projUniforms: {
    uCubeMap: { value: THREE.Texture | null };
    uProjMode: { value: number };
    uCanvasSize: { value: THREE.Vector2 };
    uScCenter: { value: THREE.Vector2 };
    uInvScR: { value: number };
    uIsHemi: { value: number };
    uBasisR: { value: THREE.Vector3 };
    uBasisU: { value: THREE.Vector3 };
    uBasisF: { value: THREE.Vector3 };
    uAllSkyR: { value: number };
    uCenterAzRad: { value: number };
    uPanoScale: { value: THREE.Vector2 };
    uCenterAzDeg: { value: number };
    uCenterAltDeg: { value: number };
    uAzOffRad: { value: number };
    uAltOffRad: { value: number };
    uOpacity: { value: number };
    uNightVision: { value: number };
    uInverted: { value: number };
  };
  pbr: PbrTextureSuite;
  cache: Map<string, BakedCubeEntry>;
  lastRw: number;
  lastRh: number;
}

let engineState: TerrainEngineState | null = null;
let webglDisabled = false;

function hash2D(ix: number, iz: number): number {
  const n = Math.sin(ix * 127.1 + iz * 311.7) * 43758.5453123;
  return n - Math.floor(n);
}

function periodicNoise(u: number, v: number, freq: number): number {
  const x = u * freq;
  const y = v * freq;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const ix0 = ((ix % freq) + freq) % freq;
  const ix1 = (ix0 + 1) % freq;
  const iy0 = ((iy % freq) + freq) % freq;
  const iy1 = (iy0 + 1) % freq;
  const a = hash2D(ix0, iy0);
  const b = hash2D(ix1, iy0);
  const c = hash2D(ix0, iy1);
  const d = hash2D(ix1, iy1);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

function periodicFbm(u: number, v: number, baseFreq: number, octaves = 4): number {
  let sum = 0;
  let amp = 0.5;
  let f = baseFreq;
  for (let i = 0; i < octaves; i++) {
    sum += amp * periodicNoise(u, v, f);
    f *= 2;
    amp *= 0.5;
  }
  return sum;
}

function buildSeamlessPbrPair(
  size: number,
  repeat: number,
  normalStrength: number,
  maxAniso: number,
  pixelFn: (u: number, v: number) => { r: number; g: number; b: number; h: number },
): PbrTexturePair {
  const heightMap = new Float32Array(size * size);
  const cMap = document.createElement("canvas");
  cMap.width = size;
  cMap.height = size;
  const ctxA = cMap.getContext("2d")!;
  const imgA = ctxA.createImageData(size, size);
  const dA = imgA.data;

  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const p = pixelFn(u, v);
      const i = y * size + x;
      heightMap[i] = p.h;
      const i4 = i * 4;
      dA[i4] = Math.max(0, Math.min(255, Math.round(p.r)));
      dA[i4 + 1] = Math.max(0, Math.min(255, Math.round(p.g)));
      dA[i4 + 2] = Math.max(0, Math.min(255, Math.round(p.b)));
      dA[i4 + 3] = 255;
    }
  }
  ctxA.putImageData(imgA, 0, 0);

  const cNorm = document.createElement("canvas");
  cNorm.width = size;
  cNorm.height = size;
  const ctxN = cNorm.getContext("2d")!;
  const imgN = ctxN.createImageData(size, size);
  const dN = imgN.data;

  for (let y = 0; y < size; y++) {
    const ym = (y - 1 + size) % size;
    const yp = (y + 1) % size;
    for (let x = 0; x < size; x++) {
      const xm = (x - 1 + size) % size;
      const xp = (x + 1) % size;
      const dhx = (heightMap[y * size + xp] - heightMap[y * size + xm]) * normalStrength;
      const dhy = (heightMap[yp * size + x] - heightMap[ym * size + x]) * normalStrength;
      const invLen = 1 / Math.hypot(dhx, dhy, 1);
      const nx = -dhx * invLen;
      const ny = -dhy * invLen;
      const nz = invLen;
      const i4 = (y * size + x) * 4;
      dN[i4] = Math.round((nx * 0.5 + 0.5) * 255);
      dN[i4 + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      dN[i4 + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      dN[i4 + 3] = 255;
    }
  }
  ctxN.putImageData(imgN, 0, 0);

  const map = new THREE.CanvasTexture(cMap);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.RepeatWrapping;
  map.repeat.set(repeat, repeat);
  map.anisotropy = Math.min(8, maxAniso);
  map.needsUpdate = true;

  const normalMap = new THREE.CanvasTexture(cNorm);
  normalMap.colorSpace = THREE.NoColorSpace;
  normalMap.wrapS = THREE.RepeatWrapping;
  normalMap.wrapT = THREE.RepeatWrapping;
  normalMap.repeat.set(repeat, repeat);
  normalMap.anisotropy = Math.min(8, maxAniso);
  normalMap.needsUpdate = true;

  return { map, normalMap };
}

function createPbrTextureSuite(maxAniso: number): PbrTextureSuite {
  // 1. Rich alpine meadow / soil / moss / tiny gravel pebbles (used on continuous terrain mesh)
  const meadow = buildSeamlessPbrPair(256, 1, 5.2, maxAniso, (u, v) => {
    const macro = periodicFbm(u, v, 4, 4);
    const blade = periodicNoise(u, v, 48);
    const speckle = periodicNoise(u + 0.37, v + 0.19, 96);
    const pebble = speckle > 0.84 ? (speckle - 0.84) * 4.5 : 0;
    const h = macro * 0.45 + blade * 0.35 + pebble * 0.45;
    // Neutral luminance + organic texture detail so terrain vertex colors control biome cleanly
    const l = 165 + macro * 55 + blade * 32 + pebble * 42;
    return {
      r: l * (0.94 + blade * 0.08),
      g: l * (1.02 + blade * 0.06),
      b: l * (0.92 + macro * 0.06),
      h,
    };
  });

  // 2. Stratified granite rock texture for boulders & cliffs
  const rock = buildSeamlessPbrPair(256, 1, 6.5, maxAniso, (u, v) => {
    const strata = periodicFbm(u * 0.5, v * 2.2, 6, 4);
    const crack = Math.abs(periodicNoise(u, v, 16) - 0.5) * 2;
    const grain = periodicNoise(u + 0.13, v + 0.41, 64);
    const h = strata * 0.6 + crack * 0.25 + grain * 0.2;
    const vShade = 84 + strata * 68 + grain * 26 - (crack < 0.08 ? 28 : 0);
    return { r: vShade * 0.96, g: vShade * 0.99, b: vShade * 1.05, h };
  });

  // 3. Textured pine foliage
  const foliage = buildSeamlessPbrPair(256, 2, 4.8, maxAniso, (u, v) => {
    const tuft = periodicFbm(u, v, 8, 3);
    const needles = periodicNoise(u * 2.0, v * 0.5, 48);
    const h = tuft * 0.5 + needles * 0.5;
    return {
      r: 32 + tuft * 34 + needles * 18,
      g: 56 + tuft * 48 + needles * 28,
      b: 38 + tuft * 28 + needles * 14,
      h,
    };
  });

  // 4. Vertical grooved conifer bark
  const bark = buildSeamlessPbrPair(128, 2, 5.5, maxAniso, (u, v) => {
    const groove = Math.sin(u * Math.PI * 16 + periodicNoise(u, v, 6) * 2.2) * 0.5 + 0.5;
    const fine = periodicNoise(u, v, 24);
    const h = groove * 0.7 + fine * 0.3;
    const c = 44 + groove * 42 + fine * 16;
    return { r: c * 1.15, g: c * 0.86, b: c * 0.68, h };
  });

  // 5. Wind-rippled sand & beach shingle
  const sand = buildSeamlessPbrPair(256, 1, 4.2, maxAniso, (u, v) => {
    const warp = periodicFbm(u, v, 4, 3);
    const ripple = Math.sin((u * 10 + v * 4 + warp * 1.6) * Math.PI * 2) * 0.5 + 0.5;
    const grain = periodicNoise(u, v, 96);
    const h = ripple * 0.65 + warp * 0.25 + grain * 0.18;
    const lum = 186 + ripple * 36 + grain * 18;
    return { r: lum * 1.04, g: lum * 0.96, b: lum * 0.84, h };
  });

  // 6. Observatory wooden deck planks
  const woodDeck = buildSeamlessPbrPair(256, 2, 5.6, maxAniso, (u, v) => {
    const plankV = (v * 8) % 1;
    const seam = plankV < 0.06 || plankV > 0.94 ? 0 : 1;
    const plankId = Math.floor(v * 8);
    const tint = 0.9 + ((plankId * 37) % 10) * 0.02;
    const grain = periodicFbm(u * 0.35, v * 5.0, 12, 3);
    const h = seam * (0.5 + grain * 0.45);
    const lum = (74 + grain * 42) * tint * (seam ? 1 : 0.42);
    return { r: lum * 1.18, g: lum * 0.92, b: lum * 0.72, h };
  });

  // 7. Ocean wave normal map
  const seaSize = 256;
  const cSea = document.createElement("canvas");
  cSea.width = seaSize;
  cSea.height = seaSize;
  const gSea = cSea.getContext("2d")!;
  const imgSea = gSea.createImageData(seaSize, seaSize);
  const dSea = imgSea.data;
  const tau = Math.PI * 2;
  for (let y = 0; y < seaSize; y++) {
    const vv = (y / seaSize) * tau;
    for (let x = 0; x < seaSize; x++) {
      const uu = (x / seaSize) * tau;
      const dx =
        0.34 * Math.cos(uu * 3 + vv * 2) +
        0.24 * Math.cos(uu * 7 - vv * 5) +
        0.16 * Math.cos(uu * 13 + vv * 11) +
        0.1 * Math.cos(uu * 23 - vv * 17);
      const dy =
        0.38 * Math.sin(vv * 4 - uu * 2) +
        0.26 * Math.sin(vv * 9 + uu * 4) +
        0.17 * Math.sin(vv * 15 - uu * 8) +
        0.11 * Math.sin(vv * 25 + uu * 19);
      const len = Math.hypot(dx, dy, 1.0);
      const idx = (y * seaSize + x) * 4;
      dSea[idx] = Math.round(((dx / len) * 0.5 + 0.5) * 255);
      dSea[idx + 1] = Math.round(((dy / len) * 0.5 + 0.5) * 255);
      dSea[idx + 2] = Math.round(((1.0 / len) * 0.5 + 0.5) * 255);
      dSea[idx + 3] = 255;
    }
  }
  gSea.putImageData(imgSea, 0, 0);
  const waterNormal = new THREE.CanvasTexture(cSea);
  waterNormal.wrapS = THREE.RepeatWrapping;
  waterNormal.wrapT = THREE.RepeatWrapping;
  waterNormal.repeat.set(48, 48);
  waterNormal.anisotropy = Math.min(8, maxAniso);
  waterNormal.needsUpdate = true;

  return { meadow, rock, foliage, bark, sand, woodDeck, waterNormal };
}

function getOrCreateEngine(): TerrainEngineState | null {
  if (webglDisabled) return null;
  if (engineState) return engineState;
  if (typeof document === "undefined") {
    webglDisabled = true;
    return null;
  }
  try {
    const renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      powerPreference: "high-performance",
      premultipliedAlpha: true,
      preserveDrawingBuffer: true,
    });
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.shadowMap.autoUpdate = false;
    renderer.toneMapping = THREE.NoToneMapping;

    const isSmallScreen = typeof window !== "undefined" && Math.min(window.innerWidth, window.innerHeight) < 600;
    const cubeSize = isSmallScreen ? 768 : 1024;
    const maxAniso = renderer.capabilities.getMaxAnisotropy();

    const projUniforms = {
      uCubeMap: { value: null as THREE.Texture | null },
      uProjMode: { value: 0 },
      uCanvasSize: { value: new THREE.Vector2(800, 600) },
      uScCenter: { value: new THREE.Vector2(400, 300) },
      uInvScR: { value: 0.002 },
      uIsHemi: { value: 0 },
      uBasisR: { value: new THREE.Vector3(1, 0, 0) },
      uBasisU: { value: new THREE.Vector3(0, 1, 0) },
      uBasisF: { value: new THREE.Vector3(0, 0, 1) },
      uAllSkyR: { value: 300 },
      uCenterAzRad: { value: Math.PI },
      uPanoScale: { value: new THREE.Vector2(2, 2) },
      uCenterAzDeg: { value: 180 },
      uCenterAltDeg: { value: 20 },
      uAzOffRad: { value: 0 },
      uAltOffRad: { value: 0 },
      uOpacity: { value: 1.0 },
      uNightVision: { value: 0 },
      uInverted: { value: 0 },
    };

    const projScene = new THREE.Scene();
    const projCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const quad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        uniforms: projUniforms,
        vertexShader: PROJ_VERT,
        fragmentShader: PROJ_FRAG,
        transparent: false,
        depthTest: false,
        depthWrite: false,
      }),
    );
    projScene.add(quad);

    engineState = {
      renderer,
      cubeSize,
      projScene,
      projCam,
      projUniforms,
      pbr: createPbrTextureSuite(maxAniso),
      cache: new Map(),
      lastRw: 0,
      lastRh: 0,
    };
    return engineState;
  } catch {
    webglDisabled = true;
    return null;
  }
}

function valueNoise2D(x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);
  const a = hash2D(ix, iz);
  const b = hash2D(ix + 1, iz);
  const c = hash2D(ix, iz + 1);
  const d = hash2D(ix + 1, iz + 1);
  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}

function fbm(x: number, z: number, octaves = 4): number {
  let val = 0;
  let amp = 0.5;
  let freq = 1;
  for (let i = 0; i < octaves; i++) {
    val += amp * valueNoise2D(x * freq, z * freq);
    freq *= 2.04;
    amp *= 0.5;
  }
  return val;
}

function ridged(x: number, z: number, octaves = 4): number {
  let val = 0;
  let amp = 0.5;
  let freq = 1;
  let weight = 1;
  for (let i = 0; i < octaves; i++) {
    let n = 1 - Math.abs(valueNoise2D(x * freq, z * freq) * 2 - 1);
    n = n * n * weight;
    weight = Math.max(0.22, Math.min(1, n * 1.45));
    val += n * amp;
    freq *= 2.08;
    amp *= 0.5;
  }
  return val;
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

function azAltToVec3(azDeg: number, altDeg: number, dist = 1): THREE.Vector3 {
  const az = azDeg * DEG2RAD;
  const alt = altDeg * DEG2RAD;
  const ca = Math.cos(alt);
  return new THREE.Vector3(dist * ca * Math.sin(az), dist * Math.sin(alt), -dist * ca * Math.cos(az));
}

/**
 * Seamless radial terrain starting cleanly from a single pole at `(0, y0, 0)` (zero inner circle seam),
 * with world-space planar UV tiling and finite-difference crevice Ambient Occlusion.
 */
function buildSeamlessTerrainMesh(
  rMax: number,
  angSegs: number,
  radSegs: number,
  uvScale: number,
  pbr: PbrTexturePair,
  normalScaleVal: number,
  roughness: number,
  sampleFn: (x: number, z: number, r: number, az: number) => { y: number; color: [number, number, number] },
): THREE.Mesh {
  const vCount = 1 + angSegs * radSegs;
  const positions = new Float32Array(vCount * 3);
  const colors = new Float32Array(vCount * 3);
  const uvs = new Float32Array(vCount * 2);
  const indices: number[] = [];

  // Center pole vertex at (0, heightAt(0, 0), 0)
  const center = sampleFn(0, 0, 0, 0);
  positions[0] = 0;
  positions[1] = center.y;
  positions[2] = 0;
  colors[0] = center.color[0];
  colors[1] = center.color[1];
  colors[2] = center.color[2];
  uvs[0] = 0;
  uvs[1] = 0;

  let ptr = 1;
  for (let ir = 1; ir <= radSegs; ir++) {
    const t = ir / radSegs;
    // Pow 2.35 gives dense 0.2..1.5m detail around feet out to 460m peaks
    const r = rMax * Math.pow(t, 2.35);
    const eps = Math.max(0.4, r * 0.045);
    for (let ia = 0; ia < angSegs; ia++) {
      const az = (ia / angSegs) * Math.PI * 2;
      const x = r * Math.sin(az);
      const z = -r * Math.cos(az);
      const s = sampleFn(x, z, r, az);

      // Finite-difference crevice AO: valleys & depressions darken softly
      const hL = sampleFn(x - eps, z, Math.hypot(x - eps, z), Math.atan2(x - eps, -z)).y;
      const hR = sampleFn(x + eps, z, Math.hypot(x + eps, z), Math.atan2(x + eps, -z)).y;
      const hF = sampleFn(x, z - eps, Math.hypot(x, z - eps), Math.atan2(x, -(z - eps))).y;
      const hB = sampleFn(x, z + eps, Math.hypot(x, z + eps), Math.atan2(x, -(z + eps))).y;
      const avgNeighbor = (hL + hR + hF + hB) * 0.25;
      const cavity = Math.max(0, (avgNeighbor - s.y) / Math.max(0.5, eps * 0.45));
      const ao = 1.0 - Math.min(0.38, cavity * 0.26);

      positions[ptr * 3] = x;
      positions[ptr * 3 + 1] = s.y;
      positions[ptr * 3 + 2] = z;
      colors[ptr * 3] = s.color[0] * ao;
      colors[ptr * 3 + 1] = s.color[1] * ao;
      colors[ptr * 3 + 2] = s.color[2] * ao;
      uvs[ptr * 2] = x * uvScale;
      uvs[ptr * 2 + 1] = z * uvScale;
      ptr++;
    }
  }

  // First fan around center vertex 0 (counter-clockwise upward +Y winding)
  for (let ia = 0; ia < angSegs; ia++) {
    const nextIa = (ia + 1) % angSegs;
    indices.push(0, 1 + nextIa, 1 + ia);
  }

  // Concentric rings (counter-clockwise upward +Y winding)
  for (let ir = 1; ir < radSegs; ir++) {
    const ring0 = 1 + (ir - 1) * angSegs;
    const ring1 = 1 + ir * angSegs;
    for (let ia = 0; ia < angSegs; ia++) {
      const nextIa = (ia + 1) % angSegs;
      const a = ring0 + ia;
      const b = ring0 + nextIa;
      const c = ring1 + ia;
      const d = ring1 + nextIa;
      indices.push(a, b, c, b, d, c);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    map: pbr.map,
    normalMap: pbr.normalMap,
    normalScale: new THREE.Vector2(normalScaleVal, normalScaleVal),
    roughness,
    metalness: 0.03,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** Build a sculpted granite boulder perturbed by deterministic 3D harmonics + rock PBR normal map. */
function makeSculptedBoulderGeo(radius: number, seed: number): THREE.BufferGeometry {
  const geo = new THREE.IcosahedronGeometry(radius, 2);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const vx = pos.getX(i);
    const vy = pos.getY(i);
    const vz = pos.getZ(i);
    const d =
      1 +
      0.22 * Math.sin(vx * 2.4 + seed) * Math.cos(vz * 2.1 - seed) +
      0.14 * Math.sin(vy * 3.8 + vz * 3.1 + seed * 1.7);
    pos.setXYZ(i, vx * d, vy * d * 0.72, vz * d);
  }
  geo.computeVertexNormals();
  return geo;
}

/** 4-tier realistic ruffled pine tree + bark trunk instancing with cast & receive shadows. */
function addDetailedPines(
  scene: THREE.Scene,
  disposables: { dispose(): void }[],
  pbr: PbrTextureSuite,
  trees: { x: number; y: number; z: number; scale: number }[],
) {
  if (trees.length === 0) return;

  const trunkGeo = new THREE.CylinderGeometry(0.11, 0.22, 1.35, 6);
  trunkGeo.translate(0, 0.65, 0);
  const trunkMat = new THREE.MeshStandardMaterial({
    map: pbr.bark.map,
    normalMap: pbr.bark.normalMap,
    normalScale: new THREE.Vector2(0.85, 0.85),
    roughness: 0.94,
  });

  const makeTier = (rBot: number, h: number, yBase: number, tierSeed: number) => {
    const g = new THREE.ConeGeometry(rBot, h, 9, 2);
    const pos = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const py = pos.getY(i);
      if (py < h * 0.45) {
        const px = pos.getX(i);
        const pz = pos.getZ(i);
        const ang = Math.atan2(pz, px);
        const ruffle = 1 + 0.16 * Math.sin(ang * 5 + tierSeed) + 0.08 * Math.cos(py * 3.2);
        pos.setX(i, px * ruffle);
        pos.setZ(i, pz * ruffle);
      }
    }
    g.translate(0, yBase + h * 0.5, 0);
    g.computeVertexNormals();
    return g;
  };

  const t1Geo = makeTier(1.22, 1.85, 0.95, 0.5);
  const t2Geo = makeTier(0.98, 1.65, 2.05, 1.7);
  const t3Geo = makeTier(0.74, 1.45, 3.05, 3.1);
  const t4Geo = makeTier(0.46, 1.15, 3.95, 4.4);

  const folMat = new THREE.MeshStandardMaterial({
    map: pbr.foliage.map,
    normalMap: pbr.foliage.normalMap,
    normalScale: new THREE.Vector2(0.95, 0.95),
    roughness: 0.88,
    metalness: 0.02,
  });

  const trunkInst = new THREE.InstancedMesh(trunkGeo, trunkMat, trees.length);
  const i1 = new THREE.InstancedMesh(t1Geo, folMat, trees.length);
  const i2 = new THREE.InstancedMesh(t2Geo, folMat, trees.length);
  const i3 = new THREE.InstancedMesh(t3Geo, folMat, trees.length);
  const i4 = new THREE.InstancedMesh(t4Geo, folMat, trees.length);

  for (const inst of [trunkInst, i1, i2, i3, i4]) {
    inst.castShadow = true;
    inst.receiveShadow = true;
  }

  const dummy = new THREE.Object3D();
  const col = new THREE.Color();
  trees.forEach((t, i) => {
    dummy.position.set(t.x, t.y - 0.12, t.z);
    dummy.rotation.set(
      (((i * 13) % 7) - 3) * 0.015,
      (i * 2.3999) % (Math.PI * 2),
      (((i * 17) % 7) - 3) * 0.015,
    );
    const sx = t.scale * (0.9 + (i % 5) * 0.05);
    const sy = t.scale * (0.85 + ((i * 3) % 7) * 0.06);
    dummy.scale.set(sx, sy, sx);
    dummy.updateMatrix();
    trunkInst.setMatrixAt(i, dummy.matrix);
    i1.setMatrixAt(i, dummy.matrix);
    i2.setMatrixAt(i, dummy.matrix);
    i3.setMatrixAt(i, dummy.matrix);
    i4.setMatrixAt(i, dummy.matrix);

    const tone = 0.84 + ((i * 29) % 10) * 0.032;
    col.setRGB(tone * 0.94, tone * 1.04, tone * 0.96);
    i1.setColorAt(i, col);
    i2.setColorAt(i, col);
    i3.setColorAt(i, col);
    i4.setColorAt(i, col);
  });

  for (const inst of [trunkInst, i1, i2, i3, i4]) {
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    scene.add(inst);
  }
  disposables.push(trunkGeo, t1Geo, t2Geo, t3Geo, t4Geo, trunkMat, folMat);
}

/** Instanced grass tufts / scrub bushes to break up close ground around the observer. */
function addGrassTufts(
  scene: THREE.Scene,
  disposables: { dispose(): void }[],
  tufts: { x: number; y: number; z: number; scale: number }[],
  tintHex: number,
) {
  if (tufts.length === 0) return;
  const tuftGeo = new THREE.ConeGeometry(0.32, 0.55, 5);
  tuftGeo.translate(0, 0.22, 0);
  const tuftMat = new THREE.MeshStandardMaterial({
    color: tintHex,
    roughness: 0.94,
  });
  const inst = new THREE.InstancedMesh(tuftGeo, tuftMat, tufts.length);
  inst.castShadow = true;
  inst.receiveShadow = true;
  const dummy = new THREE.Object3D();
  tufts.forEach((t, i) => {
    dummy.position.set(t.x, t.y - 0.04, t.z);
    dummy.rotation.set(0.12 * Math.sin(i), i * 1.7, 0.1 * Math.cos(i));
    dummy.scale.set(t.scale, t.scale * (0.7 + (i % 4) * 0.18), t.scale);
    dummy.updateMatrix();
    inst.setMatrixAt(i, dummy.matrix);
  });
  inst.instanceMatrix.needsUpdate = true;
  scene.add(inst);
  disposables.push(tuftGeo, tuftMat);
}

function populateMountainScene(
  scene: THREE.Scene,
  disposables: { dispose(): void }[],
  pbr: PbrTextureSuite,
  isNight: boolean,
) {
  const heightAt = (x: number, z: number, r: number, az: number): { y: number; color: [number, number, number] } => {
    const clearMask = smoothstep(5.5, 34, r);
    const farMask = smoothstep(48, 175, r);
    const rangeWeight = 0.65 + 0.45 * Math.sin(az - 0.65) + 0.3 * Math.cos(az * 2 + 1.1);
    const micro = fbm(x * 0.11 + 1.2, z * 0.11 - 0.8, 2) * 0.38;
    const hill = fbm(x * 0.024 + 3.1, z * 0.024 - 1.7, 3) * 9.0 * clearMask;
    const peaks = ridged(x * 0.0085 - 2.4, z * 0.0085 + 4.3, 4) * 34.0 * farMask * Math.max(0.28, rangeWeight);
    const y = -1.78 + micro * 0.65 + hill + peaks - smoothstep(320, 440, r) * 8.0;

    // Trail pebble strip heading North-East + meadow -> forest -> cliff -> snowcap
    const dirtTrack = Math.exp(-Math.pow((x - Math.sin(z * 0.08) * 1.5) / 1.8, 2)) * (1 - smoothstep(10, 45, r));
    const meadow: [number, number, number] = [0.22, 0.32, 0.21];
    const trail: [number, number, number] = [0.36, 0.31, 0.25];
    const forest: [number, number, number] = [0.16, 0.25, 0.18];
    const rock: [number, number, number] = [0.38, 0.41, 0.46];
    const snow: [number, number, number] = [0.88, 0.92, 0.98];

    const foreT = smoothstep(16, 65, r);
    const rockT = smoothstep(6.2, 14.0, y);
    const snowT = smoothstep(16.5, 24.5, y);

    let c0 = meadow[0] + (trail[0] - meadow[0]) * dirtTrack;
    let c1 = meadow[1] + (trail[1] - meadow[1]) * dirtTrack;
    let c2 = meadow[2] + (trail[2] - meadow[2]) * dirtTrack;

    c0 = c0 + (forest[0] - c0) * foreT;
    c1 = c1 + (forest[1] - c1) * foreT;
    c2 = c2 + (forest[2] - c2) * foreT;

    c0 = c0 + (rock[0] - c0) * rockT;
    c1 = c1 + (rock[1] - c1) * rockT;
    c2 = c2 + (rock[2] - c2) * rockT;

    c0 = c0 + (snow[0] - c0) * snowT;
    c1 = c1 + (snow[1] - c1) * snowT;
    c2 = c2 + (snow[2] - c2) * snowT;

    return { y, color: [c0, c1, c2] };
  };

  const terrain = buildSeamlessTerrainMesh(440, 192, 68, 0.22, pbr.meadow, 1.05, 0.93, heightAt);
  scene.add(terrain);
  disposables.push(terrain.geometry, terrain.material as THREE.Material);

  // Foreground boulders sunk cleanly into terrain with real rock PBR + shadows
  const rockMat = new THREE.MeshStandardMaterial({
    map: pbr.rock.map,
    normalMap: pbr.rock.normalMap,
    normalScale: new THREE.Vector2(1.15, 1.15),
    roughness: 0.88,
  });
  for (let i = 0; i < 24; i++) {
    const az = (i * 2.399 + 0.4) % (Math.PI * 2);
    const r = 4.2 + ((i * 19) % 24);
    const x = r * Math.sin(az);
    const z = -r * Math.cos(az);
    const { y } = heightAt(x, z, r, az);
    const rad = 0.35 + (i % 4) * 0.22;
    const g = makeSculptedBoulderGeo(rad, i * 1.7);
    const m = new THREE.Mesh(g, rockMat);
    m.position.set(x, y + rad * 0.28, z);
    m.rotation.set(0.2 * i, i * 1.1, 0.15 * i);
    m.castShadow = true;
    m.receiveShadow = true;
    scene.add(m);
    disposables.push(g);
  }
  disposables.push(rockMat);

  // Grass tufts right around the clearing so foreground has tactile depth
  const tufts: { x: number; y: number; z: number; scale: number }[] = [];
  for (let i = 0; i < 160; i++) {
    const az = (i * 2.39996) % (Math.PI * 2);
    const r = 3.2 + ((i * 29) % 24);
    const x = r * Math.sin(az);
    const z = -r * Math.cos(az);
    const { y } = heightAt(x, z, r, az);
    tufts.push({ x, y, z, scale: 0.65 + (i % 5) * 0.2 });
  }
  addGrassTufts(scene, disposables, tufts, 0x2e462d);

  // Lush 4-tier conifer pine forest on slopes
  const trees: { x: number; y: number; z: number; scale: number }[] = [];
  for (let i = 0; i < 440; i++) {
    const az = (i * 2.399963) % (Math.PI * 2);
    const r = 13.5 + ((i * 73) % 88);
    const x = r * Math.sin(az);
    const z = -r * Math.cos(az);
    const { y } = heightAt(x, z, r, az);
    if (y < 9.8) {
      trees.push({ x, y, z, scale: 0.85 + ((i * 19) % 10) * 0.08 });
    }
  }
  addDetailedPines(scene, disposables, pbr, trees);

  // Subtle camp lantern on a stone at South-East edge (~9.5m away) casting warm ground glow at night
  const lAz = 2.15;
  const lR = 9.5;
  const lx = lR * Math.sin(lAz);
  const lz = -lR * Math.cos(lAz);
  const ly = heightAt(lx, lz, lR, lAz).y;
  const lanternBodyG = new THREE.CylinderGeometry(0.11, 0.13, 0.28, 10);
  const lanternBodyM = new THREE.MeshStandardMaterial({
    color: 0xffd27d,
    emissive: 0xff8c24,
    emissiveIntensity: isNight ? 2.2 : 0.2,
    roughness: 0.3,
  });
  const lMesh = new THREE.Mesh(lanternBodyG, lanternBodyM);
  lMesh.position.set(lx, ly + 0.16, lz);
  scene.add(lMesh);
  disposables.push(lanternBodyG, lanternBodyM);
  if (isNight) {
    const campGlow = new THREE.PointLight(0xff9642, 16, 20, 1.8);
    campGlow.position.set(lx, ly + 0.32, lz);
    campGlow.castShadow = true;
    campGlow.shadow.mapSize.set(512, 512);
    scene.add(campGlow);
  }
}

function populateCoastScene(
  scene: THREE.Scene,
  disposables: { dispose(): void }[],
  pbr: PbrTextureSuite,
  isNight: boolean,
) {
  // Shimmering ocean water plane catching real Sun / Moon reflection glints
  const seaGeo = new THREE.CircleGeometry(460, 96);
  seaGeo.rotateX(-Math.PI / 2);
  seaGeo.translate(0, -1.78, 0);
  const seaMat = new THREE.MeshStandardMaterial({
    color: 0x0b2a47,
    roughness: 0.14,
    metalness: 0.38,
    normalMap: pbr.waterNormal,
    normalScale: new THREE.Vector2(0.55, 0.55),
  });
  const seaMesh = new THREE.Mesh(seaGeo, seaMat);
  seaMesh.receiveShadow = true;
  scene.add(seaMesh);
  disposables.push(seaGeo, seaMat);

  // Seamless beach cove + rocky headland + distant bay island
  const heightAt = (x: number, z: number, r: number, az: number): { y: number; color: [number, number, number] } => {
    // Open bay toward South..West; sandy cove underfoot curving N..E..SE
    const capeAng = Math.abs(Math.atan2(Math.sin(az - 2.68), Math.cos(az - 2.68)));
    const isCape = smoothstep(0.52, 0.08, capeAng) * smoothstep(24, 54, r) * (1 - smoothstep(82, 128, r));
    const landArc = smoothstep(1.45, 0.38, Math.abs(Math.atan2(Math.sin(az - 0.18), Math.cos(az - 0.18))));
    const islAng = Math.abs(Math.atan2(Math.sin(az - 3.85), Math.cos(az - 3.85)));
    const island = smoothstep(0.35, 0.04, islAng) * smoothstep(145, 180, r) * (1 - smoothstep(195, 245, r));

    const hill = fbm(x * 0.032 + 2.0, z * 0.032 + 4.5, 3);
    const nearStrand = 1 - smoothstep(7.0, 22.0, r);
    const bayDir = smoothstep(1.3, 0.2, Math.abs(Math.atan2(Math.sin(az - 3.45), Math.cos(az - 3.45))));
    const shoreDrop = nearStrand * (0.85 - bayDir * 1.15);

    const y =
      -2.25 +
      shoreDrop +
      landArc * smoothstep(16, 95, r) * (3.6 + hill * 5.8) +
      isCape * (11.5 + hill * 4.8) +
      island * (14.5 + hill * 6.0);

    const wetSand: [number, number, number] = [0.28, 0.25, 0.22];
    const drySand: [number, number, number] = [0.62, 0.56, 0.44];
    const scrub: [number, number, number] = [0.18, 0.28, 0.20];
    const cliff: [number, number, number] = [0.34, 0.36, 0.41];

    const wetT = smoothstep(-1.82, -1.35, y);
    const scrubT = smoothstep(-0.3, 1.4, y);
    const rockMask = smoothstep(3.5, 8.5, y);

    let c0 = wetSand[0] + (drySand[0] - wetSand[0]) * wetT;
    let c1 = wetSand[1] + (drySand[1] - wetSand[1]) * wetT;
    let c2 = wetSand[2] + (drySand[2] - wetSand[2]) * wetT;

    c0 = c0 + (scrub[0] - c0) * scrubT;
    c1 = c1 + (scrub[1] - c1) * scrubT;
    c2 = c2 + (scrub[2] - c2) * scrubT;

    c0 = c0 + (cliff[0] - c0) * rockMask;
    c1 = c1 + (cliff[1] - c1) * rockMask;
    c2 = c2 + (cliff[2] - c2) * rockMask;
    return { y, color: [c0, c1, c2] };
  };

  const land = buildSeamlessTerrainMesh(280, 176, 56, 0.24, pbr.sand, 0.85, 0.9, heightAt);
  scene.add(land);
  disposables.push(land.geometry, land.material as THREE.Material);

  // Coastal granite rocks along shore
  const rockMat = new THREE.MeshStandardMaterial({
    map: pbr.rock.map,
    normalMap: pbr.rock.normalMap,
    normalScale: new THREE.Vector2(1.1, 1.1),
    roughness: 0.85,
  });
  for (let i = 0; i < 20; i++) {
    const az = (i * 1.85 + 0.1) % (Math.PI * 2);
    const r = 5.5 + ((i * 13) % 18);
    const x = r * Math.sin(az);
    const z = -r * Math.cos(az);
    const { y } = heightAt(x, z, r, az);
    if (y > -2.1) {
      const rad = 0.4 + (i % 3) * 0.25;
      const g = makeSculptedBoulderGeo(rad, i * 2.1);
      const m = new THREE.Mesh(g, rockMat);
      m.position.set(x, Math.max(-1.82, y) + rad * 0.22, z);
      m.castShadow = true;
      m.receiveShadow = true;
      scene.add(m);
      disposables.push(g);
    }
  }
  disposables.push(rockMat);

  // Coastal pines
  const trees: { x: number; y: number; z: number; scale: number }[] = [];
  for (let i = 0; i < 180; i++) {
    const az = (i * 2.399) % (Math.PI * 2);
    const r = 20 + ((i * 53) % 62);
    const x = r * Math.sin(az);
    const z = -r * Math.cos(az);
    const { y } = heightAt(x, z, r, az);
    if (y > 0.3 && y < 12) {
      trees.push({ x, y, z, scale: 0.72 + (i % 5) * 0.08 });
    }
  }
  addDetailedPines(scene, disposables, pbr, trees);

  // Cape Lighthouse + glow
  const lhAz = 2.68;
  const lhR = 66;
  const lhX = lhR * Math.sin(lhAz);
  const lhZ = -lhR * Math.cos(lhAz);
  const lhBaseY = heightAt(lhX, lhZ, lhR, lhAz).y;

  const whiteMat = new THREE.MeshStandardMaterial({ color: 0xf1f5f9, roughness: 0.45 });
  const redMat = new THREE.MeshStandardMaterial({ color: 0xdc2626, roughness: 0.5 });
  const ironMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.55, metalness: 0.55 });
  const lanternMat = new THREE.MeshStandardMaterial({
    color: 0xffd27d,
    emissive: 0xffaa2b,
    emissiveIntensity: isNight ? 2.8 : 0.7,
    roughness: 0.2,
  });

  const parts: [THREE.BufferGeometry, THREE.Material, number][] = [
    [new THREE.CylinderGeometry(1.18, 1.5, 3.6, 18), whiteMat, 1.5],
    [new THREE.CylinderGeometry(0.96, 1.18, 2.4, 18), redMat, 4.5],
    [new THREE.CylinderGeometry(0.86, 0.96, 2.0, 18), whiteMat, 6.7],
    [new THREE.CylinderGeometry(1.1, 1.1, 0.2, 18), ironMat, 7.7],
    [new THREE.CylinderGeometry(0.7, 0.7, 1.1, 14), lanternMat, 8.35],
    [new THREE.ConeGeometry(0.9, 0.9, 14), ironMat, 9.3],
  ];
  for (const [g, mat, dy] of parts) {
    const m = new THREE.Mesh(g, mat);
    m.position.set(lhX, lhBaseY + dy, lhZ);
    m.castShadow = true;
    m.receiveShadow = true;
    scene.add(m);
    disposables.push(g);
  }
  disposables.push(whiteMat, redMat, ironMat, lanternMat);

  if (isNight) {
    const lhGlow = new THREE.PointLight(0xffb84d, 48, 80, 1.5);
    lhGlow.position.set(lhX, lhBaseY + 8.35, lhZ);
    scene.add(lhGlow);
  }
}

function populateObservatoryScene(
  scene: THREE.Scene,
  disposables: { dispose(): void }[],
  pbr: PbrTextureSuite,
  isNight: boolean,
) {
  const heightAt = (x: number, z: number, r: number): { y: number; color: [number, number, number] } => {
    const plateau = r < 18 ? 0 : smoothstep(18, 48, r) * -14.0;
    const farRise = smoothstep(95, 280, r) * ridged(x * 0.0072, z * 0.0072, 3) * 28.0;
    const slope = fbm(x * 0.02 + 1.5, z * 0.02 - 2.1, 3) * 4.5 * smoothstep(20, 62, r);
    const y = -1.78 + plateau + slope + farRise;
    const col: [number, number, number] =
      y > 4 ? [0.42, 0.46, 0.54] : y < -7 ? [0.16, 0.22, 0.19] : [0.28, 0.31, 0.36];
    return { y, color: col };
  };

  const terrain = buildSeamlessTerrainMesh(420, 168, 56, 0.2, pbr.rock, 0.9, 0.92, heightAt);
  scene.add(terrain);
  disposables.push(terrain.geometry, terrain.material as THREE.Material);

  // Wooden textured observation deck + steel perimeter railing casting real shadows
  const deckGeo = new THREE.CylinderGeometry(12.2, 12.6, 0.4, 48);
  deckGeo.translate(0, -1.68, 0);
  const deckMat = new THREE.MeshStandardMaterial({
    map: pbr.woodDeck.map,
    normalMap: pbr.woodDeck.normalMap,
    normalScale: new THREE.Vector2(0.95, 0.95),
    roughness: 0.78,
  });
  const deckMesh = new THREE.Mesh(deckGeo, deckMat);
  deckMesh.receiveShadow = true;
  scene.add(deckMesh);
  disposables.push(deckGeo, deckMat);

  const railMat = new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.45, metalness: 0.65 });
  const topRailGeo = new THREE.TorusGeometry(11.9, 0.055, 8, 64);
  topRailGeo.rotateX(Math.PI / 2);
  topRailGeo.translate(0, -0.78, 0);
  const midRailGeo = new THREE.TorusGeometry(11.9, 0.035, 6, 64);
  midRailGeo.rotateX(Math.PI / 2);
  midRailGeo.translate(0, -1.16, 0);
  const topRail = new THREE.Mesh(topRailGeo, railMat);
  const midRail = new THREE.Mesh(midRailGeo, railMat);
  topRail.castShadow = true;
  midRail.castShadow = true;
  scene.add(topRail, midRail);

  const postGeo = new THREE.CylinderGeometry(0.05, 0.06, 0.95, 8);
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    const p = new THREE.Mesh(postGeo, railMat);
    p.position.set(11.9 * Math.sin(a), -1.15, -11.9 * Math.cos(a));
    p.castShadow = true;
    p.receiveShadow = true;
    scene.add(p);
  }
  disposables.push(topRailGeo, midRailGeo, postGeo, railMat);

  // Main Astronomical Dome & auxiliary dome
  const addDome = (azDeg: number, dist: number, scale: number, openSlit: boolean) => {
    const az = azDeg * DEG2RAD;
    const bx = dist * Math.sin(az);
    const bz = -dist * Math.cos(az);
    const by = -1.78;
    const wallGeo = new THREE.CylinderGeometry(3.3 * scale, 3.5 * scale, 3.0 * scale, 28);
    const domeGeo = new THREE.SphereGeometry(3.35 * scale, 28, 18, 0, Math.PI * 2, 0, Math.PI * 0.52);
    const wallMat = new THREE.MeshStandardMaterial({ color: 0xe2e8f0, roughness: 0.52 });
    const domeMat = new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.32, metalness: 0.25 });

    const wall = new THREE.Mesh(wallGeo, wallMat);
    wall.position.set(bx, by + 1.5 * scale, bz);
    wall.castShadow = true;
    wall.receiveShadow = true;
    const dome = new THREE.Mesh(domeGeo, domeMat);
    dome.position.set(bx, by + 3.0 * scale, bz);
    dome.castShadow = true;
    dome.receiveShadow = true;
    scene.add(wall, dome);
    disposables.push(wallGeo, domeGeo, wallMat, domeMat);

    if (openSlit) {
      const slitGeo = new THREE.BoxGeometry(0.95 * scale, 2.4 * scale, 1.45 * scale);
      const slitMat = new THREE.MeshStandardMaterial({
        color: 0x090d16,
        emissive: 0xb91c1c,
        emissiveIntensity: isNight ? 1.05 : 0.04,
        roughness: 0.5,
      });
      const slit = new THREE.Mesh(slitGeo, slitMat);
      slit.position.set(bx - Math.sin(az) * 1.95 * scale, by + 4.55 * scale, bz + Math.cos(az) * 1.95 * scale);
      slit.rotation.y = -az;
      slit.rotation.x = 0.35;
      scene.add(slit);
      disposables.push(slitGeo, slitMat);
    }
  };
  addDome(222, 31, 1.05, true);
  addDome(245, 43, 0.65, false);

  if (isNight) {
    const dotGeo = new THREE.SphereGeometry(0.08, 8, 8);
    const dotMat = new THREE.MeshBasicMaterial({ color: 0xef4444 });
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const dx = 11.6 * Math.sin(a);
      const dz = -11.6 * Math.cos(a);
      const m = new THREE.Mesh(dotGeo, dotMat);
      m.position.set(dx, -1.42, dz);
      scene.add(m);
    }
    const deckRed = new THREE.PointLight(0xef4444, 6, 18, 2.0);
    deckRed.position.set(-5, -0.6, 5);
    scene.add(deckRed);
    disposables.push(dotGeo, dotMat);
  }
}

function populateDesertScene(
  scene: THREE.Scene,
  disposables: { dispose(): void }[],
  pbr: PbrTextureSuite,
) {
  const heightAt = (x: number, z: number, r: number, az: number): { y: number; color: [number, number, number] } => {
    const clearMask = smoothstep(4.5, 20, r);
    const dunePhase = x * 0.068 + z * 0.025 + Math.sin(z * 0.03) * 1.4;
    const dune = (Math.sin(dunePhase) * 0.5 + 0.5) ** 1.35 * 2.4 * clearMask * (1 - smoothstep(90, 165, r));

    const mesa1 = smoothstep(0.45, 0.14, Math.abs(Math.atan2(Math.sin(az - 1.15), Math.cos(az - 1.15))));
    const mesa2 = smoothstep(0.38, 0.1, Math.abs(Math.atan2(Math.sin(az - 3.65), Math.cos(az - 3.65))));
    const mesa3 = smoothstep(0.3, 0.08, Math.abs(Math.atan2(Math.sin(az - 5.2), Math.cos(az - 5.2))));
    const mesaRad = smoothstep(115, 145, r) * (1 - smoothstep(190, 250, r));
    const mesaProf = Math.min(1, (mesa1 + mesa2 * 0.85 + mesa3 * 0.72) * mesaRad * 1.35);
    const mesaY = mesaProf > 0.05 ? Math.min(16.0, mesaProf * 18.5 + fbm(x * 0.02, z * 0.02, 2) * 2.5) : 0;

    const y = -1.78 + dune + mesaY;
    const sand: [number, number, number] = [0.68, 0.53, 0.37];
    const shadowSand: [number, number, number] = [0.48, 0.36, 0.27];
    const strata = Math.round(y * 1.6) % 2 === 0 ? 0.06 : -0.04;
    const rock: [number, number, number] = [0.58 + strata, 0.31 + strata * 0.5, 0.21];

    const isMesa = smoothstep(1.2, 4.5, mesaY);
    const sandMix = smoothstep(-1.7, 0.2, dune);
    const s0 = shadowSand[0] + (sand[0] - shadowSand[0]) * sandMix;
    const s1 = shadowSand[1] + (sand[1] - shadowSand[1]) * sandMix;
    const s2 = shadowSand[2] + (sand[2] - shadowSand[2]) * sandMix;
    return {
      y,
      color: [s0 + (rock[0] - s0) * isMesa, s1 + (rock[1] - s1) * isMesa, s2 + (rock[2] - s2) * isMesa],
    };
  };

  const terrain = buildSeamlessTerrainMesh(340, 176, 58, 0.25, pbr.sand, 0.9, 0.94, heightAt);
  scene.add(terrain);
  disposables.push(terrain.geometry, terrain.material as THREE.Material);

  const rockMat = new THREE.MeshStandardMaterial({
    map: pbr.rock.map,
    normalMap: pbr.rock.normalMap,
    normalScale: new THREE.Vector2(1.05, 1.05),
    color: 0x7c4936,
    roughness: 0.9,
  });
  for (let i = 0; i < 18; i++) {
    const az = (i * 2.1 + 0.5) % (Math.PI * 2);
    const r = 5.0 + ((i * 15) % 24);
    const x = r * Math.sin(az);
    const z = -r * Math.cos(az);
    const { y } = heightAt(x, z, r, az);
    const rad = 0.35 + (i % 4) * 0.22;
    const g = makeSculptedBoulderGeo(rad, i * 1.3);
    const m = new THREE.Mesh(g, rockMat);
    m.position.set(x, y + rad * 0.25, z);
    m.castShadow = true;
    m.receiveShadow = true;
    scene.add(m);
    disposables.push(g);
  }
  disposables.push(rockMat);

  const bushes: { x: number; y: number; z: number; scale: number }[] = [];
  for (let i = 0; i < 90; i++) {
    const az = (i * 2.3999) % (Math.PI * 2);
    const r = 4.5 + ((i * 23) % 30);
    const x = r * Math.sin(az);
    const z = -r * Math.cos(az);
    const { y } = heightAt(x, z, r, az);
    bushes.push({ x, y, z, scale: 0.55 + (i % 4) * 0.16 });
  }
  addGrassTufts(scene, disposables, bushes, 0x4c5439);
}

function getOrBakeCubeMap(
  eng: TerrainEngineState,
  preset: Terrain3dPresetId,
  frame: SkyFrame,
  nightDimming: boolean,
): THREE.WebGLCubeRenderTarget {
  const sun = frame.bodies[0];
  const moon = frame.bodies[1];
  const pal = frame.sky_palette;

  const sunAz = sun?.az_deg ?? 180;
  const sunAlt = sun?.alt_deg ?? -30;
  const moonAz = moon?.az_deg ?? 180;
  const moonAlt = moon?.alt_deg ?? -30;
  const moonIllum = moon?.illuminated_fraction ?? 0;

  const sunAltQ = sunAlt > -10 ? Math.round(sunAlt / 3) * 3 : -20;
  const sunAzQ = sunAlt > -10 ? Math.round(sunAz / 6) * 6 : 0;
  const moonActive = moonAlt > -2 && moonIllum > 0.08 && sunAlt < 0;
  const moonAzQ = moonActive ? Math.round(moonAz / 10) * 10 : 0;
  const moonAltQ = moonActive ? Math.round(moonAlt / 6) * 6 : -20;
  const moonIllQ = moonActive ? Math.round(moonIllum * 5) : 0;
  const key = `${preset}|${sunAltQ}|${sunAzQ}|${moonAltQ}|${moonAzQ}|${moonIllQ}|${
    nightDimming ? 1 : 0
  }|${pal.horizon.r},${pal.horizon.g},${pal.horizon.b}`;

  const hit = eng.cache.get(key);
  if (hit) {
    eng.cache.delete(key);
    eng.cache.set(key, hit);
    return hit.rt;
  }

  const scene = new THREE.Scene();
  const disposables: { dispose(): void }[] = [];
  const isNight = nightDimming && sunAlt < -5 && pal.star_visibility_factor > 0.45;
  const horizonCol = new THREE.Color(pal.horizon.r / 255, pal.horizon.g / 255, pal.horizon.b / 255);
  scene.fog = new THREE.FogExp2(horizonCol, isNight ? 0.0024 : 0.0018);

  // Ambient + Hemisphere lighting scaled cleanly for depth without muddy darkness
  const hemiSky = isNight
    ? new THREE.Color(0x2c4270)
    : horizonCol.clone().lerp(new THREE.Color(0x93c5fd), 0.48);
  const hemiGnd = isNight ? new THREE.Color(0x0c1320) : new THREE.Color(0x212922);
  const hemiIntensity = nightDimming
    ? isNight
      ? 0.34 + pal.moonlight_strength * 0.42
      : 0.56 + smoothstep(-6, 12, sunAlt) * 0.55
    : 0.85;
  scene.add(new THREE.HemisphereLight(hemiSky, hemiGnd, hemiIntensity));

  // Real PCFSoftShadowMap key directional light (Sun, Moon, or cool nocturnal starlight key)
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.0);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(2048, 2048);
  keyLight.shadow.camera.near = 1;
  keyLight.shadow.camera.far = 260;
  const sSpan = 72;
  keyLight.shadow.camera.left = -sSpan;
  keyLight.shadow.camera.right = sSpan;
  keyLight.shadow.camera.top = sSpan;
  keyLight.shadow.camera.bottom = -sSpan;
  keyLight.shadow.bias = -0.00045;
  keyLight.shadow.normalBias = 0.045;

  if (!nightDimming) {
    keyLight.color.setHex(0xfff4e0);
    keyLight.intensity = 1.65;
    keyLight.position.copy(azAltToVec3(220, 26, 120));
  } else if (sunAlt > -7) {
    const warmness = 1 - smoothstep(-2, 16, sunAlt);
    keyLight.color
      .setHex(0xfff5e4)
      .lerp(new THREE.Color(pal.sun_glow.r / 255, pal.sun_glow.g / 255, pal.sun_glow.b / 255), warmness * 0.85);
    keyLight.intensity = 0.32 + smoothstep(-7, 8, sunAlt) * 2.5;
    keyLight.position.copy(azAltToVec3(sunAz, Math.max(6, sunAlt), 120));
  } else if (moonAlt > 1 && pal.moonlight_strength > 0.04) {
    keyLight.color.setHex(0xd0e2ff);
    keyLight.intensity = 0.52 + pal.moonlight_strength * 1.25;
    keyLight.position.copy(azAltToVec3(moonAz, Math.max(8, moonAlt), 120));
  } else {
    // Cool nocturnal sky key light so trees, rocks & domes still cast crisp 3D shadows in starlight
    keyLight.color.setHex(0x749be6);
    keyLight.intensity = 0.54;
    keyLight.position.copy(azAltToVec3(215, 36, 120));
  }
  scene.add(keyLight);
  scene.add(keyLight.target);

  if (preset === "mountain") {
    populateMountainScene(scene, disposables, eng.pbr, isNight);
  } else if (preset === "coast") {
    populateCoastScene(scene, disposables, eng.pbr, isNight);
  } else if (preset === "observatory") {
    populateObservatoryScene(scene, disposables, eng.pbr, isNight);
  } else {
    populateDesertScene(scene, disposables, eng.pbr);
  }

  const cubeRT = new THREE.WebGLCubeRenderTarget(eng.cubeSize, {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: true,
  });
  const cubeCam = new THREE.CubeCamera(0.3, 520, cubeRT);
  cubeCam.position.set(0, 0, 0);

  eng.renderer.setRenderTarget(null);
  eng.renderer.setClearColor(0x000000, 0);
  // Render shadows once and reuse across all 6 faces of CubeCamera
  eng.renderer.shadowMap.needsUpdate = true;
  cubeCam.update(eng.renderer, scene);

  for (const d of disposables) {
    d.dispose();
  }

  if (eng.cache.size >= MAX_CUBE_CACHE) {
    const oldest = eng.cache.keys().next().value;
    if (oldest !== undefined) {
      eng.cache.get(oldest)?.rt.dispose();
      eng.cache.delete(oldest);
    }
  }
  eng.cache.set(key, { rt: cubeRT });
  return cubeRT;
}

/**
 * Render the active Three.js 3D terrain directly at native screen resolution onto Canvas2D
 * using an exact GPU projection pass. Returns `false` cleanly if WebGL is unavailable.
 */
export function renderThreeTerrainOnCanvas(
  c: CanvasRenderingContext2D,
  pCtx: CompiledProjectionContext,
  panel: number,
  frame: SkyFrame,
  preset: Terrain3dPresetId,
  config: LandscapeConfig,
  nightVision: boolean,
  isInverted: boolean,
): boolean {
  const { params } = pCtx;
  if (
    params.mode === "star_chart" ||
    frame.view_mode === "other_planet" ||
    frame.view_mode === "other_star"
  ) {
    return false;
  }

  const eng = getOrCreateEngine();
  if (!eng) return false;

  const w = params.width;
  const h = params.height;
  if (w < 4 || h < 4) return false;

  const cubeRT = getOrBakeCubeMap(eng, preset, frame, config.nightDimming);

  const dpr = Math.min(1.5, typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1);
  const rw = Math.max(16, Math.min(1920, Math.round(w * dpr)));
  const rh = Math.max(16, Math.min(1080, Math.round(h * dpr)));
  const sx = rw / w;
  const sy = rh / h;

  const u = eng.projUniforms;
  u.uCubeMap.value = cubeRT.texture;
  u.uCanvasSize.value.set(rw, rh);
  u.uAzOffRad.value = config.azOffsetDeg * DEG2RAD;
  u.uAltOffRad.value = config.altOffsetDeg * DEG2RAD;
  // Keep terrain opaque unless showBelowHorizon is enabled or opacity was deliberately lowered
  const solidFloorOpacity =
    !params.show_below_horizon && config.opacity >= 0.85 ? 1.0 : config.opacity;
  u.uOpacity.value = params.show_below_horizon ? config.opacity * 0.34 : solidFloorOpacity;
  u.uNightVision.value = nightVision ? 1 : 0;
  u.uInverted.value = isInverted ? 1 : 0;

  if (params.mode === "all_sky") {
    u.uProjMode.value = 1;
    u.uScCenter.value.set(pCtx.cx * sx, pCtx.cy * sy);
    u.uAllSkyR.value = pCtx.allSkyRadius * Math.min(sx, sy);
    u.uCenterAzRad.value = params.center_az_deg * DEG2RAD;
  } else if (params.mode === "panorama") {
    u.uProjMode.value = 2;
    u.uScCenter.value.set(pCtx.cx * sx, pCtx.cy * sy);
    u.uPanoScale.value.set(pCtx.panoScaleX * sx, pCtx.panoScaleY * sy);
    u.uCenterAzDeg.value = params.center_az_deg;
    u.uCenterAltDeg.value = params.center_alt_deg;
  } else {
    const isHemi = params.mode === "hemisphere_single" || params.mode === "hemisphere_dual";
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

    u.uProjMode.value = 0;
    u.uScCenter.value.set(scX * sx, scY * sy);
    u.uInvScR.value = 1 / Math.max(1e-6, scR * Math.min(sx, sy));
    u.uIsHemi.value = isHemi ? 1 : 0;
    u.uBasisR.value.set(basis.rx, basis.ry, basis.rz);
    u.uBasisU.value.set(basis.ux, basis.uy, basis.uz);
    u.uBasisF.value.set(basis.fx, basis.fy, basis.fz);
  }

  if (eng.lastRw !== rw || eng.lastRh !== rh) {
    eng.renderer.setSize(rw, rh, false);
    eng.lastRw = rw;
    eng.lastRh = rh;
  }
  eng.renderer.setRenderTarget(null);
  eng.renderer.setClearColor(0x000000, 0);
  eng.renderer.clear();
  eng.renderer.render(eng.projScene, eng.projCam);

  c.save();
  c.imageSmoothingEnabled = true;
  c.drawImage(eng.renderer.domElement, 0, 0, w, h);
  c.restore();
  return true;
}
