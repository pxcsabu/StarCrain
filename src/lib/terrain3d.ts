import * as THREE from "three";
import type { EquirectTexture } from "@/lib/panoramaLandscape";
import type { SkyFrame } from "@/types/sky";

export type Terrain3dPresetId = "mountain" | "coast" | "observatory" | "desert";

const DEG2RAD = Math.PI / 180;
const CUBE_SIZE = 384;
const EQ_W = 1024;
const EQ_H = 512;
const MAX_CACHE_ENTRIES = 8;

const UNWRAP_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// CubeCamera uses Az clockwise from North (-Z):
//   dir = (cos(alt)*sin(az), sin(alt), -cos(alt)*cos(az))
// EquirectTexture puts zenith (alt=+90°) at row 0 (OpenGL readPixels y=0 => vUv.y=0)
// and nadir (alt=-90°) at row EQ_H-1 (vUv.y=1).
const UNWRAP_FRAG = /* glsl */ `
uniform samplerCube uCubeMap;
varying vec2 vUv;

void main() {
  float az = vUv.x * 6.28318530718;
  float alt = (0.5 - vUv.y) * 3.14159265359;
  float cAlt = cos(alt);
  vec3 dir = vec3(cAlt * sin(az), sin(alt), -cAlt * cos(az));
  vec4 c = textureCube(uCubeMap, dir);
  if (c.a > 0.004) {
    vec3 straight = clamp(c.rgb / c.a, 0.0, 1.0);
    // Convert linear render target color to sRGB for EquirectTexture Uint8 array
    vec3 srgb = pow(straight, vec3(1.0 / 2.2));
    gl_FragColor = vec4(srgb, c.a);
  } else {
    gl_FragColor = vec4(0.0);
  }
}
`;

interface TerrainRendererCtx {
  renderer: THREE.WebGLRenderer;
  cubeRT: THREE.WebGLCubeRenderTarget;
  cubeCam: THREE.CubeCamera;
  eqScene: THREE.Scene;
  eqCam: THREE.OrthographicCamera;
  eqRT: THREE.WebGLRenderTarget;
  rawBuf: Uint8Array;
  waterNormalTex: THREE.CanvasTexture;
}

let ctxCache: TerrainRendererCtx | null = null;
let webglFailed = false;
let versionSeq = 1000;
const bakedCache = new Map<string, EquirectTexture>();

function createWaterNormalTexture(): THREE.CanvasTexture {
  const size = 128;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const g = c.getContext("2d");
  if (g) {
    const img = g.createImageData(size, size);
    const d = img.data;
    const tau = Math.PI * 2;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = (x / size) * tau;
        const v = (y / size) * tau;
        const dx =
          0.32 * Math.cos(u * 3 + v * 2) +
          0.22 * Math.cos(u * 7 - v * 5) +
          0.14 * Math.cos(u * 11 + v * 9);
        const dy =
          0.35 * Math.sin(v * 4 - u * 2) +
          0.24 * Math.sin(v * 8 + u * 4) +
          0.16 * Math.sin(v * 13 - u * 6);
        const len = Math.hypot(dx, dy, 1.0);
        const idx = (y * size + x) * 4;
        d[idx] = Math.round(((dx / len) * 0.5 + 0.5) * 255);
        d[idx + 1] = Math.round(((dy / len) * 0.5 + 0.5) * 255);
        d[idx + 2] = Math.round(((1.0 / len) * 0.5 + 0.5) * 255);
        d[idx + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(34, 34);
  tex.needsUpdate = true;
  return tex;
}

function getOrCreateContext(): TerrainRendererCtx | null {
  if (webglFailed) return null;
  if (ctxCache) return ctxCache;
  if (typeof document === "undefined") {
    webglFailed = true;
    return null;
  }
  try {
    const renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: false,
      powerPreference: "high-performance",
      preserveDrawingBuffer: false,
    });
    renderer.setSize(EQ_W, EQ_H, false);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;

    const cubeRT = new THREE.WebGLCubeRenderTarget(CUBE_SIZE, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
    });
    const cubeCam = new THREE.CubeCamera(0.4, 520, cubeRT);
    cubeCam.position.set(0, 0, 0);

    const eqRT = new THREE.WebGLRenderTarget(EQ_W, EQ_H, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
    });

    const eqScene = new THREE.Scene();
    const eqCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const quad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        uniforms: {
          uCubeMap: { value: cubeRT.texture },
        },
        vertexShader: UNWRAP_VERT,
        fragmentShader: UNWRAP_FRAG,
        transparent: false,
        depthTest: false,
        depthWrite: false,
      }),
    );
    eqScene.add(quad);

    ctxCache = {
      renderer,
      cubeRT,
      cubeCam,
      eqScene,
      eqCam,
      eqRT,
      rawBuf: new Uint8Array(EQ_W * EQ_H * 4),
      waterNormalTex: createWaterNormalTexture(),
    };
    return ctxCache;
  } catch {
    webglFailed = true;
    return null;
  }
}

