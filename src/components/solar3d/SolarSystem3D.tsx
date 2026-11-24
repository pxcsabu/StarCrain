import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  Compass,
  Eye,
  Orbit,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  X,
} from "lucide-react";
import { bvToRgb } from "@/lib/projection";
import {
  type AnimatedSolarBodyHandle,
  createDetailedBodyObject,
} from "@/components/solar3d/planetMeshes";
import { Button } from "@/components/ui/button";
import { useSkyStore } from "@/store/skyStore";
import type { SolarSystem3DBody, SolarSystem3DState } from "@/types/sky";

const OBLIQUITY_RAD = (23.4392911 * Math.PI) / 180;
const DEG2RAD = Math.PI / 180;

function jdToIsoDateTime(jdUt: number): string {
  const unixMs = (jdUt - 2440587.5) * 86400000;
  const d = new Date(unixMs);
  if (!Number.isFinite(d.getTime())) return "---";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${day} ${hh}:${mm}`;
}

/** Map J2000 Ecliptic (x, y, z) AU to Three.js (+X=Vernal, +Y=NorthPole, -Z=Solstice) */
function mapAuToScene(
  xyz: [number, number, number],
  scaleMode: "compressed" | "true",
): THREE.Vector3 {
  const [ex, ey, ez] = xyz;
  const r = Math.hypot(ex, ey, ez);
  if (r < 1e-8) return new THREE.Vector3(0, 0, 0);
  const sceneR =
    scaleMode === "compressed" ? 6.8 * Math.pow(r, 0.44) : 6.0 * r;
  const k = sceneR / r;
  return new THREE.Vector3(ex * k, ez * k, -ey * k);
}

/** Cylindrical polar (r, shortestAngle, z) interpolation keeps orbiting planets on elliptical arcs. */
function interpAuPolar(
  p0: [number, number, number],
  p1: [number, number, number],
  u: number,
): [number, number, number] {
  const r0 = Math.hypot(p0[0], p0[1]);
  const r1 = Math.hypot(p1[0], p1[1]);
  if (r0 < 1e-4 || r1 < 1e-4) {
    const w = 1 - u;
    return [p0[0] * w + p1[0] * u, p0[1] * w + p1[1] * u, p0[2] * w + p1[2] * u];
  }
  const th0 = Math.atan2(p0[1], p0[0]);
  const th1 = Math.atan2(p1[1], p1[0]);
  const dTh = Math.atan2(Math.sin(th1 - th0), Math.cos(th1 - th0));
  const th = th0 + dTh * u;
  const r = r0 + (r1 - r0) * u;
  const z = p0[2] + (p1[2] - p0[2]) * u;
  return [r * Math.cos(th), r * Math.sin(th), z];
}

export function SolarSystem3D() {
  const jdUt = useSkyStore((s) => s.jdUt);
  const staticAssets = useSkyStore((s) => s.staticAssets);
  const cometsVersion = useSkyStore((s) => s.cometsVersion);
  const jumpToJdUt = useSkyStore((s) => s.jumpToJdUt);
  const setActivePanel = useSkyStore((s) => s.setActivePanel);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scaleMode, setScaleMode] = useState<"compressed" | "true">("compressed");
  const [focusId, setFocusId] = useState<string>("sun");
  const [showOrbits, setShowOrbits] = useState<boolean>(true);
  const [showLabels, setShowLabels] = useState<boolean>(true);
  const [syncWithSky, setSyncWithSky] = useState<boolean>(true);
  const [playing, setPlaying] = useState<boolean>(false);
  const [direction, setDirection] = useState<1 | -1>(1);
  const [daysPerSec, setDaysPerSec] = useState<number>(15);
  const [localJd, setLocalJd] = useState<number>(jdUt);
  const [bodies, setBodies] = useState<SolarSystem3DBody[]>([]);

  const labelDomRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const lastLabelPosRef = useRef<Map<string, { x: number; y: number; vis: boolean }>>(new Map());
  const dateTextRef = useRef<HTMLSpanElement | null>(null);
  const lastDateStrRef = useRef<string>("");
  const localJdRef = useRef<number>(jdUt);
  const lastSyncPushRef = useRef<number>(0);
  const lastBodiesUiEmitRef = useRef<number>(0);
  const wasPlayingRef = useRef<boolean>(false);

  const playingRef = useRef<boolean>(playing);
  playingRef.current = playing;
  const directionRef = useRef<1 | -1>(direction);
  directionRef.current = direction;
  const daysPerSecRef = useRef<number>(daysPerSec);
  daysPerSecRef.current = daysPerSec;
  const syncWithSkyRef = useRef<boolean>(syncWithSky);
  syncWithSkyRef.current = syncWithSky;

  // Mutable Three.js handles
  const sceneRef = useRef<{
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    renderer: THREE.WebGLRenderer;
    controls: OrbitControls;
    meshes: Map<string, THREE.Object3D>;
    bodyHandles: Map<string, AnimatedSolarBodyHandle>;
    tailsMap: Map<string, THREE.Line>;
    maxAnisotropy: number;
    orbitsGroup: THREE.Group;
    gridGroup: THREE.Group;
    tailsGroup: THREE.Group;
    starsPoints: THREE.Points | null;
  } | null>(null);

  const cachedOrbitsRef = useRef<Map<string, [number, number, number][]>>(new Map());
  const latestBodiesRef = useRef<SolarSystem3DBody[]>([]);
  const keyframesRef = useRef<
    { jd: number; bodies: SolarSystem3DBody[]; byId: Map<string, SolarSystem3DBody> }[]
  >([]);
  const focusIdRef = useRef<string>(focusId);
  focusIdRef.current = focusId;
  const scaleModeRef = useRef<"compressed" | "true">(scaleMode);
  scaleModeRef.current = scaleMode;
  const showLabelsRef = useRef<boolean>(showLabels);
  showLabelsRef.current = showLabels;
  const fetchInFlightRef = useRef<boolean>(false);
  const simEpochRef = useRef<number>(0);
  const jumpToJdUtRef = useRef(jumpToJdUt);
  jumpToJdUtRef.current = jumpToJdUt;
  const requestKeyframeRef = useRef<((targetJd: number, cometsDirty: boolean) => void) | null>(null);

  useEffect(() => {
    lastLabelPosRef.current.clear();
  }, [showLabels, bodies]);

  // Sync external store -> localJd when sync mode active and paused
  useEffect(() => {
    if (syncWithSky && !playing) {
      localJdRef.current = jdUt;
      setLocalJd(jdUt);
    }
  }, [jdUt, syncWithSky, playing]);

  // Initialize Three.js WebGL scene once
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const width = Math.max(300, container.clientWidth);
    const height = Math.max(240, container.clientHeight);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#030612");

    const camera = new THREE.PerspectiveCamera(48, width / height, 0.1, 2500);
    camera.position.set(16, 15, 22);

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio || 1));
    renderer.setSize(width, height);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    container.appendChild(renderer.domElement);
    const maxAnisotropy = renderer.capabilities.getMaxAnisotropy();

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 0.55;
    controls.maxDistance = 600;

    // Physical Sunlight + Subtle Fill Lighting for Day/Night Hemisphere Detail
    const ambient = new THREE.AmbientLight(0x94a3b8, 0.62);
    scene.add(ambient);
    const hemi = new THREE.HemisphereLight(0xcbd5e1, 0x1e293b, 0.34);
    scene.add(hemi);
    const sunLight = new THREE.PointLight(0xfff7e6, 3.2, 0, 0);
    scene.add(sunLight);

    const orbitsGroup = new THREE.Group();
    const gridGroup = new THREE.Group();
    const tailsGroup = new THREE.Group();
    scene.add(orbitsGroup);
    scene.add(gridGroup);
    scene.add(tailsGroup);

    // Background stars mapped from real J2000 bright stars
    let starsPoints: THREE.Points | null = null;
    if (staticAssets?.named_stars && staticAssets.named_stars.length > 0) {
      const stars = staticAssets.named_stars.slice(0, 2200);
      const posArr = new Float32Array(stars.length * 3);
      const colArr = new Float32Array(stars.length * 3);
      const cosE = Math.cos(OBLIQUITY_RAD);
      const sinE = Math.sin(OBLIQUITY_RAD);

      stars.forEach((st, idx) => {
        const ra = st.ra_deg * DEG2RAD;
        const dec = st.dec_deg * DEG2RAD;
        const eqX = Math.cos(dec) * Math.cos(ra);
        const eqY = Math.cos(dec) * Math.sin(ra);
        const eqZ = Math.sin(dec);
        // Equatorial -> Ecliptic rotation around X by -obliquity
        const eclX = eqX;
        const eclY = cosE * eqY + sinE * eqZ;
        const eclZ = -sinE * eqY + cosE * eqZ;
        const R = 420;
        posArr[idx * 3] = eclX * R;
        posArr[idx * 3 + 1] = eclZ * R;
        posArr[idx * 3 + 2] = -eclY * R;

        const rgb = bvToRgb(st.ci, false);
        const dim = Math.max(0.28, Math.min(1, (5.8 - st.mag) / 5.5));
        colArr[idx * 3] = (rgb.r / 255) * dim;
        colArr[idx * 3 + 1] = (rgb.g / 255) * dim;
        colArr[idx * 3 + 2] = (rgb.b / 255) * dim;
      });

      const starGeo = new THREE.BufferGeometry();
      starGeo.setAttribute("position", new THREE.BufferAttribute(posArr, 3));
      starGeo.setAttribute("color", new THREE.BufferAttribute(colArr, 3));
      const starMat = new THREE.PointsMaterial({
        size: 1.5,
        vertexColors: true,
        sizeAttenuation: false,
      });
      starsPoints = new THREE.Points(starGeo, starMat);
      scene.add(starsPoints);
    }

    const meshes = new Map<string, THREE.Object3D>();
    const bodyHandles = new Map<string, AnimatedSolarBodyHandle>();
    const tailsMap = new Map<string, THREE.Line>();
    sceneRef.current = {
      scene,
      camera,
      renderer,
      controls,
      meshes,
      bodyHandles,
      tailsMap,
      maxAnisotropy,
      orbitsGroup,
      gridGroup,
      tailsGroup,
      starsPoints,
    };

    const ro = new ResizeObserver(() => {
      if (!container || !sceneRef.current) return;
      const w = Math.max(240, container.clientWidth);
      const h = Math.max(200, container.clientHeight);
      sceneRef.current.camera.aspect = w / h;
      sceneRef.current.camera.updateProjectionMatrix();
      sceneRef.current.renderer.setSize(w, h);
    });
    ro.observe(container);

    let rafId = 0;
    const tmpLabel = new THREE.Vector3();
    const tmpTailPos = new THREE.Vector3();
    const tmpTailDir = new THREE.Vector3();
    let prevAnimTs = performance.now();

    const animate = (now: number) => {
      const dt = Math.min(0.05, Math.max(0.001, (now - prevAnimTs) / 1000));
      prevAnimTs = now;
      const ctx = sceneRef.current;
      if (!ctx) return;

      // Continuous per-vblank simulation advancement & keyframe interpolation
      if (playingRef.current) {
        const dir = directionRef.current;
        const speed = daysPerSecRef.current;
        const nextJd = localJdRef.current + dir * speed * dt;
        localJdRef.current = nextJd;

        const formatted = jdToIsoDateTime(nextJd);
        if (dateTextRef.current && formatted !== lastDateStrRef.current) {
          lastDateStrRef.current = formatted;
          dateTextRef.current.textContent = formatted;
        }

        if (syncWithSkyRef.current && now - lastSyncPushRef.current >= 220) {
          lastSyncPushRef.current = now;
          jumpToJdUtRef.current(nextJd);
        }

        const kfs = keyframesRef.current;
        while (kfs.length > 2 && dir * (nextJd - kfs[1].jd) >= 0) {
          kfs.shift();
        }
        if (!fetchInFlightRef.current && kfs.length < 3) {
          const tailJd = kfs.length > 0 ? kfs[kfs.length - 1].jd : nextJd;
          const baseJd = dir > 0 ? Math.max(nextJd, tailJd) : Math.min(nextJd, tailJd);
          const stepDays = Math.max(0.04, speed * 0.085);
          requestKeyframeRef.current?.(baseJd + dir * stepDays, false);
        }

        if (kfs.length >= 2) {
          const kf0 = kfs[0];
          const kf1 = kfs[1];
          const span = kf1.jd - kf0.jd;
          const u =
            Math.abs(span) < 1e-9
              ? 1
              : Math.max(0, Math.min(1, (nextJd - kf0.jd) / span));
          applyInterpolatedState(ctx, kf0, kf1, u, scaleModeRef.current, tmpTailPos, tmpTailDir);
        } else if (kfs.length === 1) {
          applyInterpolatedState(ctx, kfs[0], kfs[0], 0, scaleModeRef.current, tmpTailPos, tmpTailDir);
        }
      }

      for (const h of ctx.bodyHandles.values()) {
        if (h.spinTarget) {
          h.spinTarget.rotation.y += h.spinRateRadPerSec * dt;
        }
        if (h.cloudMesh) {
          h.cloudMesh.rotation.y += 0.34 * dt;
        }
        if (h.moonPivots) {
          for (const mp of h.moonPivots) {
            mp.pivot.rotation.y += mp.speedRadPerSec * dt;
          }
        }
      }

      const focusMesh = ctx.meshes.get(focusIdRef.current);
      if (focusMesh) {
        const trackAlpha = 1 - Math.exp(-12 * dt);
        ctx.controls.target.lerp(focusMesh.position, trackAlpha);
      }

      ctx.controls.update();
      ctx.renderer.render(ctx.scene, ctx.camera);

      // Update projected 2D label transforms every vblank directly via DOM refs (zero React re-renders)
      if (showLabelsRef.current) {
        const w = container.clientWidth;
        const h = container.clientHeight;
        for (const b of latestBodiesRef.current) {
          if (b.id === "moon") continue;
          const el = labelDomRefs.current.get(b.id);
          const obj = ctx.meshes.get(b.id);
          if (!el || !obj) continue;
          tmpLabel.copy(obj.position).project(ctx.camera);
          const vis =
            tmpLabel.z > -1 &&
            tmpLabel.z < 1 &&
            tmpLabel.x >= -1 &&
            tmpLabel.x <= 1 &&
            tmpLabel.y >= -1 &&
            tmpLabel.y <= 1;
          const x = (tmpLabel.x * 0.5 + 0.5) * w;
          const y = (-tmpLabel.y * 0.5 + 0.5) * h;
          const prev = lastLabelPosRef.current.get(b.id);
          if (
            prev &&
            prev.vis === vis &&
            (!vis || (Math.abs(prev.x - x) < 0.25 && Math.abs(prev.y - y) < 0.25))
          ) {
            continue;
          }
          lastLabelPosRef.current.set(b.id, { x, y, vis });
          if (vis) {
            el.style.display = "";
            el.style.transform = `translate3d(${x.toFixed(1)}px, ${(y - 16).toFixed(1)}px, 0) translate(-50%, -50%)`;
          } else {
            el.style.display = "none";
          }
        }
      }

      rafId = requestAnimationFrame(animate);
    };
    rafId = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(rafId);
      ro.disconnect();
      controls.dispose();
      scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh || obj instanceof THREE.Line || obj instanceof THREE.Points) {
          obj.geometry.dispose();
          if (Array.isArray(obj.material)) {
            obj.material.forEach((m) => m.dispose());
          } else {
            obj.material.dispose();
          }
        }
      });
      renderer.dispose();
      if (renderer.domElement.parentElement === container) {
        container.removeChild(renderer.domElement);
      }
      sceneRef.current = null;
    };
  }, [staticAssets]);

  // Rebuild orbits & AU rings when scaleMode / showOrbits changes or initial orbits arrive
  const rebuildOrbitGeometry = (bodyList: SolarSystem3DBody[]) => {
    const ctx = sceneRef.current;
    if (!ctx) return;

    while (ctx.orbitsGroup.children.length > 0) {
      const ch = ctx.orbitsGroup.children[0];
      ctx.orbitsGroup.remove(ch);
      if (ch instanceof THREE.Line) {
        ch.geometry.dispose();
        (ch.material as THREE.Material).dispose();
      }
    }
    while (ctx.gridGroup.children.length > 0) {
      const ch = ctx.gridGroup.children[0];
      ctx.gridGroup.remove(ch);
      if (ch instanceof THREE.Line) {
        ch.geometry.dispose();
        (ch.material as THREE.Material).dispose();
      }
    }

    if (!showOrbits) return;

    // Ecliptic AU reference rings
    for (const au of [1.0, 5.2, 10.0, 30.0]) {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 180; i++) {
        const ang = (i / 180) * Math.PI * 2;
        pts.push(mapAuToScene([Math.cos(ang) * au, Math.sin(ang) * au, 0], scaleMode));
      }
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const mat = new THREE.LineBasicMaterial({
        color: 0x334155,
        transparent: true,
        opacity: 0.35,
      });
      ctx.gridGroup.add(new THREE.Line(geo, mat));
    }

    for (const b of bodyList) {
      const rawOrbit = cachedOrbitsRef.current.get(b.id) ?? b.orbit_xyz_au;
      if (!rawOrbit || rawOrbit.length < 2) continue;
      const pts = rawOrbit.map((p) => mapAuToScene(p, scaleMode));
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const mat = new THREE.LineBasicMaterial({
        color: new THREE.Color(b.color),
        transparent: true,
        opacity: b.kind === "comet" ? 0.38 : 0.58,
      });
      ctx.orbitsGroup.add(new THREE.Line(geo, mat));
    }
  };

  // Sync body meshes & positions cleanly with GC-free in-place comet tails & polar interpolation
  const updateCometTail = (
    ctx: NonNullable<typeof sceneRef.current>,
    id: string,
    pos: THREE.Vector3,
    helioAu: number,
    tmpDir: THREE.Vector3,
  ) => {
    let tailLine = ctx.tailsMap.get(id);
    if (helioAu >= 8.0) {
      if (tailLine) tailLine.visible = false;
      return;
    }
    if (!tailLine) {
      const arr = new Float32Array(6);
      const tGeo = new THREE.BufferGeometry();
      tGeo.setAttribute("position", new THREE.BufferAttribute(arr, 3));
      const tMat = new THREE.LineBasicMaterial({
        color: 0x6ee7b7,
        transparent: true,
        opacity: 0.72,
      });
      tailLine = new THREE.Line(tGeo, tMat);
      tailLine.frustumCulled = false;
      ctx.tailsMap.set(id, tailLine);
      ctx.tailsGroup.add(tailLine);
    }
    tailLine.visible = true;
    const tailLen = Math.max(0.6, Math.min(3.5, 2.8 / Math.max(0.3, helioAu)));
    tmpDir.copy(pos);
    const len = tmpDir.length();
    if (len > 1e-6) {
      tmpDir.multiplyScalar(1 / len);
    } else {
      tmpDir.set(1, 0, 0);
    }
    const posAttr = tailLine.geometry.getAttribute("position") as THREE.BufferAttribute;
    const arr = posAttr.array as Float32Array;
    arr[0] = pos.x;
    arr[1] = pos.y;
    arr[2] = pos.z;
    arr[3] = pos.x + tmpDir.x * tailLen;
    arr[4] = pos.y + tmpDir.y * tailLen;
    arr[5] = pos.z + tmpDir.z * tailLen;
    posAttr.needsUpdate = true;
  };

  const applyInterpolatedState = (
    ctx: NonNullable<typeof sceneRef.current>,
    kf0: { jd: number; bodies: SolarSystem3DBody[]; byId: Map<string, SolarSystem3DBody> },
    kf1: { jd: number; bodies: SolarSystem3DBody[]; byId: Map<string, SolarSystem3DBody> },
    u: number,
    mode: "compressed" | "true",
    tmpPos: THREE.Vector3,
    tmpDir: THREE.Vector3,
  ) => {
    const useInterp = u > 0.001 && kf0 !== kf1;
    const e0 = kf0.byId.get("earth");
    const e1 = kf1.byId.get("earth");
    let earthScenePos = tmpPos.set(0, 0, 0);
    let earthAuX = e0?.pos_xyz_au[0] ?? 0;
    let earthAuY = e0?.pos_xyz_au[1] ?? 0;
    let earthAuZ = e0?.pos_xyz_au[2] ?? 0;

    if (e0) {
      if (useInterp && e1) {
        const p = interpAuPolar(e0.pos_xyz_au, e1.pos_xyz_au, u);
        earthAuX = p[0];
        earthAuY = p[1];
        earthAuZ = p[2];
        earthScenePos = mapAuToScene([earthAuX, earthAuY, earthAuZ], mode);
      } else {
        earthScenePos = mapAuToScene(e0.pos_xyz_au, mode);
      }
    }

    for (const b0 of kf0.bodies) {
      let obj = ctx.meshes.get(b0.id);
      if (!obj) {
        const handle = createDetailedBodyObject(b0, ctx.maxAnisotropy);
        obj = handle.group;
        ctx.bodyHandles.set(b0.id, handle);
        ctx.meshes.set(b0.id, obj);
        ctx.scene.add(obj);
      }

      const b1 = useInterp ? (kf1.byId.get(b0.id) ?? b0) : b0;
      if (b0.id === "moon" && e0) {
        const dx0 = b0.pos_xyz_au[0] - e0.pos_xyz_au[0];
        const dy0 = b0.pos_xyz_au[1] - e0.pos_xyz_au[1];
        const dz0 = b0.pos_xyz_au[2] - e0.pos_xyz_au[2];
        if (useInterp && e1) {
          const dx1 = b1.pos_xyz_au[0] - e1.pos_xyz_au[0];
          const dy1 = b1.pos_xyz_au[1] - e1.pos_xyz_au[1];
          const dz1 = b1.pos_xyz_au[2] - e1.pos_xyz_au[2];
          const rel = interpAuPolar([dx0, dy0, dz0], [dx1, dy1, dz1], u);
          tmpDir.set(rel[0], rel[2], -rel[1]).normalize();
        } else {
          tmpDir.set(dx0, dz0, -dy0).normalize();
        }
        obj.position.copy(earthScenePos).addScaledVector(tmpDir, 0.78);
      } else {
        const xyz = useInterp ? interpAuPolar(b0.pos_xyz_au, b1.pos_xyz_au, u) : b0.pos_xyz_au;
        obj.position.copy(mapAuToScene(xyz, mode));
      }

      if (b0.kind === "comet") {
        const hAu = useInterp ? b0.helio_au * (1 - u) + b1.helio_au * u : b0.helio_au;
        updateCometTail(ctx, b0.id, obj.position, hAu, tmpDir);
      }
    }
  };

  const updateBodyMeshes = (bodyList: SolarSystem3DBody[]) => {
    const ctx = sceneRef.current;
    if (!ctx) return;
    const byId = new Map<string, SolarSystem3DBody>();
    for (const b of bodyList) byId.set(b.id, b);
    const kf = { jd: localJdRef.current, bodies: bodyList, byId };
    applyInterpolatedState(ctx, kf, kf, 0, scaleMode, new THREE.Vector3(), new THREE.Vector3());
  };

  const prevCometsVerRef = useRef<number>(cometsVersion);

  const requestKeyframe = (targetJd: number, cometsDirty: boolean) => {
    if (!isTauri()) return;
    if (!cometsDirty && fetchInFlightRef.current) return;
    if (cometsDirty) {
      simEpochRef.current += 1;
      cachedOrbitsRef.current.clear();
      keyframesRef.current = [];
      const ctx = sceneRef.current;
      if (ctx) {
        for (const [id, obj] of ctx.meshes.entries()) {
          if (id.startsWith("comet:")) {
            ctx.scene.remove(obj);
            ctx.meshes.delete(id);
            ctx.bodyHandles.delete(id);
          }
        }
        for (const [id, line] of ctx.tailsMap.entries()) {
          if (id.startsWith("comet:")) {
            ctx.tailsGroup.remove(line);
            line.geometry.dispose();
            (line.material as THREE.Material).dispose();
            ctx.tailsMap.delete(id);
          }
        }
      }
    }
    const reqEpoch = simEpochRef.current;
    fetchInFlightRef.current = true;
    const needOrbits = cachedOrbitsRef.current.size === 0 || cometsDirty;
    void invoke<SolarSystem3DState>("get_solar_system_3d_state", {
      req: { jd_ut: targetJd, include_orbits: needOrbits },
    })
      .then((res) => {
        if (needOrbits) {
          for (const b of res.bodies) {
            if (b.orbit_xyz_au.length > 0) {
              cachedOrbitsRef.current.set(b.id, b.orbit_xyz_au);
            }
          }
          rebuildOrbitGeometry(res.bodies);
        }
        if (reqEpoch !== simEpochRef.current && !cometsDirty) return;
        const byId = new Map<string, SolarSystem3DBody>();
        for (const b of res.bodies) byId.set(b.id, b);
        const kf = { jd: targetJd, bodies: res.bodies, byId };
        if (playingRef.current) {
          keyframesRef.current.push(kf);
          if (keyframesRef.current.length > 5) {
            keyframesRef.current.shift();
          }
        } else {
          keyframesRef.current = [kf];
          updateBodyMeshes(res.bodies);
        }
        latestBodiesRef.current = res.bodies;
        const now = performance.now();
        if (!playingRef.current || now - lastBodiesUiEmitRef.current >= 180) {
          lastBodiesUiEmitRef.current = now;
          setBodies(res.bodies);
        }
      })
      .finally(() => {
        fetchInFlightRef.current = false;
      });
  };
  requestKeyframeRef.current = requestKeyframe;

  // Fetch solar system positions when paused JD or registered comets change
  useEffect(() => {
    const cometsDirty = prevCometsVerRef.current !== cometsVersion;
    prevCometsVerRef.current = cometsVersion;
    if (playingRef.current) {
      if (cometsDirty) {
        requestKeyframe(localJdRef.current, true);
      }
      return;
    }
    localJdRef.current = localJd;
    lastDateStrRef.current = jdToIsoDateTime(localJd);
    if (dateTextRef.current) {
      dateTextRef.current.textContent = lastDateStrRef.current;
    }
    requestKeyframe(localJd, cometsDirty);
  }, [localJd, cometsVersion]);

  // Rebuild orbits & positions when scaleMode / showOrbits / focusId changes
  useEffect(() => {
    if (latestBodiesRef.current.length === 0) return;
    rebuildOrbitGeometry(latestBodiesRef.current);
    if (!playing) {
      updateBodyMeshes(latestBodiesRef.current);
    }
  }, [scaleMode, showOrbits, focusId]);

  // Play/pause lifecycle: prime lookahead keyframe when starting; sync JD on pause
  useEffect(() => {
    simEpochRef.current += 1;
    if (!playing) {
      if (wasPlayingRef.current) {
        setLocalJd(localJdRef.current);
        if (syncWithSkyRef.current) {
          jumpToJdUtRef.current(localJdRef.current);
        }
      }
      wasPlayingRef.current = false;
      return;
    }
    wasPlayingRef.current = true;
    const seedBodies = latestBodiesRef.current;
    if (seedBodies.length > 0) {
      const byId = new Map<string, SolarSystem3DBody>();
      for (const b of seedBodies) byId.set(b.id, b);
      keyframesRef.current = [{ jd: localJdRef.current, bodies: seedBodies, byId }];
      const stepDays = Math.max(0.04, daysPerSec * 0.085);
      requestKeyframe(localJdRef.current + direction * stepDays, false);
    } else {
      keyframesRef.current = [];
      requestKeyframe(localJdRef.current, false);
    }
  }, [playing, direction, daysPerSec]);

  const focusedBody = bodies.find((b) => b.id === focusId) ?? bodies[0] ?? null;

  return (
    <aside className="flex h-full w-[48rem] max-w-[calc(100vw-5.5rem)] flex-col rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface-glass)] text-[var(--text-primary)] shadow-2xl backdrop-blur-md">
      {/* Header */}
      <div className="flex items-start justify-between gap-2 border-b border-[var(--border-subtle)] px-4 py-2.5">
        <div>
          <h2 className="flex items-center gap-1.5 text-sm font-semibold tracking-tight">
            <Orbit className="h-4 w-4 text-[var(--accent-primary)]" /> 3D 太陽系シミュレーター
          </h2>
          <p className="text-[11px] text-[var(--text-muted)]">
            ドラッグ回転・ホイールズーム・右ドラッグ移動 /{" "}
            <span ref={dateTextRef}>{jdToIsoDateTime(localJd)}</span>
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => setActivePanel(null)}
          title="閉じる"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Controls Strip */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-subtle)] px-4 py-2 text-xs">
        <div className="flex flex-wrap items-center gap-1.5">
          <select
            value={focusId}
            onChange={(e) => {
              const id = e.target.value;
              setFocusId(id);
              const ctx = sceneRef.current;
              const mesh = ctx?.meshes.get(id);
              const handle = ctx?.bodyHandles.get(id);
              if (ctx && mesh) {
                ctx.controls.target.copy(mesh.position);
                if (id !== "sun" && handle) {
                  const viewDist = Math.max(1.35, handle.visualRadius * 3.8);
                  const dir = new THREE.Vector3(0.55, 0.38, 0.74).normalize();
                  ctx.camera.position.copy(mesh.position).addScaledVector(dir, viewDist);
                }
              }
            }}
            className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 py-1 text-xs text-[var(--text-primary)]"
          >
            {bodies
              .filter((b) => b.id !== "moon")
              .map((b) => (
                <option key={b.id} value={b.id}>
                  注視: {b.name_ja} ({b.helio_au.toFixed(2)} AU)
                </option>
              ))}
          </select>

          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1 px-2 text-[11px]"
            onClick={() =>
              setScaleMode((m) => (m === "compressed" ? "true" : "compressed"))
            }
          >
            {scaleMode === "compressed" ? "圧縮スケール" : "実距離スケール"}
          </Button>

          <Button
            variant={showOrbits ? "default" : "outline"}
            size="sm"
            className="h-7 px-2 text-[11px]"
            onClick={() => setShowOrbits((v) => !v)}
          >
            軌道線
          </Button>
          <Button
            variant={showLabels ? "default" : "outline"}
            size="sm"
            className="h-7 px-2 text-[11px]"
            onClick={() => setShowLabels((v) => !v)}
          >
            <Eye className="h-3 w-3 mr-1" /> ラベル
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <Button
            variant={playing && direction === -1 ? "default" : "outline"}
            size="sm"
            className="h-7 px-2 text-[11px]"
            onClick={() => {
              if (playing && direction === -1) setPlaying(false);
              else {
                setDirection(-1);
                setPlaying(true);
              }
            }}
          >
            <RotateCcw className="h-3 w-3 mr-1" /> 逆再生
          </Button>
          <Button
            variant={playing && direction === 1 ? "default" : "outline"}
            size="sm"
            className="h-7 px-2 text-[11px]"
            onClick={() => {
              if (playing && direction === 1) setPlaying(false);
              else {
                setDirection(1);
                setPlaying(true);
              }
            }}
          >
            {playing && direction === 1 ? (
              <Pause className="h-3 w-3 mr-1" />
            ) : (
              <Play className="h-3 w-3 mr-1" />
            )}
            {playing ? "停止" : "再生"}
          </Button>

          <select
            value={daysPerSec}
            onChange={(e) => setDaysPerSec(Number(e.target.value))}
            className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-1.5 py-1 font-mono-num text-[11px]"
          >
            <option value={1}>1日/s</option>
            <option value={7}>7日/s</option>
            <option value={15}>15日/s</option>
            <option value={60}>60日/s</option>
            <option value={180}>180日/s</option>
          </select>

          <label className="ml-1 flex cursor-pointer items-center gap-1 text-[11px] text-[var(--text-secondary)]">
            <input
              type="checkbox"
              checked={syncWithSky}
              onChange={(e) => {
                setSyncWithSky(e.target.checked);
                if (e.target.checked) jumpToJdUt(localJd);
              }}
              className="h-3.5 w-3.5 accent-[var(--accent-primary)]"
            />
            星図同期
          </label>
        </div>
      </div>

      {/* 3D WebGL Viewport + Floating Label Overlay */}
      <div className="relative min-h-0 flex-1 overflow-hidden bg-[#030612]">
        <div ref={containerRef} className="h-full w-full" />

        {showLabels && (
          <div className="pointer-events-none absolute inset-0 overflow-hidden">
            {bodies
              .filter((b) => b.id !== "moon")
              .map((b) => (
                <button
                  key={b.id}
                  ref={(el) => {
                    if (el) {
                      labelDomRefs.current.set(b.id, el);
                    } else {
                      labelDomRefs.current.delete(b.id);
                    }
                  }}
                  type="button"
                  onClick={() => setFocusId(b.id)}
                  style={{
                    left: 0,
                    top: 0,
                    color: b.color,
                    display: "none",
                  }}
                  className="pointer-events-auto absolute rounded border border-white/15 bg-slate-950/80 px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap hover:bg-slate-900"
                >
                  {b.name_ja}
                </button>
              ))}
          </div>
        )}

        {/* Quick Camera Presets bottom-left */}
        <div className="absolute bottom-3 left-3 flex gap-1.5">
          <Button
            variant="outline"
            size="sm"
            className="h-7 border-white/15 bg-slate-950/80 px-2 text-[10.5px] hover:bg-slate-900"
            onClick={() => {
              const ctx = sceneRef.current;
              if (!ctx) return;
              setFocusId("sun");
              ctx.controls.target.set(0, 0, 0);
              ctx.camera.position.set(16, 15, 22);
            }}
          >
            全体斜め
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 border-white/15 bg-slate-950/80 px-2 text-[10.5px] hover:bg-slate-900"
            onClick={() => {
              const ctx = sceneRef.current;
              if (!ctx) return;
              setFocusId("sun");
              ctx.controls.target.set(0, 0, 0);
              ctx.camera.position.set(0, 32, 0.01);
            }}
          >
            真上 (黄道北極)
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 border-white/15 bg-slate-950/80 px-2 text-[10.5px] hover:bg-slate-900"
            onClick={() => {
              setSyncWithSky(true);
              setLocalJd(useSkyStore.getState().jdUt);
            }}
          >
            <RefreshCw className="mr-1 h-3 w-3" /> 星図時刻取得
          </Button>
        </div>
      </div>

      {/* Bottom Selected Body Telemetry */}
      {focusedBody && (
        <div className="flex items-center justify-between gap-3 border-t border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)]/70 px-4 py-2 text-[11px]">
          <div className="flex items-center gap-3 font-mono-num">
            <span className="font-sans font-bold" style={{ color: focusedBody.color }}>
              {focusedBody.name_ja}
            </span>
            <span>日心: {focusedBody.helio_au.toFixed(3)} AU</span>
            <span>地心: {focusedBody.geo_au.toFixed(3)} AU</span>
            <span>{focusedBody.mag.toFixed(1)}等</span>
            <span>離角 {focusedBody.elongation_deg.toFixed(1)}°</span>
          </div>
          {focusedBody.id !== "sun" && focusedBody.id !== "earth" && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1 px-2 text-[10.5px]"
              onClick={() => {
                jumpToJdUt(localJd);
                useSkyStore
                  .getState()
                  .centerOnSkyCoords(focusedBody.ra_deg, focusedBody.dec_deg);
              }}
            >
              <Compass className="h-3 w-3" /> 星図でこの天体を見る
            </Button>
          )}
        </div>
      )}
    </aside>
  );
}
