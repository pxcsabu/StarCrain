export type LunarFeatureKind = "mare" | "crater" | "mountain";

export interface LunarFeature {
  id: string;
  nameJa: string;
  nameEn: string;
  kind: LunarFeatureKind;
  latDeg: number; // selenographic latitude (+N / -S)
  lonDeg: number; // selenographic longitude (+E lunar limb = Mare Crisium side / -W = Procellarum side)
  diameterKm: number;
  rank: 1 | 2;
}

export const LUNAR_FEATURES: LunarFeature[] = [
  // Major Maria & Ocean (rank 1)
  { id: "procellarum", nameJa: "嵐の大洋", nameEn: "Oceanus Procellarum", kind: "mare", latDeg: 18.4, lonDeg: -54.0, diameterKm: 2568, rank: 1 },
  { id: "imbrium", nameJa: "雨の海", nameEn: "Mare Imbrium", kind: "mare", latDeg: 32.8, lonDeg: -15.6, diameterKm: 1146, rank: 1 },
  { id: "serenitatis", nameJa: "晴れの海", nameEn: "Mare Serenitatis", kind: "mare", latDeg: 28.0, lonDeg: 17.5, diameterKm: 674, rank: 1 },
  { id: "tranquillitatis", nameJa: "静かの海", nameEn: "Mare Tranquillitatis", kind: "mare", latDeg: 8.5, lonDeg: 31.4, diameterKm: 873, rank: 1 },
  { id: "fecunditatis", nameJa: "豊かの海", nameEn: "Mare Fecunditatis", kind: "mare", latDeg: -7.8, lonDeg: 51.3, diameterKm: 840, rank: 1 },
  { id: "crisium", nameJa: "危機の海", nameEn: "Mare Crisium", kind: "mare", latDeg: 17.0, lonDeg: 59.1, diameterKm: 556, rank: 1 },
  { id: "nubium", nameJa: "雲の海", nameEn: "Mare Nubium", kind: "mare", latDeg: -21.3, lonDeg: -16.6, diameterKm: 715, rank: 1 },
  { id: "humorum", nameJa: "湿りの海", nameEn: "Mare Humorum", kind: "mare", latDeg: -24.4, lonDeg: -38.6, diameterKm: 425, rank: 2 },
  { id: "nectaris", nameJa: "神酒の海", nameEn: "Mare Nectaris", kind: "mare", latDeg: -15.2, lonDeg: 35.5, diameterKm: 333, rank: 2 },
  { id: "frigoris", nameJa: "氷の海", nameEn: "Mare Frigoris", kind: "mare", latDeg: 56.0, lonDeg: 1.4, diameterKm: 1446, rank: 2 },
  { id: "vaporum", nameJa: "蒸気の海", nameEn: "Mare Vaporum", kind: "mare", latDeg: 13.3, lonDeg: 3.6, diameterKm: 245, rank: 2 },

  // Major Craters (rank 1)
  { id: "tycho", nameJa: "ティコ", nameEn: "Tycho", kind: "crater", latDeg: -43.3, lonDeg: -11.4, diameterKm: 85, rank: 1 },
  { id: "copernicus", nameJa: "コペルニクス", nameEn: "Copernicus", kind: "crater", latDeg: 9.6, lonDeg: -20.1, diameterKm: 93, rank: 1 },
  { id: "kepler", nameJa: "ケプラー", nameEn: "Kepler", kind: "crater", latDeg: 8.1, lonDeg: -38.0, diameterKm: 31, rank: 1 },
  { id: "aristarchus", nameJa: "アリスタルコス", nameEn: "Aristarchus", kind: "crater", latDeg: 23.7, lonDeg: -47.4, diameterKm: 40, rank: 1 },
  { id: "plato", nameJa: "プラトン", nameEn: "Plato", kind: "crater", latDeg: 51.6, lonDeg: -9.3, diameterKm: 101, rank: 1 },
  { id: "clavius", nameJa: "クラビウス", nameEn: "Clavius", kind: "crater", latDeg: -58.4, lonDeg: -14.4, diameterKm: 231, rank: 1 },
  { id: "grimaldi", nameJa: "グリマルディ", nameEn: "Grimaldi", kind: "crater", latDeg: -5.2, lonDeg: -68.6, diameterKm: 173, rank: 1 },
  { id: "archimedes", nameJa: "アルキメデス", nameEn: "Archimedes", kind: "crater", latDeg: 29.7, lonDeg: -4.0, diameterKm: 81, rank: 1 },

  // Additional Famous Craters & Mountain Ranges (rank 2)
  { id: "apenninus", nameJa: "アペニン山脈", nameEn: "Montes Apenninus", kind: "mountain", latDeg: 18.9, lonDeg: -3.7, diameterKm: 600, rank: 2 },
  { id: "alpes", nameJa: "アルプス山脈", nameEn: "Montes Alpes", kind: "mountain", latDeg: 46.4, lonDeg: -0.8, diameterKm: 281, rank: 2 },
  { id: "theophilus", nameJa: "テオフィルス", nameEn: "Theophilus", kind: "crater", latDeg: -11.4, lonDeg: 26.4, diameterKm: 100, rank: 2 },
  { id: "ptolemaeus", nameJa: "プトレマイオス", nameEn: "Ptolemaeus", kind: "crater", latDeg: -9.2, lonDeg: -1.8, diameterKm: 154, rank: 2 },
  { id: "alphonsus", nameJa: "アルフォンスス", nameEn: "Alphonsus", kind: "crater", latDeg: -13.4, lonDeg: -2.8, diameterKm: 119, rank: 2 },
  { id: "langrenus", nameJa: "ラングレヌス", nameEn: "Langrenus", kind: "crater", latDeg: -8.9, lonDeg: 60.9, diameterKm: 132, rank: 2 },
  { id: "petavius", nameJa: "ペタビウス", nameEn: "Petavius", kind: "crater", latDeg: -25.3, lonDeg: 60.4, diameterKm: 184, rank: 2 },
  { id: "gassendi", nameJa: "ガッセンディ", nameEn: "Gassendi", kind: "crater", latDeg: -17.5, lonDeg: -39.9, diameterKm: 111, rank: 2 },
  { id: "posidonius", nameJa: "ポシドニウス", nameEn: "Posidonius", kind: "crater", latDeg: 31.8, lonDeg: 29.9, diameterKm: 95, rank: 2 },
];

const DEG2RAD = Math.PI / 180;

export interface ProjectedLunarFeature {
  feature: LunarFeature;
  x: number;
  y: number;
  nx: number; // normalized [-1..1] in screen coords relative to center
  ny: number;
  isVisibleLimb: boolean;
}

/**
 * Project a selenographic `(latDeg, lonDeg)` onto a circular lunar disk centered at `(cx, cy)`
 * with radius `r` and lunar North rotated clockwise on screen by `northRotRad`.
 */
export function projectLunarFeature(
  feature: LunarFeature,
  cx: number,
  cy: number,
  r: number,
  northRotRad = 0,
): ProjectedLunarFeature {
  const lat = feature.latDeg * DEG2RAD;
  const lon = feature.lonDeg * DEG2RAD;
  const lx = Math.cos(lat) * Math.sin(lon);
  const ly = -Math.sin(lat);
  const cosR = Math.cos(northRotRad);
  const sinR = Math.sin(northRotRad);
  const nx = lx * cosR - ly * sinR;
  const ny = lx * sinR + ly * cosR;
  return {
    feature,
    x: cx + nx * r,
    y: cy + ny * r,
    nx,
    ny,
    isVisibleLimb: Math.cos(lat) * Math.cos(lon) > 0.14,
  };
}
