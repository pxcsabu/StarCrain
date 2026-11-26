import { invoke, isTauri } from "@tauri-apps/api/core";
import { create } from "zustand";
import { clearHipsFailureCache } from "@/lib/hipsSurvey";
import { defaultFovPresets } from "@/lib/fovMath";
import {
  buildGpsLocationPreset,
  requestCurrentGpsPosition,
} from "@/lib/deviceSensors";
import {
  buildBrowserPreviewFrame,
  effectiveFovDeg,
  horizontalToEquatorialFast,
  j2000ToHorWithMatrix,
  wrapDeg360,
} from "@/lib/projection";
import { useClockStore, type ClockThemeId, type HourlyChimeMode } from "@/store/clockStore";
import { type ThemeMode, useThemeStore } from "@/store/themeStore";
import {
  type ActivePanelId,
  type AltitudeTargetItem,
  type AngleFormat,
  COLOR_PRESETS,
  type ColorPresetId,
  type CometWithEphemeris,
  type ConstellationLineMode,
  type CustomColorPalette,
  type DaySpecialTimes,
  DEFAULT_HIPS_CONFIG,
  DEFAULT_LANDSCAPE_CONFIG,
  DEFAULT_LAYERS,
  type FovPreset,
  type HipsSurveyConfig,
  type LandscapeConfig,
  type LocationPreset,
  type NightWeatherForecast,
  type ObjectDetails,
  type ObjectTrail,
  type ObserverBodyId,
  type PickedObject,
  type PlanetTrackOverlay,
  PROJECTION_META,
  type ProjectionMode,
  type ProjectionParams,
  type SatellitePass,
  type SatelliteSkyPos,
  type SimulationLockMode,
  type SimulationTarget,
  type SkyFrame,
  type SkyLayerVisibility,
  type SkyStaticAssets,
  type SkyViewMode,
  type SpaceWeatherSnapshot,
  type StarCraneProfileV1,
  type UnitSystem,
} from "@/types/sky";

const AKASHI_DEFAULT: LocationPreset = {
  id: "akashi",
  name_ja: "明石市",
  name_en: "Akashi",
  country_ja: "日本",
  region: "近畿",
  lat_deg: 34.6431,
  lon_deg: 134.9972,
  alt_m: 10,
  tz_offset_min: 540,
  tz_name: "JST",
  category: "japan",
  is_default: true,
};

const COLORS_STORAGE_KEY = "starcrane-colors-v1";
const LOCATIONS_STORAGE_KEY = "starcrane-locations-v1";
const STARTUP_OBS_STORAGE_KEY = "starcrane-startup-obs-v1";
const STARTUP_DEMO_STORAGE_KEY = "starcrane-startup-demo-v1";
const UNITS_STORAGE_KEY = "starcrane-units-v1";
const FOV_STORAGE_KEY = "starcrane-fov-v1";
const OFFLINE_STORAGE_KEY = "starcrane-offline-v1";
const WEATHER_CLOUDS_STORAGE_KEY = "starcrane-weather-clouds-v1";
const LANDSCAPE_STORAGE_KEY = "starcrane:landscape:v2";
const LEGACY_LANDSCAPE_STORAGE_KEY = "starcrane:landscape:v1";
const METEOR_ANIM_STORAGE_KEY = "starcrane:meteors_on:v1";
const HIPS_STORAGE_KEY = "starcrane-hips-v1";

function loadHipsConfig(): HipsSurveyConfig {
  if (typeof window === "undefined") return { ...DEFAULT_HIPS_CONFIG };
  try {
    const raw = window.localStorage.getItem(HIPS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_HIPS_CONFIG };
    const p = JSON.parse(raw) as Partial<HipsSurveyConfig>;
    const surveyId =
      p.surveyId === "dss2_color" || p.surveyId === "dss2_red" || p.surveyId === "2mass_color"
        ? p.surveyId
        : DEFAULT_HIPS_CONFIG.surveyId;
    return {
      enabled: typeof p.enabled === "boolean" ? p.enabled : DEFAULT_HIPS_CONFIG.enabled,
      surveyId,
      opacity:
        typeof p.opacity === "number" && Number.isFinite(p.opacity)
          ? Math.max(0.15, Math.min(1, p.opacity))
          : DEFAULT_HIPS_CONFIG.opacity,
      maxOrder:
        typeof p.maxOrder === "number" && Number.isFinite(p.maxOrder)
          ? Math.max(2, Math.min(7, Math.round(p.maxOrder)))
          : DEFAULT_HIPS_CONFIG.maxOrder,
    };
  } catch {
    return { ...DEFAULT_HIPS_CONFIG };
  }
}

function persistHipsConfig(cfg: HipsSurveyConfig): void {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(HIPS_STORAGE_KEY, JSON.stringify(cfg));
  }
}

const ALTITUDE_TARGET_COLORS = [
  "#38bdf8",
  "#fbbf24",
  "#f472b6",
  "#34d399",
  "#c084fc",
  "#fb923c",
  "#60a5fa",
  "#a3e635",
];

const DEFAULT_ALTITUDE_TARGETS: AltitudeTargetItem[] = [
  { id: "dso:M31", nameJa: "M31 アンドロメダ銀河", kind: "dso", raDeg: 10.6847, decDeg: 41.2688, color: ALTITUDE_TARGET_COLORS[0] },
  { id: "dso:M42", nameJa: "M42 オリオン大星雲", kind: "dso", raDeg: 83.8221, decDeg: -5.3911, color: ALTITUDE_TARGET_COLORS[1] },
  { id: "dso:M45", nameJa: "M45 すばる", kind: "dso", raDeg: 56.75, decDeg: 24.1167, color: ALTITUDE_TARGET_COLORS[2] },
  { id: "jupiter", nameJa: "木星", kind: "planet", raDeg: 75, decDeg: 22, color: ALTITUDE_TARGET_COLORS[3] },
];

function parseLandscapeFields(
  p: Partial<LandscapeConfig>,
  preset: LandscapeConfig["preset"],
): LandscapeConfig {
  const validMask =
    p.maskMode === "auto_sky_key" ||
    p.maskMode === "horizon_cut" ||
    p.maskMode === "alpha_only"
      ? p.maskMode
      : DEFAULT_LANDSCAPE_CONFIG.maskMode;
  return {
    preset,
    azOffsetDeg:
      typeof p.azOffsetDeg === "number" && Number.isFinite(p.azOffsetDeg)
        ? Math.max(-180, Math.min(180, p.azOffsetDeg))
        : DEFAULT_LANDSCAPE_CONFIG.azOffsetDeg,
    altOffsetDeg:
      typeof p.altOffsetDeg === "number" && Number.isFinite(p.altOffsetDeg)
        ? Math.max(-20, Math.min(20, p.altOffsetDeg))
        : DEFAULT_LANDSCAPE_CONFIG.altOffsetDeg,
    opacity:
      typeof p.opacity === "number" && Number.isFinite(p.opacity)
        ? Math.max(0.1, Math.min(1, p.opacity))
        : DEFAULT_LANDSCAPE_CONFIG.opacity,
    nightDimming:
      typeof p.nightDimming === "boolean"
        ? p.nightDimming
        : DEFAULT_LANDSCAPE_CONFIG.nightDimming,
    maskMode: validMask,
    skyKeyThreshold:
      typeof p.skyKeyThreshold === "number" && Number.isFinite(p.skyKeyThreshold)
        ? Math.max(8, Math.min(90, p.skyKeyThreshold))
        : DEFAULT_LANDSCAPE_CONFIG.skyKeyThreshold,
    customFileName: typeof p.customFileName === "string" ? p.customFileName : null,
  };
}

function loadLandscapeConfig(): LandscapeConfig {
  if (typeof window === "undefined") return { ...DEFAULT_LANDSCAPE_CONFIG };
  try {
    const raw = window.localStorage.getItem(LANDSCAPE_STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<LandscapeConfig>;
      const validPreset =
        p.preset === "veil" ||
        p.preset === "mountain" ||
        p.preset === "coast" ||
        p.preset === "observatory" ||
        p.preset === "desert" ||
        p.preset === "custom"
          ? p.preset
          : DEFAULT_LANDSCAPE_CONFIG.preset;
      return parseLandscapeFields(p, validPreset);
    }
    const legacyRaw = window.localStorage.getItem(LEGACY_LANDSCAPE_STORAGE_KEY);
    if (!legacyRaw) return { ...DEFAULT_LANDSCAPE_CONFIG };
    const lp = JSON.parse(legacyRaw) as Partial<LandscapeConfig>;
    const migratedPreset =
      lp.preset === "custom" && typeof lp.customFileName === "string"
        ? "custom"
        : DEFAULT_LANDSCAPE_CONFIG.preset;
    const migrated = parseLandscapeFields(lp, migratedPreset);
    persistLandscapeConfig(migrated);
    return migrated;
  } catch {
    return { ...DEFAULT_LANDSCAPE_CONFIG };
  }
}

function persistLandscapeConfig(cfg: LandscapeConfig): void {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(LANDSCAPE_STORAGE_KEY, JSON.stringify(cfg));
  }
}

