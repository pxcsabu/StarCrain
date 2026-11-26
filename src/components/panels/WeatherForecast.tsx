import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  Calendar,
  Cloud,
  CloudFog,
  CloudLightning,
  CloudMoon,
  CloudRain,
  CloudSnow,
  CloudSun,
  Compass,
  Droplets,
  Gauge,
  Moon,
  RefreshCw,
  Sparkles,
  Sun,
  Thermometer,
  WifiOff,
  Wind,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { formatTempC, formatWindKmh } from "@/lib/units";
import { useSkyStore } from "@/store/skyStore";
import type {
  NightWeatherForecast,
  SpaceWeatherSnapshot,
  WeatherDailyPoint,
  WeatherHourPoint,
} from "@/types/sky";

function buildBrowserPreviewSpaceWeather(latDeg: number): SpaceWeatherSnapshot {
  const kpVals = [1.67, 2.0, 2.33, 3.0, 3.67, 3.33, 2.67, 2.33, 2.0, 2.33, 3.0, 3.33];
  const kp_series = kpVals.map((kp, i) => ({
    time_tag: `2026-11-26 ${String((i * 3) % 24).padStart(2, "0")}:00`,
    kp,
    a_running: Math.round(kp * 6),
    station_count: 8,
  }));
  const geomag = latDeg * 0.72;
  const vis = Math.abs(geomag) >= 55 ? 45 : 0;
  return {
    source_url: "preview://noaa-swpc",
    current_kp: 3.33,
    max_kp_24h: 3.67,
    storm_level_ja: "静穏 (G0 Quiet)",
    solar_wind_km_s: 432,
    bz_nt: -2.4,
    f107_flux: 168,
    geomagnetic_lat_deg: Number(geomag.toFixed(1)),
    aurora_visibility_pct: vis,
    aurora_summary_ja:
      vis > 20
        ? "暗い北の地平線で微かなオーロラ期待可能 (プレビュー)"
        : "現在地（磁気緯度）でのオーロラ観測は困難 (プレビュー)",
    kp_series,
  };
}

function windDirToJa(deg: number): string {
  const dirs = ["北", "北東", "東", "南東", "南", "南西", "西", "北西"];
  const idx = Math.round((((deg % 360) + 360) % 360) / 45) % 8;
  return dirs[idx] ?? "北";
}

function WeatherCodeIcon({
  code,
  isNight = false,
  className = "h-5 w-5",
}: {
  code: number;
  isNight?: boolean;
  className?: string;
}) {
  if (code === 0) {
    return isNight ? (
      <Moon className={`${className} text-amber-200`} />
    ) : (
      <Sun className={`${className} text-amber-400`} />
    );
  }
  if (code === 1 || code === 2) {
    return isNight ? (
      <CloudMoon className={`${className} text-sky-300`} />
    ) : (
      <CloudSun className={`${className} text-amber-300`} />
    );
  }
  if (code === 45 || code === 48) {
    return <CloudFog className={`${className} text-slate-300`} />;
  }
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) {
    return <CloudRain className={`${className} text-sky-400`} />;
  }
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) {
    return <CloudSnow className={`${className} text-cyan-200`} />;
  }
  if (code >= 95) {
    return <CloudLightning className={`${className} text-yellow-300`} />;
  }
  return <Cloud className={`${className} text-slate-300`} />;
}

function scoreColorClass(score: number): string {
  if (score >= 80) return "border-emerald-400/40 bg-emerald-500/15 text-emerald-300";
  if (score >= 55) return "border-sky-400/40 bg-sky-500/15 text-sky-300";
  if (score >= 30) return "border-amber-400/40 bg-amber-500/15 text-amber-300";
  return "border-rose-400/40 bg-rose-500/15 text-rose-300";
}

function formatDateJaWithWeekday(isoDate: string): string {
  const m = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return isoDate;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  const wds = ["日", "月", "火", "水", "木", "金", "土"];
  const wd = wds[dt.getUTCDay()] ?? "";
  return `${mo}/${d}(${wd})`;
}

