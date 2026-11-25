export type ProjectionMode =
  | "free_direction"
  | "all_sky"
  | "hemisphere_single"
  | "hemisphere_dual"
  | "panorama"
  | "star_chart"
  | "horizon_zoom"
  | "mid_sky"
  | "zenith";

export interface ProjectionMeta {
  mode: ProjectionMode;
  index: number;
  labelJa: string;
  shortJa: string;
  descriptionJa: string;
  isEquatorial: boolean;
  defaultAltDeg: number;
  defaultFovDeg: number;
}

export const PROJECTION_META: ProjectionMeta[] = [
  {
    mode: "free_direction",
    index: 1,
    labelJa: "1. 好きな方向",
    shortJa: "好きな方向",
    descriptionJa: "ステレオ投影（方位・高度・視野角を自由操作）",
    isEquatorial: false,
    defaultAltDeg: 30,
    defaultFovDeg: 90,
  },
  {
    mode: "all_sky",
    index: 2,
    labelJa: "2. 全球プラネタリウム",
    shortJa: "全球",
    descriptionJa: "正距方位図法（星座早見盤型の全天円形）",
    isEquatorial: false,
    defaultAltDeg: 90,
    defaultFovDeg: 180,
  },
  {
    mode: "hemisphere_single",
    index: 3,
    labelJa: "3. 半球プラネタリウム（大1個）",
    shortJa: "半球(大1)",
    descriptionJa: "指定方位の半天ドームを大画面1面表示",
    isEquatorial: false,
    defaultAltDeg: 0,
    defaultFovDeg: 180,
  },
  {
    mode: "hemisphere_dual",
    index: 4,
    labelJa: "4. 半球プラネタリウム（小2個）",
    shortJa: "半球(小2)",
    descriptionJa: "対向する2方位（例：南天＋北天）の2面同時表示",
    isEquatorial: false,
    defaultAltDeg: 0,
    defaultFovDeg: 180,
  },
  {
    mode: "panorama",
    index: 5,
    labelJa: "5. 全体表示（パノラマ）",
    shortJa: "全体360°",
    descriptionJa: "全天360°正距円筒パノラマ展開図",
    isEquatorial: false,
    defaultAltDeg: 40,
    defaultFovDeg: 360,
  },
  {
    mode: "star_chart",
    index: 6,
    labelJa: "6. 星図形式（赤経・赤緯）",
    shortJa: "星図",
    descriptionJa: "赤経・赤緯中心の高倍率星図（北が上・東が左）",
    isEquatorial: true,
    defaultAltDeg: 0,
    defaultFovDeg: 60,
  },
  {
    mode: "horizon_zoom",
    index: 7,
    labelJa: "7. 地平線方向拡大",
    shortJa: "地平拡大",
    descriptionJa: "低空（日の出・夕焼け・水星・彗星等）に最適化",
    isEquatorial: false,
    defaultAltDeg: 12,
    defaultFovDeg: 45,
  },
  {
    mode: "mid_sky",
    index: 8,
    labelJa: "8. 空の中ほど",
    shortJa: "中空",
    descriptionJa: "見上げやすい高度30°〜60°の中空域を中心表示",
    isEquatorial: false,
    defaultAltDeg: 45,
    defaultFovDeg: 65,
  },
  {
    mode: "zenith",
    index: 9,
    labelJa: "9. 天頂方向",
    shortJa: "天頂",
    descriptionJa: "真上を見上げた天頂中心のステレオ広角図",
    isEquatorial: false,
    defaultAltDeg: 90,
    defaultFovDeg: 90,
  },
];

export interface ProjectionParams {
  mode: ProjectionMode;
  width: number;
  height: number;
  center_az_deg: number;
  center_alt_deg: number;
  center_ra_deg: number;
  center_dec_deg: number;
  fov_deg: number;
  zoom: number;
  show_below_horizon: boolean;
}

export interface ProjectedPoint {
  x: number;
  y: number;
  panel: number;
  visible: boolean;
}

export interface InversePoint {
  az_deg: number | null;
  alt_deg: number | null;
  ra_deg: number | null;
  dec_deg: number | null;
  panel: number;
}

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface SkyPalette {
  zenith: Rgb;
  mid_sky: Rgb;
  horizon: Rgb;
  sun_glow: Rgb;
  sun_glow_strength: number;
  anti_solar_glow: Rgb;
  anti_solar_strength: number;
  moonlight_glow: Rgb;
  moonlight_strength: number;
  light_pollution: Rgb;
  light_pollution_strength: number;
  ground: Rgb;
  horizon_line: Rgb;
  star_visibility_factor: number;
  estimated_bortle: number;
}

export interface SolarSystemBodyRender {
  id: string;
  kind: "sun" | "moon" | "planet" | "dwarf_planet" | "comet";
  name_ja: string;
  name_en: string;
  ra_deg: number;
  dec_deg: number;
  az_deg: number;
  alt_deg: number;
  geo_au: number;
  helio_au: number;
  visual_magnitude: number;
  angular_diameter_arcsec: number;
  illuminated_fraction: number;
  phase_angle_deg: number;
  elongation_deg: number;
  moon_age_days?: number | null;
  bright_limb_pa_deg?: number | null;
  saturn_ring_tilt_deg?: number | null;
}

export interface LocalDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export type SkyViewMode =
  | "normal"
  | "precession"
  | "proper_motion"
  | "other_planet"
  | "other_star";

