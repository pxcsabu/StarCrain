import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  Camera,
  Compass,
  Eye,
  Globe,
  MapPin,
  Orbit,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Satellite,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { Button } from "@/components/ui/button";
import { nowUtcJd, useSkyStore } from "@/store/skyStore";
import type { IssEarthViewData, IssTrackSample, OnlineSyncResult } from "@/types/sky";

const EARTH_R = 6.371; // 1 unit = 1000 km
const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

type IssCameraMode = "cupola" | "nadir" | "orbit";

const SPEED_PRESETS = [
  { label: "×1 実時間", mult: 1 },
  { label: "×10", mult: 10 },
  { label: "×30", mult: 30 },
  { label: "×60", mult: 60 },
  { label: "×180", mult: 180 },
] as const;

const EARTH_SURFACE_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vWorldNormal;
varying vec3 vWorldPos;

void main() {
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const EARTH_SURFACE_FRAG = /* glsl */ `
uniform sampler2D uDayTex;
uniform sampler2D uNightTex;
uniform sampler2D uSpecTex;
uniform sampler2D uCloudsTex;
uniform vec3 uSunDir;

varying vec2 vUv;
varying vec3 vWorldNormal;
varying vec3 vWorldPos;

void main() {
  vec3 N = normalize(vWorldNormal);
  vec3 L = normalize(uSunDir);
  vec3 V = normalize(cameraPosition - vWorldPos);

  float ndotl = dot(N, L);
  float dayMask = smoothstep(-0.08, 0.22, ndotl);
  float nightMask = smoothstep(0.08, -0.18, ndotl);
  float twilight = exp(-pow((ndotl + 0.015) / 0.115, 2.0));

  vec3 dayCol = texture2D(uDayTex, vUv).rgb;
  vec3 nightCol = texture2D(uNightTex, vUv).rgb;
  float specMask = texture2D(uSpecTex, vUv).r;
  float cloudMask = texture2D(uCloudsTex, vUv + vec2(0.0018, 0.0)).r;

  // Diffuse daylight softened for realistic contrast + faint cloud shadow on surface
  float diffuse = pow(max(ndotl, 0.0), 0.72) * 1.12;
  float cloudShadow = 1.0 - 0.34 * cloudMask;
  vec3 litDay = dayCol * (0.04 + diffuse * cloudShadow);

  // Specular sun glint over oceans
  vec3 H = normalize(L + V);
  float spec = pow(max(dot(N, H), 0.0), 44.0) * specMask * smoothstep(-0.04, 0.25, ndotl);
  litDay += vec3(1.0, 0.96, 0.88) * spec * 0.58 * (1.0 - 0.75 * cloudMask);

  // Faint Earthshine on dark side + glowing night city lights
  vec3 earthshine = dayCol * 0.022;
  vec3 cities = nightCol * 1.55 * nightMask * (1.0 - 0.65 * cloudMask);

  vec3 color = mix(earthshine + cities, litDay, dayMask);

  // Golden-amber twilight scattering along the solar terminator
  color += vec3(1.0, 0.45, 0.16) * twilight * 0.17 * (0.35 + 0.65 * dayMask);

  // Subtle Rayleigh limb scatter across sunlit horizon
  float rim = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 2.9);
  float sunRim = smoothstep(-0.18, 0.35, ndotl);
  color += vec3(0.32, 0.62, 1.0) * rim * sunRim * 0.55;

  gl_FragColor = vec4(color, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const CLOUDS_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vWorldNormal;

void main() {
  vUv = uv;
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const CLOUDS_FRAG = /* glsl */ `
uniform sampler2D uCloudsTex;
uniform vec3 uSunDir;

varying vec2 vUv;
varying vec3 vWorldNormal;

void main() {
  vec3 N = normalize(vWorldNormal);
  vec3 L = normalize(uSunDir);
  float ndotl = dot(N, L);
  float c = texture2D(uCloudsTex, vUv).r;
  if (c < 0.025) discard;

  float lit = smoothstep(-0.14, 0.24, ndotl);
  float twilight = exp(-pow((ndotl + 0.01) / 0.10, 2.0));
  vec3 cloudCol = mix(vec3(0.03, 0.05, 0.10), vec3(0.96, 0.98, 1.0), lit);
  cloudCol += vec3(1.0, 0.46, 0.18) * twilight * 0.24;

  float alpha = c * mix(0.24, 0.84, lit);
  gl_FragColor = vec4(cloudCol, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const ATMO_VERT = /* glsl */ `
varying vec3 vWorldNormal;
varying vec3 vWorldPos;

void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const ATMO_FRAG = /* glsl */ `
uniform vec3 uSunDir;

varying vec3 vWorldNormal;
varying vec3 vWorldPos;

void main() {
  vec3 N = normalize(vWorldNormal);
  vec3 L = normalize(uSunDir);
  vec3 V = normalize(cameraPosition - vWorldPos);

  float ndotv = dot(N, V);
  // Crisp outer-limb glow visible from both LEO Cupola and orbital overview
  float rim = pow(clamp(1.0 + ndotv, 0.0, 1.0), 3.4) * smoothstep(-0.65, -0.02, ndotv);
  float ndotl = dot(N, L);
  float sunMask = smoothstep(-0.22, 0.32, ndotl);
  float twilight = exp(-pow((ndotl + 0.02) / 0.12, 2.0));

  vec3 dayAtmo = vec3(0.28, 0.62, 1.0);
  vec3 sunsetAtmo = vec3(1.0, 0.48, 0.20);
  vec3 nightAirglow = vec3(0.10, 0.24, 0.38);

  vec3 col = mix(nightAirglow * 0.28, dayAtmo, sunMask);
  col = mix(col, sunsetAtmo, clamp(twilight * 0.72, 0.0, 0.85));

  float alpha = rim * mix(0.16, 0.85, sunMask);
  if (alpha < 0.01) discard;
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

function latLonAltToVec3(
  latDeg: number,
  lonDeg: number,
  altKm = 0,
  out = new THREE.Vector3(),
): THREE.Vector3 {
  const r = EARTH_R + altKm / 1000;
  const lat = latDeg * DEG2RAD;
  const lon = lonDeg * DEG2RAD;
  const clat = Math.cos(lat);
  return out.set(r * clat * Math.cos(lon), r * Math.sin(lat), -r * clat * Math.sin(lon));
}

function vec3ToLatLonAlt(v: THREE.Vector3): { latDeg: number; lonDeg: number; altKm: number } {
  const r = Math.max(1e-6, v.length());
  const latDeg = Math.asin(Math.max(-1, Math.min(1, v.y / r))) * RAD2DEG;
  const lonDeg = Math.atan2(-v.z, v.x) * RAD2DEG;
  const altKm = (r - EARTH_R) * 1000;
  return { latDeg, lonDeg, altKm };
}

function wrapDeg180(deg: number): number {
  let d = ((deg + 180) % 360 + 360) % 360 - 180;
  if (d <= -180) d += 360;
  return d;
}

function wrapDeg360(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

function formatLatLon(latDeg: number, lonDeg: number): string {
  const ns = latDeg >= 0 ? "N" : "S";
  const ew = lonDeg >= 0 ? "E" : "W";
  return `${Math.abs(latDeg).toFixed(2)}°${ns} ${Math.abs(lonDeg).toFixed(2)}°${ew}`;
}

function jdToDateTimeStrings(jd: number, tzOffsetMin: number): { utc: string; local: string } {
  const unixMs = (jd - 2440587.5) * 86400000;
  const du = new Date(unixMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  const utc = `${du.getUTCFullYear()}-${pad(du.getUTCMonth() + 1)}-${pad(du.getUTCDate())} ${pad(
    du.getUTCHours(),
  )}:${pad(du.getUTCMinutes())}:${pad(du.getUTCSeconds())} UTC`;

  const dl = new Date(unixMs + tzOffsetMin * 60000);
  const local = `${dl.getUTCFullYear()}-${pad(dl.getUTCMonth() + 1)}-${pad(dl.getUTCDate())} ${pad(
    dl.getUTCHours(),
  )}:${pad(dl.getUTCMinutes())}:${pad(dl.getUTCSeconds())}`;
  return { utc, local };
}

/** Browser preview fallback (uses circular 51.64° inclination LEO model when Tauri IPC is unavailable). */
function computeFallbackIssView(
  jdUt: number,
  obsLatDeg: number,
  obsLonDeg: number,
): IssEarthViewData {
  const d = jdUt - 2451545.0;
  const gmstDeg = wrapDeg360(280.46061837 + 360.98564736629 * d);
  const meanSunLon = wrapDeg360(280.46 + 0.9856474 * d);
  const meanSunAnom = (357.528 + 0.9856003 * d) * DEG2RAD;
  const eclLon =
    (meanSunLon + 1.915 * Math.sin(meanSunAnom) + 0.02 * Math.sin(2 * meanSunAnom)) * DEG2RAD;
  const obl = 23.4393 * DEG2RAD;
  const sunRaDeg = Math.atan2(Math.cos(obl) * Math.sin(eclLon), Math.cos(eclLon)) * RAD2DEG;
  const sunDecDeg = Math.asin(Math.sin(obl) * Math.sin(eclLon)) * RAD2DEG;
  const subsolarLat = sunDecDeg;
  const subsolarLon = wrapDeg180(sunRaDeg - gmstDeg);
  const sunUnit = latLonAltToVec3(subsolarLat, subsolarLon, 0).normalize();

  const evalAt = (tJd: number): IssTrackSample => {
    const dtMin = (tJd - 2451545.0) * 1440;
    const periodMin = 92.9;
    const nu = (dtMin / periodMin) * Math.PI * 2;
    const inc = 51.64 * DEG2RAD;
    const raan = (142.3 - 0.00348 * dtMin) * DEG2RAD;
    // Orbital plane position in ECI
    const xOrb = Math.cos(nu);
    const yOrb = Math.sin(nu);
    const xEci = Math.cos(raan) * xOrb - Math.sin(raan) * Math.cos(inc) * yOrb;
    const yEci = Math.sin(raan) * xOrb + Math.cos(raan) * Math.cos(inc) * yOrb;
    const zEci = Math.sin(inc) * yOrb;
    const latDeg = Math.asin(Math.max(-1, Math.min(1, zEci))) * RAD2DEG;
    const eciLon = Math.atan2(yEci, xEci) * RAD2DEG;
    const gmst = wrapDeg360(280.46061837 + 360.98564736629 * (tJd - 2451545.0));
    const lonDeg = wrapDeg180(eciLon - gmst);
    const altKm = 418.0 + 4.5 * Math.sin(nu);
    const posU = latLonAltToVec3(latDeg, lonDeg, altKm);
    const dotSun = posU.dot(sunUnit);
    const perp = Math.sqrt(Math.max(0, posU.lengthSq() - dotSun * dotSun));
    const isSunlit = dotSun >= 0 || perp > EARTH_R;
    return {
      jd_ut: tJd,
      lat_deg: latDeg,
      lon_deg: lonDeg,
      altitude_km: altKm,
      velocity_km_s: 7.66,
      is_sunlit: isSunlit,
    };
  };

  const cur = evalAt(jdUt);
  const track: IssTrackSample[] = [];
  for (let i = 0; i < 97; i++) {
    const offsetMin = -15 + (i / 96) * 110;
    track.push(evalAt(jdUt + offsetMin / 1440));
  }

  // Approximate observer look vector
  const obsV = latLonAltToVec3(obsLatDeg, obsLonDeg, 0);
  const satV = latLonAltToVec3(cur.lat_deg, cur.lon_deg, cur.altitude_km);
  const diff = satV.clone().sub(obsV);
  const rangeKm = diff.length() * 1000;
  const up = obsV.clone().normalize();
  const east = new THREE.Vector3(0, 1, 0).cross(up).normalize();
  const north = up.clone().cross(east).normalize();
  const altRad = Math.asin(Math.max(-1, Math.min(1, diff.dot(up) / Math.max(1e-6, diff.length()))));
  const azRad = Math.atan2(diff.dot(east), diff.dot(north));

  return {
    jd_ut: jdUt,
    name: "ISS (ZARYA)",
    norad_id: 25544,
    subsolar_lat_deg: subsolarLat,
    subsolar_lon_deg: subsolarLon,
    epoch_age_days: 0,
    track,
    current: {
      id: "sat:25544",
      norad_id: 25544,
      name: "ISS (ZARYA)",
      category: "stations",
      enabled: true,
      ra_deg: 0,
      dec_deg: 0,
      az_deg: wrapDeg360(azRad * RAD2DEG),
      alt_deg: altRad * RAD2DEG,
      range_km: rangeKm,
      altitude_km: cur.altitude_km,
      velocity_km_s: cur.velocity_km_s,
      subpoint_lat_deg: cur.lat_deg,
      subpoint_lon_deg: cur.lon_deg,
      is_sunlit: cur.is_sunlit,
      is_visible: cur.is_sunlit && altRad > 0,
      epoch_age_days: 0,
    },
  };
}

function buildMiniatureIssModel(): THREE.Group {
  const group = new THREE.Group();

  const trussMat = new THREE.MeshStandardMaterial({
    color: 0xdbeafe,
    metalness: 0.72,
    roughness: 0.35,
  });
  const moduleMat = new THREE.MeshStandardMaterial({
    color: 0xf1f5f9,
    metalness: 0.55,
    roughness: 0.3,
  });
  const goldMat = new THREE.MeshStandardMaterial({
    color: 0xf59e0b,
    metalness: 0.85,
    roughness: 0.25,
  });
  const panelMat = new THREE.MeshStandardMaterial({
    color: 0x1d4ed8,
    emissive: 0x172554,
    emissiveIntensity: 0.35,
    metalness: 0.78,
    roughness: 0.22,
  });

  // Main integrated truss along ±X (span ~109m scaled cleanly for orbit view)
  const truss = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.022, 0.022), trussMat);
  group.add(truss);

  // Pressurized module spine along ±Z (flight direction)
  const hull = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.24, 12), moduleMat);
  hull.rotation.x = Math.PI / 2;
  group.add(hull);

  // Node & Cupola gold ring near center/bottom
  const cupola = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.024, 0.04, 12), goldMat);
  cupola.rotation.x = Math.PI / 2;
  cupola.position.set(0, 0, 0.04);
  group.add(cupola);

  // 4 pairs of double-wing Solar Array Wings (SAW) along outer truss
  const wingOffsetsX = [-0.185, -0.135, 0.135, 0.185];
  for (const x of wingOffsetsX) {
    const wingPos = new THREE.Mesh(new THREE.BoxGeometry(0.036, 0.003, 0.145), panelMat);
    wingPos.position.set(x, 0, 0.088);
    group.add(wingPos);
    const wingNeg = new THREE.Mesh(new THREE.BoxGeometry(0.036, 0.003, 0.145), panelMat);
    wingNeg.position.set(x, 0, -0.088);
    group.add(wingNeg);
  }

  // Subtle glowing beacon so ISS stands out at global scale
  const beacon = new THREE.Mesh(
    new THREE.SphereGeometry(0.048, 12, 12),
    new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.65 }),
  );
  group.add(beacon);

  return group;
}