function loadMeteorAnimPref(): boolean {
  if (typeof window === "undefined") return true;
  const raw = window.localStorage.getItem(METEOR_ANIM_STORAGE_KEY);
  return raw === null ? true : raw === "1";
}

function persistMeteorAnimPref(on: boolean): void {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(METEOR_ANIM_STORAGE_KEY, on ? "1" : "0");
  }
}

function loadFovPresets(): FovPreset[] {
  const def = defaultFovPresets();
  if (typeof window === "undefined") return def;
  try {
    const raw = window.localStorage.getItem(FOV_STORAGE_KEY);
    if (!raw) return def;
    const parsed = JSON.parse(raw) as FovPreset[];
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : def;
  } catch {
    return def;
  }
}

function persistFovPresets(list: FovPreset[]): void {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(FOV_STORAGE_KEY, JSON.stringify(list));
  }
}

function loadOfflineMode(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(OFFLINE_STORAGE_KEY) === "1";
}

function loadWeatherCloudsPref(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(WEATHER_CLOUDS_STORAGE_KEY) === "1";
}

function loadStartupObsPref(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(STARTUP_OBS_STORAGE_KEY) === "1";
}

function loadStartupDemoPref(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(STARTUP_DEMO_STORAGE_KEY) === "1";
}

function loadUnitPrefs(): { unitSystem: UnitSystem; angleFormat: AngleFormat } {
  if (typeof window === "undefined") return { unitSystem: "metric", angleFormat: "dms" };
  try {
    const raw = window.localStorage.getItem(UNITS_STORAGE_KEY);
    if (!raw) return { unitSystem: "metric", angleFormat: "dms" };
    const parsed = JSON.parse(raw) as Partial<{ unitSystem: UnitSystem; angleFormat: AngleFormat }>;
    return {
      unitSystem: parsed.unitSystem === "imperial" ? "imperial" : "metric",
      angleFormat: parsed.angleFormat === "deg" ? "deg" : "dms",
    };
  } catch {
    return { unitSystem: "metric", angleFormat: "dms" };
  }
}

function persistUnitPrefs(unitSystem: UnitSystem, angleFormat: AngleFormat): void {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(UNITS_STORAGE_KEY, JSON.stringify({ unitSystem, angleFormat }));
  }
}

const TRAIL_COLORS: Record<string, { label: string; color: string }> = {
  sun: { label: "太陽", color: "#fbbf24" },
  moon: { label: "月", color: "#e2e8f0" },
  mercury: { label: "水星", color: "#94a3b8" },
  venus: { label: "金星", color: "#fef08a" },
  mars: { label: "火星", color: "#fb7154" },
  jupiter: { label: "木星", color: "#fdba74" },
  saturn: { label: "土星", color: "#fde68a" },
};

export function nowUtcJd(): number {
  return 2440587.5 + Date.now() / 86400000;
}

/** Convert calendar `(year, month, day, hour, minute, second)` in local TZ to UT Julian Day. */
export function localYmdHmsToJdUt(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  tzOffsetMin: number,
): number {
  let y = year;
  let m = month;
  if (m <= 2) {
    y -= 1;
    m += 12;
  }
  const dayFrac = day + (hour + (minute + second / 60) / 60) / 24;
  const isGregorian =
    year > 1582 || (year === 1582 && (month > 10 || (month === 10 && day >= 15)));
  let b = 0;
  if (isGregorian) {
    const a = Math.floor(y / 100);
    b = 2 - a + Math.floor(a / 4);
  }
  const jdLocal =
    Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + dayFrac + b - 1524.5;
  return jdLocal - tzOffsetMin / 1440;
}

function toFloat32Buffer(raw: unknown): Float32Array {
  if (raw instanceof ArrayBuffer) {
    return new Float32Array(raw);
  }
  if (raw instanceof Uint8Array) {
    return new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4));
  }
  if (Array.isArray(raw)) {
    const u8 = new Uint8Array(raw);
    return new Float32Array(u8.buffer);
  }
  return new Float32Array(0);
}

function loadSavedColors(): { preset: ColorPresetId | "custom"; colors: CustomColorPalette } {
  const def = COLOR_PRESETS[0];
  if (typeof window === "undefined") {
    return { preset: def.id, colors: { ...def.colors } };
  }
  try {
    const raw = window.localStorage.getItem(COLORS_STORAGE_KEY);
    if (!raw) return { preset: def.id, colors: { ...def.colors } };
    const parsed = JSON.parse(raw) as {
      preset?: ColorPresetId | "custom";
      colors?: Partial<CustomColorPalette>;
    };
    return {
      preset: parsed.preset ?? def.id,
      colors: { ...def.colors, ...(parsed.colors ?? {}) },
    };
  } catch {
    return { preset: def.id, colors: { ...def.colors } };
  }
}

function loadSavedLocations(presets: LocationPreset[]): LocationPreset[] {
  if (typeof window === "undefined") return presets;
  try {
    const raw = window.localStorage.getItem(LOCATIONS_STORAGE_KEY);
    if (!raw) return presets;
    const saved = JSON.parse(raw) as LocationPreset[];
    if (!Array.isArray(saved) || saved.length === 0) return presets;
    return saved;
  } catch {
    return presets;
  }
}

function persistLocations(list: LocationPreset[]): void {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(LOCATIONS_STORAGE_KEY, JSON.stringify(list));
  }
}

export interface SkyState {
  initialized: boolean;
  loading: boolean;
  error: string | null;
  staticAssets: SkyStaticAssets | null;
  baseStarBuffer: Float32Array | null;
  starBuffer: Float32Array | null;
  starCount: number;
  dsoBuffer: Float32Array | null;
  dsoCount: number;
  skyFrame: SkyFrame | null;
  location: LocationPreset;
  locationsList: LocationPreset[];
  jdUt: number;
  projectionMode: ProjectionMode;
  viewMode: SkyViewMode;
  observerBody: ObserverBodyId;
  originStarHip: number;
  centerAzDeg: number;
  centerAltDeg: number;
  centerRaDeg: number;
  centerDecDeg: number;
  fovDeg: number;
  zoom: number;
  limitingMag: number;
  skyRealismLevel: number;
  refractionEnabled: boolean;
  showBelowHorizon: boolean;
  layers: SkyLayerVisibility;
  colorPreset: ColorPresetId | "custom";
  customColors: CustomColorPalette;
  selectedObject: PickedObject | null;
  selectedObjectDetails: ObjectDetails | null;
  picking: boolean;
  activePanel: ActivePanelId;
  openPanels: Exclude<ActivePanelId, null>[];
  commandPaletteOpen: boolean;
  leftDockCollapsed: boolean;
  searchInitialTab: "name" | "gallery" | "nearby";
  nearbyTarget: { name: string; raDeg: number; decDeg: number } | null;
  showObservationOnStartup: boolean;
  startupDemo: boolean;
  unitSystem: UnitSystem;
  angleFormat: AngleFormat;

  // Phase 4
  selectedMeteorShowerCode: string | null;
  meteorAnimationEnabled: boolean;
  meteorShowAllRadiants: boolean;
  meteorRateMultiplier: number;

  // Horizon Panorama Landscape & Altitude Graph Planner
  landscapeConfig: LandscapeConfig;
  landscapeVersion: number;
  hipsConfig: HipsSurveyConfig;
  planet3dBodyId: string | null;
  altitudeTargets: AltitudeTargetItem[];

  // Planet Analysis Tracks (Phase 5)
  planetTracks: Record<string, PlanetTrackOverlay>;

  // Registered Comets (Phase 7 SQLite)
  comets: CometWithEphemeris[];
  cometsVersion: number;

  // Phase 8: FOV Overlay, Satellites/ISS, Offline Mode
  fovPresets: FovPreset[];
  showSatellites: boolean;
  satellites: SatelliteSkyPos[];
  satellitesVersion: number;
  highlightedSatPass: SatellitePass | null;
  offlineMode: boolean;
  liveWeather: NightWeatherForecast | null;
  showWeatherCloudsOverlay: boolean;
  liveSpaceWeather: SpaceWeatherSnapshot | null;

  // Simulation & Timeline
  simPlaying: boolean;
  simDirection: 1 | -1;
  simTarget: SimulationTarget;
  simStepMinutes: number;
  simLatStepDeg: number;
  simAzStepDeg: number;
  simLockMode: SimulationLockMode;
  simLockTargetId: string;
  autoRunRealtime: boolean;
  trailEnabled: boolean;
  trails: Record<string, ObjectTrail>;

  // Mobile / Tablet Sensors (GPS & Gyroscope/Compass)
  gyroEnabled: boolean;
  gyroAzOffsetDeg: number;
  gyroStatus: string | null;
  gpsLoading: boolean;
  gpsStatus: string | null;

  initSky: () => Promise<void>;
  refreshFrame: (nightVisionOverride?: boolean) => Promise<void>;
  reloadStarBufferForMode: () => Promise<void>;
  setLocation: (loc: LocationPreset) => void;
  setLatitudeDirect: (latDeg: number) => void;
  addLocation: (loc: Omit<LocationPreset, "id" | "is_default">) => void;
  updateLocation: (loc: LocationPreset) => void;
  deleteLocation: (id: string) => void;
  reorderLocations: (fromIdx: number, toIdx: number) => void;
  resetLocationsToPresets: () => void;

