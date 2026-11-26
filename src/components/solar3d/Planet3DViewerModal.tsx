import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { Box, Pause, Play, RotateCcw, Sun, X } from "lucide-react";
import {
  type AnimatedSolarBodyHandle,
  createStandalonePlanetModel,
} from "@/components/solar3d/planetMeshes";
import { Button } from "@/components/ui/button";
import { useSkyStore } from "@/store/skyStore";

interface PlanetMetaInfo {
  id: string;
  nameJa: string;
  nameEn: string;
  diameterKm: string;
  tilt: string;
  rotation: string;
}

const PLANET_CATALOG: PlanetMetaInfo[] = [
  { id: "sun", nameJa: "太陽", nameEn: "Sun", diameterKm: "1,392,700 km", tilt: "7.25°", rotation: "約25.4日" },
  { id: "mercury", nameJa: "水星", nameEn: "Mercury", diameterKm: "4,879 km", tilt: "0.03°", rotation: "58.6日" },
  { id: "venus", nameJa: "金星", nameEn: "Venus", diameterKm: "12,104 km", tilt: "177.4°", rotation: "-243日 (逆行)" },
  { id: "earth", nameJa: "地球", nameEn: "Earth", diameterKm: "12,742 km", tilt: "23.44°", rotation: "23時間56分" },
  { id: "moon", nameJa: "月", nameEn: "Moon", diameterKm: "3,474 km", tilt: "6.68°", rotation: "27.3日 (同期)" },
  { id: "mars", nameJa: "火星", nameEn: "Mars", diameterKm: "6,779 km", tilt: "25.19°", rotation: "24時間37分" },
  { id: "jupiter", nameJa: "木星", nameEn: "Jupiter", diameterKm: "139,820 km", tilt: "3.13°", rotation: "9時間55分" },
  { id: "saturn", nameJa: "土星", nameEn: "Saturn", diameterKm: "116,460 km", tilt: "26.73°", rotation: "10時間33分" },
  { id: "uranus", nameJa: "天王星", nameEn: "Uranus", diameterKm: "50,724 km", tilt: "97.77°", rotation: "-17時間14分" },
  { id: "neptune", nameJa: "海王星", nameEn: "Neptune", diameterKm: "49,244 km", tilt: "28.32°", rotation: "16時間06分" },
  { id: "pluto", nameJa: "冥王星", nameEn: "Pluto", diameterKm: "2,377 km", tilt: "122.5°", rotation: "-6.39日" },
  { id: "eris", nameJa: "エリス", nameEn: "Eris", diameterKm: "2,326 km", tilt: "---", rotation: "約25.9時間" },
];

