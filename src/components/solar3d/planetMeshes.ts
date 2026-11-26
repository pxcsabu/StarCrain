import * as THREE from "three";
import type { SolarSystem3DBody } from "@/types/sky";

const DEG2RAD = Math.PI / 180;
const textureLoader = new THREE.TextureLoader();
const textureCache = new Map<string, THREE.Texture>();
let cometComaTexture: THREE.CanvasTexture | null = null;

function loadPlanetTexture(
  fileName: string,
  srgb: boolean,
  maxAnisotropy: number,
): THREE.Texture {
  const key = `${fileName}:${srgb ? "srgb" : "lin"}`;
  const existing = textureCache.get(key);
  if (existing) {
    return existing;
  }
  const tex = textureLoader.load(`/textures/planets/${fileName}`);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.anisotropy = Math.min(8, Math.max(1, maxAnisotropy));
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  textureCache.set(key, tex);
  return tex;
}

function getCometComaTexture(): THREE.CanvasTexture {
  if (cometComaTexture) return cometComaTexture;
  const size = 128;
  const half = size * 0.5;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d");
  if (ctx) {
    const g = ctx.createRadialGradient(half, half, 2, half, half, half);
    g.addColorStop(0, "rgba(236, 253, 245, 1)");
    g.addColorStop(0.22, "rgba(110, 231, 183, 0.85)");
    g.addColorStop(0.55, "rgba(45, 212, 191, 0.32)");
    g.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  cometComaTexture = new THREE.CanvasTexture(c);
  cometComaTexture.colorSpace = THREE.SRGBColorSpace;
  return cometComaTexture;
}

function createFresnelRimMesh(
  radius: number,
  colorHex: number,
  intensity: number,
  power: number,
  scaleY = 1,
): THREE.Mesh {
  const geo = new THREE.SphereGeometry(radius, 48, 36);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(colorHex) },
      uIntensity: { value: intensity },
      uPower: { value: power },
    },
    vertexShader: `
      varying vec3 vNormalView;
      varying vec3 vViewPos;
      void main() {
        vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
        vViewPos = -mvPos.xyz;
        vNormalView = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * mvPos;
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uIntensity;
      uniform float uPower;
      varying vec3 vNormalView;
      varying vec3 vViewPos;
      void main() {
        vec3 n = normalize(vNormalView);
        vec3 v = normalize(vViewPos);
        float rim = pow(clamp(1.0 - max(0.0, dot(n, v)), 0.0, 1.0), uPower);
        gl_FragColor = vec4(uColor, rim * uIntensity);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  if (scaleY !== 1) mesh.scale.set(1, scaleY, 1);
  return mesh;
}

function createRadialRingGeometry(
  innerRadius: number,
  outerRadius: number,
  thetaSegments = 128,
): THREE.RingGeometry {
  const geo = new THREE.RingGeometry(innerRadius, outerRadius, thetaSegments, 1);
  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  const span = Math.max(1e-4, outerRadius - innerRadius);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const r = Math.hypot(x, y);
    const u = Math.max(0.01, Math.min(0.99, (r - innerRadius) / span));
    uv.setXY(i, u, 0.5);
  }
  uv.needsUpdate = true;
  geo.rotateX(-Math.PI * 0.5);
  return geo;
}

export interface AnimatedSolarBodyHandle {
  group: THREE.Group;
  visualRadius: number;
  spinTarget?: THREE.Object3D;
  spinRateRadPerSec: number;
  cloudMesh?: THREE.Mesh;
  moonPivots?: { pivot: THREE.Group; speedRadPerSec: number }[];
}

interface TexturedPlanetSpec {
  texture: string;
  bumpScale?: number;
  roughness: number;
  tiltDeg: number;
  oblateness?: number;
  spinRate: number;
  atmosphere?: { color: number; intensity: number; power: number };
}

const PLANET_SPECS: Record<string, TexturedPlanetSpec> = {
  mercury: {
    texture: "mercury.jpg",
    bumpScale: 0.015,
    roughness: 0.92,
    tiltDeg: 0.03,
    spinRate: 0.08,
  },
  venus: {
    texture: "venus.jpg",
    roughness: 0.72,
    tiltDeg: 177.4,
    spinRate: -0.04,
    atmosphere: { color: 0xfef3c7, intensity: 0.65, power: 2.6 },
  },
  moon: {
    texture: "moon.jpg",
    bumpScale: 0.012,
    roughness: 0.95,
    tiltDeg: 6.68,
    spinRate: 0.1,
  },
  mars: {
    texture: "mars.jpg",
    bumpScale: 0.016,
    roughness: 0.88,
    tiltDeg: 25.19,
    spinRate: 0.25,
    atmosphere: { color: 0xfb923c, intensity: 0.35, power: 3.2 },
  },
  jupiter: {
    texture: "jupiter.jpg",
    roughness: 0.68,
    tiltDeg: 3.13,
    oblateness: 0.935,
    spinRate: 0.55,
    atmosphere: { color: 0xfde68a, intensity: 0.24, power: 3.4 },
  },
  saturn: {
    texture: "saturn.jpg",
    roughness: 0.72,
    tiltDeg: 26.73,
    oblateness: 0.902,
    spinRate: 0.5,
    atmosphere: { color: 0xfef08a, intensity: 0.22, power: 3.4 },
  },
  uranus: {
    texture: "uranus.jpg",
    roughness: 0.66,
    tiltDeg: 97.77,
    oblateness: 0.977,
    spinRate: -0.35,
    atmosphere: { color: 0x67e8f9, intensity: 0.45, power: 2.8 },
  },
  neptune: {
    texture: "neptune.jpg",
    roughness: 0.64,
    tiltDeg: 28.32,
    oblateness: 0.983,
    spinRate: 0.38,
    atmosphere: { color: 0x3b82f6, intensity: 0.52, power: 2.7 },
  },
};

function computeVisualRadius(b: SolarSystem3DBody): number {
  if (b.id === "sun") return 0.76;
  if (b.id === "moon") return 0.11;
  if (b.id === "earth") return 0.28;
  if (b.id === "saturn") return 0.44;
  if (b.id === "jupiter") return 0.54;
  if (b.kind === "comet") return 0.12;
  return Math.max(0.16, b.radius_hint * 0.31);
}

function buildPlanetObjectWithRadius(
  b: { id: string; kind: string; color: string },
  r: number,
  maxAnisotropy: number,
): AnimatedSolarBodyHandle {
  const group = new THREE.Group();

  if (b.id === "sun") {
    const sunTex = loadPlanetTexture("sun.jpg", true, maxAnisotropy);
    const globe = new THREE.Mesh(
      new THREE.SphereGeometry(r, 64, 48),
      new THREE.MeshBasicMaterial({ map: sunTex, color: 0xfff8e7 }),
    );
    const corona = createFresnelRimMesh(r * 1.07, 0xf59e0b, 0.9, 1.8);
    const outerGlow = new THREE.Mesh(
      new THREE.SphereGeometry(r * 1.48, 32, 24),
      new THREE.MeshBasicMaterial({
        color: 0xf59e0b,
        transparent: true,
        opacity: 0.16,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    group.add(globe, corona, outerGlow);
    return {
      group,
      visualRadius: r,
      spinTarget: globe,
      spinRateRadPerSec: 0.08,
    };
  }

  if (b.id === "earth") {
    const tiltGroup = new THREE.Group();
    tiltGroup.rotation.z = 23.44 * DEG2RAD;

    const dayTex = loadPlanetTexture("earth_day.jpg", true, maxAnisotropy);
    const normTex = loadPlanetTexture("earth_normal.jpg", false, maxAnisotropy);
    const specTex = loadPlanetTexture("earth_specular.jpg", false, maxAnisotropy);
    const cloudTex = loadPlanetTexture("earth_clouds.png", true, maxAnisotropy);

    const earthMat = new THREE.MeshPhongMaterial({
      map: dayTex,
      normalMap: normTex,
      normalScale: new THREE.Vector2(0.85, 0.85),
      specularMap: specTex,
      specular: new THREE.Color(0x60a5fa),
      shininess: 30,
    });
    const earthGlobe = new THREE.Mesh(new THREE.SphereGeometry(r, 64, 48), earthMat);
    const cloudMesh = new THREE.Mesh(
      new THREE.SphereGeometry(r * 1.018, 64, 48),
      new THREE.MeshLambertMaterial({
        map: cloudTex,
        transparent: true,
        opacity: 0.82,
        depthWrite: false,
      }),
    );
    const atmosphere = createFresnelRimMesh(r * 1.055, 0x38bdf8, 0.72, 2.7);
    tiltGroup.add(earthGlobe, cloudMesh, atmosphere);
    group.add(tiltGroup);
    return {
      group,
      visualRadius: r,
      spinTarget: earthGlobe,
      spinRateRadPerSec: 0.28,
      cloudMesh,
    };
  }

  const spec = PLANET_SPECS[b.id];
  if (spec) {
    const tiltGroup = new THREE.Group();
    tiltGroup.rotation.z = spec.tiltDeg * DEG2RAD;
    const oblate = spec.oblateness ?? 1;

    const tex = loadPlanetTexture(spec.texture, true, maxAnisotropy);
    const globeMat = new THREE.MeshStandardMaterial({
      map: tex,
      roughness: spec.roughness,
      metalness: 0.04,
      ...(spec.bumpScale
        ? {
            bumpMap: tex,
            bumpScale: spec.bumpScale,
          }
        : {}),
    });
    const globe = new THREE.Mesh(new THREE.SphereGeometry(r, 64, 48), globeMat);
    if (oblate !== 1) globe.scale.set(1, oblate, 1);
    tiltGroup.add(globe);

    if (spec.atmosphere) {
      tiltGroup.add(
        createFresnelRimMesh(
          r * 1.045,
          spec.atmosphere.color,
          spec.atmosphere.intensity,
          spec.atmosphere.power,
          oblate,
        ),
      );
    }

    if (b.id === "saturn") {
      const ringTex = loadPlanetTexture("saturn_ring.png", true, maxAnisotropy);
      const ringGeo = createRadialRingGeometry(r * 1.24, r * 2.48, 128);
      const ringMat = new THREE.MeshStandardMaterial({
        map: ringTex,
        transparent: true,
        alphaTest: 0.02,
        side: THREE.DoubleSide,
        roughness: 0.85,
        metalness: 0.02,
        depthWrite: false,
      });
      tiltGroup.add(new THREE.Mesh(ringGeo, ringMat));
    }

    if (b.id === "uranus") {
      const uRingGeo = createRadialRingGeometry(r * 1.55, r * 1.92, 96);
      const uRingMat = new THREE.MeshBasicMaterial({
        color: 0xa5f3fc,
        transparent: true,
        opacity: 0.28,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      tiltGroup.add(new THREE.Mesh(uRingGeo, uRingMat));
    }

    let moonPivots: { pivot: THREE.Group; speedRadPerSec: number }[] | undefined;
    if (b.id === "jupiter") {
      const galilean = [
        { dist: r * 1.55, mr: r * 0.065, col: 0xfde047, speed: 1.5, phase: 0.4 },
        { dist: r * 1.92, mr: r * 0.055, col: 0xe2e8f0, speed: 1.05, phase: 2.1 },
        { dist: r * 2.42, mr: r * 0.082, col: 0xd6d3d1, speed: 0.65, phase: 4.0 },
        { dist: r * 3.05, mr: r * 0.075, col: 0x94a3b8, speed: 0.36, phase: 5.2 },
      ];
      moonPivots = galilean.map((gm) => {
        const pivot = new THREE.Group();
        pivot.rotation.y = gm.phase;
        const m = new THREE.Mesh(
          new THREE.SphereGeometry(gm.mr, 14, 10),
          new THREE.MeshStandardMaterial({ color: gm.col, roughness: 0.8 }),
        );
        m.position.x = gm.dist;
        pivot.add(m);
        tiltGroup.add(pivot);
        return { pivot, speedRadPerSec: gm.speed };
      });
    }

    group.add(tiltGroup);
    return {
      group,
      visualRadius: b.id === "saturn" ? r * 2.1 : r,
      spinTarget: globe,
      spinRateRadPerSec: spec.spinRate,
      moonPivots,
    };
  }

  if (b.kind === "comet") {
    const nucleus = new THREE.Mesh(
      new THREE.DodecahedronGeometry(r * 0.72, 1),
      new THREE.MeshStandardMaterial({
        color: 0xd1fae5,
        roughness: 0.9,
        emissive: new THREE.Color(0x34d399),
        emissiveIntensity: 0.35,
      }),
    );
    const comaSprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: getCometComaTexture(),
        color: 0xa7f3d0,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    comaSprite.scale.setScalar(r * 5.2);
    group.add(nucleus, comaSprite);
    return {
      group,
      visualRadius: r * 1.8,
      spinTarget: nucleus,
      spinRateRadPerSec: 0.4,
    };
  }

  // Dwarf planets (Pluto / Eris) with subtle moon-like albedo bump shading
  const fallbackTex = loadPlanetTexture("moon.jpg", true, maxAnisotropy);
  const dwarfMesh = new THREE.Mesh(
    new THREE.SphereGeometry(r, 40, 30),
    new THREE.MeshStandardMaterial({
      map: fallbackTex,
      color: new THREE.Color(b.color),
      bumpMap: fallbackTex,
      bumpScale: 0.01,
      roughness: 0.85,
    }),
  );
  group.add(dwarfMesh);
  return {
    group,
    visualRadius: r,
    spinTarget: dwarfMesh,
    spinRateRadPerSec: 0.14,
  };
}

export function createDetailedBodyObject(
  b: SolarSystem3DBody,
  maxAnisotropy: number,
): AnimatedSolarBodyHandle {
  return buildPlanetObjectWithRadius(b, computeVisualRadius(b), maxAnisotropy);
}

const STANDALONE_COLORS: Record<string, string> = {
  pluto: "#e7cbb3",
  eris: "#dbeafe",
};

export function createStandalonePlanetModel(
  bodyId: string,
  maxAnisotropy: number,
  radius = 2.0,
): AnimatedSolarBodyHandle {
  const id = bodyId.toLowerCase();
  const kind =
    id === "sun"
      ? "star"
      : id === "moon"
        ? "moon"
        : id === "pluto" || id === "eris"
          ? "dwarf_planet"
          : "planet";
  const color = STANDALONE_COLORS[id] ?? "#d6d3d1";
  return buildPlanetObjectWithRadius({ id, kind, color }, radius, maxAnisotropy);
}