function sampleIssAlongTrack(
  view: IssEarthViewData,
  simJd: number,
  outPos: THREE.Vector3,
  outVelDir: THREE.Vector3,
): {
  latDeg: number;
  lonDeg: number;
  altitudeKm: number;
  velocityKmS: number;
  isSunlit: boolean;
} {
  const track = view.track;
  if (track.length < 2) {
    latLonAltToVec3(view.current.subpoint_lat_deg, view.current.subpoint_lon_deg, view.current.altitude_km, outPos);
    outVelDir.set(0, 0, -1);
    return {
      latDeg: view.current.subpoint_lat_deg,
      lonDeg: view.current.subpoint_lon_deg,
      altitudeKm: view.current.altitude_km,
      velocityKmS: view.current.velocity_km_s,
      isSunlit: view.current.is_sunlit,
    };
  }

  let idx = 0;
  if (simJd <= track[0].jd_ut) {
    idx = 0;
  } else if (simJd >= track[track.length - 1].jd_ut) {
    idx = track.length - 2;
  } else {
    for (let i = 0; i < track.length - 1; i++) {
      if (simJd >= track[i].jd_ut && simJd <= track[i + 1].jd_ut) {
        idx = i;
        break;
      }
    }
  }

  const s0 = track[idx];
  const s1 = track[idx + 1];
  const span = Math.max(1e-9, s1.jd_ut - s0.jd_ut);
  const u = Math.max(0, Math.min(1, (simJd - s0.jd_ut) / span));

  const p0 = latLonAltToVec3(s0.lat_deg, s0.lon_deg, s0.altitude_km);
  const p1 = latLonAltToVec3(s1.lat_deg, s1.lon_deg, s1.altitude_km);
  const r0 = p0.length();
  const r1 = p1.length();
  const n0 = p0.clone().divideScalar(r0);
  const n1 = p1.clone().divideScalar(r1);
  const rInterp = r0 + (r1 - r0) * u;
  outPos.copy(n0).lerp(n1, u).normalize().multiplyScalar(rInterp);

  outVelDir.copy(p1).sub(p0);
  if (outVelDir.lengthSq() < 1e-10) {
    outVelDir.set(0, 0, -1);
  } else {
    // Project tangent onto local horizontal plane at outPos
    const radial = outPos.clone().normalize();
    outVelDir.addScaledVector(radial, -outVelDir.dot(radial)).normalize();
  }

  const geo = vec3ToLatLonAlt(outPos);
  return {
    latDeg: geo.latDeg,
    lonDeg: geo.lonDeg,
    altitudeKm: s0.altitude_km + (s1.altitude_km - s0.altitude_km) * u,
    velocityKmS: s0.velocity_km_s + (s1.velocity_km_s - s0.velocity_km_s) * u,
    isSunlit: u < 0.5 ? s0.is_sunlit : s1.is_sunlit,
  };
}