export type ObserverBodyId =
  | "Mercury"
  | "Venus"
  | "Moon"
  | "Mars"
  | "Jupiter"
  | "Saturn"
  | "Uranus"
  | "Neptune";

export const OBSERVER_BODIES: { id: ObserverBodyId; labelJa: string; subJa: string }[] = [
  { id: "Moon", labelJa: "月", subJa: "大気なし・地球を望む" },
  { id: "Mars", labelJa: "火星", subJa: "薄いCO₂大気・地球が明けの明星" },
  { id: "Mercury", labelJa: "水星", subJa: "太陽間近・漆黒の宇宙" },
  { id: "Venus", labelJa: "金星", subJa: "厚い雲の黄金色の空" },
  { id: "Jupiter", labelJa: "木星", subJa: "巨大ガス惑星クラウドトップ" },
  { id: "Saturn", labelJa: "土星", subJa: "環を仰ぐ空" },
  { id: "Uranus", labelJa: "天王星", subJa: "横倒しの自転軸" },
  { id: "Neptune", labelJa: "海王星", subJa: "太陽系最遠の蒼い空" },
];

export const OTHER_STAR_PRESETS: {
  hip: number;
  nameJa: string;
  nameEn: string;
  distLy: number;
  spectral: string;
}[] = [
  { hip: 71683, nameJa: "ケンタウルス座α星", nameEn: "Alpha Centauri A", distLy: 4.37, spectral: "G2V" },
  { hip: 32349, nameJa: "シリウス", nameEn: "Sirius", distLy: 8.6, spectral: "A1V" },
  { hip: 37279, nameJa: "プロキオン", nameEn: "Procyon", distLy: 11.46, spectral: "F5IV" },
  { hip: 97649, nameJa: "アルタイル", nameEn: "Altair", distLy: 16.73, spectral: "A7V" },
  { hip: 91262, nameJa: "ベガ", nameEn: "Vega", distLy: 25.04, spectral: "A0V" },
  { hip: 69673, nameJa: "アークトゥルス", nameEn: "Arcturus", distLy: 36.7, spectral: "K1.5III" },
  { hip: 677, nameJa: "アルフェラッツ", nameEn: "Alpheratz", distLy: 97, spectral: "B8IV" },
  { hip: 27989, nameJa: "ベテルギウス", nameEn: "Betelgeuse", distLy: 548, spectral: "M1-2Ia" },
];

export interface PoleTrackPoint {
  year: number;
  ra_deg: number;
  dec_deg: number;
  label: string | null;
}

export interface SolFromStarInfo {
  ra_deg: number;
  dec_deg: number;
  mag: number;
  dist_ly: number;
  origin_name: string;
}

export interface SkyFrameRequest {
  jd_ut?: number | null;
  lat_deg: number;
  lon_deg: number;
  alt_m: number;
  tz_offset_min: number;
  limiting_mag: number;
  realism_level: number;
  night_vision: boolean;
  refraction: boolean;
  view_mode?: SkyViewMode;
  observer_body?: ObserverBodyId;
  origin_star_hip?: number;
}

export interface SkyFrame {
  jd_ut: number;
  jd_tt: number;
  gmst_deg: number;
  lst_deg: number;
  last_deg: number;
  obliquity_deg: number;
  local_dt: LocalDateTimeParts;
  view_mode: SkyViewMode;
  j2000_to_apparent_matrix: number[][];
  j2000_to_enu_override: number[][] | null;
  pole_track_north: PoleTrackPoint[];
  pole_track_south: PoleTrackPoint[];
  sol_from_other_star: SolFromStarInfo | null;
  bodies: SolarSystemBodyRender[];
  sky_palette: SkyPalette;
}

export interface NamedStarAsset {
  hip: number;
  proper_name: string;
  name_ja: string | null;
  bayer: string;
  flam_num: number;
  con: string;
  ra_deg: number;
  dec_deg: number;
  mag: number;
  ci: number;
  dist_pc: number;
}

export interface DsoEntry {
  id: string;
  messier: number | null;
  obj_type: string;
  name_en: string;
  name_ja: string | null;
  constellation: string;
  ra_deg: number;
  dec_deg: number;
  mag: number | null;
  maj_ax_arcmin: number | null;
  min_ax_arcmin: number | null;
  pos_ang_deg: number | null;
}

export interface ConstellationEntry {
  id: string;
  name_la: string;
  name_en: string;
  name_ja: string;
  genitive: string;
  rank: number;
  center_ra_deg: number;
  center_dec_deg: number;
  lines_simple: [number, number][][];
  lines_standard: [number, number][][];
  lines_detailed: [number, number][][];
  bounds: [number, number][][];
}

export interface AsterismEntry {
  id: string;
  name_en: string;
  name_ja: string;
  priority: number;
  lines: [number, number][][];
}

export interface MilkyWayLevel {
  level: string;
  polygons: [number, number][][][];
}

export interface LocationPreset {
  id: string;
  name_ja: string;
  name_en: string;
  country_ja: string;
  region: string;
  lat_deg: number;
  lon_deg: number;
  alt_m: number;
  tz_offset_min: number;
  tz_name: string;
  category: string;
  is_default: boolean;
}

export interface StarGuide {
  hip: number;
  name_ja: string;
  name_en: string;
  constellation: string;
  bayer: string;
  mag: number;
  dist_ly: number;
  spectrum: string;
  summary_ja: string;
  commentary_ja: string;
}