function azAltToVec3(azDeg: number, altDeg: number, dist = 1): THREE.Vector3 {
  const az = azDeg * DEG2RAD;
  const alt = altDeg * DEG2RAD;
  const cAlt = Math.cos(alt);
  return new THREE.Vector3(
    dist * cAlt * Math.sin(az),
    dist * Math.sin(alt),
    -dist * cAlt * Math.cos(az),
  );
}

function hash2D(ix: number, iz: number): number {
  const n = Math.sin(ix * 127.1 + iz * 311.7) * 43758.5453123;
  return n - Math.floor(n);
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
    weight = Math.max(0.2, Math.min(1, n * 1.4));
    val += n * amp;
    freq *= 2.1;
    amp *= 0.5;
  }
  return val;
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

function buildRadialHeightMesh(
  rMin: number,
  rMax: number,
  angSegs: number,
  radSegs: number,
  sampleFn: (x: number, z: number, r: number, az: number) => { y: number; color: [number, number, number] },
  roughness = 0.9,
): THREE.Mesh {
  const vCount = (angSegs + 1) * (radSegs + 1);
  const positions = new Float32Array(vCount * 3);
  const colors = new Float32Array(vCount * 3);
  const indices: number[] = [];

  let ptr = 0;
  for (let ir = 0; ir <= radSegs; ir++) {
    const t = ir / radSegs;
    // Quadratic radial spacing gives high density near foreground clearing & far peaks cleanly
    const r = rMin + (rMax - rMin) * (t * t * 0.72 + t * 0.28);
    for (let ia = 0; ia <= angSegs; ia++) {
      const az = (ia / angSegs) * Math.PI * 2;
      const x = r * Math.sin(az);
      const z = -r * Math.cos(az);
      const s = sampleFn(x, z, r, az);
      positions[ptr * 3] = x;
      positions[ptr * 3 + 1] = s.y;
      positions[ptr * 3 + 2] = z;
      colors[ptr * 3] = s.color[0];
      colors[ptr * 3 + 1] = s.color[1];
      colors[ptr * 3 + 2] = s.color[2];
      ptr++;
    }
  }

  const stride = angSegs + 1;
  for (let ir = 0; ir < radSegs; ir++) {
    for (let ia = 0; ia < angSegs; ia++) {
      const a = ir * stride + ia;
      const b = a + 1;
      const c = (ir + 1) * stride + ia;
      const d = c + 1;
      indices.push(a, b, c, b, d, c);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();

  return new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness,
      metalness: 0.04,
      side: THREE.DoubleSide,
    }),
  );
}

function addInstancedPines(
  scene: THREE.Scene,
  disposables: { dispose(): void }[],
  trees: { x: number; y: number; z: number; scale: number }[],
) {
  if (trees.length === 0) return;
  const folGeo = new THREE.ConeGeometry(0.95, 3.8, 6);
  folGeo.translate(0, 2.2, 0);
  const folMat = new THREE.MeshStandardMaterial({
    color: 0x1a3024,
    roughness: 0.92,
    metalness: 0.02,
  });
  const trunkGeo = new THREE.CylinderGeometry(0.14, 0.2, 0.9, 5);
  trunkGeo.translate(0, 0.4, 0);
  const trunkMat = new THREE.MeshStandardMaterial({
    color: 0x3b2a20,
    roughness: 0.95,
  });

  const folInst = new THREE.InstancedMesh(folGeo, folMat, trees.length);
  const trunkInst = new THREE.InstancedMesh(trunkGeo, trunkMat, trees.length);
  const dummy = new THREE.Object3D();

  trees.forEach((t, i) => {
    dummy.position.set(t.x, t.y - 0.15, t.z);
    dummy.rotation.y = (i * 1.618) % (Math.PI * 2);
    dummy.scale.set(t.scale, t.scale * (0.9 + (i % 5) * 0.06), t.scale);
    dummy.updateMatrix();
    folInst.setMatrixAt(i, dummy.matrix);
    trunkInst.setMatrixAt(i, dummy.matrix);
  });
  folInst.instanceMatrix.needsUpdate = true;
  trunkInst.instanceMatrix.needsUpdate = true;

  scene.add(folInst, trunkInst);
  disposables.push(folGeo, folMat, trunkGeo, trunkMat);
}

