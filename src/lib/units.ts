import type { AngleFormat, UnitSystem } from "@/types/sky";

export function formatElevationM(meters: number, unit: UnitSystem): string {
  if (!Number.isFinite(meters)) return "-";
  if (unit === "imperial") {
    return `${Math.round(meters * 3.28084)} ft`;
  }
  return `${Math.round(meters)} m`;
}

export function formatDistanceKm(km: number, unit: UnitSystem, decimals = 0): string {
  if (!Number.isFinite(km)) return "-";
  if (unit === "imperial") {
    return `${(km * 0.621371).toFixed(decimals)} mi`;
  }
  return `${km.toFixed(decimals)} km`;
}

export function formatVelocityKmS(kmPerSec: number, unit: UnitSystem, decimals = 2): string {
  if (!Number.isFinite(kmPerSec)) return "-";
  if (unit === "imperial") {
    return `${(kmPerSec * 0.621371).toFixed(decimals)} mi/s`;
  }
  return `${kmPerSec.toFixed(decimals)} km/s`;
}

export function formatTempC(celsius: number, unit: UnitSystem): string {
  if (!Number.isFinite(celsius)) return "-";
  if (unit === "imperial") {
    return `${((celsius * 9) / 5 + 32).toFixed(1)}°F`;
  }
  return `${celsius.toFixed(1)}°C`;
}

export function formatWindKmh(kmh: number, unit: UnitSystem): string {
  if (!Number.isFinite(kmh)) return "-";
  if (unit === "imperial") {
    return `${Math.round(kmh * 0.621371)} mph`;
  }
  return `${Math.round(kmh)} km/h`;
}

export function formatDegValue(deg: number, format: AngleFormat, signed = false): string {
  if (!Number.isFinite(deg)) return "-";
  if (format === "deg") {
    const sign = signed && deg > 0 ? "+" : "";
    return `${sign}${deg.toFixed(2)}°`;
  }
  const signChar = deg < 0 ? "-" : signed && deg > 0 ? "+" : "";
  const abs = Math.abs(deg);
  let d = Math.floor(abs);
  const mFloat = (abs - d) * 60;
  let m = Math.floor(mFloat);
  let s = Math.round((mFloat - m) * 60);
  if (s >= 60) {
    s = 0;
    m += 1;
  }
  if (m >= 60) {
    m = 0;
    d += 1;
  }
  return `${signChar}${d}°${String(m).padStart(2, "0")}'${String(s).padStart(2, "0")}"`;
}