export interface VariableStar {
  id: string;
  name_ja: string;
  name_en: string;
  constellation: string;
  hip: number;
  ra_deg: number;
  dec_deg: number;
  var_type: string;
  mag_max: number;
  mag_min: number;
  period_days: number | null;
  spectrum: string;
  description_ja: string;
}

export interface MeteorShower {
  code: string;
  iau_no: number;
  name_ja: string;
  name_en: string;
  constellation: string;
  active_start: string;
  active_end: string;
  peak_date: string;
  peak_solar_lon_deg: number;
  ra_deg: number;
  dec_deg: number;
  drift_ra_deg: number;
  drift_dec_deg: number;
  velocity_km_s: number;
  zhr: number;
  parent_body: string;
  description_ja: string;
}

export interface ConstellationMyth {
  id: string;
  name_ja: string;
  name_la: string;
  season: string;
  summary: string;
  how_to_find: string;
  mythology: string;
  notable_objects: string[];
}

export interface SkyStaticAssets {
  named_stars: NamedStarAsset[];
  dsos: DsoEntry[];
  constellations: ConstellationEntry[];
  asterisms: AsterismEntry[];
  milky_way: MilkyWayLevel[];
  locations: LocationPreset[];
  meteor_showers: MeteorShower[];
  star_guides: StarGuide[];
  variable_stars: VariableStar[];
  constellation_myths: ConstellationMyth[];
}

export interface PickedObject {
  kind: "sun" | "moon" | "planet" | "dwarf_planet" | "comet" | "star" | "dso";
  id: string;
  name_ja: string;
  name_en: string;
  constellation: string | null;
  mag: number | null;
  ra_deg: number;
  dec_deg: number;
  az_deg: number;
  alt_deg: number;
  dist_text: string;
  angular_sep_deg: number;
  extra_info: string;
}

export type ConstellationLineMode = "off" | "simple" | "standard" | "detailed";

export interface SkyLayerVisibility {
  constellationLines: ConstellationLineMode;
  constellationBoundaries: boolean;
  constellationArtwork: boolean;
  constellationNames: boolean;
  milkyWay: boolean;
  asterisms: boolean;
  ecliptic: boolean;
  celestialEquator: boolean;
  equatorialGrid: boolean;
  horizontalGrid: boolean;
  gridLabels: boolean;
  zenithMark: boolean;
  horizonAndCardinals: boolean;
  starNames: boolean;
  planetNames: boolean;
  dsoMarkers: boolean;
  dsoNames: boolean;
  meteorRadiants: boolean;
  zoomTextures: boolean;
  lunarLabels: boolean;
}

export const DEFAULT_LAYERS: SkyLayerVisibility = {
  constellationLines: "standard",
  constellationBoundaries: false,
  constellationArtwork: false,
  constellationNames: true,
  milkyWay: true,
  asterisms: false,
  ecliptic: true,
  celestialEquator: false,
  equatorialGrid: false,
  horizontalGrid: false,
  gridLabels: true,
  zenithMark: true,
  horizonAndCardinals: true,
  starNames: true,
  planetNames: true,
  dsoMarkers: true,
  dsoNames: true,
  meteorRadiants: false,
  zoomTextures: true,
  lunarLabels: true,
};

export interface DaySpecialTimes {
  date_str: string;
  sunrise_jd_ut: number | null;
  sunrise_str: string | null;
  solar_transit_jd_ut: number | null;
  solar_transit_str: string | null;
  sunset_jd_ut: number | null;
  sunset_str: string | null;
  moonrise_jd_ut: number | null;
  moonrise_str: string | null;
  lunar_transit_jd_ut: number | null;
  lunar_transit_str: string | null;
  moonset_jd_ut: number | null;
  moonset_str: string | null;
  civil_dawn_jd_ut: number | null;
  civil_dawn_str: string | null;
  civil_dusk_jd_ut: number | null;
  civil_dusk_str: string | null;
  nautical_dawn_jd_ut: number | null;
  nautical_dawn_str: string | null;
  nautical_dusk_jd_ut: number | null;
  nautical_dusk_str: string | null;
  astro_dawn_jd_ut: number | null;
  astro_dawn_str: string | null;
  astro_dusk_jd_ut: number | null;
  astro_dusk_str: string | null;
}

export interface AltitudeSample {
  offset_hours: number;
  local_hour: number;
  label: string;
  jd_ut: number;
  alt_deg: number;
  az_deg: number;
  sun_alt_deg: number;
}

export interface ObjectDetails {
  rise_jd_ut: number | null;
  rise_str: string | null;
  transit_jd_ut: number | null;
  transit_str: string | null;
  set_jd_ut: number | null;
  set_str: string | null;
  max_alt_deg: number;
  status: string;
  moon_separation_deg: number;
  elongation_deg: number;
  constellation_ja: string | null;
  spectrum: string | null;
  commentary_ja: string | null;
  how_to_find_ja: string | null;
  altitude_curve: AltitudeSample[];
}

export interface SearchResultItem {
  kind: "sun" | "moon" | "planet" | "dwarf_planet" | "comet" | "star" | "dso" | "constellation";
  id: string;
  name_ja: string;
  name_en: string;
  constellation: string | null;
  obj_type: string;
  mag: number | null;
  ra_deg: number;
  dec_deg: number;
  az_deg: number;
  alt_deg: number;
  extra: string;
}