export function Planet3DViewerModal() {
  const planet3dBodyId = useSkyStore((s) => s.planet3dBodyId);
  const openPlanet3d = useSkyStore((s) => s.openPlanet3d);
  const skyFrame = useSkyStore((s) => s.skyFrame);

  const [autoSpin, setAutoSpin] = useState(true);
  const [fullLight, setFullLight] = useState(false);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const autoSpinRef = useRef(autoSpin);
  autoSpinRef.current = autoSpin;
  const fullLightRef = useRef(fullLight);
  fullLightRef.current = fullLight;

  const currentId = (planet3dBodyId ?? "saturn").toLowerCase();
  const meta = useMemo(
    () =>
      PLANET_CATALOG.find((p) => p.id === currentId) ?? {
        id: currentId,
        nameJa: currentId,
        nameEn: currentId,
        diameterKm: "---",
        tilt: "---",
        rotation: "---",
      },
    [currentId],
  );

  const liveBody = useMemo(
    () => skyFrame?.bodies.find((b) => b.id.toLowerCase() === currentId) ?? null,
    [skyFrame?.bodies, currentId],
  );
  const phaseAngleDeg = liveBody?.phase_angle_deg ?? 35;
  const phaseAngleRef = useRef(phaseAngleDeg);
  phaseAngleRef.current = phaseAngleDeg;

  useEffect(() => {
    if (!planet3dBodyId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") openPlanet3d(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [planet3dBodyId, openPlanet3d]);

  const cameraResetRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!planet3dBodyId) return;
    const el = containerRef.current;
    if (!el) return;

    const w = Math.max(280, el.clientWidth);
    const h = Math.max(280, el.clientHeight);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x030712);

    const camera = new THREE.PerspectiveCamera(42, w / h, 0.1, 200);
    const defaultCamPos =
      currentId === "saturn"
        ? new THREE.Vector3(0, 2.3, 8.2)
        : currentId === "jupiter"
          ? new THREE.Vector3(0, 1.4, 7.6)
          : new THREE.Vector3(0, 1.0, 6.2);
    camera.position.copy(defaultCamPos);

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h);
    el.innerHTML = "";
    el.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = currentId === "saturn" ? 4.2 : 3.0;
    controls.maxDistance = 18;
    controls.target.set(0, 0, 0);
    controls.update();

    cameraResetRef.current = () => {
      camera.position.copy(defaultCamPos);
      controls.target.set(0, 0, 0);
      controls.update();
    };

    // Background 3D stars
    const starCount = 900;
    const starPos = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      const u = Math.random();
      const v = Math.random();
      const theta = u * Math.PI * 2;
      const phi = Math.acos(2 * v - 1);
      const rad = 75 + Math.random() * 25;
      starPos[i * 3] = rad * Math.sin(phi) * Math.cos(theta);
      starPos[i * 3 + 1] = rad * Math.cos(phi);
      starPos[i * 3 + 2] = rad * Math.sin(phi) * Math.sin(theta);
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute("position", new THREE.BufferAttribute(starPos, 3));
    const starMat = new THREE.PointsMaterial({ color: 0xe2e8f0, size: 0.28, sizeAttenuation: true });
    scene.add(new THREE.Points(starGeo, starMat));

    const ambient = new THREE.AmbientLight(0xdbeafe, 0.35);
    const sunLight = new THREE.DirectionalLight(0xfffbeb, 2.8);
    const fillLight = new THREE.DirectionalLight(0x93c5fd, 0.45);
    fillLight.position.set(-5, -3, 4);
    scene.add(ambient, sunLight, fillLight);

    const maxAniso = renderer.capabilities.getMaxAnisotropy();
    const handle: AnimatedSolarBodyHandle = createStandalonePlanetModel(currentId, maxAniso, 2.0);
    scene.add(handle.group);

    let rafId = 0;
    let lastTime = performance.now();

    const animate = (now: number) => {
      rafId = window.requestAnimationFrame(animate);
      const dt = Math.min(0.05, Math.max(0.001, (now - lastTime) / 1000));
      lastTime = now;

      if (autoSpinRef.current) {
        const rate = handle.spinRateRadPerSec * 1.4;
        if (handle.spinTarget) handle.spinTarget.rotation.y += rate * dt;
        if (handle.cloudMesh) handle.cloudMesh.rotation.y += rate * 1.18 * dt;
        if (handle.moonPivots) {
          for (const mp of handle.moonPivots) {
            mp.pivot.rotation.y += mp.speedRadPerSec * 0.45 * dt;
          }
        }
      }

      if (fullLightRef.current) {
        ambient.intensity = 1.85;
        sunLight.intensity = 1.65;
        fillLight.intensity = 1.15;
        sunLight.position.set(4, 3, 7);
      } else {
        ambient.intensity = 0.24;
        sunLight.intensity = 3.1;
        fillLight.intensity = 0.22;
        const rad = (phaseAngleRef.current * Math.PI) / 180;
        sunLight.position.set(Math.sin(rad) * 10, 1.8, Math.cos(rad) * 10);
      }

      controls.update();
      renderer.render(scene, camera);
    };
    rafId = window.requestAnimationFrame(animate);

    const onResize = () => {
      if (!el) return;
      const nw = Math.max(240, el.clientWidth);
      const nh = Math.max(240, el.clientHeight);
      camera.aspect = nw / nh;
      camera.updateProjectionMatrix();
      renderer.setSize(nw, nh);
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(el);

    return () => {
      window.cancelAnimationFrame(rafId);
      ro.disconnect();
      controls.dispose();
      starGeo.dispose();
      starMat.dispose();
      renderer.dispose();
    };
  }, [planet3dBodyId, currentId]);

  if (!planet3dBodyId) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-2 backdrop-blur-md sm:p-5"
      style={{ WebkitBackdropFilter: "blur(14px)" }}
      onClick={() => openPlanet3d(null)}
    >
      <div
        className="flex h-[88dvh] w-full max-w-4xl flex-col overflow-hidden rounded-3xl border border-white/15 bg-[#040814]/95 text-[var(--text-primary)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 px-4 py-3">
          <div className="flex items-center gap-2">
            <Box className="h-4 w-4 text-[var(--accent-primary)]" />
            <span className="text-sm font-bold">
              {meta.nameJa} 3Dモデル観察
            </span>
            <span className="text-xs text-[var(--text-muted)]">{meta.nameEn}</span>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              type="button"
              size="sm"
              variant={autoSpin ? "tonal" : "outline"}
              className="h-7 gap-1 px-2 text-[11px]"
              onClick={() => setAutoSpin((v) => !v)}
            >
              {autoSpin ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
              <span>{autoSpin ? "自転中" : "停止中"}</span>
            </Button>
            <Button
              type="button"
              size="sm"
              variant={fullLight ? "tonal" : "outline"}
              className="h-7 gap-1 px-2 text-[11px]"
              onClick={() => setFullLight((v) => !v)}
            >
              <Sun className="h-3 w-3" />
              <span>{fullLight ? "全面ライト" : "位相照明"}</span>
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 gap-1 px-2 text-[11px]"
              onClick={() => cameraResetRef.current?.()}
            >
              <RotateCcw className="h-3 w-3" />
              <span>視点リセット</span>
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              onClick={() => openPlanet3d(null)}
              aria-label="閉じる"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Body Quick Switcher */}
        <div className="flex gap-1 overflow-x-auto border-b border-white/10 bg-white/[0.03] px-3 py-1.5">
          {PLANET_CATALOG.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => openPlanet3d(p.id)}
              className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
                p.id === currentId
                  ? "m3-tonal-active font-semibold"
                  : "text-[var(--text-secondary)] hover:bg-white/10"
              }`}
            >
              {p.nameJa}
            </button>
          ))}
        </div>

        {/* 3D Canvas Viewport */}
        <div className="relative min-h-0 flex-1 bg-[#030712]">
          <div ref={containerRef} className="h-full w-full touch-none" />
          <div className="pointer-events-none absolute bottom-3 left-3 right-3 flex flex-wrap items-end justify-between gap-2 text-[10.5px]">
            <div className="rounded-xl border border-white/10 bg-black/55 px-3 py-1.5 font-mono-num backdrop-blur-sm">
              <div>直径 {meta.diameterKm} ・ 赤道傾斜 {meta.tilt} ・ 自転 {meta.rotation}</div>
              {liveBody && (
                <div className="text-[var(--accent-primary)]">
                  視等級 {liveBody.visual_magnitude.toFixed(2)}等 ・ 輝面比{" "}
                  {(liveBody.illuminated_fraction * 100).toFixed(1)}%
                  {liveBody.saturn_ring_tilt_deg != null
                    ? ` ・ 環傾き ${liveBody.saturn_ring_tilt_deg.toFixed(1)}°`
                    : ""}
                </div>
              )}
            </div>
            <div className="rounded-full border border-white/10 bg-black/55 px-2.5 py-1 text-[10px] text-[var(--text-muted)] backdrop-blur-sm">
              ドラッグ / スワイプで回転 ・ ピンチ / ホイールで拡大縮小
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
