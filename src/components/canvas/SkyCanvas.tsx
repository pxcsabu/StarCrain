import { useCallback, useEffect, useRef } from "react";
import {
  createStarSpriteAtlas,
  type MeteorParticle,
  renderMeteorOverlay,
  renderSkyCanvas,
  type StarSpriteAtlas,
  stepMeteorParticles,
} from "@/components/canvas/skyRenderer";
import { enuToAzAlt, startSkyOrientationSensor } from "@/lib/deviceSensors";
import { onHipsTileLoaded } from "@/lib/hipsSurvey";
import { initCustomPanoramaFromStorage } from "@/lib/panoramaLandscape";
import {
  applyStandardRefractionDeg,
  effectiveFovDeg,
  equatorialToHorizontalFast,
  j2000ToHorWithMatrix,
  unprojectScreen,
  wrapDeg180,
  wrapDeg360,
} from "@/lib/projection";
import { useSkyStore } from "@/store/skyStore";
import { useTelemetryStore } from "@/store/telemetryStore";
import { useThemeStore } from "@/store/themeStore";
import type {
  InversePoint,
  ProjectionMode,
  ProjectionParams,
  Rgb,
  SkyFrame,
  SolarSystemBodyRender,
} from "@/types/sky";

export interface SkyTelemetry {
  fps: number;
  hover: InversePoint | null;
}

interface SkyCanvasProps {
  onTelemetry?: (telemetry: SkyTelemetry) => void;
}

interface SimInterpState {
  fromFrame: SkyFrame;
  toFrame: SkyFrame;
  startMs: number;
  endMs: number;
  avgIntervalMs: number;
  lastKeyframeMs: number;
}

function isZoomProjection(mode: ProjectionMode): boolean {
  return (
    mode === "all_sky" ||
    mode === "hemisphere_single" ||
    mode === "hemisphere_dual" ||
    mode === "panorama"
  );
}

function lerpRgb(a: Rgb, b: Rgb, u: number): Rgb {
  return {
    r: Math.round(a.r + (b.r - a.r) * u),
    g: Math.round(a.g + (b.g - a.g) * u),
    b: Math.round(a.b + (b.b - a.b) * u),
  };
}

function lerpMat3(a: number[][], b: number[][], u: number, normalizeRows: boolean): number[][] {
  const out: number[][] = [];
  const w0 = 1 - u;
  for (let r = 0; r < 3; r++) {
    const ar = a[r];
    const br = b[r];
    let x = ar[0] * w0 + br[0] * u;
    let y = ar[1] * w0 + br[1] * u;
    let z = ar[2] * w0 + br[2] * u;
    if (normalizeRows) {
      const len = Math.hypot(x, y, z) || 1;
      x /= len;
      y /= len;
      z /= len;
    }
    out.push([x, y, z]);
  }
  return out;
}

function interpolateSkyFrame(
  f0: SkyFrame,
  f1: SkyFrame,
  u: number,
  latDeg: number,
  refractionEnabled: boolean,
): SkyFrame {
  if (u <= 0.001) return f0;
  if (u >= 0.999) return f1;

  const w0 = 1 - u;
  const lastDeg = wrapDeg360(f0.last_deg + wrapDeg180(f1.last_deg - f0.last_deg) * u);
  const gmstDeg = wrapDeg360(f0.gmst_deg + wrapDeg180(f1.gmst_deg - f0.gmst_deg) * u);
  const lstDeg = wrapDeg360(f0.lst_deg + wrapDeg180(f1.lst_deg - f0.lst_deg) * u);
  const directHorInterp =
    f0.j2000_to_enu_override !== null ||
    f0.view_mode === "other_planet" ||
    f0.view_mode === "other_star";

  const bodies: SolarSystemBodyRender[] = new Array(f0.bodies.length);
  for (let i = 0; i < f0.bodies.length; i++) {
    const b0 = f0.bodies[i];
    const b1 =
      f1.bodies[i]?.id === b0.id
        ? f1.bodies[i]
        : (f1.bodies.find((candidate) => candidate.id === b0.id) ?? b0);
    const raDeg = wrapDeg360(b0.ra_deg + wrapDeg180(b1.ra_deg - b0.ra_deg) * u);
    const decDeg = b0.dec_deg * w0 + b1.dec_deg * u;
    let azDeg: number;
    let altDeg: number;
    if (directHorInterp) {
      azDeg = wrapDeg360(b0.az_deg + wrapDeg180(b1.az_deg - b0.az_deg) * u);
      altDeg = b0.alt_deg * w0 + b1.alt_deg * u;
    } else {
      const h = equatorialToHorizontalFast(raDeg, decDeg, latDeg, lastDeg);
      azDeg = h.azDeg;
      altDeg =
        refractionEnabled && h.altDeg > -2 ? applyStandardRefractionDeg(h.altDeg) : h.altDeg;
    }
    bodies[i] = {
      ...b1,
      ra_deg: raDeg,
      dec_deg: decDeg,
      az_deg: azDeg,
      alt_deg: altDeg,
      visual_magnitude: b0.visual_magnitude * w0 + b1.visual_magnitude * u,
      angular_diameter_arcsec:
        b0.angular_diameter_arcsec * w0 + b1.angular_diameter_arcsec * u,
      illuminated_fraction: b0.illuminated_fraction * w0 + b1.illuminated_fraction * u,
    };
  }

  const p0 = f0.sky_palette;
  const p1 = f1.sky_palette;
  const needMatInterp =
    f0.view_mode === "precession" || Math.abs(f1.jd_ut - f0.jd_ut) > 30;

  return {
    ...f1,
    jd_ut: f0.jd_ut * w0 + f1.jd_ut * u,
    jd_tt: f0.jd_tt * w0 + f1.jd_tt * u,
    gmst_deg: gmstDeg,
    lst_deg: lstDeg,
    last_deg: lastDeg,
    obliquity_deg: f0.obliquity_deg * w0 + f1.obliquity_deg * u,
    local_dt: u < 0.5 ? f0.local_dt : f1.local_dt,
    j2000_to_apparent_matrix: needMatInterp
      ? lerpMat3(f0.j2000_to_apparent_matrix, f1.j2000_to_apparent_matrix, u, true)
      : f1.j2000_to_apparent_matrix,
    j2000_to_enu_override:
      f0.j2000_to_enu_override && f1.j2000_to_enu_override
        ? lerpMat3(f0.j2000_to_enu_override, f1.j2000_to_enu_override, u, true)
        : f1.j2000_to_enu_override,
    bodies,
    sky_palette: {
      zenith: lerpRgb(p0.zenith, p1.zenith, u),
      mid_sky: lerpRgb(p0.mid_sky, p1.mid_sky, u),
      horizon: lerpRgb(p0.horizon, p1.horizon, u),
      sun_glow: lerpRgb(p0.sun_glow, p1.sun_glow, u),
      sun_glow_strength: p0.sun_glow_strength * w0 + p1.sun_glow_strength * u,
      anti_solar_glow: lerpRgb(p0.anti_solar_glow, p1.anti_solar_glow, u),
      anti_solar_strength: p0.anti_solar_strength * w0 + p1.anti_solar_strength * u,
      moonlight_glow: lerpRgb(p0.moonlight_glow, p1.moonlight_glow, u),
      moonlight_strength: p0.moonlight_strength * w0 + p1.moonlight_strength * u,
      light_pollution: lerpRgb(p0.light_pollution, p1.light_pollution, u),
      light_pollution_strength:
        p0.light_pollution_strength * w0 + p1.light_pollution_strength * u,
      ground: lerpRgb(p0.ground, p1.ground, u),
      horizon_line: lerpRgb(p0.horizon_line, p1.horizon_line, u),
      star_visibility_factor:
        p0.star_visibility_factor * w0 + p1.star_visibility_factor * u,
      estimated_bortle: p1.estimated_bortle,
    },
  };
}