export interface NearbyObjectItem {
  kind: "sun" | "moon" | "planet" | "dwarf_planet" | "comet" | "star" | "dso";
  id: string;
  name_ja: string;
  name_en: string;
  constellation: string | null;
  obj_type: string;
  mag: number | null;
  angular_sep_deg: number;
  ra_deg: number;
  dec_deg: number;
  az_deg: number;
  alt_deg: number;
}

export interface CustomColorPalette {
  constellationLines: string;
  constellationNames: string;
  constellationBoundaries: string;
  asterisms: string;
  ecliptic: string;
  celestialEquator: string;
  grids: string;
  dso: string;
}

export type ColorPresetId = "classic" | "amber_gold" | "ice_mono" | "high_contrast";

export const COLOR_PRESETS: {
  id: ColorPresetId;
  labelJa: string;
  colors: CustomColorPalette;
}[] = [
  {
    id: "classic",
    labelJa: "標準スターライト",
    colors: {
      constellationLines: "#67b7f5",
      constellationNames: "#7dd3fc",
      constellationBoundaries: "#f472b6",
      asterisms: "#fbbf24",
      ecliptic: "#fbbf24",
      celestialEquator: "#38bdf8",
      grids: "#94a3b8",
      dso: "#c084fc",
    },
  },
  {
    id: "amber_gold",
    labelJa: "クラシック金色",
    colors: {
      constellationLines: "#eab308",
      constellationNames: "#fde047",
      constellationBoundaries: "#f97316",
      asterisms: "#fb923c",
      ecliptic: "#facc15",
      celestialEquator: "#34d399",
      grids: "#a3a3a3",
      dso: "#f472b6",
    },
  },
  {
    id: "ice_mono",
    labelJa: "クール・モノ",
    colors: {
      constellationLines: "#cbd5e1",
      constellationNames: "#e2e8f0",
      constellationBoundaries: "#94a3b8",
      asterisms: "#93c5fd",
      ecliptic: "#bfdbfe",
      celestialEquator: "#7dd3fc",
      grids: "#64748b",
      dso: "#a5b4fc",
    },
  },
  {
    id: "high_contrast",
    labelJa: "くっきり高コントラスト",
    colors: {
      constellationLines: "#38bdf8",
      constellationNames: "#f8fafc",
      constellationBoundaries: "#fb7185",
      asterisms: "#fde047",
      ecliptic: "#fbbf24",
      celestialEquator: "#22d3ee",
      grids: "#cbd5e1",
      dso: "#e879f9",
    },
  },
];

export type SimulationTarget = "time" | "latitude" | "viewpoint";
export type SimulationLockMode = "none" | "constellation" | "planet" | "sunrise" | "sunset";

export interface TrailSample {
  ra_deg: number;
  dec_deg: number;
  az_deg: number;
  alt_deg: number;
}

export interface ObjectTrail {
  id: string;
  label: string;
  color: string;
  points: TrailSample[];
}

export type ActivePanelId =
  | null
  | "display"
  | "time"
  | "simulation"
  | "locations"
  | "search"
  | "observation"
  | "moon_calendar"
  | "meteors"
  | "planets"
  | "solar3d"
  | "eclipses"
  | "comets"
  | "variables"
  | "encyclopedia"
  | "calculator"
  | "clock"
  | "fov"
  | "print"
  | "altitude_graph"
  | "settings";

export interface KyurekiSummary {
  year: number;
  month: number;
  is_leap: boolean;
  day: number;
  label_ja: string;
  rokuyo_ja: string;
}

export interface SunDaySummary {
  rise_jd_ut: number | null;
  rise_str: string | null;
  transit_jd_ut: number | null;
  transit_str: string | null;
  set_jd_ut: number | null;
  set_str: string | null;
  max_alt_deg: number;
  status: string;
  daylight_hours: number;
  civil_dawn_str: string | null;
  civil_dusk_str: string | null;
  nautical_dawn_str: string | null;
  nautical_dusk_str: string | null;
  astro_dawn_jd_ut: number | null;
  astro_dawn_str: string | null;
  astro_dusk_jd_ut: number | null;
  astro_dusk_str: string | null;
  dark_night_hours: number;
  equation_of_time_min: number;
  solar_lon_deg: number;
  ra_deg: number;
  dec_deg: number;
}

export interface MoonDaySummary {
  rise_jd_ut: number | null;
  rise_str: string | null;
  transit_jd_ut: number | null;
  transit_str: string | null;
  set_jd_ut: number | null;
  set_str: string | null;
  max_alt_deg: number;
  status: string;
  moon_age_21h: number;
  moon_age_noon: number;
  illuminated_fraction: number;
  phase_angle_deg: number;
  waxing: boolean;
  bright_limb_pa_deg: number;
  distance_km: number;
  angular_diameter_arcmin: number;
  phase_name_ja: string;
  ra_deg: number;
  dec_deg: number;
}

export interface PlanetDaySummary {
  id: string;
  name_ja: string;
  mag: number;
  elongation_deg: number;
  rise_jd_ut: number | null;
  rise_str: string | null;
  transit_jd_ut: number | null;
  transit_str: string | null;
  set_jd_ut: number | null;
  set_str: string | null;
  alt_21h_deg: number;
  az_21h_deg: number;
  ra_deg: number;
  dec_deg: number;
  visibility_ja: string;
}