export function IssEarthView() {
  const closePanel = useSkyStore((s) => s.closePanel);
  const location = useSkyStore((s) => s.location);
  const refractionEnabled = useSkyStore((s) => s.refractionEnabled);
  const offlineMode = useSkyStore((s) => s.offlineMode);
  const lookAtDirection = useSkyStore((s) => s.lookAtDirection);
  const notifySatellitesChanged = useSkyStore((s) => s.notifySatellitesChanged);
  const staticAssets = useSkyStore((s) => s.staticAssets);

  const mountRef = useRef<HTMLDivElement | null>(null);
  const [cameraMode, setCameraMode] = useState<IssCameraMode>("cupola");
  const [showCupolaFrame, setShowCupolaFrame] = useState(true);
  const [playing, setPlaying] = useState(true);
  const [speedMult, setSpeedMult] = useState<number>(1);
  const [useAppTime, setUseAppTime] = useState(false);
  const [viewData, setViewData] = useState<IssEarthViewData | null>(null);
  const [syncingTle, setSyncingTle] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const [hud, setHud] = useState({
    latDeg: 35.0,
    lonDeg: 135.0,
    altKm: 418.0,
    velKmS: 7.66,
    isSunlit: true,
    jdUt: nowUtcJd(),
  });

  const appJdUt = useSkyStore((s) => s.jdUt);

  const simJdRef = useRef<number>(nowUtcJd());
  const cameraModeRef = useRef<IssCameraMode>(cameraMode);
  const playingRef = useRef(playing);
  const speedMultRef = useRef(speedMult);
  const viewDataRef = useRef<IssEarthViewData | null>(null);
  const lookOffsetRef = useRef({ yawDeg: 0, pitchDeg: -26, fov: 56 });
  const nadirOffsetRef = useRef({ yawDeg: 0, pitchDeg: -89.2, fov: 48 });
  const fetchingRef = useRef(false);
  const lastFetchedCenterJdRef = useRef<number>(0);
  const fetchIssViewRef = useRef<(targetJd: number) => Promise<void>>(() => Promise.resolve());

  cameraModeRef.current = cameraMode;
  playingRef.current = playing;
  speedMultRef.current = speedMult;

  const sceneRef = useRef<{
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    renderer: THREE.WebGLRenderer;
    controls: OrbitControls;
    earthUniforms: {
      uSunDir: { value: THREE.Vector3 };
    };
    cloudsUniforms: {
      uSunDir: { value: THREE.Vector3 };
    };
    atmoUniforms: {
      uSunDir: { value: THREE.Vector3 };
    };
    cloudsMesh: THREE.Mesh;
    issGroup: THREE.Group;
    trackLine: THREE.Line | null;
    groundLine: THREE.Line | null;
    observerPin: THREE.Mesh;
    subpointDot: THREE.Mesh;
    sunDirVec: THREE.Vector3;
  } | null>(null);

  const fetchIssView = useCallback(
    async (targetJd: number) => {
      if (fetchingRef.current) return;
      fetchingRef.current = true;
      try {
        const req = {
          jd_ut: targetJd,
          lat_deg: location.lat_deg,
          lon_deg: location.lon_deg,
          alt_m: location.alt_m,
          tz_offset_min: location.tz_offset_min,
          refraction: refractionEnabled,
        };
        const data = isTauri()
          ? await invoke<IssEarthViewData>("get_iss_earth_view_cmd", { req })
          : computeFallbackIssView(targetJd, location.lat_deg, location.lon_deg);
        lastFetchedCenterJdRef.current = targetJd;
        viewDataRef.current = data;
        setViewData(data);

        // Update sun direction uniform from exact solar ephemeris subsolar point
        const ctx = sceneRef.current;
        if (ctx) {
          const sunV = latLonAltToVec3(data.subsolar_lat_deg, data.subsolar_lon_deg, 0).normalize();
          ctx.sunDirVec.copy(sunV);
          ctx.earthUniforms.uSunDir.value.copy(sunV);
          ctx.cloudsUniforms.uSunDir.value.copy(sunV);
          ctx.atmoUniforms.uSunDir.value.copy(sunV);

          // Rebuild orbit & ground track geometry
          if (ctx.trackLine) {
            ctx.scene.remove(ctx.trackLine);
            ctx.trackLine.geometry.dispose();
          }
          if (ctx.groundLine) {
            ctx.scene.remove(ctx.groundLine);
            ctx.groundLine.geometry.dispose();
          }
          if (data.track.length >= 2) {
            const posArr = new Float32Array(data.track.length * 3);
            const colArr = new Float32Array(data.track.length * 3);
            const gndArr = new Float32Array(data.track.length * 3);
            const tmp = new THREE.Vector3();
            const cDay = new THREE.Color(0x38bdf8);
            const cDark = new THREE.Color(0x818cf8);

            data.track.forEach((pt, idx) => {
              latLonAltToVec3(pt.lat_deg, pt.lon_deg, pt.altitude_km, tmp);
              posArr[idx * 3] = tmp.x;
              posArr[idx * 3 + 1] = tmp.y;
              posArr[idx * 3 + 2] = tmp.z;

              const c = pt.is_sunlit ? cDay : cDark;
              colArr[idx * 3] = c.r;
              colArr[idx * 3 + 1] = c.g;
              colArr[idx * 3 + 2] = c.b;

              latLonAltToVec3(pt.lat_deg, pt.lon_deg, 10, tmp);
              gndArr[idx * 3] = tmp.x;
              gndArr[idx * 3 + 1] = tmp.y;
              gndArr[idx * 3 + 2] = tmp.z;
            });

            const orbGeo = new THREE.BufferGeometry();
            orbGeo.setAttribute("position", new THREE.BufferAttribute(posArr, 3));
            orbGeo.setAttribute("color", new THREE.BufferAttribute(colArr, 3));
            ctx.trackLine = new THREE.Line(
              orbGeo,
              new THREE.LineBasicMaterial({
                vertexColors: true,
                transparent: true,
                opacity: 0.72,
              }),
            );
            ctx.scene.add(ctx.trackLine);

            const gndGeo = new THREE.BufferGeometry();
            gndGeo.setAttribute("position", new THREE.BufferAttribute(gndArr, 3));
            ctx.groundLine = new THREE.Line(
              gndGeo,
              new THREE.LineBasicMaterial({
                color: 0x38bdf8,
                transparent: true,
                opacity: 0.25,
              }),
            );
            ctx.scene.add(ctx.groundLine);
          }

          latLonAltToVec3(location.lat_deg, location.lon_deg, 12, ctx.observerPin.position);
        }
      } catch (err) {
        setStatusMsg(err instanceof Error ? err.message : String(err));
      } finally {
        fetchingRef.current = false;
      }
    },
    [location, refractionEnabled],
  );

  fetchIssViewRef.current = fetchIssView;

  // Sync when toggling "アプリ時刻" or updating observer location
  useEffect(() => {
    const startJd = useAppTime ? appJdUt : nowUtcJd();
    simJdRef.current = startJd;
    void fetchIssView(startJd);
  }, [useAppTime, appJdUt, location.lat_deg, location.lon_deg, fetchIssView]);

  // Initialize Three.js WebGL scene
  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const width = Math.max(300, container.clientWidth);
    const height = Math.max(220, container.clientHeight);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#02040d");

    const camera = new THREE.PerspectiveCamera(56, width / height, 0.015, 300);
    camera.position.set(13.5, 4.2, 12.0);

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(Math.min(1.75, window.devicePixelRatio || 1));
    renderer.setSize(width, height);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;
    container.appendChild(renderer.domElement);
    const maxAniso = renderer.capabilities.getMaxAnisotropy();

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 8.2;
    controls.maxDistance = 36;
    controls.enabled = cameraModeRef.current === "orbit";

    // Lighting for 3D ISS spacecraft & observer pin
    scene.add(new THREE.AmbientLight(0xb8c7e0, 0.42));
    const dirLight = new THREE.DirectionalLight(0xfff7e6, 2.4);
    dirLight.position.set(30, 5, 10);
    scene.add(dirLight);

    // Star dome
    if (staticAssets?.named_stars && staticAssets.named_stars.length > 0) {
      const stars = staticAssets.named_stars.slice(0, 1800);
      const posArr = new Float32Array(stars.length * 3);
      stars.forEach((st, i) => {
        const ra = st.ra_deg * DEG2RAD;
        const dec = st.dec_deg * DEG2RAD;
        const R = 140;
        posArr[i * 3] = R * Math.cos(dec) * Math.cos(ra);
        posArr[i * 3 + 1] = R * Math.sin(dec);
        posArr[i * 3 + 2] = -R * Math.cos(dec) * Math.sin(ra);
      });
      const starGeo = new THREE.BufferGeometry();
      starGeo.setAttribute("position", new THREE.BufferAttribute(posArr, 3));
      scene.add(
        new THREE.Points(
          starGeo,
          new THREE.PointsMaterial({ color: 0xe2e8f0, size: 0.45, sizeAttenuation: false }),
        ),
      );
    }

    const loader = new THREE.TextureLoader();
    const loadTex = (url: string, srgb: boolean) => {
      const t = loader.load(url);
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.anisotropy = Math.min(8, maxAniso);
      t.wrapS = THREE.RepeatWrapping;
      return t;
    };

    const dayTex = loadTex("/textures/planets/earth_day.jpg", true);
    const nightTex = loadTex("/textures/planets/earth_night.jpg", true);
    const specTex = loadTex("/textures/planets/earth_specular.jpg", false);
    const cloudsTex = loadTex("/textures/planets/earth_clouds.png", false);

    const sunDirVec = new THREE.Vector3(0.8, 0.25, 0.55).normalize();

    const earthUniforms = {
      uDayTex: { value: dayTex },
      uNightTex: { value: nightTex },
      uSpecTex: { value: specTex },
      uCloudsTex: { value: cloudsTex },
      uSunDir: { value: sunDirVec.clone() },
    };

    const earthMesh = new THREE.Mesh(
      new THREE.SphereGeometry(EARTH_R, 96, 72),
      new THREE.ShaderMaterial({
        uniforms: earthUniforms,
        vertexShader: EARTH_SURFACE_VERT,
        fragmentShader: EARTH_SURFACE_FRAG,
      }),
    );
    scene.add(earthMesh);

    const cloudsUniforms = {
      uCloudsTex: { value: cloudsTex },
      uSunDir: { value: sunDirVec.clone() },
    };
    const cloudsMesh = new THREE.Mesh(
      new THREE.SphereGeometry(EARTH_R * 1.0078, 84, 64),
      new THREE.ShaderMaterial({
        uniforms: cloudsUniforms,
        vertexShader: CLOUDS_VERT,
        fragmentShader: CLOUDS_FRAG,
        transparent: true,
        depthWrite: false,
      }),
    );
    scene.add(cloudsMesh);

    const atmoUniforms = {
      uSunDir: { value: sunDirVec.clone() },
    };
    const atmoMesh = new THREE.Mesh(
      new THREE.SphereGeometry(EARTH_R * 1.032, 72, 54),
      new THREE.ShaderMaterial({
        uniforms: atmoUniforms,
        vertexShader: ATMO_VERT,
        fragmentShader: ATMO_FRAG,
        transparent: true,
        depthWrite: false,
        side: THREE.BackSide,
        blending: THREE.AdditiveBlending,
      }),
    );
    scene.add(atmoMesh);

    const issGroup = buildMiniatureIssModel();
    scene.add(issGroup);

    const observerPin = new THREE.Mesh(
      new THREE.SphereGeometry(0.052, 16, 16),
      new THREE.MeshBasicMaterial({ color: 0xfbbf24 }),
    );
    latLonAltToVec3(location.lat_deg, location.lon_deg, 12, observerPin.position);
    scene.add(observerPin);

    const subpointDot = new THREE.Mesh(
      new THREE.RingGeometry(0.04, 0.085, 24),
      new THREE.MeshBasicMaterial({
        color: 0x38bdf8,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.85,
      }),
    );
    scene.add(subpointDot);

    sceneRef.current = {
      scene,
      camera,
      renderer,
      controls,
      earthUniforms,
      cloudsUniforms,
      atmoUniforms,
      cloudsMesh,
      issGroup,
      trackLine: null,
      groundLine: null,
      observerPin,
      subpointDot,
      sunDirVec,
    };

    // Trigger immediate data fetch onto newly mounted scene if already cached
    if (viewDataRef.current) {
      void fetchIssViewRef.current(simJdRef.current);
    }

    // Custom Cupola / Nadir look drag + wheel FOV zoom
    let dragPointerId: number | null = null;
    let prevClientX = 0;
    let prevClientY = 0;

    const onPointerDown = (e: PointerEvent) => {
      if (cameraModeRef.current === "orbit") return;
      dragPointerId = e.pointerId;
      prevClientX = e.clientX;
      prevClientY = e.clientY;
      renderer.domElement.setPointerCapture(e.pointerId);
    };

    const onPointerMove = (e: PointerEvent) => {
      if (dragPointerId !== e.pointerId || cameraModeRef.current === "orbit") return;
      const dx = e.clientX - prevClientX;
      const dy = e.clientY - prevClientY;
      prevClientX = e.clientX;
      prevClientY = e.clientY;
      if (cameraModeRef.current === "cupola") {
        const lk = lookOffsetRef.current;
        lk.yawDeg = Math.max(-135, Math.min(135, lk.yawDeg - dx * 0.24));
        lk.pitchDeg = Math.max(-85, Math.min(22, lk.pitchDeg - dy * 0.2));
      } else {
        const nk = nadirOffsetRef.current;
        nk.yawDeg = Math.max(-180, Math.min(180, nk.yawDeg - dx * 0.22));
        nk.pitchDeg = Math.max(-89.8, Math.min(-45, nk.pitchDeg - dy * 0.16));
      }
    };

    const onPointerUp = (e: PointerEvent) => {
      if (dragPointerId !== e.pointerId) return;
      dragPointerId = null;
      if (renderer.domElement.hasPointerCapture(e.pointerId)) {
        renderer.domElement.releasePointerCapture(e.pointerId);
      }
    };

    const onWheel = (e: WheelEvent) => {
      if (cameraModeRef.current === "orbit") return;
      e.preventDefault();
      const targetRef =
        cameraModeRef.current === "cupola" ? lookOffsetRef.current : nadirOffsetRef.current;
      targetRef.fov = Math.max(20, Math.min(86, targetRef.fov + e.deltaY * 0.035));
    };

    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("pointermove", onPointerMove);
    renderer.domElement.addEventListener("pointerup", onPointerUp);
    renderer.domElement.addEventListener("pointercancel", onPointerUp);
    renderer.domElement.addEventListener("wheel", onWheel, { passive: false });

    const ro = new ResizeObserver(() => {
      const w = Math.max(280, container.clientWidth);
      const h = Math.max(200, container.clientHeight);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    });
    ro.observe(container);

    const tmpIssPos = new THREE.Vector3();
    const tmpVelDir = new THREE.Vector3();
    const tmpRadialUp = new THREE.Vector3();
    const tmpRight = new THREE.Vector3();
    const tmpLookDir = new THREE.Vector3();
    const tmpTarget = new THREE.Vector3();
    const lvMat = new THREE.Matrix4();

    let prevNow = performance.now();
    let lastHudUpdate = 0;
    let rafId = 0;

    const animate = (now: number) => {
      const dt = Math.min(0.08, Math.max(0.001, (now - prevNow) / 1000));
      prevNow = now;
      const ctx = sceneRef.current;
      if (!ctx) return;

      if (playingRef.current) {
        simJdRef.current += (dt * speedMultRef.current) / 86400;
      }

      // Gently drift cloud texture slightly so weather feels living even at x1
      cloudsTex.offset.x = (cloudsTex.offset.x + dt * 0.00025 * Math.min(20, speedMultRef.current)) % 1;

      const curData = viewDataRef.current;
      if (curData) {
        // Trigger background SGP4 track refresh well before running off the 110-min track window
        const minJd = curData.track[0]?.jd_ut ?? curData.jd_ut;
        const maxJd = curData.track[curData.track.length - 1]?.jd_ut ?? curData.jd_ut;
        if (
          !fetchingRef.current &&
          (simJdRef.current < minJd + 2 / 1440 || simJdRef.current > maxJd - 12 / 1440) &&
          Math.abs(simJdRef.current - lastFetchedCenterJdRef.current) > 3 / 1440
        ) {
          void fetchIssViewRef.current(simJdRef.current);
        }

        const sample = sampleIssAlongTrack(curData, simJdRef.current, tmpIssPos, tmpVelDir);
        tmpRadialUp.copy(tmpIssPos).normalize();
        tmpRight.crossVectors(tmpVelDir, tmpRadialUp).normalize();

        // Update ISS 3D spacecraft & subsatellite surface ring
        ctx.issGroup.position.copy(tmpIssPos);
        lvMat.makeBasis(tmpRight, tmpRadialUp, tmpVelDir.clone().negate());
        ctx.issGroup.quaternion.setFromRotationMatrix(lvMat);
        ctx.issGroup.visible = cameraModeRef.current === "orbit";

        ctx.subpointDot.position.copy(tmpRadialUp).multiplyScalar(EARTH_R + 0.012);
        ctx.subpointDot.lookAt(tmpRadialUp.clone().multiplyScalar(EARTH_R + 2));
        ctx.subpointDot.visible = cameraModeRef.current !== "cupola";

        dirLight.position.copy(ctx.sunDirVec).multiplyScalar(32);

        const mode = cameraModeRef.current;
        if (mode === "orbit") {
          ctx.controls.enabled = true;
          ctx.camera.up.set(0, 1, 0);
          if (Math.abs(ctx.camera.fov - 46) > 0.2) {
            ctx.camera.fov = 46;
            ctx.camera.updateProjectionMatrix();
          }
          ctx.controls.update();
        } else if (mode === "cupola") {
          ctx.controls.enabled = false;
          const lk = lookOffsetRef.current;
          if (Math.abs(ctx.camera.fov - lk.fov) > 0.1) {
            ctx.camera.fov = lk.fov;
            ctx.camera.updateProjectionMatrix();
          }
          const yawRad = lk.yawDeg * DEG2RAD;
          const pitchRad = lk.pitchDeg * DEG2RAD;
          const horizX = Math.cos(yawRad);
          const horizY = Math.sin(yawRad);
          const cPitch = Math.cos(pitchRad);
          const sPitch = Math.sin(pitchRad);
          tmpLookDir
            .copy(tmpVelDir)
            .multiplyScalar(cPitch * horizX)
            .addScaledVector(tmpRight, cPitch * horizY)
            .addScaledVector(tmpRadialUp, sPitch)
            .normalize();

          ctx.camera.position.copy(tmpIssPos).addScaledVector(tmpRadialUp, 0.015);
          ctx.camera.up.copy(tmpRadialUp);
          tmpTarget.copy(ctx.camera.position).addScaledVector(tmpLookDir, 3.0);
          ctx.camera.lookAt(tmpTarget);
        } else {
          // nadir straight-down camera
          ctx.controls.enabled = false;
          const nk = nadirOffsetRef.current;
          if (Math.abs(ctx.camera.fov - nk.fov) > 0.1) {
            ctx.camera.fov = nk.fov;
            ctx.camera.updateProjectionMatrix();
          }
          const yawRad = nk.yawDeg * DEG2RAD;
          const pitchRad = nk.pitchDeg * DEG2RAD;
          const cPitch = Math.cos(pitchRad);
          const sPitch = Math.sin(pitchRad);
          tmpLookDir
            .copy(tmpVelDir)
            .multiplyScalar(cPitch * Math.cos(yawRad))
            .addScaledVector(tmpRight, cPitch * Math.sin(yawRad))
            .addScaledVector(tmpRadialUp, sPitch)
            .normalize();

          ctx.camera.position.copy(tmpIssPos).addScaledVector(tmpRadialUp, 0.015);
          ctx.camera.up.copy(tmpVelDir);
          tmpTarget.copy(ctx.camera.position).addScaledVector(tmpLookDir, 3.0);
          ctx.camera.lookAt(tmpTarget);
        }

        if (now - lastHudUpdate > 240) {
          lastHudUpdate = now;
          setHud({
            latDeg: sample.latDeg,
            lonDeg: sample.lonDeg,
            altKm: sample.altitudeKm,
            velKmS: sample.velocityKmS,
            isSunlit: sample.isSunlit,
            jdUt: simJdRef.current,
          });
        }
      }

      ctx.renderer.render(ctx.scene, ctx.camera);
      rafId = requestAnimationFrame(animate);
    };

    rafId = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(rafId);
      ro.disconnect();
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      renderer.domElement.removeEventListener("pointercancel", onPointerUp);
      renderer.domElement.removeEventListener("wheel", onWheel);
      controls.dispose();
      renderer.dispose();
      dayTex.dispose();
      nightTex.dispose();
      specTex.dispose();
      cloudsTex.dispose();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
      sceneRef.current = null;
    };
  }, [staticAssets]);

  const handleModeChange = (mode: IssCameraMode) => {
    setCameraMode(mode);
    const ctx = sceneRef.current;
    if (!ctx) return;
    if (mode === "orbit") {
      const pos = ctx.issGroup.position.lengthSq() > 1
        ? ctx.issGroup.position.clone().normalize().multiplyScalar(17.5)
        : new THREE.Vector3(12, 6, 12);
      ctx.camera.up.set(0, 1, 0);
      ctx.camera.position.copy(pos);
      ctx.controls.target.set(0, 0, 0);
      ctx.controls.update();
    }
  };

  const handleResetCamera = () => {
    if (cameraMode === "cupola") {
      lookOffsetRef.current = { yawDeg: 0, pitchDeg: -26, fov: 56 };
    } else if (cameraMode === "nadir") {
      nadirOffsetRef.current = { yawDeg: 0, pitchDeg: -89.2, fov: 48 };
    } else {
      handleModeChange("orbit");
    }
  };

  const handleSyncTle = async () => {
    if (!isTauri() || syncingTle) return;
    setSyncingTle(true);
    setStatusMsg("CelesTrak から最新ISS軌道 (TLE) を取得中...");
    try {
      const res = await invoke<OnlineSyncResult>("sync_celestrak_tle_cmd", {
        offlineMode,
        group: "stations",
      });
      await notifySatellitesChanged();
      setStatusMsg(res.summary_ja);
      await fetchIssView(simJdRef.current);
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncingTle(false);
    }
  };

  const handleJumpLiveNow = () => {
    setUseAppTime(false);
    const nowJd = nowUtcJd();
    simJdRef.current = nowJd;
    setPlaying(true);
    setSpeedMult(1);
    void fetchIssView(nowJd);
  };

  const times = jdToDateTimeStrings(hud.jdUt, location.tz_offset_min);

  return (
    <aside className="flex h-[34rem] max-h-[calc(100dvh-10.5rem)] w-[50rem] max-w-[calc(100vw-5.5rem)] flex-col text-[var(--text-primary)] max-sm:h-[82dvh] max-sm:max-h-none max-sm:w-full max-sm:max-w-none">
      {/* Header */}
      <div className="flex items-start justify-between gap-2 border-b border-[var(--border-subtle)] px-3.5 py-2.5 sm:px-4">
        <div className="min-w-0">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold tracking-tight">
            <Satellite className="h-4 w-4 text-[var(--accent-primary)]" />
            <span>ISS リアルタイム地球ビュー</span>
            <span
              className={`ml-1 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${
                hud.isSunlit
                  ? "border-sky-400/40 bg-sky-500/15 text-sky-300"
                  : "border-indigo-400/40 bg-indigo-500/15 text-indigo-300"
              }`}
            >
              {hud.isSunlit ? "昼側 (日照)" : "地球の影 (夜側)"}
            </span>
          </h2>
          <p className="truncate text-[11px] text-[var(--text-muted)]">
            {viewData?.name ?? "ISS (ZARYA)"} · 高度 {hud.altKm.toFixed(1)} km · 速度{" "}
            {hud.velKmS.toFixed(2)} km/s · {times.utc}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          onClick={() => closePanel("iss_view")}
          title="閉じる"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Controls Bar */}
      <div className="flex flex-wrap items-center justify-between gap-1.5 border-b border-[var(--border-subtle)] px-3.5 py-1.5 text-xs sm:px-4">
        <div className="flex flex-wrap items-center gap-1">
          <Button
            type="button"
            size="sm"
            variant={cameraMode === "cupola" ? "default" : "outline"}
            className="h-7 gap-1 px-2 text-[11px]"
            onClick={() => handleModeChange("cupola")}
          >
            <Camera className="h-3.5 w-3.5" />
            ISS窓
          </Button>
          <Button
            type="button"
            size="sm"
            variant={cameraMode === "nadir" ? "default" : "outline"}
            className="h-7 gap-1 px-2 text-[11px]"
            onClick={() => handleModeChange("nadir")}
          >
            <Eye className="h-3.5 w-3.5" />
            直下
          </Button>
          <Button
            type="button"
            size="sm"
            variant={cameraMode === "orbit" ? "default" : "outline"}
            className="h-7 gap-1 px-2 text-[11px]"
            onClick={() => handleModeChange("orbit")}
          >
            <Orbit className="h-3.5 w-3.5" />
            3D軌道
          </Button>
          {cameraMode === "cupola" && (
            <Button
              type="button"
              size="sm"
              variant={showCupolaFrame ? "tonal" : "ghost"}
              className="h-7 px-2 text-[11px]"
              onClick={() => setShowCupolaFrame((v) => !v)}
            >
              窓枠{showCupolaFrame ? "ON" : "OFF"}
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0"
            onClick={handleResetCamera}
            title="視点をリセット"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <Button
            type="button"
            size="sm"
            variant={playing ? "tonal" : "default"}
            className="h-7 gap-1 px-2 text-[11px]"
            onClick={() => setPlaying((p) => !p)}
          >
            {playing ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
            {playing ? "停止" : "再生"}
          </Button>
          <select
            value={speedMult}
            onChange={(e) => setSpeedMult(Number(e.target.value))}
            aria-label="再生倍率"
            className="h-7 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-1.5 text-[11px] text-[var(--text-primary)]"
          >
            {SPEED_PRESETS.map((p) => (
              <option key={p.mult} value={p.mult}>
                {p.label}
              </option>
            ))}
          </select>
          <Button
            type="button"
            size="sm"
            variant={!useAppTime ? "default" : "outline"}
            className="h-7 px-2 text-[11px]"
            onClick={handleJumpLiveNow}
            title="現在時刻の実時間に同期"
          >
            LIVE
          </Button>
          <Button
            type="button"
            size="sm"
            variant={useAppTime ? "default" : "outline"}
            className="h-7 px-2 text-[11px]"
            onClick={() => setUseAppTime(true)}
            title="星図の表示時刻に合わせる"
          >
            星図時刻
          </Button>
          {isTauri() && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={syncingTle || offlineMode}
              className="h-7 gap-1 px-2 text-[11px]"
              onClick={() => void handleSyncTle()}
              title="CelesTrakからISSの最新TLEを取得"
            >
              <RefreshCw className={`h-3 w-3 ${syncingTle ? "animate-spin" : ""}`} />
              TLE更新
            </Button>
          )}
        </div>
      </div>

      {/* 3D Viewport */}
      <div className="relative min-h-0 flex-1 overflow-hidden bg-[#02040d]">
        <div ref={mountRef} className="h-full w-full touch-none" />

        {/* Optional ISS Cupola Window Silhouette Overlay */}
        {cameraMode === "cupola" && showCupolaFrame && (
          <svg
            viewBox="0 0 800 500"
            preserveAspectRatio="none"
            className="pointer-events-none absolute inset-0 h-full w-full"
          >
            <defs>
              <radialGradient id="cupola-vignette" cx="50%" cy="50%" r="58%">
                <stop offset="68%" stopColor="#020612" stopOpacity="0" />
                <stop offset="93%" stopColor="#020612" stopOpacity="0.65" />
                <stop offset="100%" stopColor="#020612" stopOpacity="0.96" />
              </radialGradient>
            </defs>
            <rect x="0" y="0" width="800" height="500" fill="url(#cupola-vignette)" />
            {/* Radial cupola struts */}
            <g stroke="rgba(148,163,184,0.28)" strokeWidth="6" fill="none">
              <circle cx="400" cy="250" r="228" />
              <circle cx="400" cy="250" r="102" strokeWidth="4" />
              <line x1="400" y1="22" x2="400" y2="148" />
              <line x1="597" y1="136" x2="488" y2="199" />
              <line x1="597" y1="364" x2="488" y2="301" />
              <line x1="400" y1="478" x2="400" y2="352" />
              <line x1="203" y1="364" x2="312" y2="301" />
              <line x1="203" y1="136" x2="312" y2="199" />
            </g>
          </svg>
        )}

        {/* Nadir Center Reticle */}
        {cameraMode === "nadir" && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="h-14 w-14 rounded-full border border-sky-300/45 shadow-[0_0_20px_rgba(56,189,248,0.2)]" />
            <div className="absolute h-3 w-px bg-sky-300/75" />
            <div className="absolute h-px w-3 bg-sky-300/75" />
          </div>
        )}

        {/* Live Telemetry Overlay */}
        <div className="pointer-events-none absolute top-2.5 left-2.5 flex flex-col gap-1 rounded-xl border border-white/15 bg-slate-950/65 px-2.5 py-2 text-[11px] backdrop-blur-md">
          <div className="flex items-center gap-1.5 font-mono text-sky-300">
            <Globe className="h-3.5 w-3.5 shrink-0" />
            <span>直下点: {formatLatLon(hud.latDeg, hud.lonDeg)}</span>
          </div>
          <div className="text-[10px] text-slate-300">
            現地時刻: {times.local}
            {viewData && (
              <>
                {" · "}軌道高度 {hud.altKm.toFixed(1)} km · 距離 {viewData.current.range_km.toFixed(0)} km
              </>
            )}
          </div>
          {viewData && (
            <div className="flex items-center gap-1.5 text-[10px] text-amber-200/90">
              <MapPin className="h-3 w-3 shrink-0" />
              <span>
                {location.name_ja}: 仰角 {viewData.current.alt_deg.toFixed(1)}° / 方位{" "}
                {viewData.current.az_deg.toFixed(0)}°
              </span>
            </div>
          )}
        </div>

        {/* Center ISS on Sky Map Button */}
        {viewData && (
          <div className="absolute right-2.5 bottom-2.5 flex items-center gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="tonal"
              className="h-7 gap-1 border border-white/15 bg-slate-950/75 px-2.5 text-[11px] text-slate-100 backdrop-blur-md hover:bg-slate-900/90"
              onClick={() =>
                lookAtDirection(viewData.current.az_deg, Math.max(-25, viewData.current.alt_deg))
              }
            >
              <Compass className="h-3.5 w-3.5 text-sky-400" />
              星図でISS方位を見る
            </Button>
          </div>
        )}

        {statusMsg && (
          <div className="pointer-events-none absolute bottom-2.5 left-2.5 max-w-[65%] rounded-lg border border-sky-400/30 bg-slate-950/80 px-2.5 py-1 text-[10px] text-sky-200 backdrop-blur-md">
            {statusMsg}
          </div>
        )}
      </div>

      {/* Footer Hint */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border-subtle)] px-3.5 py-1.5 text-[10px] text-[var(--text-muted)] sm:px-4">
        <span>
          {cameraMode === "orbit"
            ? "ドラッグで地球を回転 · スクロール/ピンチでズーム · 青線=日照軌道 / 紫線=地球影"
            : "ドラッグで窓の向きを調整 · ホイールで望遠/広角ズーム"}
        </span>
        {viewData && (
          <span>
            TLE経過 {Math.abs(viewData.epoch_age_days).toFixed(1)} 日 · 太陽直下{" "}
            {formatLatLon(viewData.subsolar_lat_deg, viewData.subsolar_lon_deg)}
          </span>
        )}
      </div>
    </aside>
  );
}