function populateMountainScene(
  scene: THREE.Scene,
  disposables: { dispose(): void }[],
  isNight: boolean,
) {
  const heightAt = (x: number, z: number, r: number, az: number): { y: number; color: [number, number, number] } => {
    const clearMask = smoothstep(10, 42, r);
    const farMask = smoothstep(55, 190, r);
    // Azimuth valley modulation so low eastern/southern views remain fairly clear while NE/NW host high peaks
    const rangeWeight = 0.62 + 0.48 * Math.sin(az - 0.65) + 0.32 * Math.cos(az * 2 + 1.1);
    const hill = fbm(x * 0.022 + 3.1, z * 0.022 - 1.7, 3) * 8.5 * clearMask;
    const peaks = ridged(x * 0.0082 - 2.4, z * 0.0082 + 4.3, 4) * 34.0 * farMask * Math.max(0.28, rangeWeight);
    const y = -2.2 + hill + peaks - smoothstep(260, 340, r) * 6.0;

    // Color grading by altitude & radius
    const meadow: [number, number, number] = [0.16, 0.25, 0.18];
    const forest: [number, number, number] = [0.11, 0.19, 0.16];
    const rock: [number, number, number] = [0.30, 0.34, 0.41];
    const snow: [number, number, number] = [0.82, 0.87, 0.94];

    const snowT = smoothstep(16.5, 24.0, y);
    const rockT = smoothstep(5.5, 13.5, y);
    const foreT = smoothstep(18, 70, r);

    const base: [number, number, number] = [
      meadow[0] + (forest[0] - meadow[0]) * foreT,
      meadow[1] + (forest[1] - meadow[1]) * foreT,
      meadow[2] + (forest[2] - meadow[2]) * foreT,
    ];
    const withRock: [number, number, number] = [
      base[0] + (rock[0] - base[0]) * rockT,
      base[1] + (rock[1] - base[1]) * rockT,
      base[2] + (rock[2] - base[2]) * rockT,
    ];
    const col: [number, number, number] = [
      withRock[0] + (snow[0] - withRock[0]) * snowT,
      withRock[1] + (snow[1] - withRock[1]) * snowT,
      withRock[2] + (snow[2] - withRock[2]) * snowT,
    ];
    return { y, color: col };
  };

  // Observer foreground disk
  const floorGeo = new THREE.CircleGeometry(14, 32);
  floorGeo.rotateX(-Math.PI / 2);
  floorGeo.translate(0, -2.2, 0);
  const floorMat = new THREE.MeshStandardMaterial({ color: 0x263526, roughness: 0.95 });
  scene.add(new THREE.Mesh(floorGeo, floorMat));
  disposables.push(floorGeo, floorMat);

  const terrain = buildRadialHeightMesh(3.8, 340, 168, 54, heightAt, 0.92);
  scene.add(terrain);
  disposables.push(terrain.geometry, terrain.material as THREE.Material);

  // Conifer forest belt
  const trees: { x: number; y: number; z: number; scale: number }[] = [];
  for (let i = 0; i < 360; i++) {
    const az = (i * 2.399963) % (Math.PI * 2);
    const r = 17 + ((i * 73) % 78);
    const x = r * Math.sin(az);
    const z = -r * Math.cos(az);
    const { y } = heightAt(x, z, r, az);
    if (y < 9.5) {
      trees.push({ x, y, z, scale: 0.8 + ((i * 19) % 10) * 0.07 });
    }
  }
  addInstancedPines(scene, disposables, trees);

  // Foreground boulders
  const rockGeo = new THREE.DodecahedronGeometry(0.65, 1);
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x47505c, roughness: 0.9 });
  for (let i = 0; i < 16; i++) {
    const az = (i * 1.9 + 0.4) % (Math.PI * 2);
    const r = 7.5 + (i % 4) * 2.2;
    const x = r * Math.sin(az);
    const z = -r * Math.cos(az);
    const { y } = heightAt(x, z, r, az);
    const m = new THREE.Mesh(rockGeo, rockMat);
    m.position.set(x, y + 0.12, z);
    m.scale.set(1.2, 0.65 + (i % 3) * 0.25, 0.9);
    m.rotation.set(i, i * 0.7, 0);
    scene.add(m);
  }
  disposables.push(rockGeo, rockMat);

  // Distant warm mountain cabin lights at night
  if (isNight) {
    const winGeo = new THREE.BoxGeometry(0.45, 0.3, 0.45);
    const winMat = new THREE.MeshBasicMaterial({ color: 0xffb347 });
    [1.15, 2.65, 4.9].forEach((az, idx) => {
      const r = 68 + idx * 14;
      const x = r * Math.sin(az);
      const z = -r * Math.cos(az);
      const { y } = heightAt(x, z, r, az);
      const m = new THREE.Mesh(winGeo, winMat);
      m.position.set(x, y + 0.35, z);
      scene.add(m);
    });
    disposables.push(winGeo, winMat);
  }
}