export interface DailyPhenomenon {
  kind: string;
  title_ja: string;
  detail_ja: string;
  time_str: string | null;
  jd_ut: number;
  target_ra_deg: number | null;
  target_dec_deg: number | null;
}

export interface ObservationDashboard {
  year: number;
  month: number;
  day: number;
  date_str: string;
  weekday: number;
  weekday_ja: string;
  holiday_ja: string | null;
  solar_term_ja: string | null;
  next_solar_term_ja: string;
  next_solar_term_date: string;
  kyureki: KyurekiSummary;
  sun: SunDaySummary;
  moon: MoonDaySummary;
  planets: PlanetDaySummary[];
  phenomena: DailyPhenomenon[];
}

export interface MoonCalendarDay {
  day: number;
  date_str: string;
  weekday: number;
  jd_ut: number;
  moon_age_days: number;
  illuminated_fraction: number;
  phase_angle_deg: number;
  waxing: boolean;
  bright_limb_pa_deg: number;
  phase_event_ja: string | null;
  phase_event_time: string | null;
  kyureki_label: string;
  kyureki_day: number;
  rokuyo_ja: string;
  solar_term_ja: string | null;
  holiday_ja: string | null;
  moonrise_str: string | null;
  moonset_str: string | null;
  distance_km: number;
}

export interface MoonCalendarMonth {
  year: number;
  month: number;
  days_in_month: number;
  first_weekday: number;
  ref_time_str: string;
  days: MoonCalendarDay[];
}

export interface MeteorShowerYearInfo {
  code: string;
  iau_no: number;
  name_ja: string;
  name_en: string;
  constellation: string;
  constellation_ja: string;
  active_start: string;
  active_end: string;
  peak_date_ref: string;
  peak_jd_ut: number;
  peak_local_str: string;
  best_observe_jd_ut: number;
  peak_solar_lon_deg: number;
  ra_deg: number;
  dec_deg: number;
  current_ra_deg: number;
  current_dec_deg: number;
  current_az_deg: number;
  current_alt_deg: number;
  drift_ra_deg: number;
  drift_dec_deg: number;
  velocity_km_s: number;
  zhr: number;
  parent_body: string;
  description_ja: string;
  is_major_three: boolean;
  is_active_now: boolean;
  days_to_peak: number;
  peak_moon_age_days: number;
  peak_moon_illumination: number;
  peak_moon_phase_ja: string;
  peak_radiant_max_alt_deg: number;
  condition_score: number;
  condition_grade: string;
  condition_note_ja: string;
}

export interface PlanetOverviewItem {
  id: string;
  kind: "sun" | "moon" | "planet" | "dwarf_planet";
  name_ja: string;
  name_en: string;
  ra_deg: number;
  dec_deg: number;
  az_deg: number;
  alt_deg: number;
  mag: number;
  geo_au: number;
  helio_au: number;
  elongation_deg: number;
  phase_angle_deg: number;
  illuminated_fraction: number;
  angular_diameter_arcsec: number;
  saturn_ring_tilt_deg: number | null;
  rise_str: string | null;
  transit_str: string | null;
  set_str: string | null;
  status_ja: string;
}

export interface JupiterPhysicalEphemeris {
  jd_tt: number;
  cm_sys1_deg: number;
  cm_sys2_deg: number;
  cm_sys3_deg: number;
  de_deg: number;
  ds_deg: number;
  phase_angle_deg: number;
  pole_pa_deg: number;
  apparent_eq_diam_arcsec: number;
  grs_sys2_lon_deg: number;
  grs_offset_deg: number;
  grs_visible: boolean;
}

export interface GalileanMoonPosition {
  id: string;
  name_ja: string;
  x_rj: number;
  y_rj: number;
  z_rj: number;
  x_shadow_rj: number;
  y_shadow_rj: number;
  status_ja: string;
  in_front_of_disk: boolean;
  behind_disk: boolean;
  in_eclipse: boolean;
  shadow_on_disk: boolean;
}

export interface GrsTransitEvent {
  jd_ut: number;
  time_str: string;
  cm_sys2_deg: number;
  jupiter_alt_deg: number;
  sun_alt_deg: number;
  observable: boolean;
}

export interface PlanetAppearanceData {
  id: string;
  name_ja: string;
  jd_ut: number;
  ra_deg: number;
  dec_deg: number;
  az_deg: number;
  alt_deg: number;
  mag: number;
  geo_au: number;
  angular_diameter_arcsec: number;
  phase_angle_deg: number;
  illuminated_fraction: number;
  elongation_deg: number;
  waxing: boolean;
  bright_limb_pa_deg: number;
  parallactic_angle_deg: number;
  pole_pa_deg: number | null;
  saturn_ring_tilt_deg: number | null;
  jupiter_phys: JupiterPhysicalEphemeris | null;
  galilean_moons: GalileanMoonPosition[];
  moon_age_days: number | null;
}

export interface PlanetTrackPoint {
  jd_ut: number;
  date_label: string;
  ra_deg: number;
  dec_deg: number;
  az_deg: number;
  alt_deg: number;
  mag: number;
  elongation_deg: number;
  illuminated_fraction: number;
  angular_diameter_arcsec: number;
  waxing: boolean;
  is_retrograde: boolean;
}

export interface PlanetTrackOverlay {
  id: string;
  name_ja: string;
  color: string;
  showInnerShapes: boolean;
  points: PlanetTrackPoint[];
}