function evaluateSimInterp(
  sim: SimInterpState,
  now: number,
  latDeg: number,
  refractionEnabled: boolean,
): SkyFrame {
  const span = Math.max(1, sim.endMs - sim.startMs);
  const u = Math.max(0, Math.min(1, (now - sim.startMs) / span));
  return interpolateSkyFrame(sim.fromFrame, sim.toFrame, u, latDeg, refractionEnabled);
}

export function SkyCanvas({ onTelemetry }: SkyCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const staticCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const atlasRef = useRef<StarSpriteAtlas | null>(null);
  const skyDirtyRef = useRef(true);
  const needHqRefreshRef = useRef(true);
  const sizeRef = useRef({ width: 0, height: 0, dpr: 0 });
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const gestureRef = useRef<{
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    lastMoveTs: number;
    moved: boolean;
    wasMultiTouch: boolean;
    pinchDist: number;
    pinchMidX: number;
    pinchMidY: number;
  }>({
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
    lastMoveTs: 0,
    moved: false,
    wasMultiTouch: false,
    pinchDist: 0,
    pinchMidX: 0,
    pinchMidY: 0,
  });

  const initialSky = useSkyStore.getState();
  const camRef = useRef({
    az: initialSky.centerAzDeg,
    alt: initialSky.centerAltDeg,
    ra: initialSky.centerRaDeg,
    dec: initialSky.centerDecDeg,
    fov: initialSky.fovDeg,
    zoom: initialSky.zoom,
    targetFov: initialSky.fovDeg,
    targetZoom: initialSky.zoom,
    velAz: 0,
    velAlt: 0,
    velRa: 0,
    velDec: 0,
    gyroVec: null as { e: number; n: number; u: number } | null,
    gyroTargetVec: null as { e: number; n: number; u: number } | null,
    lastInteractionTs: 0,
    lastStorePushTs: 0,
    dirtyFast: false,
    storeSyncPending: false,
    pushedAz: initialSky.centerAzDeg,
    pushedAlt: initialSky.centerAltDeg,
    pushedRa: initialSky.centerRaDeg,
    pushedDec: initialSky.centerDecDeg,
    pushedFov: initialSky.fovDeg,
    pushedZoom: initialSky.zoom,
  });

  const simInterpRef = useRef<SimInterpState | null>(null);
  const hoverRef = useRef<InversePoint | null>(null);
  const fpsAccumRef = useRef({ frames: 0, lastReportTime: performance.now(), fps: 60 });
  const lastHoverEmitRef = useRef(0);
  const meteorParticlesRef = useRef<MeteorParticle[]>([]);
  const lastFrameTimeRef = useRef<number>(performance.now());
  const onTelemetryRef = useRef(onTelemetry);
  onTelemetryRef.current = onTelemetry;

  const gyroEnabled = useSkyStore((s) => s.gyroEnabled);

  const commitCamToStore = useCallback((mode?: ProjectionMode) => {
    const cam = camRef.current;
    const st = useSkyStore.getState();
    const nextAz = wrapDeg360(cam.az);
    const nextAlt = Math.min(89.5, Math.max(-85, cam.alt));
    const nextRa = wrapDeg360(cam.ra);
    const nextDec = Math.min(89.5, Math.max(-89.5, cam.dec));
    const nextFov = effectiveFovDeg(mode ?? st.projectionMode, cam.fov);
    const nextZoom = cam.zoom;
    if (
      Math.abs(st.centerAzDeg - nextAz) < 1e-4 &&
      Math.abs(st.centerAltDeg - nextAlt) < 1e-4 &&
      Math.abs(st.centerRaDeg - nextRa) < 1e-4 &&
      Math.abs(st.centerDecDeg - nextDec) < 1e-4 &&
      Math.abs(st.fovDeg - nextFov) < 1e-4 &&
      Math.abs(st.zoom - nextZoom) < 1e-4 &&
      (!mode || st.projectionMode === mode)
    ) {
      cam.storeSyncPending = false;
      return;
    }
    cam.pushedAz = nextAz;
    cam.pushedAlt = nextAlt;
    cam.pushedRa = nextRa;
    cam.pushedDec = nextDec;
    cam.pushedFov = nextFov;
    cam.pushedZoom = nextZoom;
    cam.storeSyncPending = false;
    cam.lastStorePushTs = performance.now();
    useSkyStore.setState({
      ...(mode && mode !== st.projectionMode ? { projectionMode: mode } : {}),
      centerAzDeg: nextAz,
      centerAltDeg: nextAlt,
      centerRaDeg: nextRa,
      centerDecDeg: nextDec,
      fovDeg: nextFov,
      zoom: nextZoom,
    });
  }, []);

  useEffect(() => {
    if (!gyroEnabled) {
      camRef.current.gyroVec = null;
      camRef.current.gyroTargetVec = null;
      return;
    }
    return startSkyOrientationSensor(
      ({ azDeg, altDeg }) => {
        // Low-frequency fallback sync for non-canvas status listeners
        if (!camRef.current.gyroTargetVec) {
          useSkyStore.getState().applyGyroDirection(azDeg, altDeg);
        }
      },
      (status) => {
        useSkyStore.getState().setGyroStatus(status);
      },
      (vec) => {
        camRef.current.gyroTargetVec = vec;
      },
    );
  }, [gyroEnabled]);

  useEffect(() => {
    const st = useSkyStore.getState();
    initCustomPanoramaFromStorage(
      st.landscapeConfig.maskMode,
      st.landscapeConfig.skyKeyThreshold,
      () => {
        useSkyStore.getState().bumpLandscapeVersion();
      },
    );
  }, []);

  // Store subscription without React re-renders during drag/zoom/gyro/playback
  useEffect(() => {
    const unsubSky = useSkyStore.subscribe((next, prev) => {
      const cam = camRef.current;

      if (next.projectionMode !== prev.projectionMode) {
        cam.az = next.centerAzDeg;
        cam.alt = next.centerAltDeg;
        cam.ra = next.centerRaDeg;
        cam.dec = next.centerDecDeg;
        cam.fov = next.fovDeg;
        cam.targetFov = next.fovDeg;
        cam.zoom = next.zoom;
        cam.targetZoom = next.zoom;
        cam.velAz = 0;
        cam.velAlt = 0;
        cam.velRa = 0;
        cam.velDec = 0;
        cam.pushedAz = next.centerAzDeg;
        cam.pushedAlt = next.centerAltDeg;
        cam.pushedRa = next.centerRaDeg;
        cam.pushedDec = next.centerDecDeg;
        cam.pushedFov = next.fovDeg;
        cam.pushedZoom = next.zoom;
        skyDirtyRef.current = true;
        needHqRefreshRef.current = true;
      } else {
        const ignoreLockUpdate =
          next.simPlaying &&
          next.simTarget === "time" &&
          (next.simLockMode === "planet" || next.simLockMode === "constellation");

        if (
          !ignoreLockUpdate &&
          (next.centerAzDeg !== cam.pushedAz || next.centerAltDeg !== cam.pushedAlt) &&
          (next.centerAzDeg !== prev.centerAzDeg || next.centerAltDeg !== prev.centerAltDeg)
        ) {
          cam.az = next.centerAzDeg;
          cam.alt = next.centerAltDeg;
          cam.velAz = 0;
          cam.velAlt = 0;
          cam.pushedAz = next.centerAzDeg;
          cam.pushedAlt = next.centerAltDeg;
          skyDirtyRef.current = true;
        }
        if (
          !ignoreLockUpdate &&
          (next.centerRaDeg !== cam.pushedRa || next.centerDecDeg !== cam.pushedDec) &&
          (next.centerRaDeg !== prev.centerRaDeg || next.centerDecDeg !== prev.centerDecDeg)
        ) {
          cam.ra = next.centerRaDeg;
          cam.dec = next.centerDecDeg;
          cam.velRa = 0;
          cam.velDec = 0;
          cam.pushedRa = next.centerRaDeg;
          cam.pushedDec = next.centerDecDeg;
          skyDirtyRef.current = true;
        }
        if (next.fovDeg !== cam.pushedFov && next.fovDeg !== prev.fovDeg) {
          cam.targetFov = next.fovDeg;
          cam.pushedFov = next.fovDeg;
          skyDirtyRef.current = true;
        }
        if (next.zoom !== cam.pushedZoom && next.zoom !== prev.zoom) {
          cam.targetZoom = next.zoom;
          cam.pushedZoom = next.zoom;
          skyDirtyRef.current = true;
        }
      }

      if (
        !next.simPlaying ||
        next.simTarget !== "time" ||
        next.simLockMode === "sunrise" ||
        next.simLockMode === "sunset"
      ) {
        if (simInterpRef.current !== null) {
          simInterpRef.current = null;
          skyDirtyRef.current = true;
          needHqRefreshRef.current = true;
        }
      }

      if (next.skyFrame !== prev.skyFrame && next.skyFrame) {
        const isSmoothTimePlay =
          next.simPlaying &&
          next.simTarget === "time" &&
          next.simLockMode !== "sunrise" &&
          next.simLockMode !== "sunset" &&
          prev.skyFrame !== null;
        if (isSmoothTimePlay && prev.skyFrame) {
          const now = performance.now();
          const cur = simInterpRef.current;
          if (cur) {
            const curShown = evaluateSimInterp(
              cur,
              now,
              next.location.lat_deg,
              next.refractionEnabled,
            );
            const dtInterval = Math.max(24, Math.min(250, now - cur.lastKeyframeMs));
            const avg = cur.avgIntervalMs * 0.65 + dtInterval * 0.35;
            cur.fromFrame = curShown;
            cur.toFrame = next.skyFrame;
            cur.startMs = now;
            cur.avgIntervalMs = avg;
            cur.endMs = now + Math.max(40, avg * 1.08);
            cur.lastKeyframeMs = now;
          } else {
            simInterpRef.current = {
              fromFrame: prev.skyFrame,
              toFrame: next.skyFrame,
              startMs: now,
              endMs: now + 62,
              avgIntervalMs: 62,
              lastKeyframeMs: now,
            };
          }
          needHqRefreshRef.current = true;
        } else {
          simInterpRef.current = null;
          skyDirtyRef.current = true;
          needHqRefreshRef.current = true;
        }
      }

      if (
        next.staticAssets !== prev.staticAssets ||
        next.starBuffer !== prev.starBuffer ||
        next.starCount !== prev.starCount ||
        next.dsoBuffer !== prev.dsoBuffer ||
        next.dsoCount !== prev.dsoCount ||
        next.location !== prev.location ||
        next.viewMode !== prev.viewMode ||
        next.limitingMag !== prev.limitingMag ||
        next.skyRealismLevel !== prev.skyRealismLevel ||
        next.refractionEnabled !== prev.refractionEnabled ||
        next.showBelowHorizon !== prev.showBelowHorizon ||
        next.layers !== prev.layers ||
        next.customColors !== prev.customColors ||
        next.trails !== prev.trails ||
        next.selectedObject !== prev.selectedObject ||
        next.selectedMeteorShowerCode !== prev.selectedMeteorShowerCode ||
        next.meteorAnimationEnabled !== prev.meteorAnimationEnabled ||
        next.meteorShowAllRadiants !== prev.meteorShowAllRadiants ||
        next.meteorRateMultiplier !== prev.meteorRateMultiplier ||
        next.planetTracks !== prev.planetTracks ||
        next.fovPresets !== prev.fovPresets ||
        next.satellites !== prev.satellites ||
        next.showSatellites !== prev.showSatellites ||
        next.highlightedSatPass !== prev.highlightedSatPass ||
        next.landscapeConfig !== prev.landscapeConfig ||
        next.landscapeVersion !== prev.landscapeVersion ||
        next.hipsConfig !== prev.hipsConfig ||
        next.offlineMode !== prev.offlineMode ||
        next.simLockMode !== prev.simLockMode ||
        next.simStepMinutes !== prev.simStepMinutes ||
        next.gyroAzOffsetDeg !== prev.gyroAzOffsetDeg
      ) {
        skyDirtyRef.current = true;
        needHqRefreshRef.current = true;
      }

      if (prev.simPlaying && !next.simPlaying && cam.storeSyncPending) {
        commitCamToStore();
      }
    });

    const unsubTheme = useThemeStore.subscribe(() => {
      skyDirtyRef.current = true;
      needHqRefreshRef.current = true;
    });

    const unsubHips = onHipsTileLoaded(() => {
      skyDirtyRef.current = true;
      needHqRefreshRef.current = true;
    });

    return () => {
      unsubSky();
      unsubTheme();
      unsubHips();
    };
  }, [commitCamToStore]);

  // High-DPI ResizeObserver with smart backing-store cap for maximized viewports
  useEffect(() => {
    const el = containerRef.current;
    const canvas = canvasRef.current;
    if (!el || !canvas) return;
    if (!staticCanvasRef.current) {
      staticCanvasRef.current = document.createElement("canvas");
    }
    const staticCanvas = staticCanvasRef.current;

    const updateSize = () => {
      const rect = el.getBoundingClientRect();
      const rawDpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(200, Math.floor(rect.width));
      const h = Math.max(200, Math.floor(rect.height));
      const maxBackingPixels = 2_073_600;
      const area = w * h;
      const dpr =
        area * rawDpr * rawDpr > maxBackingPixels
          ? Math.max(1, Math.sqrt(maxBackingPixels / area))
          : rawDpr;
      const targetW = Math.round(w * dpr);
      const targetH = Math.round(h * dpr);
      if (
        sizeRef.current.width !== w ||
        sizeRef.current.height !== h ||
        sizeRef.current.dpr !== dpr ||
        canvas.width !== targetW ||
        canvas.height !== targetH ||
        staticCanvas.width !== targetW ||
        staticCanvas.height !== targetH
      ) {
        sizeRef.current = { width: w, height: h, dpr };
        canvas.width = targetW;
        canvas.height = targetH;
        staticCanvas.width = targetW;
        staticCanvas.height = targetH;
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
        skyDirtyRef.current = true;
        needHqRefreshRef.current = true;
      }
    };

    updateSize();
    const ro = new ResizeObserver(updateSize);
    ro.observe(el);
    window.addEventListener("resize", updateSize);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", updateSize);
    };
  }, []);

  // Native non-passive wheel listener for silky-smooth zoom at native refresh rate
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY;
      if (Math.abs(delta) < 0.01) return;
      const st = useSkyStore.getState();
      const cam = camRef.current;
      const clampedDelta = Math.max(-180, Math.min(180, delta));
      const factor =
        Math.abs(delta) >= 40
          ? delta < 0
            ? 1.15
            : 1 / 1.15
          : Math.pow(1.0028, -clampedDelta);

      if (isZoomProjection(st.projectionMode)) {
        cam.targetZoom = Math.min(8, Math.max(0.5, cam.targetZoom * factor));
      } else {
        cam.targetFov = effectiveFovDeg(st.projectionMode, cam.targetFov / factor);
      }
      cam.dirtyFast = true;
      cam.storeSyncPending = true;
      cam.lastInteractionTs = performance.now();
      needHqRefreshRef.current = true;
    };

    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, []);

  // Native-refresh-rate requestAnimationFrame loop (supports 60Hz, 120Hz, 144Hz, 165Hz+)
  useEffect(() => {
    if (!atlasRef.current) {
      atlasRef.current = createStarSpriteAtlas();
    }
    let rafId = 0;

    const tick = (now: number) => {
      const dtSec = Math.min(0.05, Math.max(0.001, (now - lastFrameTimeRef.current) / 1000));
      lastFrameTimeRef.current = now;
      const st = useSkyStore.getState();
      const cam = camRef.current;
      let camMoved = cam.dirtyFast;
      cam.dirtyFast = false;

      // 1. Inertial panning after pointer release
      if (pointersRef.current.size === 0 && !st.gyroEnabled) {
        const decay = Math.exp(-9.0 * dtSec);
        if (Math.abs(cam.velAz) > 0.08 || Math.abs(cam.velAlt) > 0.08) {
          cam.az = wrapDeg360(cam.az + cam.velAz * dtSec);
          const minAlt = st.projectionMode === "panorama" ? -60 : -85;
          const maxAlt = st.projectionMode === "panorama" ? 85 : 89.5;
          cam.alt = Math.min(maxAlt, Math.max(minAlt, cam.alt + cam.velAlt * dtSec));
          cam.velAz *= decay;
          cam.velAlt *= decay;
          camMoved = true;
          cam.storeSyncPending = true;
          cam.lastInteractionTs = now;
        } else {
          cam.velAz = 0;
          cam.velAlt = 0;
        }
        if (Math.abs(cam.velRa) > 0.08 || Math.abs(cam.velDec) > 0.08) {
          cam.ra = wrapDeg360(cam.ra + cam.velRa * dtSec);
          cam.dec = Math.min(89.5, Math.max(-89.5, cam.dec + cam.velDec * dtSec));
          cam.velRa *= decay;
          cam.velDec *= decay;
          camMoved = true;
          cam.storeSyncPending = true;
          cam.lastInteractionTs = now;
        } else {
          cam.velRa = 0;
          cam.velDec = 0;
        }
      }

      // 2. Smooth exponential FOV / zoom interpolation
      const zoomAlpha = 1 - Math.exp((pointersRef.current.size >= 2 ? -28 : -16) * dtSec);
      if (Math.abs(cam.targetFov - cam.fov) > 1e-3) {
        cam.fov += (cam.targetFov - cam.fov) * zoomAlpha;
        camMoved = true;
        cam.storeSyncPending = true;
        cam.lastInteractionTs = now;
      } else if (cam.fov !== cam.targetFov) {
        cam.fov = cam.targetFov;
        camMoved = true;
        cam.storeSyncPending = true;
      }
      if (Math.abs(cam.targetZoom - cam.zoom) > 1e-4) {
        cam.zoom += (cam.targetZoom - cam.zoom) * zoomAlpha;
        camMoved = true;
        cam.storeSyncPending = true;
        cam.lastInteractionTs = now;
      } else if (cam.zoom !== cam.targetZoom) {
        cam.zoom = cam.targetZoom;
        camMoved = true;
        cam.storeSyncPending = true;
      }

      // 3. Silky vblank-locked Gyroscope orientation SLERP
      let nextModeOverride: ProjectionMode | undefined;
      if (st.gyroEnabled && cam.gyroTargetVec) {
        const tv = cam.gyroTargetVec;
        if (!cam.gyroVec) {
          cam.gyroVec = { e: tv.e, n: tv.n, u: tv.u };
          camMoved = true;
        } else {
          const gv = cam.gyroVec;
          const dot = gv.e * tv.e + gv.n * tv.n + gv.u * tv.u;
          if (dot < 0.9999998) {
            const gAlpha = 1 - Math.exp(-18 * dtSec);
            const ne = gv.e + (tv.e - gv.e) * gAlpha;
            const nn = gv.n + (tv.n - gv.n) * gAlpha;
            const nu = gv.u + (tv.u - gv.u) * gAlpha;
            const len = Math.hypot(ne, nn, nu) || 1;
            gv.e = ne / len;
            gv.n = nn / len;
            gv.u = nu / len;
            camMoved = true;
          }
        }
        const gv = cam.gyroVec;
        const { azDeg, altDeg } = enuToAzAlt(gv.e, gv.n, gv.u);
        const desiredAz = wrapDeg360(azDeg + st.gyroAzOffsetDeg);
        const desiredAlt = Math.min(89.5, Math.max(-85, altDeg));
        if (
          Math.abs(wrapDeg180(desiredAz - cam.az)) > 0.002 ||
          Math.abs(desiredAlt - cam.alt) > 0.002
        ) {
          cam.az = desiredAz;
          cam.alt = desiredAlt;
          camMoved = true;
          cam.storeSyncPending = true;
          cam.lastInteractionTs = now;
        }
        if (st.projectionMode === "star_chart" || st.projectionMode === "zenith") {
          nextModeOverride = "free_direction";
        }
      }

      // 4. Native vblank smooth viewpoint playback (10Hz backend -> 165Hz canvas panning)
      if (st.simPlaying && st.simTarget === "viewpoint") {
        const degPerSec = st.simDirection * st.simAzStepDeg * 10;
        if (st.projectionMode === "star_chart") {
          cam.ra = wrapDeg360(cam.ra + degPerSec * dtSec);
        } else {
          cam.az = wrapDeg360(cam.az + degPerSec * dtSec);
        }
        camMoved = true;
        cam.storeSyncPending = true;
        cam.lastInteractionTs = now;
      }

      // 5. Evaluate interpolated skyFrame for smooth planetary & sidereal motion
      const isTimePlay = st.simPlaying && st.simTarget === "time";
      const sim = simInterpRef.current;
      const activeFrame =
        isTimePlay && sim
          ? evaluateSimInterp(sim, now, st.location.lat_deg, st.refractionEnabled)
          : st.skyFrame;
      const simFrameActive = isTimePlay && sim !== null;

      // Keep planet / constellation lock dead-center on interpolated coordinates
      if (isTimePlay && activeFrame) {
        if (st.simLockMode === "planet") {
          const tgt = activeFrame.bodies.find((b) => b.id === st.simLockTargetId);
          if (tgt) {
            cam.az = wrapDeg360(tgt.az_deg);
            cam.alt = Math.min(89.5, Math.max(-85, tgt.alt_deg));
            cam.ra = tgt.ra_deg;
            cam.dec = tgt.dec_deg;
          }
        } else if (st.simLockMode === "constellation" && st.staticAssets) {
          const con = st.staticAssets.constellations.find(
            (c) => c.id === st.simLockTargetId,
          );
          if (con) {
            const pos = j2000ToHorWithMatrix(
              con.center_ra_deg,
              con.center_dec_deg,
              activeFrame.j2000_to_apparent_matrix,
              st.location.lat_deg,
              activeFrame.last_deg,
            );
            cam.az = pos.azDeg;
            cam.alt = Math.min(89.5, Math.max(-85, pos.altDeg));
            cam.ra = pos.appRaDeg;
            cam.dec = pos.appDecDeg;
          }
        }
      }

      // 6. Step shooting stars / meteor shower particles at native refresh rate
      const prevLen = meteorParticlesRef.current.length;
      let meteorFrameChanged = false;
      if ((st.meteorAnimationEnabled || prevLen > 0) && activeFrame) {
        const nextMeteors = stepMeteorParticles(
          meteorParticlesRef.current,
          st.staticAssets?.meteor_showers ?? [],
          st.selectedMeteorShowerCode,
          st.meteorAnimationEnabled,
          dtSec,
          st.meteorRateMultiplier,
          {
            month: activeFrame.local_dt.month,
            day: activeFrame.local_dt.day,
            latDeg: st.location.lat_deg,
            lastDeg: activeFrame.last_deg,
            starVisibilityFactor: activeFrame.sky_palette.star_visibility_factor,
            preferSelected: st.openPanels.includes("meteors"),
          },
        );
        meteorParticlesRef.current = nextMeteors;
        if (nextMeteors.length > 0 || prevLen > 0) {
          meteorFrameChanged = true;
        }
      }

      if (camMoved) {
        needHqRefreshRef.current = true;
      }

      const isActivelyMoving =
        camMoved ||
        pointersRef.current.size > 0 ||
        now - cam.lastInteractionTs < 120 ||
        simFrameActive ||
        (st.simPlaying && st.simTarget === "viewpoint");

      if (cam.storeSyncPending && (!isActivelyMoving || now - cam.lastStorePushTs >= 150)) {
        commitCamToStore(nextModeOverride);
      } else if (nextModeOverride && nextModeOverride !== st.projectionMode) {
        commitCamToStore(nextModeOverride);
      }

      // 7. Render sky canvas (1-pass fastInteractive while moving; crisp cached static layer when settled)
      const needHqSettledPass = !isActivelyMoving && needHqRefreshRef.current;
      if (isActivelyMoving || skyDirtyRef.current || needHqSettledPass || meteorFrameChanged) {
        const canvas = canvasRef.current;
        if (!staticCanvasRef.current) {
          staticCanvasRef.current = document.createElement("canvas");
          staticCanvasRef.current.width = canvas?.width ?? 0;
          staticCanvasRef.current.height = canvas?.height ?? 0;
        }
        const staticCanvas = staticCanvasRef.current;
        const ctx = canvas?.getContext("2d", { alpha: false });
        const staticCtx = staticCanvas.getContext("2d", { alpha: false });
        if (
          ctx &&
          staticCtx &&
          activeFrame &&
          atlasRef.current &&
          sizeRef.current.width > 0 &&
          sizeRef.current.height > 0
        ) {
          const { width, height, dpr } = sizeRef.current;
          const params: ProjectionParams = {
            mode: nextModeOverride ?? st.projectionMode,
            width,
            height,
            center_az_deg: cam.az,
            center_alt_deg: cam.alt,
            center_ra_deg: cam.ra,
            center_dec_deg: cam.dec,
            fov_deg: effectiveFovDeg(nextModeOverride ?? st.projectionMode, cam.fov),
            zoom: cam.zoom,
            show_below_horizon: st.showBelowHorizon,
          };
          const nightVision = useThemeStore.getState().theme === "night-vision";

          if (isActivelyMoving) {
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            renderSkyCanvas({
              ctx,
              width,
              height,
              params,
              frame: activeFrame,
              location: st.location,
              staticAssets: st.staticAssets,
              starBuffer: st.starBuffer,
              starCount: st.starCount,
              dsoBuffer: st.dsoBuffer,
              dsoCount: st.dsoCount,
              limitingMag: st.limitingMag,
              refractionEnabled: st.refractionEnabled,
              layers: st.layers,
              customColors: st.customColors,
              trails: st.trails,
              simLockMode: st.simLockMode,
              simStepMinutes: st.simStepMinutes,
              nightVision,
              selectedObject: st.selectedObject,
              atlas: atlasRef.current,
              selectedMeteorShowerCode: st.selectedMeteorShowerCode,
              meteorShowAllRadiants: st.meteorShowAllRadiants,
              meteorParticles: meteorParticlesRef.current,
              planetTracks: st.planetTracks,
              fovPresets: st.fovPresets,
              satellites: st.satellites,
              showSatellites: st.showSatellites,
              highlightedSatPass: st.highlightedSatPass,
              landscapeConfig: st.landscapeConfig,
              hipsConfig: st.hipsConfig,
              offlineMode: st.offlineMode,
              skipMeteors: false,
              fastInteractive: true,
              onTextureLoaded: () => {
                skyDirtyRef.current = true;
                needHqRefreshRef.current = true;
              },
            });
            skyDirtyRef.current = false;
            needHqRefreshRef.current = true;
          } else {
            if (skyDirtyRef.current || needHqRefreshRef.current) {
              staticCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
              renderSkyCanvas({
                ctx: staticCtx,
                width,
                height,
                params,
                frame: activeFrame,
                location: st.location,
                staticAssets: st.staticAssets,
                starBuffer: st.starBuffer,
                starCount: st.starCount,
                dsoBuffer: st.dsoBuffer,
                dsoCount: st.dsoCount,
                limitingMag: st.limitingMag,
                refractionEnabled: st.refractionEnabled,
                layers: st.layers,
                customColors: st.customColors,
                trails: st.trails,
                simLockMode: st.simLockMode,
                simStepMinutes: st.simStepMinutes,
                nightVision,
                selectedObject: st.selectedObject,
                atlas: atlasRef.current,
                selectedMeteorShowerCode: st.selectedMeteorShowerCode,
                meteorShowAllRadiants: st.meteorShowAllRadiants,
                meteorParticles: [],
                planetTracks: st.planetTracks,
                fovPresets: st.fovPresets,
                satellites: st.satellites,
                showSatellites: st.showSatellites,
                highlightedSatPass: st.highlightedSatPass,
                landscapeConfig: st.landscapeConfig,
                hipsConfig: st.hipsConfig,
                offlineMode: st.offlineMode,
                skipMeteors: true,
                fastInteractive: false,
                onTextureLoaded: () => {
                  skyDirtyRef.current = true;
                  needHqRefreshRef.current = true;
                },
              });
              skyDirtyRef.current = false;
              needHqRefreshRef.current = false;
            }

            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.drawImage(staticCanvas, 0, 0);

            if (meteorParticlesRef.current.length > 0 && activeFrame.view_mode !== "other_star") {
              ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
              renderMeteorOverlay({
                ctx,
                width,
                height,
                params,
                frame: activeFrame,
                location: st.location,
                refractionEnabled: st.refractionEnabled,
                nightVision,
                meteorParticles: meteorParticlesRef.current,
              });
            }
          }
        }
      }

      const acc = fpsAccumRef.current;
      acc.frames++;
      if (now - acc.lastReportTime >= 450) {
        const nextFps = Math.round((acc.frames * 1000) / (now - acc.lastReportTime));
        fpsAccumRef.current.fps = nextFps;
        acc.frames = 0;
        acc.lastReportTime = now;
        useTelemetryStore.getState().setFps(nextFps);
        onTelemetryRef.current?.({ fps: nextFps, hover: hoverRef.current });
      }

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [commitCamToStore]);

  const applyPanDelta = useCallback((dx: number, dy: number, dtSec: number) => {
    const { width, height } = sizeRef.current;
    if (width <= 0 || height <= 0) return;
    const st = useSkyStore.getState();
    const cam = camRef.current;
    if (st.gyroEnabled) {
      useSkyStore.setState({ gyroEnabled: false, gyroStatus: null });
    }
    const minDim = Math.max(100, Math.min(width, height));
    const safeDt = Math.max(0.004, Math.min(0.05, dtSec));
    let dAz = 0;
    let dAlt = 0;
    let dRa = 0;
    let dDec = 0;

    if (st.projectionMode === "star_chart") {
      const fov = effectiveFovDeg("star_chart", cam.fov) / cam.zoom;
      const degPerPx = fov / minDim;
      const cosDec = Math.max(0.18, Math.cos((cam.dec * Math.PI) / 180));
      dRa = (dx * degPerPx) / cosDec;
      dDec = dy * degPerPx;
      cam.ra = wrapDeg360(cam.ra + dRa);
      cam.dec = Math.min(89.5, Math.max(-89.5, cam.dec + dDec));
    } else if (
      st.projectionMode === "all_sky" ||
      st.projectionMode === "zenith" ||
      st.projectionMode === "hemisphere_single" ||
      st.projectionMode === "hemisphere_dual"
    ) {
      dAz = (-dx / minDim) * 180;
      cam.az = wrapDeg360(cam.az + dAz);
    } else if (st.projectionMode === "panorama") {
      dAz = -dx / (((width * 0.48) / 180) * cam.zoom);
      dAlt = dy / (((height * 0.8) / 100) * cam.zoom);
      cam.az = wrapDeg360(cam.az + dAz);
      cam.alt = Math.min(85, Math.max(-60, cam.alt + dAlt));
    } else {
      const fov = effectiveFovDeg(st.projectionMode, cam.fov) / cam.zoom;
      const degPerPx = fov / minDim;
      const cosAlt = Math.max(0.2, Math.cos((cam.alt * Math.PI) / 180));
      dAz = -(dx * degPerPx) / cosAlt;
      dAlt = dy * degPerPx;
      cam.az = wrapDeg360(cam.az + dAz);
      cam.alt = Math.min(89.5, Math.max(-85, cam.alt + dAlt));
    }

    cam.velAz = cam.velAz * 0.45 + (dAz / safeDt) * 0.55;
    cam.velAlt = cam.velAlt * 0.45 + (dAlt / safeDt) * 0.55;
    cam.velRa = cam.velRa * 0.45 + (dRa / safeDt) * 0.55;
    cam.velDec = cam.velDec * 0.45 + (dDec / safeDt) * 0.55;
    cam.dirtyFast = true;
    cam.storeSyncPending = true;
    cam.lastInteractionTs = performance.now();
    needHqRefreshRef.current = true;
  }, []);

  const updateHover = useCallback((clientX: number, clientY: number) => {
    const now = performance.now();
    if (now - lastHoverEmitRef.current < 32) return;
    const canvas = canvasRef.current;
    const st = useSkyStore.getState();
    const cam = camRef.current;
    if (!canvas || !st.skyFrame) return;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const { width, height } = sizeRef.current;
    if (width <= 0 || height <= 0) return;
    const inv = unprojectScreen(
      x,
      y,
      {
        mode: st.projectionMode,
        width,
        height,
        center_az_deg: cam.az,
        center_alt_deg: cam.alt,
        center_ra_deg: cam.ra,
        center_dec_deg: cam.dec,
        fov_deg: effectiveFovDeg(st.projectionMode, cam.fov),
        zoom: cam.zoom,
        show_below_horizon: st.showBelowHorizon,
      },
      st.location.lat_deg,
      st.skyFrame.last_deg,
    );
    hoverRef.current = inv;
    lastHoverEmitRef.current = now;
    useTelemetryStore.getState().setHover(inv);
    onTelemetryRef.current?.({ fps: fpsAccumRef.current.fps, hover: inv });
  }, []);

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // Ignore synthetic pointer capture rejection
    }

    if (e.pointerType === "touch" && hoverRef.current !== null) {
      hoverRef.current = null;
      useTelemetryStore.getState().setHover(null);
      onTelemetryRef.current?.({ fps: fpsAccumRef.current.fps, hover: null });
    }

    const cam = camRef.current;
    cam.velAz = 0;
    cam.velAlt = 0;
    cam.velRa = 0;
    cam.velDec = 0;

    const pointers = pointersRef.current;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gestureRef.current;
    g.lastMoveTs = performance.now();

    if (pointers.size === 1) {
      g.startX = e.clientX;
      g.startY = e.clientY;
      g.lastX = e.clientX;
      g.lastY = e.clientY;
      g.moved = false;
      g.wasMultiTouch = false;
      g.pinchDist = 0;
    } else if (pointers.size === 2) {
      const [p1, p2] = Array.from(pointers.values());
      g.wasMultiTouch = true;
      g.moved = true;
      g.pinchDist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      g.pinchMidX = (p1.x + p2.x) * 0.5;
      g.pinchMidY = (p1.y + p2.y) * 0.5;
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const pointers = pointersRef.current;
    const g = gestureRef.current;
    if (pointers.has(e.pointerId)) {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const { width, height } = sizeRef.current;
      const now = performance.now();
      const dtSec = Math.max(0.002, (now - g.lastMoveTs) / 1000);
      g.lastMoveTs = now;

      if (width > 0 && height > 0) {
        if (pointers.size >= 2) {
          const [p1, p2] = Array.from(pointers.values());
          const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
          const midX = (p1.x + p2.x) * 0.5;
          const midY = (p1.y + p2.y) * 0.5;
          if (g.pinchDist > 8 && dist > 8) {
            const ratio = dist / g.pinchDist;
            if (Math.abs(ratio - 1) > 0.002) {
              const st = useSkyStore.getState();
              const cam = camRef.current;
              if (isZoomProjection(st.projectionMode)) {
                cam.targetZoom = Math.min(8, Math.max(0.5, cam.targetZoom * ratio));
              } else {
                cam.targetFov = effectiveFovDeg(st.projectionMode, cam.targetFov / ratio);
              }
              cam.dirtyFast = true;
              cam.storeSyncPending = true;
              cam.lastInteractionTs = now;
              needHqRefreshRef.current = true;
            }
          }
          const mdx = midX - g.pinchMidX;
          const mdy = midY - g.pinchMidY;
          if (mdx !== 0 || mdy !== 0) {
            applyPanDelta(mdx, mdy, dtSec);
          }
          g.pinchDist = dist;
          g.pinchMidX = midX;
          g.pinchMidY = midY;
        } else if (pointers.size === 1 && !g.wasMultiTouch) {
          const dx = e.clientX - g.lastX;
          const dy = e.clientY - g.lastY;
          if (Math.hypot(e.clientX - g.startX, e.clientY - g.startY) >= 6) {
            g.moved = true;
          }
          g.lastX = e.clientX;
          g.lastY = e.clientY;
          if (dx !== 0 || dy !== 0) {
            applyPanDelta(dx, dy, dtSec);
          }
        }
      }
      return;
    }
    if (e.pointerType !== "touch") {
      updateHover(e.clientX, e.clientY);
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const pointers = pointersRef.current;
    const g = gestureRef.current;
    const canvas = canvasRef.current;
    const hadPointer = pointers.has(e.pointerId);
    pointers.delete(e.pointerId);

    if (canvas?.hasPointerCapture(e.pointerId)) {
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch {
        // Ignore capture cleanup errors
      }
    }
    if (!hadPointer) return;

    if (pointers.size === 1) {
      const [rem] = Array.from(pointers.values());
      g.lastX = rem.x;
      g.lastY = rem.y;
      g.pinchDist = 0;
      g.wasMultiTouch = true;
      camRef.current.velAz = 0;
      camRef.current.velAlt = 0;
      camRef.current.velRa = 0;
      camRef.current.velDec = 0;
      return;
    }

    const wasClick = e.type === "pointerup" && !g.moved && !g.wasMultiTouch;
    g.wasMultiTouch = false;
    g.pinchDist = 0;

    if (wasClick) {
      camRef.current.velAz = 0;
      camRef.current.velAlt = 0;
      camRef.current.velRa = 0;
      camRef.current.velDec = 0;
      commitCamToStore();
      if (canvas) {
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const { width, height } = sizeRef.current;
        if (width > 0 && height > 0) {
          void useSkyStore.getState().pickAtScreen(x, y, width, height);
        }
      }
    } else if (performance.now() - g.lastMoveTs > 60) {
      // Finger stopped moving before lift -> no unwanted coasting
      camRef.current.velAz = 0;
      camRef.current.velAlt = 0;
      camRef.current.velRa = 0;
      camRef.current.velDec = 0;
    }
  };

  const onPointerLeave = () => {
    hoverRef.current = null;
    useTelemetryStore.getState().setHover(null);
    onTelemetryRef.current?.({ fps: fpsAccumRef.current.fps, hover: null });
  };

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden select-none">
      <canvas
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={onPointerLeave}
        className="block h-full w-full cursor-grab active:cursor-grabbing touch-none"
      />
    </div>
  );
}