function populateCoastScene(
  scene: THREE.Scene,
  disposables: { dispose(): void }[],
  waterNormalTex: THREE.CanvasTexture,
  isNight: boolean,
) {
  // Infinite 3D ocean catching real Sun & Moon specular glints
  const seaGeo = new THREE.CircleGeometry(380, 96);
  seaGeo.rotateX(-Math.PI / 2);
  seaGeo.translate(0, -2.05, 0);
  const seaMat = new THREE.MeshStandardMaterial({
    color: 0x0b253d,
    roughness: 0.16,
    metalness: 0.32,
    normalMap: waterNormalTex,
    normalScale: new THREE.Vector2(0.42, 0.42),
  });
  scene.add(new THREE.Mesh(seaGeo, seaMat));
  disposables.push(seaGeo, seaMat);

  // Foreground pebbled/sandy shore cove (half ring on North/West behind & beside observer)
  const heightAt = (x: number, z: number, r: number, az: number): { y: number; color: [number, number, number] } => {
    // Cape headland jutting south-east around az ≈ 2.65 rad (152°), beach crescent West..North..NE
    const capeAng = Math.abs(Math.atan2(Math.sin(az - 2.68), Math.cos(az - 2.68)));
    const isCape = smoothstep(0.55, 0.1, capeAng) * smoothstep(26, 56, r) * (1 - smoothstep(82, 130, r));

    // Pebble beach at foreground near r = 4..16 away from open ocean (Open ocean faces South-West..South..SE)
    const landArc = smoothstep(1.3, 0.45, Math.abs(Math.atan2(Math.sin(az - 0.15), Math.cos(az - 0.15))));
    const shore = (1 - smoothstep(12, 24, r)) * 0.45 + landArc * smoothstep(18, 95, r) * 0.85;

    // Distant volcanic island across the bay around az ≈ 3.85 rad (220° SW)
    const islAng = Math.abs(Math.atan2(Math.sin(az - 3.85), Math.cos(az - 3.85)));
    const island = smoothstep(0.35, 0.04, islAng) * smoothstep(140, 175, r) * (1 - smoothstep(190, 240, r));

    const hillNoise = fbm(x * 0.03 + 2, z * 0.03 + 5, 3);
    let y = -2.7;
    if (r < 9.5) {
      y = -1.9 + hillNoise * 0.35;
    } else {
      y = -2.85 + shore * (3.2 + hillNoise * 5.2) + isCape * (11.5 + hillNoise * 5.0) + island * (14.0 + hillNoise * 6.0);
    }

    const sand: [number, number, number] = [0.44, 0.41, 0.35];
    const cliff: [number, number, number] = [0.27, 0.30, 0.35];
    const scrub: [number, number, number] = [0.16, 0.26, 0.19];

    const aboveWater = smoothstep(-1.95, 0.5, y);
    const rockMask = isCape * 0.7 + island * 0.65;
    const col: [number, number, number] = [
      sand[0] * (1 - aboveWater) + (scrub[0] + (cliff[0] - scrub[0]) * rockMask) * aboveWater,
      sand[1] * (1 - aboveWater) + (scrub[1] + (cliff[1] - scrub[1]) * rockMask) * aboveWater,
      sand[2] * (1 - aboveWater) + (scrub[2] + (cliff[2] - scrub[2]) * rockMask) * aboveWater,
    ];
    return { y, color: col };
  };

  const land = buildRadialHeightMesh(3.2, 260, 160, 48, heightAt, 0.9);
  scene.add(land);
  disposables.push(land.geometry, land.material as THREE.Material);

  // Coastal pines along the landward ridge & headland
  const trees: { x: number; y: number; z: number; scale: number }[] = [];
  for (let i = 0; i < 160; i++) {
    const az = (i * 2.399) % (Math.PI * 2);
    const r = 20 + ((i * 53) % 62);
    const x = r * Math.sin(az);
    const z = -r * Math.cos(az);
    const { y } = heightAt(x, z, r, az);
    if (y > 0.2 && y < 12) {
      trees.push({ x, y, z, scale: 0.72 + (i % 5) * 0.08 });
    }
  }
  addInstancedPines(scene, disposables, trees);

  // Iconic 3D White & Crimson Cape Lighthouse on headland (az ≈ 2.68 rad, r = 68)
  const lhAz = 2.68;
  const lhR = 66;
  const lhX = lhR * Math.sin(lhAz);
  const lhZ = -lhR * Math.cos(lhAz);
  const lhBaseY = heightAt(lhX, lhZ, lhR, lhAz).y;

  const whiteMat = new THREE.MeshStandardMaterial({ color: 0xf1f5f9, roughness: 0.45 });
  const redMat = new THREE.MeshStandardMaterial({ color: 0xdc2626, roughness: 0.5 });
  const ironMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.6, metalness: 0.5 });
  const lanternMat = new THREE.MeshStandardMaterial({
    color: 0xffd27d,
    emissive: 0xffaa2b,
    emissiveIntensity: isNight ? 2.6 : 0.7,
    roughness: 0.2,
  });

  const baseG = new THREE.CylinderGeometry(1.15, 1.45, 3.6, 16);
  const bandG = new THREE.CylinderGeometry(0.95, 1.15, 2.4, 16);
  const topG = new THREE.CylinderGeometry(0.85, 0.95, 2.0, 16);
  const lanternG = new THREE.CylinderGeometry(0.68, 0.68, 1.1, 14);
  const capG = new THREE.ConeGeometry(0.86, 0.85, 14);

  const m1 = new THREE.Mesh(baseG, whiteMat);
  m1.position.set(lhX, lhBaseY + 1.5, lhZ);
  const m2 = new THREE.Mesh(bandG, redMat);
  m2.position.set(lhX, lhBaseY + 4.5, lhZ);
  const m3 = new THREE.Mesh(topG, whiteMat);
  m3.position.set(lhX, lhBaseY + 6.7, lhZ);
  const m4 = new THREE.Mesh(lanternG, lanternMat);
  m4.position.set(lhX, lhBaseY + 8.2, lhZ);
  const m5 = new THREE.Mesh(capG, ironMat);
  m5.position.set(lhX, lhBaseY + 9.15, lhZ);
  scene.add(m1, m2, m3, m4, m5);
  disposables.push(baseG, bandG, topG, lanternG, capG, whiteMat, redMat, ironMat, lanternMat);

  if (isNight) {
    const lhGlow = new THREE.PointLight(0xffb84d, 45, 70, 1.6);
    lhGlow.position.set(lhX, lhBaseY + 8.2, lhZ);
    scene.add(lhGlow);
  }
}