  setProjectionMode: (mode: ProjectionMode) => void;
  setViewMode: (mode: SkyViewMode) => void;
  setObserverBody: (body: ObserverBodyId) => void;
  setOriginStarHip: (hip: number) => void;

  stepTimeMinutes: (deltaMinutes: number) => void;
  setNow: () => void;
  jumpToJdUt: (jdUt: number) => void;
  jumpToYmdHms: (y: number, m: number, d: number, hh: number, mm: number, ss: number) => void;

  lookAtDirection: (azDeg: number, altDeg: number) => void;
  centerOnSkyCoords: (raDeg: number, decDeg: number, azDeg?: number, altDeg?: number) => void;
  panByPixels: (dx: number, dy: number, width: number, height: number) => void;
  setGyroEnabled: (enabled: boolean) => void;
  setGyroAzOffsetDeg: (deg: number) => void;
  setGyroStatus: (status: string | null) => void;
  applyGyroDirection: (azDeg: number, altDeg: number) => void;
  acquireGpsLocation: () => Promise<void>;
  zoomBy: (factor: number) => void;
  setZoomMultiplier: (mult: number) => void;
  resetView: () => void;

  setLimitingMag: (mag: number) => void;
  setSkyRealismLevel: (level: number) => void;
  setRefractionEnabled: (enabled: boolean) => void;
  setShowBelowHorizon: (show: boolean) => void;
  setConstellationLineMode: (mode: ConstellationLineMode) => void;
  toggleLayer: (key: Exclude<keyof SkyLayerVisibility, "constellationLines">) => void;
  applyColorPreset: (id: ColorPresetId) => void;
  setCustomColor: (key: keyof CustomColorPalette, hex: string) => void;

  pickAtScreen: (x: number, y: number, width: number, height: number) => Promise<void>;
  selectObject: (obj: PickedObject, center?: boolean) => void;
  fetchSelectedDetails: () => Promise<void>;
  clearSelection: () => void;

  setActivePanel: (panel: ActivePanelId) => void;
  togglePanel: (panel: Exclude<ActivePanelId, null>) => void;
  openPanel: (panel: Exclude<ActivePanelId, null>) => void;
  closePanel: (panel: Exclude<ActivePanelId, null>) => void;
  focusPanel: (panel: Exclude<ActivePanelId, null>) => void;
  closeAllPanels: () => void;
  setCommandPaletteOpen: (open: boolean) => void;
  setLeftDockCollapsed: (collapsed: boolean) => void;
  openNearbySearch: (name: string, raDeg: number, decDeg: number) => void;
  setSearchInitialTab: (tab: "name" | "gallery" | "nearby") => void;
  setShowObservationOnStartup: (on: boolean) => void;
  setSelectedMeteorShower: (code: string | null, centerOnRadiant?: boolean) => void;
  setMeteorAnimationEnabled: (on: boolean) => void;
  setMeteorShowAllRadiants: (on: boolean) => void;
  setMeteorRateMultiplier: (mult: number) => void;
  setLandscapeConfig: (patch: Partial<LandscapeConfig>) => void;
  bumpLandscapeVersion: () => void;
  setHipsConfig: (patch: Partial<HipsSurveyConfig>) => void;
  toggleHipsEnabled: () => void;
  openPlanet3d: (bodyId: string | null) => void;
  addAltitudeTarget: (item: Omit<AltitudeTargetItem, "color"> & { color?: string }) => void;
  removeAltitudeTarget: (id: string) => void;
  clearAltitudeTargets: () => void;
  setPlanetTrack: (track: PlanetTrackOverlay, append: boolean) => void;
  clearPlanetTracks: () => void;
  refreshComets: () => Promise<void>;
  notifyCometsChanged: () => Promise<void>;

  // Phase 8 Actions
  addFovPreset: (preset: Omit<FovPreset, "id">) => void;
  updateFovPreset: (preset: FovPreset) => void;
  deleteFovPreset: (id: string) => void;
  toggleFovPreset: (id: string) => void;
  setFovRotation: (id: string, rotationDeg: number) => void;
  resetFovPresets: () => void;
  setShowSatellites: (on: boolean) => void;
  refreshSatellites: () => Promise<void>;
  notifySatellitesChanged: () => Promise<void>;
  setHighlightedSatPass: (pass: SatellitePass | null) => void;
  setOfflineMode: (offline: boolean) => void;
  setLiveWeather: (weather: NightWeatherForecast | null) => void;
  setShowWeatherCloudsOverlay: (on: boolean) => void;
  setLiveSpaceWeather: (sw: SpaceWeatherSnapshot | null) => void;

  // Phase 9 Actions
  setDefaultLocation: (id: string) => void;
  setStartupDemo: (on: boolean) => void;
  setUnitSystem: (u: UnitSystem) => void;
  setAngleFormat: (f: AngleFormat) => void;
  exportProfileJson: () => string;
  importProfileJson: (raw: string) => { ok: boolean; message: string };
  resetAllSettings: () => void;

  // Simulation controls
  setSimPlaying: (playing: boolean) => void;
  toggleSimPlaying: () => void;
  setSimDirection: (dir: 1 | -1) => void;
  setSimTarget: (target: SimulationTarget) => void;
  setSimStepMinutes: (minutes: number) => void;
  setSimLatStepDeg: (deg: number) => void;
  setSimAzStepDeg: (deg: number) => void;
  setSimLock: (mode: SimulationLockMode, targetId?: string) => void;
  setAutoRunRealtime: (on: boolean) => void;
  setTrailEnabled: (on: boolean) => void;
  clearTrails: () => void;
  advanceSimulationTick: () => Promise<void>;

  buildProjectionParams: (width: number, height: number) => ProjectionParams;
}

let frameRequestSeq = 0;
let bufferRequestSeq = 0;
let simTickInFlight = false;
let activeFrameRequests = 0;
let lastSatFetchMs = 0;
const initialColorState = loadSavedColors();
const initialUnitPrefs = loadUnitPrefs();