export interface InnerPlanetOffsetSample {
  jd_ut: number;
  date_label: string;
  delta_ra_deg: number;
  delta_dec_deg: number;
  elongation_deg: number;
  illuminated_fraction: number;
  angular_diameter_arcsec: number;
  waxing: boolean;
  mag: number;
}

export interface InnerPlanetOffsetResult {
  planet_id: string;
  name_ja: string;
  samples: InnerPlanetOffsetSample[];
}

export interface MagnitudePoint {
  jd_ut: number;
  date_label: string;
  mag: number;
  elongation_deg: number;
  geo_au: number;
}

export interface MagnitudeCurveSeries {
  id: string;
  name_ja: string;
  color: string;
  points: MagnitudePoint[];
}

export interface PlanetaryPhenomenonRow {
  planet_id: string;
  planet_name_ja: string;
  kind: string;
  kind_ja: string;
  jd_ut: number;
  time_str: string;
  ra_deg: number;
  dec_deg: number;
  az_deg: number;
  alt_deg: number;
  mag: number;
  elongation_deg: number;
  detail_ja: string;
}

export interface ConjunctionRow {
  kind: string;
  title_ja: string;
  jd_ut: number;
  time_str: string;
  separation_deg: number;
  ra_deg: number;
  dec_deg: number;
  az_deg: number;
  alt_deg: number;
  bodies: string[];
  detail_ja: string;
}

export interface GalileanWaveSample {
  jd_ut: number;
  time_label: string;
  io_x: number;
  europa_x: number;
  ganymede_x: number;
  callisto_x: number;
}

export interface GalileanViewData {
  jd_ut: number;
  physical: JupiterPhysicalEphemeris;
  moons: GalileanMoonPosition[];
  wave_samples: GalileanWaveSample[];
  grs_transits: GrsTransitEvent[];
}

export interface SaturnPhysicalEphemeris {
  jd_tt: number;
  ring_tilt_earth_deg: number;
  ring_tilt_sun_deg: number;
  north_pole_pa_deg: number;
  phase_angle_deg: number;
  apparent_eq_diam_arcsec: number;
  geo_au: number;
  ring_outer_rs: number;
  cassini_rs: number;
  ring_inner_rs: number;
}

export interface SaturnMoonPosition {
  id: string;
  name_ja: string;
  roman: string;
  mag: number;
  period_days: number;
  x_rs: number;
  y_rs: number;
  z_rs: number;
  separation_arcsec: number;
  pa_deg: number;
  in_transit: boolean;
  in_occultation: boolean;
  in_eclipse: boolean;
  status_ja: string;
}

export interface SaturnWaveSample {
  jd_ut: number;
  time_label: string;
  mimas_x: number;
  enceladus_x: number;
  tethys_x: number;
  dione_x: number;
  rhea_x: number;
  titan_x: number;
  hyperion_x: number;
  iapetus_x: number;
}

export interface TitanElongationEvent {
  jd_ut: number;
  time_str: string;
  direction_ja: string;
  is_east: boolean;
  x_rs: number;
  sep_arcsec: number;
  saturn_alt_deg: number;
  observable: boolean;
}

export interface SaturnMoonsViewData {
  jd_ut: number;
  physical: SaturnPhysicalEphemeris;
  moons: SaturnMoonPosition[];
  wave_samples: SaturnWaveSample[];
  titan_elongations: TitanElongationEvent[];
}

export interface SolarSystem3DBody {
  id: string;
  kind: "star" | "planet" | "moon" | "dwarf_planet" | "comet";
  name_ja: string;
  color: string;
  pos_xyz_au: [number, number, number];
  helio_au: number;
  geo_au: number;
  mag: number;
  elongation_deg: number;
  ra_deg: number;
  dec_deg: number;
  radius_hint: number;
  orbit_xyz_au: [number, number, number][];
}

export interface SolarSystem3DState {
  jd_ut: number;
  bodies: SolarSystem3DBody[];
}

export interface SolarEclipseSample {
  jd_ut: number;
  sun_az_deg: number;
  sun_alt_deg: number;
  moon_dx_arcmin: number;
  moon_dy_arcmin: number;
  local_mag: number;
  sun_radius_arcmin: number;
  moon_radius_arcmin: number;
}

export interface SolarEclipseView {
  global_type: string;
  global_type_ja: string;
  local_type: string;
  local_type_ja: string;
  visible_locally: boolean;
  global_max_jd_ut: number;
  local_max_jd_ut: number;
  date_local_str: string;
  max_time_str: string;
  start_time_str: string | null;
  end_time_str: string | null;
  local_magnitude: number;
  max_obscuration_pct: number;
  max_sun_alt_deg: number;
  max_sun_az_deg: number;
  first_contact_pa_deg: number | null;
  ra_deg: number;
  dec_deg: number;
  path_samples: SolarEclipseSample[];
}

export interface LunarEclipseSample {
  jd_ut: number;
  dx_arcmin: number;
  dy_arcmin: number;
  moon_radius_arcmin: number;
  umbra_radius_arcmin: number;
  penumbra_radius_arcmin: number;
  moon_alt_deg: number;
}

export interface LunarEclipseView {
  eclipse_type: string;
  eclipse_type_ja: string;
  visible_locally: boolean;
  max_jd_ut: number;
  date_local_str: string;
  p1_str: string | null;
  u1_str: string | null;
  u2_str: string | null;
  max_str: string;
  u3_str: string | null;
  u4_str: string | null;
  p4_str: string | null;
  umbral_magnitude: number;
  penumbral_magnitude: number;
  umbra_radius_arcmin: number;
  penumbra_radius_arcmin: number;
  moon_radius_arcmin: number;
  max_moon_alt_deg: number;
  max_moon_az_deg: number;
  ra_deg: number;
  dec_deg: number;
  path_samples: LunarEclipseSample[];
}