function populateObservatoryScene(
  scene: THREE.Scene,
  disposables: { dispose(): void }[],
  isNight: boolean,
) {
  // Broad alpine summit plateau + soft distant peaks (leaving clear open horizon for telescope)
  const heightAt = (x: number, z: number, r: number): { y: number; color: [number, number, number] } => {
    if (r < 18) return { y: -1.75, color: [0.22, 0.25, 0.29] };
    const drop = smoothstep(18, 46, r) * -14.0;
    const farRise = smoothstep(95, 260, r) * ridged(x * 0.007, z * 0.007, 3) * 26.0;
    const slope = fbm(x * 0.02 + 1.5, z * 0.02 - 2.1, 3) * 4.5 * smoothstep(20, 60, r);
    const y = -1.75 + drop + slope + farRise;
    const col: [number, number, number] =
      y > 4 ? [0.36, 0.40, 0.48] : y < -8 ? [0.14, 0.20, 0.18] : [0.24, 0.27, 0.31];
    return { y, color: col };
  };

  // Observation deck platform + low circular parapet railing
  const deckGeo = new THREE.CylinderGeometry(13.5, 14.5, 0.6, 48);
  deckGeo.translate(0, -2.05, 0);
  const deckMat = new THREE.MeshStandardMaterial({ color: 0x262d38, roughness: 0.85 });
  scene.add(new THREE.Mesh(deckGeo, deckMat));
  disposables.push(deckGeo, deckMat);

  const railGeo = new THREE.TorusGeometry(13.2, 0.08, 8, 64);
  railGeo.rotateX(Math.PI / 2);
  railGeo.translate(0, -1.05, 0);
  const railMat = new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: 0.5, metalness: 0.6 });
  scene.add(new THREE.Mesh(railGeo, railMat));
  disposables.push(railGeo, railMat);

  const terrain = buildRadialHeightMesh(12, 340, 144, 44, heightAt, 0.9);
  scene.add(terrain);
  disposables.push(terrain.geometry, terrain.material as THREE.Material);

  // Main Astronomical Dome at South-West horizon (az = 215°, r = 29)
  const addDomeBuilding = (azDeg: number, dist: number, scale: number, hasNightSlit: boolean) => {
    const az = azDeg * DEG2RAD;
    const bx = dist * Math.sin(az);
    const bz = -dist * Math.cos(az);
    const by = -1.8;

    const wallGeo = new THREE.CylinderGeometry(3.2 * scale, 3.4 * scale, 2.8 * scale, 24);
    const domeGeo = new THREE.SphereGeometry(3.25 * scale, 24, 16, 0, Math.PI * 2, 0, Math.PI * 0.52);
    const wallMat = new THREE.MeshStandardMaterial({ color: 0xdbe3ee, roughness: 0.55 });
    const domeMat = new THREE.MeshStandardMaterial({ color: 0xf1f5f9, roughness: 0.35, metalness: 0.25 });

    const wall = new THREE.Mesh(wallGeo, wallMat);
    wall.position.set(bx, by + 1.4 * scale, bz);
    const dome = new THREE.Mesh(domeGeo, domeMat);
    dome.position.set(bx, by + 2.8 * scale, bz);
    scene.add(wall, dome);
    disposables.push(wallGeo, domeGeo, wallMat, domeMat);

    // Dark shutter slit facing sky + faint astronomer red interior glow
    if (hasNightSlit) {
      const slitGeo = new THREE.BoxGeometry(0.9 * scale, 2.3 * scale, 1.4 * scale);
      const slitMat = new THREE.MeshStandardMaterial({
        color: 0x090d16,
        emissive: 0x991b1b,
        emissiveIntensity: isNight ? 0.95 : 0.05,
        roughness: 0.6,
      });
      const slit = new THREE.Mesh(slitGeo, slitMat);
      // Point slit toward center clearing
      slit.position.set(bx - Math.sin(az) * 1.9 * scale, by + 4.35 * scale, bz + Math.cos(az) * 1.9 * scale);
      slit.rotation.y = -az;
      slit.rotation.x = 0.35;
      scene.add(slit);
      disposables.push(slitGeo, slitMat);
    }
  };

  addDomeBuilding(222, 31, 1.0, true);
  addDomeBuilding(244, 42, 0.62, false);

  // Subtle red dark-adaptation pathway bollards around deck edge
  if (isNight) {
    const dotGeo = new THREE.SphereGeometry(0.11, 8, 8);
    const dotMat = new THREE.MeshBasicMaterial({ color: 0xef4444 });
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const m = new THREE.Mesh(dotGeo, dotMat);
      m.position.set(13.0 * Math.sin(a), -1.0, -13.0 * Math.cos(a));
      scene.add(m);
    }
    disposables.push(dotGeo, dotMat);
  }
}

