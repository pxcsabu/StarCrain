import type { LocationPreset } from "@/types/sky";

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

export interface GpsPositionFix {
  latDeg: number;
  lonDeg: number;
  altM: number;
  accuracyM: number;
}

function getCurrentPositionAsync(options: PositionOptions): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
      reject(new Error("この環境では GPS / 位置情報 API を利用できません"));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, options);
  });
}

function mapGeolocationError(err: unknown): Error {
  if (err && typeof err === "object" && "code" in err) {
    const code = Number((err as GeolocationPositionError).code);
    if (code === 1) {
      return new Error("位置情報の権限が拒否されました。端末またはアプリの位置情報設定を許可してください。");
    }
    if (code === 2) {
      return new Error("GPS/ネットワークから現在地を取得できませんでした。位置情報(GPS)がONか確認してください。");
    }
    if (code === 3) {
      return new Error("現在地の測位がタイムアウトしました。");
    }
  }
  return err instanceof Error ? err : new Error(String(err));
}

export async function requestCurrentGpsPosition(): Promise<GpsPositionFix> {
  try {
    const pos = await getCurrentPositionAsync({
      enableHighAccuracy: true,
      timeout: 12000,
      maximumAge: 20000,
    });
    return {
      latDeg: pos.coords.latitude,
      lonDeg: pos.coords.longitude,
      altM: pos.coords.altitude ?? 0,
      accuracyM: pos.coords.accuracy ?? 0,
    };
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? Number((err as GeolocationPositionError).code)
        : 0;
    if (code === 1) {
      throw mapGeolocationError(err);
    }
    try {
      const pos = await getCurrentPositionAsync({
        enableHighAccuracy: false,
        timeout: 10000,
        maximumAge: 60000,
      });
      return {
        latDeg: pos.coords.latitude,
        lonDeg: pos.coords.longitude,
        altM: pos.coords.altitude ?? 0,
        accuracyM: pos.coords.accuracy ?? 0,
      };
    } catch (fallbackErr) {
      throw mapGeolocationError(fallbackErr);
    }
  }
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * DEG2RAD;
  const dLon = (lon2 - lon1) * DEG2RAD;
  const a =
    Math.sin(dLat * 0.5) ** 2 +
    Math.cos(lat1 * DEG2RAD) * Math.cos(lat2 * DEG2RAD) * Math.sin(dLon * 0.5) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function buildGpsLocationPreset(
  fix: GpsPositionFix,
  presets: LocationPreset[],
): LocationPreset {
  let nearest: LocationPreset | null = null;
  let bestKm = Infinity;
  for (const p of presets) {
    if (p.id === "gps_current") continue;
    const d = haversineKm(fix.latDeg, fix.lonDeg, p.lat_deg, p.lon_deg);
    if (d < bestKm) {
      bestKm = d;
      nearest = p;
    }
  }

  const nearMatch = nearest && bestKm <= 80 ? nearest : null;
  const nearShort = nearMatch
    ? nearMatch.name_ja.replace(/\s*[（(].*?[）)]/g, "").trim() || nearMatch.name_ja
    : null;
  const tzOffsetMin = -new Date().getTimezoneOffset();
  const tzName =
    typeof Intl !== "undefined"
      ? Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Tokyo"
      : "Asia/Tokyo";

  return {
    id: "gps_current",
    name_ja: nearShort ? `現在地 (GPS · ${nearShort}付近)` : "現在地 (GPS)",
    name_en: nearMatch ? `Current GPS (near ${nearMatch.name_en})` : "Current GPS",
    country_ja: nearMatch ? nearMatch.country_ja : "現在地",
    region: nearMatch ? nearMatch.region : "GPS測位",
    category: nearMatch?.category === "japan" ? "japan" : "overseas",
    lat_deg: Number(fix.latDeg.toFixed(5)),
    lon_deg: Number(fix.lonDeg.toFixed(5)),
    alt_m: Math.round(fix.altM),
    tz_offset_min: tzOffsetMin,
    tz_name: tzName,
    is_default: false,
  };
}

/**
 * Compute world ENU unit vector along device rear optical axis (-Z_device)
 * from W3C DeviceOrientation Euler angles (Z-X'-Y'': alpha, beta, gamma).
 */
export function deviceOrientationToEnu(
  alphaDeg: number,
  betaDeg: number,
  gammaDeg: number,
): { e: number; n: number; u: number } {
  const a = alphaDeg * DEG2RAD;
  const b = betaDeg * DEG2RAD;
  const g = gammaDeg * DEG2RAD;

  const sinA = Math.sin(a);
  const cosA = Math.cos(a);
  const sinB = Math.sin(b);
  const cosB = Math.cos(b);
  const sinG = Math.sin(g);
  const cosG = Math.cos(g);

  const v2x = -sinG;
  const v2y = sinB * cosG;
  const v2z = -cosB * cosG;

  const e = cosA * v2x - sinA * v2y;
  const n = sinA * v2x + cosA * v2y;
  const u = v2z;
  const norm = Math.hypot(e, n, u) || 1;
  return { e: e / norm, n: n / norm, u: u / norm };
}

export function enuToAzAlt(e: number, n: number, u: number): { azDeg: number; altDeg: number } {
  const azDeg = ((Math.atan2(e, n) * RAD2DEG) % 360 + 360) % 360;
  const altDeg = Math.asin(Math.max(-1, Math.min(1, u))) * RAD2DEG;
  return { azDeg, altDeg };
}

interface OrientationEventWithWebkit extends DeviceOrientationEvent {
  webkitCompassHeading?: number;
}

export function startSkyOrientationSensor(
  onUpdate: (dir: { azDeg: number; altDeg: number; isAbsolute: boolean }) => void,
  onStatus: (status: string) => void,
  onVector?: (vec: { e: number; n: number; u: number; isAbsolute: boolean }) => void,
): () => void {
  if (typeof window === "undefined" || !("DeviceOrientationEvent" in window)) {
    onStatus("この端末では方位・傾きセンサーを利用できません");
    return () => {};
  }

  let stopped = false;
  let receivedAbsolute = false;
  let receivedAny = false;
  let smoothed: { e: number; n: number; u: number } | null = null;
  let lastEmitTs = 0;

  const handleEvent = (raw: Event, fromAbsoluteListener: boolean) => {
    if (stopped) return;
    const ev = raw as OrientationEventWithWebkit;
    if (ev.beta == null || ev.gamma == null) return;

    const hasWebkitCompass = typeof ev.webkitCompassHeading === "number" && Number.isFinite(ev.webkitCompassHeading);
    const isAbs = fromAbsoluteListener || ev.absolute === true || hasWebkitCompass;

    if (fromAbsoluteListener || ev.absolute === true) {
      receivedAbsolute = true;
    } else if (receivedAbsolute && !hasWebkitCompass) {
      return;
    }

    let alphaDeg = ev.alpha ?? 0;
    if (hasWebkitCompass) {
      alphaDeg = (360 - (ev.webkitCompassHeading ?? 0)) % 360;
    }

    const vec = deviceOrientationToEnu(alphaDeg, ev.beta, ev.gamma);

    if (!receivedAny) {
      receivedAny = true;
      onStatus(isAbs ? "コンパス+ジャイロ追尾中" : "相対ジャイロ追尾中（必要に応じ方位微調整）");
    }

    if (onVector) {
      onVector({ e: vec.e, n: vec.n, u: vec.u, isAbsolute: isAbs });
      const now = performance.now();
      if (now - lastEmitTs >= 120) {
        lastEmitTs = now;
        const { azDeg, altDeg } = enuToAzAlt(vec.e, vec.n, vec.u);
        onUpdate({ azDeg, altDeg, isAbsolute: isAbs });
      }
      return;
    }

    if (!smoothed) {
      smoothed = vec;
    } else {
      const k = 0.24;
      const se = smoothed.e * (1 - k) + vec.e * k;
      const sn = smoothed.n * (1 - k) + vec.n * k;
      const su = smoothed.u * (1 - k) + vec.u * k;
      const len = Math.hypot(se, sn, su) || 1;
      smoothed = { e: se / len, n: sn / len, u: su / len };
    }

    const now = performance.now();
    if (now - lastEmitTs < 16) return;
    lastEmitTs = now;

    const { azDeg, altDeg } = enuToAzAlt(smoothed.e, smoothed.n, smoothed.u);
    onUpdate({ azDeg, altDeg, isAbsolute: isAbs });
  };

  const onAbs = (e: Event) => handleEvent(e, true);
  const onRel = (e: Event) => handleEvent(e, false);

  const attachListeners = () => {
    if (stopped) return;
    onStatus("センサー信号を待機中...");
    window.addEventListener("deviceorientationabsolute", onAbs, true);
    window.addEventListener("deviceorientation", onRel, true);
  };

  const DevOrient = window.DeviceOrientationEvent as unknown as {
    requestPermission?: () => Promise<"granted" | "denied">;
  };
  if (typeof DevOrient.requestPermission === "function") {
    void DevOrient.requestPermission()
      .then((res) => {
        if (res === "granted") {
          attachListeners();
        } else {
          onStatus("モーションセンサーの権限が拒否されました");
        }
      })
      .catch(() => {
        onStatus("モーションセンサーの許可取得に失敗しました");
      });
  } else {
    attachListeners();
  }

  const noDataTimer = window.setTimeout(() => {
    if (!stopped && !receivedAny) {
      onStatus("この端末またはブラウザではジャイロ/コンパス信号を受信できません");
    }
  }, 1800);

  return () => {
    stopped = true;
    window.clearTimeout(noDataTimer);
    window.removeEventListener("deviceorientationabsolute", onAbs, true);
    window.removeEventListener("deviceorientation", onRel, true);
  };
}