export interface TransitChordSample {
  jd_ut: number;
  dx_arcmin: number;
  dy_arcmin: number;
  sun_alt_deg: number;
}

export interface PlanetaryTransitView {
  planet_id: string;
  planet_name_ja: string;
  visible_locally: boolean;
  max_jd_ut: number;
  date_local_str: string;
  c1_str: string | null;
  max_str: string;
  c4_str: string | null;
  min_sep_arcmin: number;
  sun_radius_arcmin: number;
  planet_radius_arcsec: number;
  max_sun_alt_deg: number;
  ra_deg: number;
  dec_deg: number;
  path_samples: TransitChordSample[];
}

export interface LunarOccultationView {
  target_kind: string;
  target_id: string;
  target_name_ja: string;
  mag: number;
  immersion_jd_ut: number;
  max_jd_ut: number;
  emersion_jd_ut: number;
  date_local_str: string;
  immersion_str: string;
  emersion_str: string;
  min_sep_arcmin: number;
  moon_alt_deg: number;
  moon_az_deg: number;
  moon_illum_pct: number;
  sun_alt_deg: number;
  dark_limb_immersion: boolean;
  ra_deg: number;
  dec_deg: number;
}

export interface CometRecord {
  id: string;
  name: string;
  epoch_perihelion_jd: number;
  perihelion_dist_au: number;
  eccentricity: number;
  inclination_deg: number;
  arg_periapsis_deg: number;
  ascending_node_deg: number;
  abs_mag_h: number;
  slope_param_k: number;
  enabled: boolean;
  notes: string;
}

export interface CometWithEphemeris {
  record: CometRecord;
  ra_deg: number;
  dec_deg: number;
  az_deg: number;
  alt_deg: number;
  helio_au: number;
  geo_au: number;
  visual_magnitude: number;
  elongation_deg: number;
  phase_angle_deg: number;
  perihelion_date_str: string;
  orbit_type_ja: string;
}

export interface CalcJdResult {
  jd_ut: number;
  mjd_ut: number;
  jd_tt: number;
  delta_t_sec: number;
  utc_str: string;
  local_str: string;
  weekday_ja: string;
  julian_centuries_j2000: number;
  equation_of_time_min: number;
}

export interface CalcSiderealResult {
  gmst_deg: number;
  gmst_hms: string;
  gast_deg: number;
  gast_hms: string;
  lst_deg: number;
  lst_hms: string;
  last_deg: number;
  last_hms: string;
  hour_angle_deg: number;
  hour_angle_hms: string;
  hours_to_transit: number;
}

export interface CalcElapsedResult {
  diff_days: number;
  diff_hours: number;
  diff_minutes: number;
  diff_seconds: number;
  diff_julian_years: number;
  diff_weeks: number;
  diff_sidereal_hours: number;
  breakdown_text: string;
  shifted_jd_ut: number;
  shifted_local_str: string;
  shifted_utc_str: string;
}

export interface CalcAngDistResult {
  distance_deg: number;
  distance_arcmin: number;
  distance_arcsec: number;
  distance_dms: string;
  position_angle_deg: number;
}

export interface CalcAltTimeResult {
  rising_jd_ut: number | null;
  rising_local_str: string | null;
  setting_jd_ut: number | null;
  setting_local_str: string | null;
  transit_jd_ut: number | null;
  transit_local_str: string | null;
  max_alt_deg: number;
  min_alt_deg: number;
  status_ja: string;
}

export interface CalcEpochConvertResult {
  out_ra_deg: number;
  out_dec_deg: number;
  out_ra_hms: string;
  out_dec_dms: string;
  delta_ra_arcsec: number;
  delta_dec_arcsec: number;
  ecl_lon_deg: number;
  ecl_lat_deg: number;
  gal_l_deg: number;
  gal_b_deg: number;
}

export type FovPresetType = "camera" | "eyepiece" | "binoculars" | "telrad";

export interface FovPreset {
  id: string;
  name: string;
  kind: FovPresetType;
  enabled: boolean;
  color: string;
  rotationDeg: number;
  sensorWidthMm?: number;
  sensorHeightMm?: number;
  focalLengthMm?: number;
  reducerFactor?: number;
  eyepieceFocalMm?: number;
  afovDeg?: number;
  binoMag?: number;
  binoApertureMm?: number;
  binoFieldDeg?: number;
}

export interface SatelliteSkyPos {
  id: string;
  norad_id: number;
  name: string;
  category: string;
  enabled: boolean;
  ra_deg: number;
  dec_deg: number;
  az_deg: number;
  alt_deg: number;
  range_km: number;
  altitude_km: number;
  velocity_km_s: number;
  subpoint_lat_deg: number;
  subpoint_lon_deg: number;
  is_sunlit: boolean;
  is_visible: boolean;
  epoch_age_days: number;
}

export interface SatellitePassPoint {
  jd_ut: number;
  az_deg: number;
  alt_deg: number;
  range_km: number;
  is_sunlit: boolean;
}