function populateDesertScene(scene: THREE.Scene, disposables: { dispose(): void }[]) {
  const heightAt = (x: number, z: number, r: number, az: number): { y: number; color: [number, number, number] } => {
    const clearMask = smoothstep(5, 22, r);
    // Asymmetric wind-blown sand dunes
    const dunePhase = x * 0.068 + z * 0.025 + Math.sin(z * 0.03) * 1.4;
    const dune = (Math.sin(dunePhase) * 0.5 + 0.5) ** 1.35 * 2.2 * clearMask * (1 - smoothstep(85, 160, r));

    // Distant flat-topped sandstone mesas on 3 azimuth lobes
    const mesaDir1 = smoothstep(0.45, 0.14, Math.abs(Math.atan2(Math.sin(az - 1.15), Math.cos(az - 1.15))));
    const mesaDir2 = smoothstep(0.38, 0.10, Math.abs(Math.atan2(Math.sin(az - 3.65), Math.cos(az - 3.65))));
    const mesaDir3 = smoothstep(0.30, 0.08, Math.abs(Math.atan2(Math.sin(az - 5.20), Math.cos(az - 5.20))));
    const mesaRadial = smoothstep(115, 145, r) * (1 - smoothstep(185, 240, r));
    const mesaProfile = Math.min(1, (mesaDir1 + mesaDir2 * 0.85 + mesaDir3 * 0.72) * mesaRadial * 1.35);
    const mesaY = mesaProfile > 0.05 ? Math.min(15.5, mesaProfile * 18.0 + fbm(x * 0.02, z * 0.02, 2) * 2.5) : 0;

    const y = -2.1 + dune + mesaY;

    const sand: [number, number, number] = [0.64, 0.49, 0.34];
    const shadowSand: [number, number, number] = [0.46, 0.34, 0.25];
    const mesaStrata = ((Math.round(y * 1.6) % 2 === 0) ? 0.06 : -0.04);
    const rock: [number, number, number] = [0.56 + mesaStrata, 0.29 + mesaStrata * 0.5, 0.20];

    const isMesa = smoothstep(1.2, 4.5, mesaY);
    const sandMix = smoothstep(-2.0, 0.1, dune);
    const sCol: [number, number, number] = [
      shadowSand[0] + (sand[0] - shadowSand[0]) * sandMix,
      shadowSand[1] + (sand[1] - shadowSand[1]) * sandMix,
      shadowSand[2] + (sand[2] - shadowSand[2]) * sandMix,
    ];
    return {
      y,
      color: [
        sCol[0] + (rock[0] - sCol[0]) * isMesa,
        sCol[1] + (rock[1] - sCol[1]) * isMesa,
        sCol[2] + (rock[2] - sCol[2]) * isMesa,
      ],
    };
  };

  const floorGeo = new THREE.CircleGeometry(8, 28);
  floorGeo.rotateX(-Math.PI / 2);
  floorGeo.translate(0, -2.1, 0);
  const floorMat = new THREE.MeshStandardMaterial({ color: 0x7c5e41, roughness: 0.94 });
  scene.add(new THREE.Mesh(floorGeo, floorMat));
  disposables.push(floorGeo, floorMat);

  const terrain = buildRadialHeightMesh(4, 290, 156, 48, heightAt, 0.94);
  scene.add(terrain);
  disposables.push(terrain.geometry, terrain.material as THREE.Material);
}