export const useSkyStore = create<SkyState>((set, get) => ({
  initialized: false,
  loading: false,
  error: null,
  staticAssets: null,
  baseStarBuffer: null,
  starBuffer: null,
  starCount: 0,
  dsoBuffer: null,
  dsoCount: 0,
  skyFrame: null,
  location: AKASHI_DEFAULT,
  locationsList: [AKASHI_DEFAULT],
  jdUt: nowUtcJd(),
  projectionMode: "free_direction",
  viewMode: "normal",
  observerBody: "Mars",
  originStarHip: 71683,
  centerAzDeg: 180,
  centerAltDeg: 30,
  centerRaDeg: 0,
  centerDecDeg: 20,
  fovDeg: 90,
  zoom: 1,
  limitingMag: 6.5,
  skyRealismLevel: 2,
  refractionEnabled: true,
  showBelowHorizon: false,
  layers: { ...DEFAULT_LAYERS },
  colorPreset: initialColorState.preset,
  customColors: initialColorState.colors,
  selectedObject: null,
  selectedObjectDetails: null,
  picking: false,
  activePanel: null,
  openPanels: [],
  commandPaletteOpen: false,
  leftDockCollapsed: false,
  searchInitialTab: "name",
  nearbyTarget: null,
  showObservationOnStartup: loadStartupObsPref(),
  startupDemo: loadStartupDemoPref(),
  unitSystem: initialUnitPrefs.unitSystem,
  angleFormat: initialUnitPrefs.angleFormat,
  selectedMeteorShowerCode: null,
  meteorAnimationEnabled: loadMeteorAnimPref(),
  meteorShowAllRadiants: false,
  meteorRateMultiplier: 1,
  landscapeConfig: loadLandscapeConfig(),
  landscapeVersion: 0,
  hipsConfig: loadHipsConfig(),
  planet3dBodyId: null,
  altitudeTargets: DEFAULT_ALTITUDE_TARGETS,
  planetTracks: {},
  comets: [],
  cometsVersion: 0,
  fovPresets: loadFovPresets(),
  showSatellites: true,
  satellites: [],
  satellitesVersion: 0,
  highlightedSatPass: null,
  offlineMode: loadOfflineMode(),
  liveWeather: null,
  showWeatherCloudsOverlay: loadWeatherCloudsPref(),
  liveSpaceWeather: null,

  simPlaying: false,
  simDirection: 1,
  simTarget: "time",
  simStepMinutes: 60,
  simLatStepDeg: 1.0,
  simAzStepDeg: 2.0,
  simLockMode: "none",
  simLockTargetId: "mars",
  autoRunRealtime: false,
  trailEnabled: false,
  trails: {},
  gyroEnabled: false,
  gyroAzOffsetDeg: 0,
  gyroStatus: null,
  gpsLoading: false,
  gpsStatus: null,

  buildProjectionParams: (width, height) => {
    const s = get();
    return {
      mode: s.projectionMode,
      width,
      height,
      center_az_deg: s.centerAzDeg,
      center_alt_deg: s.centerAltDeg,
      center_ra_deg: s.centerRaDeg,
      center_dec_deg: s.centerDecDeg,
      fov_deg: s.fovDeg,
      zoom: s.zoom,
      show_below_horizon: s.showBelowHorizon,
    };
  },

  initSky: async () => {
    if (get().initialized || get().loading) return;
    set({ loading: true, error: null });
    try {
      if (isTauri()) {
        const [rawStars, rawDsos, assets] = await Promise.all([
          invoke<ArrayBuffer>("get_sky_star_buffer"),
          invoke<ArrayBuffer>("get_sky_dso_buffer"),
          invoke<SkyStaticAssets>("get_sky_static_assets"),
        ]);
        const starBuffer = toFloat32Buffer(rawStars);
        const dsoBuffer = toFloat32Buffer(rawDsos);
        const mergedLocs = loadSavedLocations(assets.locations);
        const defaultLoc =
          mergedLocs.find((l) => l.is_default) ?? mergedLocs[0] ?? AKASHI_DEFAULT;
        set({
          staticAssets: assets,
          baseStarBuffer: starBuffer,
          starBuffer,
          starCount: Math.floor(starBuffer.length / 5),
          dsoBuffer,
          dsoCount: Math.floor(dsoBuffer.length / 7),
          locationsList: mergedLocs,
          location: defaultLoc,
          initialized: true,
          loading: false,
        });
      } else {
        set({
          locationsList: [AKASHI_DEFAULT],
          initialized: true,
          loading: false,
        });
      }
      if (get().showObservationOnStartup && get().openPanels.length === 0) {
        get().openPanel("observation");
      }
      if (get().startupDemo) {
        set({ autoRunRealtime: true });
      }
      await Promise.all([get().refreshFrame(), get().refreshComets(), get().refreshSatellites()]);
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  reloadStarBufferForMode: async () => {
    const s = get();
    if (!isTauri()) return;
    const seq = ++bufferRequestSeq;

    if (
      s.viewMode === "normal" ||
      s.viewMode === "precession" ||
      s.viewMode === "other_planet"
    ) {
      if (s.baseStarBuffer && s.starBuffer !== s.baseStarBuffer) {
        set({
          starBuffer: s.baseStarBuffer,
          starCount: Math.floor(s.baseStarBuffer.length / 5),
        });
      }
      return;
    }

    try {
      if (s.viewMode === "proper_motion") {
        const yearsFromJ2000 = (s.jdUt - 2451545.0) / 365.25;
        const raw = await invoke<ArrayBuffer>("get_proper_motion_star_buffer", {
          yearsFromJ2000,
          maxMag: 9.0,
        });
        if (seq !== bufferRequestSeq) return;
        const buf = toFloat32Buffer(raw);
        set({ starBuffer: buf, starCount: Math.floor(buf.length / 5) });
      } else if (s.viewMode === "other_star") {
        const raw = await invoke<ArrayBuffer>("get_reprojected_star_buffer", {
          originHip: s.originStarHip,
          maxMag: 9.5,
        });
        if (seq !== bufferRequestSeq) return;
        const buf = toFloat32Buffer(raw);
        set({ starBuffer: buf, starCount: Math.floor(buf.length / 5) });
      }
    } catch (err) {
      if (seq === bufferRequestSeq) {
        set({ error: err instanceof Error ? err.message : String(err) });
      }
    }
  },

  refreshFrame: async (nightVisionOverride) => {
    const seq = ++frameRequestSeq;
    activeFrameRequests += 1;
    const s = get();
    const nightVision =
      nightVisionOverride ?? useThemeStore.getState().theme === "night-vision";
    const req = {
      jd_ut: s.jdUt,
      lat_deg: s.location.lat_deg,
      lon_deg: s.location.lon_deg,
      alt_m: s.location.alt_m,
      tz_offset_min: s.location.tz_offset_min,
      limiting_mag: s.limitingMag,
      realism_level: s.skyRealismLevel,
      night_vision: nightVision,
      refraction: s.refractionEnabled,
      view_mode: s.viewMode,
      observer_body: s.observerBody,
      origin_star_hip: s.originStarHip,
    };

    try {
      const frame = isTauri()
        ? await invoke<SkyFrame>("compute_sky_frame", { req })
        : buildBrowserPreviewFrame(req);
      if (seq !== frameRequestSeq) return;

      // Apply object/constellation camera lock if active
      let patch: Partial<SkyState> = { skyFrame: frame };
      const cur = get();
      if (cur.simLockMode === "planet") {
        const tgt = frame.bodies.find((b) => b.id === cur.simLockTargetId);
        if (tgt) {
          patch = {
            ...patch,
            centerAzDeg: wrapDeg360(tgt.az_deg),
            centerAltDeg: Math.min(89.5, Math.max(-85, tgt.alt_deg)),
            centerRaDeg: tgt.ra_deg,
            centerDecDeg: tgt.dec_deg,
          };
        }
      } else if (cur.simLockMode === "constellation" && cur.staticAssets) {
        const con = cur.staticAssets.constellations.find((c) => c.id === cur.simLockTargetId);
        if (con) {
          const pos = j2000ToHorWithMatrix(
            con.center_ra_deg,
            con.center_dec_deg,
            frame.j2000_to_apparent_matrix,
            cur.location.lat_deg,
            frame.last_deg,
          );
          patch = {
            ...patch,
            centerAzDeg: pos.azDeg,
            centerAltDeg: Math.min(89.5, Math.max(-85, pos.altDeg)),
            centerRaDeg: pos.appRaDeg,
            centerDecDeg: pos.appDecDeg,
          };
        }
      }

      // Append trail samples if Overlay Trails is enabled (capped + deduplicated)
      if (cur.trailEnabled) {
        const nextTrails = { ...cur.trails };
        for (const b of frame.bodies) {
          const style = TRAIL_COLORS[b.id];
          if (!style) continue;
          const prev = nextTrails[b.id];
          const prevPts = prev?.points ?? [];
          const tail = prevPts.length > 0 ? prevPts[prevPts.length - 1] : null;
          if (
            tail &&
            Math.abs(tail.ra_deg - b.ra_deg) < 0.002 &&
            Math.abs(tail.dec_deg - b.dec_deg) < 0.002 &&
            Math.abs(tail.az_deg - b.az_deg) < 0.002 &&
            Math.abs(tail.alt_deg - b.alt_deg) < 0.002
          ) {
            continue;
          }
          const pts = prevPts.length >= 360 ? prevPts.slice(prevPts.length - 359) : [...prevPts];
          pts.push({
            ra_deg: b.ra_deg,
            dec_deg: b.dec_deg,
            az_deg: b.az_deg,
            alt_deg: b.alt_deg,
          });
          nextTrails[b.id] = { id: b.id, label: style.label, color: style.color, points: pts };
        }
        patch.trails = nextTrails;
      }

      set(patch);
      const after = get();
      const nowMs = Date.now();
      if (after.showSatellites && !after.simPlaying && nowMs - lastSatFetchMs >= 1500) {
        lastSatFetchMs = nowMs;
        void after.refreshSatellites();
      }
    } catch (err) {
      if (seq === frameRequestSeq) {
        set({ error: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      activeFrameRequests = Math.max(0, activeFrameRequests - 1);
    }
  },

  setLocation: (location) => {
    set({ location, selectedObject: null, selectedObjectDetails: null });
    void get().refreshFrame();
  },

  setLatitudeDirect: (latDeg) => {
    const clamped = Math.min(89.9, Math.max(-89.9, latDeg));
    set((s) => ({
      location: { ...s.location, lat_deg: clamped },
    }));
    void get().refreshFrame();
  },

  addLocation: (loc) => {
    const id = `custom_${Date.now()}`;
    const entry: LocationPreset = { ...loc, id, is_default: false };
    const next = [...get().locationsList, entry];
    persistLocations(next);
    set({ locationsList: next, location: entry });
    void get().refreshFrame();
  },

  updateLocation: (loc) => {
    const next = get().locationsList.map((l) => (l.id === loc.id ? loc : l));
    persistLocations(next);
    const active = get().location.id === loc.id ? loc : get().location;
    set({ locationsList: next, location: active });
    if (active.id === loc.id) {
      void get().refreshFrame();
    }
  },

  deleteLocation: (id) => {
    const cur = get().locationsList;
    if (cur.length <= 1) return;
    const next = cur.filter((l) => l.id !== id);
    persistLocations(next);
    const nextActive = get().location.id === id ? next[0] : get().location;
    set({ locationsList: next, location: nextActive });
    if (nextActive.id !== get().location.id || get().location.id === nextActive.id) {
      void get().refreshFrame();
    }
  },

  reorderLocations: (fromIdx, toIdx) => {
    const list = [...get().locationsList];
    if (fromIdx < 0 || toIdx < 0 || fromIdx >= list.length || toIdx >= list.length) return;
    const [moved] = list.splice(fromIdx, 1);
    list.splice(toIdx, 0, moved);
    persistLocations(list);
    set({ locationsList: list });
  },

  resetLocationsToPresets: () => {
    const presets = get().staticAssets?.locations ?? [AKASHI_DEFAULT];
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(LOCATIONS_STORAGE_KEY);
    }
    const def = presets.find((l) => l.is_default) ?? presets[0] ?? AKASHI_DEFAULT;
    set({ locationsList: presets, location: def });
    void get().refreshFrame();
  },

  acquireGpsLocation: async () => {
    if (get().gpsLoading) return;
    set({ gpsLoading: true, gpsStatus: "GPS測位中..." });
    try {
      const fix = await requestCurrentGpsPosition();
      const presets = get().staticAssets?.locations ?? get().locationsList;
      const gpsLoc = buildGpsLocationPreset(fix, presets);
      const others = get().locationsList.filter((l) => l.id !== gpsLoc.id);
      const nextList = [gpsLoc, ...others];
      persistLocations(nextList);
      const accText = fix.accuracyM > 0 ? ` (±${Math.round(fix.accuracyM)}m)` : "";
      set({
        locationsList: nextList,
        location: gpsLoc,
        gpsLoading: false,
        gpsStatus: `現在地設定完了: ${gpsLoc.lat_deg.toFixed(4)}°, ${gpsLoc.lon_deg.toFixed(4)}°${accText}`,
        selectedObject: null,
        selectedObjectDetails: null,
      });
      await get().refreshFrame();
    } catch (err) {
      set({
        gpsLoading: false,
        gpsStatus: err instanceof Error ? err.message : String(err),
      });
    }
  },

  setDefaultLocation: (id) => {
    const list = get().locationsList;
    if (!list.some((l) => l.id === id)) return;
    const nextList = list.map((l) => ({ ...l, is_default: l.id === id }));
    persistLocations(nextList);
    const nextLoc = nextList.find((l) => l.id === id) ?? get().location;
    set({ locationsList: nextList, location: nextLoc });
    void get().refreshFrame();
  },

  setProjectionMode: (mode) => {
    const s = get();
    const meta = PROJECTION_META.find((m) => m.mode === mode) ?? PROJECTION_META[0];
    if (mode === "star_chart") {
      const lastDeg = s.skyFrame?.last_deg ?? 0;
      const eq = horizontalToEquatorialFast(
        s.centerAzDeg,
        Math.min(85, Math.max(-20, s.centerAltDeg > 85 ? 45 : s.centerAltDeg)),
        s.location.lat_deg,
        lastDeg,
      );
      set({
        projectionMode: mode,
        centerRaDeg: eq.raDeg,
        centerDecDeg: eq.decDeg,
        fovDeg: meta.defaultFovDeg,
        zoom: 1,
      });
      return;
    }

    const nextAlt =
      mode === "free_direction"
        ? s.projectionMode === "zenith"
          ? 30
          : Math.min(85, Math.max(-10, s.centerAltDeg))
        : meta.defaultAltDeg;
    set({
      projectionMode: mode,
      centerAltDeg: nextAlt,
      fovDeg: meta.defaultFovDeg,
      zoom: 1,
    });
  },

  setViewMode: (viewMode) => {
    set({ viewMode, trails: {} });
    void get().reloadStarBufferForMode();
    void get().refreshFrame();
  },

  setObserverBody: (observerBody) => {
    set({ observerBody, viewMode: "other_planet", trails: {} });
    void get().reloadStarBufferForMode();
    void get().refreshFrame();
  },

  setOriginStarHip: (originStarHip) => {
    set({ originStarHip, viewMode: "other_star", trails: {} });
    void get().reloadStarBufferForMode();
    void get().refreshFrame();
  },

  stepTimeMinutes: (deltaMinutes) => {
    set((s) => ({ jdUt: s.jdUt + deltaMinutes / 1440, autoRunRealtime: false }));
    if (get().viewMode === "proper_motion") {
      void get().reloadStarBufferForMode();
    }
    void get().refreshFrame();
  },

  setNow: () => {
    set({ jdUt: nowUtcJd() });
    if (get().viewMode === "proper_motion") {
      void get().reloadStarBufferForMode();
    }
    void get().refreshFrame();
  },

  jumpToJdUt: (jdUt) => {
    set({ jdUt, autoRunRealtime: false });
    if (get().viewMode === "proper_motion") {
      void get().reloadStarBufferForMode();
    }
    void get().refreshFrame();
    if (get().selectedObject) {
      void get().fetchSelectedDetails();
    }
  },

  jumpToYmdHms: (y, m, d, hh, mm, ss) => {
    const jdUt = localYmdHmsToJdUt(y, m, d, hh, mm, ss, get().location.tz_offset_min);
    get().jumpToJdUt(jdUt);
  },

  setGyroEnabled: (enabled) => {
    const s = get();
    const nextMode =
      enabled && (s.projectionMode === "star_chart" || s.projectionMode === "zenith")
        ? "free_direction"
        : s.projectionMode;
    set({
      gyroEnabled: enabled,
      projectionMode: nextMode,
      gyroStatus: enabled ? "センサー起動中..." : null,
    });
  },

  setGyroAzOffsetDeg: (deg) => {
    set({ gyroAzOffsetDeg: Math.max(-45, Math.min(45, deg)) });
  },

  setGyroStatus: (status) => {
    set({ gyroStatus: status });
  },

  applyGyroDirection: (azDeg, altDeg) => {
    const s = get();
    if (!s.gyroEnabled) return;
    const nextMode =
      s.projectionMode === "star_chart" || s.projectionMode === "zenith"
        ? "free_direction"
        : s.projectionMode;
    set({
      projectionMode: nextMode,
      centerAzDeg: wrapDeg360(azDeg + s.gyroAzOffsetDeg),
      centerAltDeg: Math.min(89.5, Math.max(-85, altDeg)),
    });
  },

  lookAtDirection: (azDeg, altDeg) => {
    const s = get();
    if (s.projectionMode === "star_chart") {
      const lastDeg = s.skyFrame?.last_deg ?? 0;
      const eq = horizontalToEquatorialFast(azDeg, altDeg, s.location.lat_deg, lastDeg);
      set({
        gyroEnabled: false,
        gyroStatus: null,
        centerAzDeg: wrapDeg360(azDeg),
        centerAltDeg: altDeg,
        centerRaDeg: eq.raDeg,
        centerDecDeg: eq.decDeg,
      });
      return;
    }
    const nextMode =
      s.projectionMode === "zenith" && altDeg < 89 ? "free_direction" : s.projectionMode;
    set({
      gyroEnabled: false,
      gyroStatus: null,
      projectionMode: nextMode,
      centerAzDeg: wrapDeg360(azDeg),
      centerAltDeg: Math.min(89.5, Math.max(-85, altDeg)),
    });
  },

  centerOnSkyCoords: (raDeg, decDeg, azDeg, altDeg) => {
    const s = get();
    let targetAz = azDeg;
    let targetAlt = altDeg;
    if (targetAz === undefined || targetAlt === undefined) {
      const frame = s.skyFrame;
      if (frame) {
        const res = j2000ToHorWithMatrix(
          raDeg,
          decDeg,
          [
            [1, 0, 0],
            [0, 1, 0],
            [0, 0, 1],
          ],
          s.location.lat_deg,
          frame.last_deg,
        );
        targetAz = res.azDeg;
        targetAlt = res.altDeg;
      } else {
        targetAz = s.centerAzDeg;
        targetAlt = s.centerAltDeg;
      }
    }
    const needShowBelow = targetAlt < 0 ? true : s.showBelowHorizon;
    const nextMode =
      s.projectionMode === "zenith" && targetAlt < 85 ? "free_direction" : s.projectionMode;
    set({
      projectionMode: nextMode,
      centerAzDeg: wrapDeg360(targetAz),
      centerAltDeg: Math.min(89.5, Math.max(-85, targetAlt)),
      centerRaDeg: wrapDeg360(raDeg),
      centerDecDeg: Math.min(89.5, Math.max(-89.5, decDeg)),
      showBelowHorizon: needShowBelow,
    });
  },

  panByPixels: (dx, dy, width, height) => {
    const s = get();
    if (s.gyroEnabled) {
      set({ gyroEnabled: false, gyroStatus: null });
    }
    const minDim = Math.max(100, Math.min(width, height));
    if (s.projectionMode === "star_chart") {
      const fov = effectiveFovDeg("star_chart", s.fovDeg) / s.zoom;
      const degPerPx = fov / minDim;
      const cosDec = Math.max(0.18, Math.cos((s.centerDecDeg * Math.PI) / 180));
      set({
        centerRaDeg: wrapDeg360(s.centerRaDeg + (dx * degPerPx) / cosDec),
        centerDecDeg: Math.min(89.5, Math.max(-89.5, s.centerDecDeg + dy * degPerPx)),
      });
      return;
    }

    if (
      s.projectionMode === "all_sky" ||
      s.projectionMode === "zenith" ||
      s.projectionMode === "hemisphere_single" ||
      s.projectionMode === "hemisphere_dual"
    ) {
      const rotDeg = (-dx / minDim) * 180;
      set({ centerAzDeg: wrapDeg360(s.centerAzDeg + rotDeg) });
      return;
    }

    if (s.projectionMode === "panorama") {
      const azDeg = wrapDeg360(s.centerAzDeg - dx / (((width * 0.48) / 180) * s.zoom));
      const altDeg = Math.min(
        85,
        Math.max(-60, s.centerAltDeg + dy / (((height * 0.8) / 100) * s.zoom)),
      );
      set({ centerAzDeg: azDeg, centerAltDeg: altDeg });
      return;
    }

    const fov = effectiveFovDeg(s.projectionMode, s.fovDeg) / s.zoom;
    const degPerPx = fov / minDim;
    const cosAlt = Math.max(0.2, Math.cos((s.centerAltDeg * Math.PI) / 180));
    set({
      centerAzDeg: wrapDeg360(s.centerAzDeg - (dx * degPerPx) / cosAlt),
      centerAltDeg: Math.min(89.5, Math.max(-85, s.centerAltDeg + dy * degPerPx)),
    });
  },

  zoomBy: (factor) => {
    const s = get();
    if (
      s.projectionMode === "all_sky" ||
      s.projectionMode === "hemisphere_single" ||
      s.projectionMode === "hemisphere_dual" ||
      s.projectionMode === "panorama"
    ) {
      set({ zoom: Math.min(8, Math.max(0.5, s.zoom * factor)) });
      return;
    }
    const nextFov = effectiveFovDeg(s.projectionMode, s.fovDeg / factor);
    set({ fovDeg: nextFov });
  },

  setZoomMultiplier: (mult) => {
    const s = get();
    const meta = PROJECTION_META.find((m) => m.mode === s.projectionMode) ?? PROJECTION_META[0];
    if (
      s.projectionMode === "all_sky" ||
      s.projectionMode === "hemisphere_single" ||
      s.projectionMode === "hemisphere_dual" ||
      s.projectionMode === "panorama"
    ) {
      set({ zoom: Math.min(8, Math.max(0.5, mult)) });
      return;
    }
    set({
      zoom: 1,
      fovDeg: effectiveFovDeg(s.projectionMode, meta.defaultFovDeg / mult),
    });
  },

  resetView: () => {
    const s = get();
    const meta = PROJECTION_META.find((m) => m.mode === s.projectionMode) ?? PROJECTION_META[0];
    set({
      centerAzDeg: 180,
      centerAltDeg: meta.mode === "free_direction" ? 30 : meta.defaultAltDeg,
      fovDeg: meta.defaultFovDeg,
      zoom: 1,
    });
  },

  setLimitingMag: (limitingMag) => {
    set({ limitingMag });
    void get().refreshFrame();
  },

  setSkyRealismLevel: (skyRealismLevel) => {
    set({ skyRealismLevel });
    void get().refreshFrame();
  },

  setRefractionEnabled: (refractionEnabled) => {
    set({ refractionEnabled });
    void get().refreshFrame();
  },

  setShowBelowHorizon: (showBelowHorizon) => {
    set({ showBelowHorizon });
  },

  setConstellationLineMode: (mode) => {
    set((s) => ({ layers: { ...s.layers, constellationLines: mode } }));
  },

  toggleLayer: (key) => {
    set((s) => ({
      layers: { ...s.layers, [key]: !s.layers[key] },
    }));
  },

  applyColorPreset: (id) => {
    const found = COLOR_PRESETS.find((p) => p.id === id) ?? COLOR_PRESETS[0];
    const colors = { ...found.colors };
    if (typeof window !== "undefined") {
      window.localStorage.setItem(
        COLORS_STORAGE_KEY,
        JSON.stringify({ preset: id, colors }),
      );
    }
    set({ colorPreset: id, customColors: colors });
  },

  setCustomColor: (key, hex) => {
    const colors = { ...get().customColors, [key]: hex };
    if (typeof window !== "undefined") {
      window.localStorage.setItem(
        COLORS_STORAGE_KEY,
        JSON.stringify({ preset: "custom", colors }),
      );
    }
    set({ colorPreset: "custom", customColors: colors });
  },

  pickAtScreen: async (x, y, width, height) => {
    const s = get();
    if (!isTauri()) return;
    set({ picking: true });
    try {
      const proj = s.buildProjectionParams(width, height);
      const effFov = effectiveFovDeg(s.projectionMode, s.fovDeg) / s.zoom;
      const searchRadiusDeg = Math.min(3.5, Math.max(0.35, effFov / 34));
      const picked = await invoke<PickedObject | null>("pick_sky_object", {
        req: {
          x,
          y,
          projection: proj,
          jd_ut: s.jdUt,
          lat_deg: s.location.lat_deg,
          lon_deg: s.location.lon_deg,
          alt_m: s.location.alt_m,
          tz_offset_min: s.location.tz_offset_min,
          limiting_mag: s.limitingMag,
          refraction: s.refractionEnabled,
          search_radius_deg: searchRadiusDeg,
        },
      });
      set({ selectedObject: picked, selectedObjectDetails: null, picking: false });
      if (picked) {
        void get().fetchSelectedDetails();
      }
    } catch {
      set({ picking: false });
    }
  },

  selectObject: (obj, center = true) => {
    set({ selectedObject: obj, selectedObjectDetails: null });
    if (center) {
      get().centerOnSkyCoords(obj.ra_deg, obj.dec_deg, obj.az_deg, obj.alt_deg);
    }
    void get().fetchSelectedDetails();
  },

  fetchSelectedDetails: async () => {
    const s = get();
    const obj = s.selectedObject;
    if (!obj || !isTauri()) return;
    try {
      const details = await invoke<ObjectDetails>("get_object_details", {
        req: {
          kind: obj.kind,
          id: obj.id,
          ra_deg: obj.ra_deg,
          dec_deg: obj.dec_deg,
          jd_ut: s.jdUt,
          lat_deg: s.location.lat_deg,
          lon_deg: s.location.lon_deg,
          alt_m: s.location.alt_m,
          tz_offset_min: s.location.tz_offset_min,
        },
      });
      if (get().selectedObject?.id === obj.id) {
        set({ selectedObjectDetails: details });
      }
    } catch {
      // Ignore transient detail fetch failure
    }
  },

  clearSelection: () => set({ selectedObject: null, selectedObjectDetails: null }),

  setActivePanel: (activePanel) =>
    set((s) => {
      if (activePanel === null) {
        if (s.openPanels.length === 0) return { activePanel: null, openPanels: [] };
        const next = s.openPanels.slice(0, -1);
        return {
          openPanels: next,
          activePanel: next[next.length - 1] ?? null,
        };
      }
      const next = [...s.openPanels.filter((p) => p !== activePanel), activePanel];
      return {
        openPanels: next,
        activePanel,
      };
    }),
  togglePanel: (panel) =>
    set((s) => {
      const exists = s.openPanels.includes(panel);
      const next = exists
        ? s.openPanels.filter((p) => p !== panel)
        : [...s.openPanels, panel];
      return {
        openPanels: next,
        activePanel: next[next.length - 1] ?? null,
      };
    }),
  openPanel: (panel) =>
    set((s) => {
      const next = [...s.openPanels.filter((p) => p !== panel), panel];
      return {
        openPanels: next,
        activePanel: panel,
      };
    }),
  closePanel: (panel) =>
    set((s) => {
      const next = s.openPanels.filter((p) => p !== panel);
      return {
        openPanels: next,
        activePanel: next[next.length - 1] ?? null,
      };
    }),
  focusPanel: (panel) =>
    set((s) => {
      if (!s.openPanels.includes(panel)) return {};
      if (s.openPanels[s.openPanels.length - 1] === panel) {
        return s.activePanel === panel ? {} : { activePanel: panel };
      }
      const next = [...s.openPanels.filter((p) => p !== panel), panel];
      return {
        openPanels: next,
        activePanel: panel,
      };
    }),
  closeAllPanels: () => set({ openPanels: [], activePanel: null }),
  setCommandPaletteOpen: (commandPaletteOpen) => set({ commandPaletteOpen }),
  setLeftDockCollapsed: (leftDockCollapsed) => set({ leftDockCollapsed }),
  openNearbySearch: (name, raDeg, decDeg) =>
    set((s) => {
      const next = [...s.openPanels.filter((p) => p !== "search"), "search" as const];
      return {
        openPanels: next,
        activePanel: "search",
        searchInitialTab: "nearby",
        nearbyTarget: { name, raDeg, decDeg },
      };
    }),
  setSearchInitialTab: (searchInitialTab) => set({ searchInitialTab }),
  setShowObservationOnStartup: (showObservationOnStartup) => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STARTUP_OBS_STORAGE_KEY, showObservationOnStartup ? "1" : "0");
    }
    set({ showObservationOnStartup });
  },
  setSelectedMeteorShower: (code, centerOnRadiant = false) => {
    set({ selectedMeteorShowerCode: code });
    if (centerOnRadiant && code) {
      const s = get();
      const sh = s.staticAssets?.meteor_showers.find((m) => m.code === code);
      if (sh) {
        set((prev) => ({
          layers: { ...prev.layers, meteorRadiants: true },
        }));
        get().centerOnSkyCoords(sh.ra_deg, sh.dec_deg);
      }
    }
  },
  setMeteorAnimationEnabled: (meteorAnimationEnabled) => {
    persistMeteorAnimPref(meteorAnimationEnabled);
    set({ meteorAnimationEnabled });
  },
  setMeteorShowAllRadiants: (meteorShowAllRadiants) => set({ meteorShowAllRadiants }),
  setMeteorRateMultiplier: (meteorRateMultiplier) => set({ meteorRateMultiplier }),
  setLandscapeConfig: (patch) =>
    set((s) => {
      const next = { ...s.landscapeConfig, ...patch };
      persistLandscapeConfig(next);
      return { landscapeConfig: next };
    }),
  bumpLandscapeVersion: () => set((s) => ({ landscapeVersion: s.landscapeVersion + 1 })),
  setHipsConfig: (patch) =>
    set((s) => {
      const next = { ...s.hipsConfig, ...patch };
      persistHipsConfig(next);
      return { hipsConfig: next };
    }),
  toggleHipsEnabled: () =>
    set((s) => {
      const next = { ...s.hipsConfig, enabled: !s.hipsConfig.enabled };
      persistHipsConfig(next);
      return { hipsConfig: next };
    }),
  openPlanet3d: (planet3dBodyId) => set({ planet3dBodyId }),
  setLiveWeather: (liveWeather) => set({ liveWeather }),
  setShowWeatherCloudsOverlay: (showWeatherCloudsOverlay) => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(WEATHER_CLOUDS_STORAGE_KEY, showWeatherCloudsOverlay ? "1" : "0");
    }
    set({ showWeatherCloudsOverlay });
  },
  setLiveSpaceWeather: (liveSpaceWeather) => set({ liveSpaceWeather }),
  addAltitudeTarget: (item) =>
    set((s) => {
      if (s.altitudeTargets.some((t) => t.id === item.id)) {
        return { altitudeTargets: s.altitudeTargets };
      }
      const nextColor =
        item.color ??
        ALTITUDE_TARGET_COLORS[s.altitudeTargets.length % ALTITUDE_TARGET_COLORS.length];
      const nextList = [...s.altitudeTargets, { ...item, color: nextColor }];
      if (nextList.length > 8) {
        nextList.shift();
      }
      return { altitudeTargets: nextList };
    }),
  removeAltitudeTarget: (id) =>
    set((s) => ({
      altitudeTargets: s.altitudeTargets.filter((t) => t.id !== id),
    })),
  clearAltitudeTargets: () => set({ altitudeTargets: [] }),
  setPlanetTrack: (track, append) =>
    set((s) => ({
      planetTracks: append
        ? { ...s.planetTracks, [track.id]: track }
        : { [track.id]: track },
    })),
  clearPlanetTracks: () => set({ planetTracks: {} }),

  refreshComets: async () => {
    if (!isTauri()) return;
    const s = get();
    try {
      const list = await invoke<CometWithEphemeris[]>("list_comets_cmd", {
        req: {
          jd_ut: s.jdUt,
          lat_deg: s.location.lat_deg,
          lon_deg: s.location.lon_deg,
          alt_m: s.location.alt_m,
          refraction: s.refractionEnabled,
        },
      });
      set({ comets: list });
    } catch {
      // Ignore transient comet list error
    }
  },

  notifyCometsChanged: async () => {
    set((s) => ({ cometsVersion: s.cometsVersion + 1 }));
    await Promise.all([get().refreshComets(), get().refreshFrame()]);
  },

  addFovPreset: (preset) => {
    const entry: FovPreset = { ...preset, id: `fov_${Date.now()}` };
    const next = [...get().fovPresets, entry];
    persistFovPresets(next);
    set({ fovPresets: next });
  },

  updateFovPreset: (preset) => {
    const next = get().fovPresets.map((p) => (p.id === preset.id ? preset : p));
    persistFovPresets(next);
    set({ fovPresets: next });
  },

  deleteFovPreset: (id) => {
    const next = get().fovPresets.filter((p) => p.id !== id);
    persistFovPresets(next);
    set({ fovPresets: next });
  },

  toggleFovPreset: (id) => {
    const next = get().fovPresets.map((p) => (p.id === id ? { ...p, enabled: !p.enabled } : p));
    persistFovPresets(next);
    set({ fovPresets: next });
  },

  setFovRotation: (id, rotationDeg) => {
    const next = get().fovPresets.map((p) => (p.id === id ? { ...p, rotationDeg } : p));
    persistFovPresets(next);
    set({ fovPresets: next });
  },

  resetFovPresets: () => {
    const def = defaultFovPresets();
    persistFovPresets(def);
    set({ fovPresets: def });
  },

  setShowSatellites: (showSatellites) => {
    set({ showSatellites });
    if (showSatellites) {
      void get().refreshSatellites();
    }
  },

  refreshSatellites: async () => {
    if (!isTauri()) return;
    lastSatFetchMs = Date.now();
    const s = get();
    try {
      const list = await invoke<SatelliteSkyPos[]>("list_satellites_positions_cmd", {
        req: {
          jd_ut: s.jdUt,
          lat_deg: s.location.lat_deg,
          lon_deg: s.location.lon_deg,
          alt_m: s.location.alt_m,
          tz_offset_min: s.location.tz_offset_min,
          refraction: s.refractionEnabled,
        },
      });
      set({ satellites: list });
    } catch {
      // Ignore transient satellite update error
    }
  },

  notifySatellitesChanged: async () => {
    set((s) => ({ satellitesVersion: s.satellitesVersion + 1 }));
    await get().refreshSatellites();
  },

  setHighlightedSatPass: (highlightedSatPass) => set({ highlightedSatPass }),

  setOfflineMode: (offlineMode) => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(OFFLINE_STORAGE_KEY, offlineMode ? "1" : "0");
    }
    clearHipsFailureCache();
    set({ offlineMode });
  },

  setStartupDemo: (startupDemo) => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STARTUP_DEMO_STORAGE_KEY, startupDemo ? "1" : "0");
    }
    set({ startupDemo });
  },

  setUnitSystem: (unitSystem) => {
    const angleFormat = get().angleFormat;
    persistUnitPrefs(unitSystem, angleFormat);
    set({ unitSystem });
  },

  setAngleFormat: (angleFormat) => {
    const unitSystem = get().unitSystem;
    persistUnitPrefs(unitSystem, angleFormat);
    set({ angleFormat });
  },

  exportProfileJson: () => {
    const s = get();
    const clk = useClockStore.getState();
    const theme = useThemeStore.getState().theme;
    const defId = s.locationsList.find((l) => l.is_default)?.id ?? s.location.id;
    const profile: StarCraneProfileV1 = {
      version: 1,
      exportedAt: new Date().toISOString(),
      theme,
      soundEnabled: clk.soundEnabled,
      hourlyChime: clk.hourlyChime,
      clockTheme: clk.clockTheme,
      showObservationOnStartup: s.showObservationOnStartup,
      startupDemo: s.startupDemo,
      offlineMode: s.offlineMode,
      unitSystem: s.unitSystem,
      angleFormat: s.angleFormat,
      defaultLocationId: defId,
      locations: s.locationsList,
      projectionMode: s.projectionMode,
      limitingMag: s.limitingMag,
      skyRealismLevel: s.skyRealismLevel,
      refractionEnabled: s.refractionEnabled,
      showBelowHorizon: s.showBelowHorizon,
      layers: s.layers,
      colorPreset: s.colorPreset,
      customColors: s.customColors,
      fovPresets: s.fovPresets,
    };
    return JSON.stringify(profile, null, 2);
  },

  importProfileJson: (raw) => {
    if (raw.length > 512 * 1024) {
      return { ok: false, message: "プロファイルファイルが大きすぎます（上限 512 KB）。" };
    }
    try {
      const parsed = JSON.parse(raw) as Partial<StarCraneProfileV1>;
      if (!parsed || typeof parsed !== "object" || parsed.version !== 1) {
        return { ok: false, message: "対応していないプロファイル形式です（version: 1 が必要）。" };
      }

      const validTheme: ThemeMode =
        parsed.theme === "night-vision" ? "night-vision" : "dark";
      useThemeStore.getState().setTheme(validTheme);

      const clk = useClockStore.getState();
      if (typeof parsed.soundEnabled === "boolean") {
        clk.setSoundEnabled(parsed.soundEnabled);
      }
      if (
        parsed.hourlyChime === "off" ||
        parsed.hourlyChime === "hourly" ||
        parsed.hourlyChime === "half_hourly"
      ) {
        clk.setHourlyChime(parsed.hourlyChime as HourlyChimeMode);
      }
      if (
        parsed.clockTheme === "starry" ||
        parsed.clockTheme === "observatory" ||
        parsed.clockTheme === "night" ||
        parsed.clockTheme === "light"
      ) {
        clk.setClockTheme(parsed.clockTheme as ClockThemeId);
      }

      const nextShowObs =
        typeof parsed.showObservationOnStartup === "boolean"
          ? parsed.showObservationOnStartup
          : get().showObservationOnStartup;
      const nextDemo =
        typeof parsed.startupDemo === "boolean" ? parsed.startupDemo : get().startupDemo;
      const nextOffline =
        typeof parsed.offlineMode === "boolean" ? parsed.offlineMode : get().offlineMode;
      const nextUnit: UnitSystem =
        parsed.unitSystem === "imperial"
          ? "imperial"
          : parsed.unitSystem === "metric"
            ? "metric"
            : get().unitSystem;
      const nextAngle: AngleFormat =
        parsed.angleFormat === "deg"
          ? "deg"
          : parsed.angleFormat === "dms"
            ? "dms"
            : get().angleFormat;

      let nextLocs = get().locationsList;
      if (Array.isArray(parsed.locations) && parsed.locations.length > 0) {
        const sanitized = parsed.locations.filter(
          (l): l is LocationPreset =>
            Boolean(l) &&
            typeof l.id === "string" &&
            typeof l.name_ja === "string" &&
            Number.isFinite(l.lat_deg) &&
            Number.isFinite(l.lon_deg),
        );
        if (sanitized.length > 0) {
          const defId =
            typeof parsed.defaultLocationId === "string" ? parsed.defaultLocationId : "";
          nextLocs = sanitized.map((l) => ({
            ...l,
            is_default: defId ? l.id === defId : Boolean(l.is_default),
          }));
          persistLocations(nextLocs);
        }
      }
      const nextActiveLoc =
        nextLocs.find((l) => l.is_default) ?? nextLocs[0] ?? get().location;

      const validProj = PROJECTION_META.some((m) => m.mode === parsed.projectionMode)
        ? (parsed.projectionMode as ProjectionMode)
        : get().projectionMode;
      const nextMag =
        typeof parsed.limitingMag === "number" && Number.isFinite(parsed.limitingMag)
          ? Math.max(1.0, Math.min(11.0, parsed.limitingMag))
          : get().limitingMag;
      const nextRealism =
        typeof parsed.skyRealismLevel === "number" && Number.isFinite(parsed.skyRealismLevel)
          ? Math.max(0, Math.min(3, Math.round(parsed.skyRealismLevel)))
          : get().skyRealismLevel;
      const nextRefraction =
        typeof parsed.refractionEnabled === "boolean"
          ? parsed.refractionEnabled
          : get().refractionEnabled;
      const nextBelow =
        typeof parsed.showBelowHorizon === "boolean"
          ? parsed.showBelowHorizon
          : get().showBelowHorizon;
      const nextLayers: SkyLayerVisibility =
        parsed.layers && typeof parsed.layers === "object"
          ? { ...DEFAULT_LAYERS, ...parsed.layers }
          : get().layers;
      const nextColors: CustomColorPalette =
        parsed.customColors && typeof parsed.customColors === "object"
          ? { ...COLOR_PRESETS[0].colors, ...parsed.customColors }
          : get().customColors;
      const nextPreset = parsed.colorPreset ?? get().colorPreset;
      const nextFovPresets =
        Array.isArray(parsed.fovPresets) && parsed.fovPresets.length > 0
          ? parsed.fovPresets
          : get().fovPresets;

      if (typeof window !== "undefined") {
        window.localStorage.setItem(STARTUP_OBS_STORAGE_KEY, nextShowObs ? "1" : "0");
        window.localStorage.setItem(STARTUP_DEMO_STORAGE_KEY, nextDemo ? "1" : "0");
        window.localStorage.setItem(OFFLINE_STORAGE_KEY, nextOffline ? "1" : "0");
        persistUnitPrefs(nextUnit, nextAngle);
        persistFovPresets(nextFovPresets);
        window.localStorage.setItem(
          COLORS_STORAGE_KEY,
          JSON.stringify({ preset: nextPreset, colors: nextColors }),
        );
      }

      set({
        showObservationOnStartup: nextShowObs,
        startupDemo: nextDemo,
        offlineMode: nextOffline,
        unitSystem: nextUnit,
        angleFormat: nextAngle,
        locationsList: nextLocs,
        location: nextActiveLoc,
        projectionMode: validProj,
        limitingMag: nextMag,
        skyRealismLevel: nextRealism,
        refractionEnabled: nextRefraction,
        showBelowHorizon: nextBelow,
        layers: nextLayers,
        colorPreset: nextPreset,
        customColors: nextColors,
        fovPresets: nextFovPresets,
      });
      void get().refreshFrame(validTheme === "night-vision");
      return { ok: true, message: "設定プロファイルを復元しました。" };
    } catch (err) {
      return {
        ok: false,
        message: `JSON解析エラー: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },

  resetAllSettings: () => {
    const defPalette = COLOR_PRESETS[0];
    const defFov = defaultFovPresets();
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(COLORS_STORAGE_KEY);
      window.localStorage.removeItem(STARTUP_OBS_STORAGE_KEY);
      window.localStorage.removeItem(STARTUP_DEMO_STORAGE_KEY);
      window.localStorage.removeItem(UNITS_STORAGE_KEY);
      window.localStorage.removeItem(OFFLINE_STORAGE_KEY);
      window.localStorage.removeItem(FOV_STORAGE_KEY);
      window.localStorage.removeItem(HIPS_STORAGE_KEY);
    }
    useThemeStore.getState().setTheme("dark");
    const clk = useClockStore.getState();
    clk.setSoundEnabled(true);
    clk.setHourlyChime("off");
    clk.setClockTheme("starry");

    set({
      showObservationOnStartup: false,
      startupDemo: false,
      offlineMode: false,
      unitSystem: "metric",
      angleFormat: "dms",
      projectionMode: "free_direction",
      limitingMag: 6.5,
      skyRealismLevel: 2,
      refractionEnabled: true,
      showBelowHorizon: false,
      layers: { ...DEFAULT_LAYERS },
      colorPreset: defPalette.id,
      customColors: { ...defPalette.colors },
      fovPresets: defFov,
      hipsConfig: { ...DEFAULT_HIPS_CONFIG },
      autoRunRealtime: false,
    });
    get().resetLocationsToPresets();
  },

  setSimPlaying: (simPlaying) =>
    set((s) => ({
      simPlaying,
      autoRunRealtime: simPlaying ? false : s.autoRunRealtime,
    })),
  toggleSimPlaying: () => {
    const next = !get().simPlaying;
    set((s) => ({
      simPlaying: next,
      autoRunRealtime: next ? false : s.autoRunRealtime,
    }));
  },
  setSimDirection: (simDirection) => set({ simDirection }),
  setSimTarget: (simTarget) => set({ simTarget }),
  setSimStepMinutes: (simStepMinutes) => set({ simStepMinutes }),
  setSimLatStepDeg: (simLatStepDeg) => set({ simLatStepDeg }),
  setSimAzStepDeg: (simAzStepDeg) => set({ simAzStepDeg }),
  setSimLock: (simLockMode, targetId) => {
    set((s) => ({
      simLockMode,
      simLockTargetId: targetId ?? s.simLockTargetId,
      simStepMinutes:
        (simLockMode === "sunrise" || simLockMode === "sunset") && s.simStepMinutes < 1440
          ? 1440
          : s.simStepMinutes,
    }));
    void get().refreshFrame();
  },
  setAutoRunRealtime: (autoRunRealtime) =>
    set((s) => ({
      autoRunRealtime,
      simPlaying: autoRunRealtime ? false : s.simPlaying,
    })),
  setTrailEnabled: (trailEnabled) =>
    set((s) => ({
      trailEnabled,
      trails: trailEnabled ? s.trails : {},
    })),
  clearTrails: () => set({ trails: {} }),

  advanceSimulationTick: async () => {
    if (simTickInFlight || activeFrameRequests > 0) return;
    simTickInFlight = true;
    try {
      const s = get();
      const dir = s.simDirection;

      if (s.simTarget === "time") {
        if ((s.simLockMode === "sunrise" || s.simLockMode === "sunset") && isTauri()) {
          const days = Math.max(1, Math.round(Math.abs(s.simStepMinutes) / 1440)) * dir;
          const probeJd = s.jdUt + days;
          const times = await invoke<DaySpecialTimes>("get_day_special_times", {
            req: {
              jd_ut: probeJd,
              lat_deg: s.location.lat_deg,
              lon_deg: s.location.lon_deg,
              alt_m: s.location.alt_m,
              tz_offset_min: s.location.tz_offset_min,
            },
          });
          const snapped =
            s.simLockMode === "sunrise" ? times.sunrise_jd_ut : times.sunset_jd_ut;
          set({ jdUt: snapped ?? probeJd });
        } else {
          set({ jdUt: s.jdUt + (dir * s.simStepMinutes) / 1440 });
        }
        if (get().viewMode === "proper_motion") {
          await get().reloadStarBufferForMode();
        }
        await get().refreshFrame();
      } else if (s.simTarget === "latitude") {
        const nextLat = Math.min(89.9, Math.max(-89.9, s.location.lat_deg + dir * s.simLatStepDeg));
        set({ location: { ...s.location, lat_deg: nextLat } });
        await get().refreshFrame();
      } else {
        // Viewpoint panning
        if (s.projectionMode === "star_chart") {
          set({ centerRaDeg: wrapDeg360(s.centerRaDeg + dir * s.simAzStepDeg) });
        } else {
          set({ centerAzDeg: wrapDeg360(s.centerAzDeg + dir * s.simAzStepDeg) });
        }
      }
    } finally {
      simTickInFlight = false;
    }
  },
}));