export interface SatellitePass {
  sat_id: string;
  sat_name: string;
  norad_id: number;
  aos_jd_ut: number;
  aos_str: string;
  aos_az_deg: number;
  max_jd_ut: number;
  max_str: string;
  max_alt_deg: number;
  max_az_deg: number;
  los_jd_ut: number;
  los_str: string;
  los_az_deg: number;
  duration_sec: number;
  is_sunlit_max: boolean;
  sun_alt_at_max_deg: number;
  is_visible: boolean;
  track: SatellitePassPoint[];
}

export interface OnlineSyncResult {
  source_url: string;
  synced_count: number;
  skipped_count: number;
  summary_ja: string;
}

export interface WeatherHourPoint {
  time_iso: string;
  label: string;
  cloud_cover_pct: number;
  cloud_low_pct: number;
  cloud_mid_pct: number;
  cloud_high_pct: number;
  temp_c: number;
  humidity_pct: number;
  wind_kmh: number;
}

export interface NightWeatherForecast {
  source_url: string;
  lat_deg: number;
  lon_deg: number;
  tonight_avg_cloud_pct: number;
  rating_ja: string;
  hours: WeatherHourPoint[];
}

export type PrintPaperSize = "A4" | "B5";
export type PrintOrientation = "landscape" | "portrait";
export type PrintColorMode = "normal" | "inverted" | "grayscale";

export type UnitSystem = "metric" | "imperial";
export type AngleFormat = "dms" | "deg";

export interface StarCraneProfileV1 {
  version: 1;
  exportedAt: string;
  theme: "dark" | "night-vision";
  soundEnabled: boolean;
  hourlyChime: "off" | "hourly" | "half_hourly";
  clockTheme: "starry" | "observatory" | "night" | "light";
  showObservationOnStartup: boolean;
  startupDemo: boolean;
  offlineMode: boolean;
  unitSystem: UnitSystem;
  angleFormat: AngleFormat;
  defaultLocationId: string;
  locations: LocationPreset[];
  projectionMode: ProjectionMode;
  limitingMag: number;
  skyRealismLevel: number;
  refractionEnabled: boolean;
  showBelowHorizon: boolean;
  layers: SkyLayerVisibility;
  colorPreset: ColorPresetId | "custom";
  customColors: CustomColorPalette;
  fovPresets: FovPreset[];
}

export type LandscapePresetId = "veil" | "mountain" | "coast" | "observatory" | "custom";
export type CustomPanoramaMaskMode = "auto_sky_key" | "horizon_cut" | "alpha_only";

export interface LandscapeConfig {
  preset: LandscapePresetId;
  azOffsetDeg: number;
  altOffsetDeg: number;
  opacity: number;
  nightDimming: boolean;
  maskMode: CustomPanoramaMaskMode;
  skyKeyThreshold: number;
  customFileName: string | null;
}

export const DEFAULT_LANDSCAPE_CONFIG: LandscapeConfig = {
  preset: "mountain",
  azOffsetDeg: 0,
  altOffsetDeg: 0,
  opacity: 0.88,
  nightDimming: true,
  maskMode: "auto_sky_key",
  skyKeyThreshold: 36,
  customFileName: null,
};

export interface AltitudeTargetItem {
  id: string;
  nameJa: string;
  kind: "star" | "dso" | "planet" | "moon" | "sun" | "comet";
  raDeg: number;
  decDeg: number;
  color: string;
}

export type HipsSurveyId = "dss2_color" | "dss2_red" | "2mass_color";

export interface HipsSurveyConfig {
  enabled: boolean;
  surveyId: HipsSurveyId;
  opacity: number;
  maxOrder: number;
}

export const DEFAULT_HIPS_CONFIG: HipsSurveyConfig = {
  enabled: false,
  surveyId: "dss2_color",
  opacity: 0.78,
  maxOrder: 6,
};

export interface SurveyCacheStat {
  survey_id: string;
  tile_count: number;
  bytes: number;
}

export interface OfflineCacheStats {
  hips_tile_count: number;
  hips_bytes: number;
  photo_count: number;
  photo_bytes: number;
  snapshot_count: number;
  snapshot_bytes: number;
  total_bytes: number;
  surveys: SurveyCacheStat[];
}

export interface PrefetchHipsResult {
  survey_id: string;
  requested: number;
  already_cached: number;
  downloaded: number;
  failed: number;
  bytes_added: number;
}

export interface SnapshotBodyEntry {
  id: string;
  kind: string;
  name_ja: string;
  name_en: string;
  ra_deg: number;
  dec_deg: number;
  az_deg: number;
  alt_deg: number;
  mag: number | null;
  extra: string;
}

export interface SnapshotBookmark {
  id: string;
  kind: string;
  name_ja: string;
  ra_deg: number;
  dec_deg: number;
  mag: number | null;
  note: string;
}

export interface OfflineObservationSnapshot {
  id: string;
  title: string;
  created_at_iso: string;
  note: string;
  jd_ut: number;
  location: LocationPreset;
  view: {
    projectionMode: ProjectionMode;
    centerAzDeg: number;
    centerAltDeg: number;
    centerRaDeg: number;
    centerDecDeg: number;
    fovDeg: number;
    zoom: number;
  };
  bodies: SnapshotBodyEntry[];
  bookmarks: SnapshotBookmark[];
}

export interface OfflineSnapshotMeta {
  id: string;
  title: string;
  created_at_iso: string;
  note: string;
  jd_ut: number;
  location_name: string;
  body_count: number;
  bookmark_count: number;
}