export function getThreeTerrainEquirect(
  preset: Terrain3dPresetId,
  frame: SkyFrame,
  nightDimming: boolean,
): EquirectTexture | null {
  const ctx = getOrCreateContext();
  if (!ctx) return null;

  const sun = frame.bodies[0];
  const moon = frame.bodies[1];
  const pal = frame.sky_palette;

  const sunAz = sun?.az_deg ?? 180;
  const sunAlt = sun?.alt_deg ?? -30;
  const moonAz = moon?.az_deg ?? 180;
  const moonAlt = moon?.alt_deg ?? -30;
  const moonIllum = moon?.illuminated_fraction ?? 0;

  // Quantize inputs carefully so interactive sky panning/zooming never re-renders Three.js unnecessarily
  const sunAltQ = sunAlt > -10 ? Math.round(sunAlt / 3) * 3 : -20;
  const sunAzQ = sunAlt > -10 ? Math.round(sunAz / 6) * 6 : 0;
  const moonActive = moonAlt > -2 && moonIllum > 0.08 && sunAlt < 0;
  const moonAzQ = moonActive ? Math.round(moonAz / 10) * 10 : 0;
  const moonAltQ = moonActive ? Math.round(moonAlt / 6) * 6 : -20;
  const moonIllQ = moonActive ? Math.round(moonIllum * 5) : 0;
  const horHex = `${pal.horizon.r},${pal.horizon.g},${pal.horizon.b}`;
  const cacheKey = `${preset}|${sunAltQ}|${sunAzQ}|${moonAltQ}|${moonAzQ}|${moonIllQ}|${
    nightDimming ? 1 : 0
  }|${horHex}`;

  const hit = bakedCache.get(cacheKey);
  if (hit) {
    // Move to end for LRU
    bakedCache.delete(cacheKey);
    bakedCache.set(cacheKey, hit);
    return hit;
  }

  const scene = new THREE.Scene();
  const disposables: { dispose(): void }[] = [];

  const isNight = nightDimming && sunAlt < -5 && pal.star_visibility_factor > 0.45;
  const horizonCol = new THREE.Color(pal.horizon.r / 255, pal.horizon.g / 255, pal.horizon.b / 255);
  scene.fog = new THREE.FogExp2(horizonCol, isNight ? 0.0022 : 0.0018);

  // Physical sky/sun/moon lighting rig
  const hemiSky = isNight
    ? new THREE.Color(0x283a62)
    : horizonCol.clone().lerp(new THREE.Color(0x93c5fd), 0.45);
  const hemiGnd = isNight ? new THREE.Color(0x0c111c) : new THREE.Color(0x1f2520);
  const hemiIntensity = nightDimming
    ? isNight
      ? 0.34 + pal.moonlight_strength * 0.42
      : 0.52 + smoothstep(-6, 12, sunAlt) * 0.55
    : 0.95;
  scene.add(new THREE.HemisphereLight(hemiSky, hemiGnd, hemiIntensity));

  if (!nightDimming) {
    const studioSun = new THREE.DirectionalLight(0xe2edff, 1.35);
    studioSun.position.copy(azAltToVec3(215, 28, 120));
    scene.add(studioSun);
  } else if (sunAlt > -8) {
    const warmness = 1 - smoothstep(-2, 16, sunAlt);
    const sunCol = new THREE.Color(0xfff5e4).lerp(
      new THREE.Color(pal.sun_glow.r / 255, pal.sun_glow.g / 255, pal.sun_glow.b / 255),
      warmness * 0.85,
    );
    const sunInt = 0.25 + smoothstep(-8, 8, sunAlt) * 2.4;
    const sunLight = new THREE.DirectionalLight(sunCol, sunInt);
    sunLight.position.copy(azAltToVec3(sunAz, Math.max(3, sunAlt), 120));
    scene.add(sunLight);
  }

  if (nightDimming && moonAlt > 0 && pal.moonlight_strength > 0.04) {
    const moonLight = new THREE.DirectionalLight(
      0xc7dcff,
      0.35 + pal.moonlight_strength * 1.15,
    );
    moonLight.position.copy(azAltToVec3(moonAz, Math.max(4, moonAlt), 120));
    scene.add(moonLight);
  }

  if (preset === "mountain") {
    populateMountainScene(scene, disposables, isNight);
  } else if (preset === "coast") {
    populateCoastScene(scene, disposables, ctx.waterNormalTex, isNight);
  } else if (preset === "observatory") {
    populateObservatoryScene(scene, disposables, isNight);
  } else {
    populateDesertScene(scene, disposables);
  }

  // Bake 360° 3D scene into CubeMap then unwrap into EquirectTexture RGBA array
  const { renderer, cubeRT, cubeCam, eqScene, eqCam, eqRT, rawBuf } = ctx;
  renderer.setClearColor(0x000000, 0);
  const prevTarget = renderer.getRenderTarget();
  cubeCam.update(renderer, scene);

  renderer.setRenderTarget(eqRT);
  renderer.clear();
  renderer.render(eqScene, eqCam);
  renderer.readRenderTargetPixels(eqRT, 0, 0, EQ_W, EQ_H, rawBuf);
  renderer.setRenderTarget(prevTarget);

  for (const d of disposables) {
    d.dispose();
  }

  const copyData = new Uint8ClampedArray(rawBuf);
  let maxOpaqueAltDeg = 0;
  for (let y = 0; y < EQ_H; y++) {
    const rowOff = y * EQ_W * 4;
    for (let x = 0; x < EQ_W; x += 4) {
      if (copyData[rowOff + x * 4 + 3] > 6) {
        const alt = 90 - ((y + 0.5) / EQ_H) * 180;
        maxOpaqueAltDeg = Math.max(-5, Math.min(89, alt + 1.0));
        y = EQ_H;
        break;
      }
    }
  }

  const baked: EquirectTexture = {
    width: EQ_W,
    height: EQ_H,
    data: copyData,
    maxOpaqueAltDeg,
    version: ++versionSeq,
  };

  if (bakedCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = bakedCache.keys().next().value;
    if (oldestKey !== undefined) bakedCache.delete(oldestKey);
  }
  bakedCache.set(cacheKey, baked);

  // Touch cubeRT reference explicitly for clarity
  void cubeRT;
  return baked;
}