/** Browser-only realistic fallback preview when outside Tauri runtime. */
function buildBrowserPreviewWeather(latDeg: number, lonDeg: number): NightWeatherForecast {
  const now = new Date();
  const hours: WeatherHourPoint[] = [];
  for (let i = 0; i < 48; i++) {
    const t = new Date(now.getTime() + i * 3600 * 1000);
    const yr = t.getFullYear();
    const mo = String(t.getMonth() + 1).padStart(2, "0");
    const dy = String(t.getDate()).padStart(2, "0");
    const hr = t.getHours();
    const label = `${String(hr).padStart(2, "0")}:00`;
    const cc = Math.max(4, Math.min(85, Math.round(22 + 18 * Math.sin(i * 0.28))));
    const temp = Number((11 + 5.5 * Math.sin(((hr - 9) / 24) * Math.PI * 2)).toFixed(1));
    const dew = Number((temp - (4.2 + 1.8 * Math.cos(i * 0.2))).toFixed(1));
    const score = Math.max(0, Math.min(100, Math.round(100 - cc * 0.85)));
    hours.push({
      time_iso: `${yr}-${mo}-${dy}T${label}`,
      label,
      cloud_cover_pct: cc,
      cloud_low_pct: Math.round(cc * 0.45),
      cloud_mid_pct: Math.round(cc * 0.35),
      cloud_high_pct: Math.round(cc * 0.2),
      temp_c: temp,
      humidity_pct: 64,
      wind_kmh: 9,
      weather_code: cc < 20 ? 0 : cc < 50 ? 2 : 3,
      weather_label_ja: cc < 20 ? "快晴" : cc < 50 ? "一部曇り" : "曇り",
      precip_prob_pct: cc > 65 ? 30 : 5,
      precip_mm: 0,
      dew_point_c: dew,
      visibility_km: 24,
      wind_dir_deg: 290,
      stargazing_score: score,
    });
  }
  const daily: WeatherDailyPoint[] = [];
  for (let d = 0; d < 7; d++) {
    const dt = new Date(now.getTime() + d * 86400 * 1000);
    const iso = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(
      dt.getDate(),
    ).padStart(2, "0")}`;
    const cc = [12, 24, 58, 18, 8, 42, 16][d] ?? 20;
    daily.push({
      date: iso,
      weather_code: cc < 20 ? 0 : cc < 50 ? 2 : 3,
      weather_label_ja: cc < 20 ? "快晴" : cc < 50 ? "一部曇り" : "曇り",
      temp_max_c: 16.5 - (d % 3),
      temp_min_c: 7.2 + (d % 2),
      precip_prob_max_pct: cc > 50 ? 45 : 10,
      precip_sum_mm: 0,
      wind_max_kmh: 13,
      night_avg_cloud_pct: cc,
      stargazing_score: Math.round(100 - cc * 0.85),
    });
  }
  return {
    source_url: "preview://open-meteo",
    lat_deg: latDeg,
    lon_deg: lonDeg,
    tonight_avg_cloud_pct: 18,
    rating_ja: "快晴・絶好の星空コンディション (プレビュー)",
    hours,
    current: {
      temp_c: 11.4,
      apparent_temp_c: 9.8,
      humidity_pct: 62,
      cloud_cover_pct: 14,
      wind_kmh: 8.5,
      wind_dir_deg: 300,
      pressure_hpa: 1018,
      weather_code: 1,
      weather_label_ja: "ほぼ晴れ",
      is_day: false,
    },
    daily,
    tonight_stargazing_score: 84,
    best_stargazing_window: "21:00〜03:00 (平均スコア 86点)",
  };
}

export function WeatherForecast() {
  const closePanel = useSkyStore((s) => s.closePanel);
  const location = useSkyStore((s) => s.location);
  const offlineMode = useSkyStore((s) => s.offlineMode);
  const setOfflineMode = useSkyStore((s) => s.setOfflineMode);
  const unitSystem = useSkyStore((s) => s.unitSystem);
  const jumpToYmdHms = useSkyStore((s) => s.jumpToYmdHms);
  const setLiveWeather = useSkyStore((s) => s.setLiveWeather);
  const showWeatherCloudsOverlay = useSkyStore((s) => s.showWeatherCloudsOverlay);
  const setShowWeatherCloudsOverlay = useSkyStore((s) => s.setShowWeatherCloudsOverlay);
  const liveSpaceWeather = useSkyStore((s) => s.liveSpaceWeather);
  const setLiveSpaceWeather = useSkyStore((s) => s.setLiveSpaceWeather);

  const [tab, setTab] = useState<"ground" | "space">("ground");
  const [forecast, setForecast] = useState<NightWeatherForecast | null>(null);
  const [spaceWeather, setSpaceWeather] = useState<SpaceWeatherSnapshot | null>(liveSpaceWeather);
  const [loading, setLoading] = useState(false);
  const [spaceLoading, setSpaceLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [lastUpdatedLabel, setLastUpdatedLabel] = useState<string | null>(null);

  const fetchWeather = useCallback(async () => {
    setErrorMsg(null);
    if (!isTauri()) {
      const preview = buildBrowserPreviewWeather(location.lat_deg, location.lon_deg);
      setForecast(preview);
      setLiveWeather(preview);
      const now = new Date();
      setLastUpdatedLabel(
        `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`,
      );
      return;
    }
    if (offlineMode) {
      setErrorMsg("オフラインモード有効中のため気象データを取得できません。");
      return;
    }
    setLoading(true);
    try {
      const res = await invoke<NightWeatherForecast>("fetch_open_meteo_weather_cmd", {
        offlineMode,
        latDeg: location.lat_deg,
        lonDeg: location.lon_deg,
        tzOffsetMin: location.tz_offset_min,
      });
      setForecast(res);
      setLiveWeather(res);
      const now = new Date();
      setLastUpdatedLabel(
        `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`,
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [location.lat_deg, location.lon_deg, location.tz_offset_min, offlineMode, setLiveWeather]);

  const fetchSpaceWeather = useCallback(async () => {
    setErrorMsg(null);
    if (!isTauri()) {
      const preview = buildBrowserPreviewSpaceWeather(location.lat_deg);
      setSpaceWeather(preview);
      setLiveSpaceWeather(preview);
      return;
    }
    if (offlineMode) {
      setErrorMsg("オフラインモード有効中のためNOAA宇宙天気を取得できません。");
      return;
    }
    setSpaceLoading(true);
    try {
      const res = await invoke<SpaceWeatherSnapshot>("fetch_space_weather_cmd", {
        offlineMode,
        latDeg: location.lat_deg,
        lonDeg: location.lon_deg,
      });
      setSpaceWeather(res);
      setLiveSpaceWeather(res);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSpaceLoading(false);
    }
  }, [location.lat_deg, location.lon_deg, offlineMode, setLiveSpaceWeather]);

  useEffect(() => {
    if (!offlineMode || !isTauri()) {
      void fetchWeather();
    }
  }, [fetchWeather, offlineMode]);

  useEffect(() => {
    if (tab === "space" && !spaceWeather && (!offlineMode || !isTauri())) {
      void fetchSpaceWeather();
    }
  }, [tab, spaceWeather, offlineMode, fetchSpaceWeather]);

  const handleJumpToHour = (timeIso: string) => {
    const m = timeIso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    if (!m) return;
    jumpToYmdHms(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), 0);
  };

  const cur = forecast?.current;

  return (
    <aside className="flex h-[34rem] max-h-[calc(100dvh-10.5rem)] w-[30rem] max-w-[calc(100vw-4rem)] flex-col text-[var(--text-primary)] max-sm:h-[82dvh] max-sm:max-h-none max-sm:w-full max-sm:max-w-none">
      {/* Header */}
      <div className="flex items-start justify-between gap-2 border-b border-[var(--border-subtle)] px-4 py-2.5">
        <div className="min-w-0">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold tracking-tight">
            <CloudSun className="h-4 w-4 text-[var(--accent-primary)]" />
            <span>天気予報 &amp; 観望コンディション</span>
          </h2>
          <p className="truncate text-[11px] text-[var(--text-muted)]">
            {location.name_ja} ({location.lat_deg.toFixed(2)}°N, {location.lon_deg.toFixed(2)}°E)
            {lastUpdatedLabel ? ` · 更新 ${lastUpdatedLabel}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            disabled={tab === "ground" ? loading : spaceLoading}
            onClick={() => void (tab === "ground" ? fetchWeather() : fetchSpaceWeather())}
            title="最新の予報を取得"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${(tab === "ground" ? loading : spaceLoading) ? "animate-spin" : ""}`}
            />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => closePanel("weather")}
            title="閉じる"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Mode Switch + Sky Cloud Sync Toggle */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-subtle)] px-4 py-1.5 text-xs">
        <div className="flex gap-1">
          <Button
            type="button"
            size="sm"
            variant={tab === "ground" ? "default" : "outline"}
            className="h-7 gap-1 px-2.5 text-[11px]"
            onClick={() => setTab("ground")}
          >
            <CloudSun className="h-3.5 w-3.5" />
            地上天気・雲量
          </Button>
          <Button
            type="button"
            size="sm"
            variant={tab === "space" ? "default" : "outline"}
            className="h-7 gap-1 px-2.5 text-[11px]"
            onClick={() => setTab("space")}
          >
            <Sun className="h-3.5 w-3.5" />
            宇宙天気・オーロラ
          </Button>
        </div>
        {tab === "ground" && (
          <label className="flex cursor-pointer items-center gap-1.5 text-[10.5px]">
            <input
              type="checkbox"
              checked={showWeatherCloudsOverlay}
              onChange={(e) => setShowWeatherCloudsOverlay(e.target.checked)}
            />
            <span>星図に雲を反映</span>
          </label>
        )}
      </div>

      {/* Scrollable Body */}
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3 text-xs">
        {offlineMode && (
          <div className="flex items-center justify-between gap-2 rounded-xl border border-amber-500/40 bg-amber-500/15 px-3 py-2 text-[11px] text-amber-200">
            <div className="flex items-center gap-1.5">
              <WifiOff className="h-3.5 w-3.5 shrink-0" />
              <span>オフラインモードが有効なため予報取得が停止中です</span>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-6 shrink-0 border-amber-400/50 px-2 text-[10px]"
              onClick={() => setOfflineMode(false)}
            >
              通信を許可
            </Button>
          </div>
        )}

        {errorMsg && (
          <div className="rounded-xl border border-rose-500/40 bg-rose-500/15 px-3 py-2 text-[11px] text-rose-200">
            {errorMsg}
          </div>
        )}

        {tab === "ground" && !forecast && loading && (
          <div className="py-12 text-center text-[var(--text-muted)]">
            Open-Meteo から最新の気象・雲量予報を取得しています...
          </div>
        )}

        {tab === "space" && (
          <div className="space-y-3">
            {!spaceWeather && spaceLoading && (
              <div className="py-10 text-center text-[var(--text-muted)]">
                NOAA SWPC から太陽風・磁気嵐 Kp 指数を取得中...
              </div>
            )}
            {spaceWeather && (
              <>
                <section className="space-y-2.5 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface)]/85 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <div className="text-[10.5px] text-[var(--text-muted)]">
                        地磁気擾乱レベル (NOAA SWPC)
                      </div>
                      <div className="text-sm font-bold text-amber-300">
                        {spaceWeather.storm_level_ja}
                      </div>
                      <div className="font-mono-num text-[10.5px] text-[var(--text-secondary)]">
                        現在 Kp {spaceWeather.current_kp.toFixed(1)} · 24h最大 Kp{" "}
                        {spaceWeather.max_kp_24h.toFixed(1)}
                      </div>
                    </div>
                    <div
                      className={`rounded-xl border px-3 py-1.5 text-center ${
                        spaceWeather.aurora_visibility_pct >= 50
                          ? "border-emerald-400/40 bg-emerald-500/15 text-emerald-300"
                          : spaceWeather.aurora_visibility_pct >= 15
                            ? "border-amber-400/40 bg-amber-500/15 text-amber-200"
                            : "border-slate-500/40 bg-slate-800/60 text-slate-300"
                      }`}
                    >
                      <div className="text-[9.5px]">オーロラ期待度</div>
                      <div className="font-mono-num text-base font-bold">
                        {spaceWeather.aurora_visibility_pct}%
                      </div>
                    </div>
                  </div>

                  <div className="rounded-lg bg-[var(--bg-surface-elevated)]/80 px-2.5 py-1.5 text-[10.5px] text-sky-200">
                    {spaceWeather.aurora_summary_ja}（現在地の磁気緯度{" "}
                    {spaceWeather.geomagnetic_lat_deg >= 0 ? "+" : ""}
                    {spaceWeather.geomagnetic_lat_deg.toFixed(1)}°）
                  </div>

                  <div className="grid grid-cols-3 gap-1.5 text-center">
                    <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)]/70 py-1.5">
                      <div className="text-[9.5px] text-[var(--text-muted)]">太陽風速度</div>
                      <div className="font-mono-num text-xs font-semibold">
                        {spaceWeather.solar_wind_km_s !== null
                          ? `${Math.round(spaceWeather.solar_wind_km_s)} km/s`
                          : "---"}
                      </div>
                    </div>
                    <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)]/70 py-1.5">
                      <div className="text-[9.5px] text-[var(--text-muted)]">磁場 Bz (GSM)</div>
                      <div
                        className={`font-mono-num text-xs font-semibold ${
                          (spaceWeather.bz_nt ?? 0) < -5 ? "text-rose-300" : ""
                        }`}
                      >
                        {spaceWeather.bz_nt !== null
                          ? `${spaceWeather.bz_nt >= 0 ? "+" : ""}${spaceWeather.bz_nt.toFixed(1)} nT`
                          : "---"}
                      </div>
                    </div>
                    <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)]/70 py-1.5">
                      <div className="text-[9.5px] text-[var(--text-muted)]">F10.7電波流束</div>
                      <div className="font-mono-num text-xs font-semibold">
                        {spaceWeather.f107_flux !== null
                          ? `${spaceWeather.f107_flux.toFixed(0)} sfu`
                          : "---"}
                      </div>
                    </div>
                  </div>
                </section>

                <section className="space-y-2 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface)]/85 p-3">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="font-semibold text-[var(--text-secondary)]">
                      Kp 指数推移 (3時間毎 / 最新{spaceWeather.kp_series.length}点)
                    </span>
                    <span className="text-[9.5px] text-[var(--text-muted)]">Kp≥5 = 磁気嵐</span>
                  </div>
                  <div className="flex h-24 items-end gap-1 rounded-xl border border-[var(--border-subtle)] bg-[#030712] px-2 pt-3 pb-1.5">
                    {spaceWeather.kp_series.map((s) => {
                      const pct = Math.max(6, Math.min(100, (s.kp / 9) * 100));
                      const barCol =
                        s.kp >= 6
                          ? "bg-rose-500"
                          : s.kp >= 4.6
                            ? "bg-amber-400"
                            : s.kp >= 3.3
                              ? "bg-sky-400"
                              : "bg-emerald-400/80";
                      return (
                        <div
                          key={s.time_tag}
                          title={`${s.time_tag} UTC | Kp=${s.kp.toFixed(2)}`}
                          className="flex flex-1 flex-col items-center justify-end gap-0.5 h-full"
                        >
                          <div
                            className={`w-full rounded-t-sm ${barCol}`}
                            style={{ height: `${pct}%` }}
                          />
                        </div>
                      );
                    })}
                  </div>
                  <div className="text-[9.5px] text-[var(--text-muted)]">
                    データ提供: NOAA Space Weather Prediction Center (HTTPS 公式JSON)
                  </div>
                </section>
              </>
            )}
          </div>
        )}

        {tab === "ground" && forecast && (
          <>
            {/* Current Weather & Tonight Stargazing Score */}
            <section className="space-y-2.5 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface)]/85 p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <WeatherCodeIcon
                    code={cur?.weather_code ?? forecast.hours[0]?.weather_code ?? 2}
                    isNight={cur ? !cur.is_day : false}
                    className="h-9 w-9 shrink-0"
                  />
                  <div>
                    <div className="flex items-baseline gap-2">
                      <span className="font-mono-num text-xl font-bold">
                        {formatTempC(cur?.temp_c ?? forecast.hours[0]?.temp_c ?? 0, unitSystem)}
                      </span>
                      <span className="text-xs font-medium text-[var(--text-secondary)]">
                        {cur?.weather_label_ja ?? forecast.hours[0]?.weather_label_ja ?? ""}
                      </span>
                    </div>
                    {cur && (
                      <div className="text-[10.5px] text-[var(--text-muted)]">
                        体感 {formatTempC(cur.apparent_temp_c, unitSystem)} · 総合雲量{" "}
                        {cur.cloud_cover_pct.toFixed(0)}%
                      </div>
                    )}
                  </div>
                </div>

                <div
                  className={`flex flex-col items-center rounded-xl border px-3 py-1.5 text-center ${scoreColorClass(
                    forecast.tonight_stargazing_score,
                  )}`}
                >
                  <span className="text-[9.5px] opacity-85">今夜の星空指数</span>
                  <span className="font-mono-num text-base font-bold leading-tight">
                    {forecast.tonight_stargazing_score}
                    <span className="text-[10px] font-normal"> / 100</span>
                  </span>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-1.5 rounded-xl bg-[var(--bg-surface-elevated)]/80 px-2.5 py-1.5 text-[11px]">
                <span className="flex items-center gap-1 font-medium text-sky-300">
                  <Sparkles className="h-3.5 w-3.5" />
                  {forecast.rating_ja}
                </span>
                <span className="font-mono-num text-[10.5px] text-[var(--text-muted)]">
                  夜間平均雲量 {forecast.tonight_avg_cloud_pct.toFixed(0)}%
                </span>
              </div>

              {forecast.best_stargazing_window && (
                <div className="flex items-center gap-1.5 rounded-lg border border-emerald-400/25 bg-emerald-500/10 px-2.5 py-1 text-[10.5px] text-emerald-200">
                  <Compass className="h-3.5 w-3.5 shrink-0" />
                  <span>好条件時間帯: {forecast.best_stargazing_window}</span>
                </div>
              )}

              {cur && (
                <div className="grid grid-cols-4 gap-1.5 text-center">
                  <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)]/70 py-1.5">
                    <div className="flex items-center justify-center gap-1 text-[9.5px] text-[var(--text-muted)]">
                      <Cloud className="h-3 w-3" /> 雲量
                    </div>
                    <div className="font-mono-num text-xs font-semibold">
                      {cur.cloud_cover_pct.toFixed(0)}%
                    </div>
                  </div>
                  <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)]/70 py-1.5">
                    <div className="flex items-center justify-center gap-1 text-[9.5px] text-[var(--text-muted)]">
                      <Droplets className="h-3 w-3" /> 湿度
                    </div>
                    <div className="font-mono-num text-xs font-semibold">
                      {cur.humidity_pct.toFixed(0)}%
                    </div>
                  </div>
                  <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)]/70 py-1.5">
                    <div className="flex items-center justify-center gap-1 text-[9.5px] text-[var(--text-muted)]">
                      <Wind className="h-3 w-3" /> {windDirToJa(cur.wind_dir_deg)}
                    </div>
                    <div className="font-mono-num text-xs font-semibold">
                      {formatWindKmh(cur.wind_kmh, unitSystem)}
                    </div>
                  </div>
                  <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)]/70 py-1.5">
                    <div className="flex items-center justify-center gap-1 text-[9.5px] text-[var(--text-muted)]">
                      <Gauge className="h-3 w-3" /> 気圧
                    </div>
                    <div className="font-mono-num text-xs font-semibold">
                      {Math.round(cur.pressure_hpa)} hPa
                    </div>
                  </div>
                </div>
              )}
            </section>

            {/* 48-Hour Stargazing & Cloud Layer Timeline */}
            <section className="space-y-1.5 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface)]/85 p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 font-semibold text-sky-300">
                  <Thermometer className="h-3.5 w-3.5" /> 48時間予報（雲層・気温・結露・星空指数）
                </span>
                <span className="text-[10px] text-[var(--text-muted)]">タップで時刻を星図に反映</span>
              </div>

              <div className="flex gap-1.5 overflow-x-auto pb-1.5">
                {forecast.hours.map((h) => {
                  const hrNum = Number(h.label.slice(0, 2));
                  const isNightHr = hrNum >= 18 || hrNum <= 5;
                  const dewRisk = h.temp_c - h.dew_point_c <= 2.5;
                  return (
                    <button
                      key={h.time_iso}
                      type="button"
                      onClick={() => handleJumpToHour(h.time_iso)}
                      title={`${h.time_iso} | ${h.weather_label_ja} | 雲量:${h.cloud_cover_pct.toFixed(
                        0,
                      )}% (低${h.cloud_low_pct.toFixed(0)}/中${h.cloud_mid_pct.toFixed(
                        0,
                      )}/高${h.cloud_high_pct.toFixed(0)}) | 露点:${h.dew_point_c.toFixed(
                        1,
                      )}°C | 視程:${h.visibility_km.toFixed(1)}km`}
                      className={`flex w-14 shrink-0 flex-col items-center gap-1 rounded-xl border px-1.5 py-2 text-center transition hover:border-[var(--accent-primary)] ${
                        isNightHr
                          ? "border-sky-400/20 bg-slate-900/75"
                          : "border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)]/65"
                      }`}
                    >
                      <span className="font-mono-num text-[10px] font-medium text-[var(--text-secondary)]">
                        {h.label.slice(0, 5)}
                      </span>
                      <WeatherCodeIcon
                        code={h.weather_code}
                        isNight={isNightHr}
                        className="h-4 w-4"
                      />
                      <span className="font-mono-num text-[11px] font-semibold">
                        {formatTempC(h.temp_c, unitSystem)}
                      </span>

                      {/* Total Cloud Bar */}
                      <div className="relative h-8 w-3 overflow-hidden rounded-sm bg-slate-800">
                        <div
                          className="absolute right-0 bottom-0 left-0 bg-slate-400/85"
                          style={{ height: `${Math.min(100, h.cloud_cover_pct)}%` }}
                        />
                        <div
                          className="absolute right-0 bottom-0 left-0 bg-indigo-400/50"
                          style={{ height: `${Math.min(100, h.cloud_low_pct)}%` }}
                        />
                      </div>
                      <span className="font-mono-num text-[9.5px] text-[var(--text-muted)]">
                        雲{Math.round(h.cloud_cover_pct)}%
                      </span>

                      <span className="font-mono-num text-[9px] text-sky-300">
                        降{Math.round(h.precip_prob_pct)}%
                      </span>
                      <span
                        className={`rounded px-1 py-0.2 font-mono-num text-[9px] font-semibold border ${scoreColorClass(
                          h.stargazing_score,
                        )}`}
                      >
                        {h.stargazing_score}点
                      </span>
                      {dewRisk && (
                        <span className="rounded bg-amber-500/20 px-1 text-[8.5px] text-amber-300">
                          結露注意
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 text-[9.5px] text-[var(--text-muted)]">
                <span>濃い青帯＝夜間の観望時間帯（18〜05時） · 下層/全雲量を棒グラフ表示</span>
                <span>データ提供: Open-Meteo</span>
              </div>
            </section>

            {/* 7-Day Daily Forecast */}
            {forecast.daily.length > 0 && (
              <section className="space-y-1.5 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface)]/85 p-3">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5 font-semibold text-[var(--text-secondary)]">
                    <Calendar className="h-3.5 w-3.5" /> 7日間予報 &amp; 夜間の観望適性
                  </span>
                  <span className="text-[10px] text-[var(--text-muted)]">気温(最高/最低) · 夜雲量</span>
                </div>

                <div className="space-y-1">
                  {forecast.daily.map((d) => (
                    <div
                      key={d.date}
                      className="grid grid-cols-[4.5rem_1.5rem_1fr_4.5rem_3rem_2.8rem] items-center gap-1.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)]/70 px-2.5 py-1.5 text-[11px]"
                    >
                      <span className="font-mono-num font-semibold">
                        {formatDateJaWithWeekday(d.date)}
                      </span>
                      <WeatherCodeIcon code={d.weather_code} className="h-4 w-4" />
                      <div className="min-w-0 truncate text-[10.5px] text-[var(--text-secondary)]">
                        {d.weather_label_ja} · 降{Math.round(d.precip_prob_max_pct)}%
                      </div>
                      <div className="text-right font-mono-num text-[10.5px]">
                        <span className="text-amber-300">
                          {d.temp_max_c.toFixed(0)}°
                        </span>
                        <span className="text-[var(--text-muted)]"> / </span>
                        <span className="text-sky-300">
                          {d.temp_min_c.toFixed(0)}°
                        </span>
                      </div>
                      <span className="text-right font-mono-num text-[10px] text-[var(--text-muted)]">
                        雲{Math.round(d.night_avg_cloud_pct)}%
                      </span>
                      <span
                        className={`rounded border px-1 py-0.5 text-center font-mono-num text-[9.5px] font-semibold ${scoreColorClass(
                          d.stargazing_score,
                        )}`}
                      >
                        {d.stargazing_score}点
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
