import type { FovPreset } from "@/types/sky";

export interface FovDimensions {
  widthDeg: number;
  heightDeg: number;
  magnification?: number;
  summaryText: string;
}

export function computeFovDimensions(preset: FovPreset): FovDimensions {
  if (preset.kind === "camera") {
    const sw = Math.max(1, preset.sensorWidthMm ?? 36);
    const sh = Math.max(1, preset.sensorHeightMm ?? 24);
    const fl = Math.max(10, (preset.focalLengthMm ?? 500) * (preset.reducerFactor ?? 1));
    const widthDeg = (2 * Math.atan(sw / (2 * fl)) * 180) / Math.PI;
    const heightDeg = (2 * Math.atan(sh / (2 * fl)) * 180) / Math.PI;
    return {
      widthDeg,
      heightDeg,
      summaryText: `${widthDeg.toFixed(2)}° × ${heightDeg.toFixed(2)}° (f=${fl.toFixed(0)}mm)`,
    };
  }
  if (preset.kind === "eyepiece") {
    const scopeFl = Math.max(50, preset.focalLengthMm ?? 1000);
    const epFl = Math.max(1, preset.eyepieceFocalMm ?? 14);
    const afov = Math.max(20, preset.afovDeg ?? 82);
    const mag = scopeFl / epFl;
    const tfov = afov / mag;
    return {
      widthDeg: tfov,
      heightDeg: tfov,
      magnification: mag,
      summaryText: `実視界 ${tfov.toFixed(2)}° (${mag.toFixed(0)}倍 / AFOV ${afov.toFixed(0)}°)`,
    };
  }
  if (preset.kind === "binoculars") {
    const mag = Math.max(2, preset.binoMag ?? 7);
    const aperture = Math.max(10, preset.binoApertureMm ?? 50);
    const tfov = Math.max(0.5, preset.binoFieldDeg ?? 7.1);
    return {
      widthDeg: tfov,
      heightDeg: tfov,
      magnification: mag,
      summaryText: `実視界 ${tfov.toFixed(1)}° (${mag}×${aperture})`,
    };
  }
  return {
    widthDeg: 4.0,
    heightDeg: 4.0,
    summaryText: "0.5° / 2.0° / 4.0° 等倍ファインダー",
  };
}

export function defaultFovPresets(): FovPreset[] {
  return [
    {
      id: "fov_fullframe_500",
      name: "フルサイズ 36×24mm + 500mm",
      kind: "camera",
      enabled: false,
      color: "#f43f5e",
      rotationDeg: 0,
      sensorWidthMm: 36,
      sensorHeightMm: 24,
      focalLengthMm: 500,
      reducerFactor: 1.0,
    },
    {
      id: "fov_apsc_300",
      name: "APS-C 23.5×15.6mm + 300mm",
      kind: "camera",
      enabled: false,
      color: "#fb923c",
      rotationDeg: 0,
      sensorWidthMm: 23.5,
      sensorHeightMm: 15.6,
      focalLengthMm: 300,
      reducerFactor: 1.0,
    },
    {
      id: "fov_ep_14mm",
      name: "20cm F5 (1000mm) + 14mm 82°",
      kind: "eyepiece",
      enabled: false,
      color: "#38bdf8",
      rotationDeg: 0,
      focalLengthMm: 1000,
      eyepieceFocalMm: 14,
      afovDeg: 82,
    },
    {
      id: "fov_bino_7x50",
      name: "双眼鏡 7×50",
      kind: "binoculars",
      enabled: false,
      color: "#34d399",
      rotationDeg: 0,
      binoMag: 7,
      binoApertureMm: 50,
      binoFieldDeg: 7.1,
    },
    {
      id: "fov_telrad",
      name: "テルラドサークル (0.5°/2°/4°)",
      kind: "telrad",
      enabled: false,
      color: "#ef4444",
      rotationDeg: 0,
    },
  ];
}
