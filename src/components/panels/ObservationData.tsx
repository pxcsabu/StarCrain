import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Cloud,
  Compass,
  Moon,
  RefreshCw,
  Sparkles,
  Sun,
  WifiOff,
  X,
} from "lucide-react";
import { MoonPhaseSvg } from "@/components/panels/MoonPhaseSvg";
import { Button } from "@/components/ui/button";
import { formatElevationM, formatTempC, formatWindKmh } from "@/lib/units";
import { useSkyStore } from "@/store/skyStore";
import type { NightWeatherForecast, ObservationDashboard } from "@/types/sky";

function shiftCalendarDate(year: number, month: number, day: number, deltaDays: number): [number, number, number] {
  const d = new Date(Date.UTC(year, month - 1, day + deltaDays));
  return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
}

export function ObservationData() {
  const skyFrame = useSkyStore((s) => s.skyFrame);
  const location = useSkyStore((s) => s.location);
  const simPlaying = useSkyStore((s) => s.simPlaying);
  const unitSystem = useSkyStore((s) => s.unitSystem);
  const offlineMode = useSkyStore((s) => s.offlineMode);
  const setOfflineMode = useSkyStore((s) => s.setOfflineMode);
  const showObservationOnStartup = useSkyStore((s) => s.showObservationOnStartup);
  const setShowObservationOnStartup = useSkyStore((s) => s.setShowObservationOnStartup);
  const jumpToJdUt = useSkyStore((s) => s.jumpToJdUt);
  const jumpToYmdHms = useSkyStore((s) => s.jumpToYmdHms);
  const centerOnSkyCoords = useSkyStore((s) => s.centerOnSkyCoords);
  const selectObject = useSkyStore((s) => s.selectObject);
  const setActivePanel = useSkyStore((s) => s.setActivePanel);

  const initialYear = skyFrame?.local_dt.year ?? new Date().getFullYear();
  const initialMonth = skyFrame?.local_dt.month ?? new Date().getMonth() + 1;
  const initialDay = skyFrame?.local_dt.day ?? new Date().getDate();

  const [dateParts, setDateParts] = useState<[number, number, number]>([
    initialYear,
    initialMonth,
    initialDay,
  ]);
  const [dashboard, setDashboard] = useState<ObservationDashboard | null>(null);
  const [loading, setLoading] = useState(false);
  const [weather, setWeather] = useState<NightWeatherForecast | null>(null);
  const [weatherLoading, setWeatherLoading] = useState(false);
  const [weatherErr, setWeatherErr] = useState<string | null>(null);

  const handleFetchWeather = () => {
    if (!isTauri()) return;
    setWeatherErr(null);
    setWeatherLoading(true);
    void invoke<NightWeatherForecast>("fetch_open_meteo_weather_cmd", {
      offlineMode,
      latDeg: location.lat_deg,
      lonDeg: location.lon_deg,
      tzOffsetMin: location.tz_offset_min,
    })
      .then((res) => setWeather(res))
      .catch((err) => setWeatherErr(err instanceof Error ? err.message : String(err)))
      .finally(() => setWeatherLoading(false));
  };

  const [year, month, day] = dateParts;

  // Keep panel synced when user first opens or planetarium date changes via calendar click
  useEffect(() => {
    if (!skyFrame) return;
    setDateParts((prev) => {
      if (
        prev[0] === skyFrame.local_dt.year &&
        prev[1] === skyFrame.local_dt.month &&
        prev[2] === skyFrame.local_dt.day
      ) {
        return prev;
      }
      return [skyFrame.local_dt.year, skyFrame.local_dt.month, skyFrame.local_dt.day];
    });
  }, [skyFrame?.local_dt.year, skyFrame?.local_dt.month, skyFrame?.local_dt.day]);

  useEffect(() => {
    let cancelled = false;
    if (!isTauri()) {
      setDashboard(null);
      return;
    }
    const timer = window.setTimeout(() => {
      setLoading(true);
      void invoke<ObservationDashboard>("get_observation_dashboard", {
        req: {
          year,
          month,
          day,
          lat_deg: location.lat_deg,
          lon_deg: location.lon_deg,
          alt_m: location.alt_m,
          tz_offset_min: location.tz_offset_min,
        },
      })
        .then((res) => {
          if (!cancelled) setDashboard(res);
        })
        .catch(() => {
          if (!cancelled) setDashboard(null);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, simPlaying ? 450 : 60);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [year, month, day, location.lat_deg, location.lon_deg, location.alt_m, location.tz_offset_min, simPlaying]);

  const dateInputStr = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

  return (
    <aside className="flex h-full w-[25rem] max-w-[calc(100vw-5.5rem)] flex-col rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface-glass)] text-[var(--text-primary)] shadow-2xl backdrop-blur-md">
      {/* Header */}
      <div className="flex items-start justify-between gap-2 border-b border-[var(--border-subtle)] px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold tracking-tight">観測データ</h2>
          <p className="text-[11px] text-[var(--text-muted)]">
            {location.name_ja} · 標高 {formatElevationM(location.alt_m, unitSystem)}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => setActivePanel(null)}
          title="閉じる"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Date Navigation & Sync */}
      <div className="space-y-2 border-b border-[var(--border-subtle)] px-4 py-2.5 text-xs">
        <div className="flex items-center gap-1.5">
          <Button
            variant="outline"
            size="icon"
            className="h-7 w-7 shrink-0"
            onClick={() => setDateParts(shiftCalendarDate(year, month, day, -1))}
            title="前日"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          <input
            type="date"
            value={dateInputStr}
            onChange={(e) => {
              const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(e.target.value);
              if (m) {
                setDateParts([Number(m[1]), Number(m[2]), Number(m[3])]);
              }
            }}
            className="min-w-0 flex-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 py-1 font-mono-num text-xs text-[var(--text-primary)]"
          />
          <Button
            variant="outline"
            size="icon"
            className="h-7 w-7 shrink-0"
            onClick={() => setDateParts(shiftCalendarDate(year, month, day, 1))}
            title="翌日"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-[11px]"
            onClick={() => {
              const now = new Date();
              setDateParts([now.getFullYear(), now.getMonth() + 1, now.getDate()]);
            }}
          >
            今日
          </Button>
        </div>

        <div className="flex items-center justify-between gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1 px-2 text-[11px]"
            onClick={() => jumpToYmdHms(year, month, day, 21, 0, 0)}
          >
            <RefreshCw className="h-3 w-3" />
            この日の21:00へ移動
          </Button>

          <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-[var(--text-secondary)]">
            <input
              type="checkbox"
              checked={showObservationOnStartup}
              onChange={(e) => setShowObservationOnStartup(e.target.checked)}
              className="h-3.5 w-3.5 accent-[var(--accent-primary)]"
            />
            起動時に表示
          </label>
        </div>
      </div>

      {/* Scrollable Dashboard Content */}
      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3 text-xs">
        {loading && !dashboard ? (
          <div className="py-10 text-center text-[var(--text-muted)]">観測データを計算中...</div>
        ) : !dashboard ? (
          <div className="py-10 text-center text-[var(--text-muted)]">
            デスクトップ実行時に全天文エフェメリスが表示されます
          </div>
        ) : (
          <>
            {/* Calendar / Kyureki / Rokuyo / Holiday */}
            <section className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)]/70 p-3">
              <div className="flex flex-wrap items-center justify-between gap-1.5">
                <div className="flex items-center gap-1.5">
                  <span
                    className={`font-mono-num text-sm font-bold ${
                      dashboard.holiday_ja || dashboard.weekday === 0
                        ? "text-rose-400"
                        : dashboard.weekday === 6
                          ? "text-sky-400"
                          : "text-[var(--text-primary)]"
                    }`}
                  >
                    {dashboard.year}年{dashboard.month}月{dashboard.day}日 ({dashboard.weekday_ja})
                  </span>
                  {dashboard.holiday_ja && (
                    <span className="rounded bg-rose-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-rose-300">
                      {dashboard.holiday_ja}
                    </span>
                  )}
                </div>
                <span className="rounded bg-[var(--bg-surface)] px-2 py-0.5 text-[10px] font-medium text-[var(--text-secondary)]">
                  {dashboard.kyureki.rokuyo_ja}
                </span>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 text-[11px] text-[var(--text-muted)]">
                <span>{dashboard.kyureki.label_ja}</span>
                <span>
                  {dashboard.solar_term_ja ? (
                    <strong className="text-[var(--accent-primary)]">
                      本日: {dashboard.solar_term_ja}
                    </strong>
                  ) : (
                    `次の節気: ${dashboard.next_solar_term_ja} (${dashboard.next_solar_term_date})`
                  )}
                </span>
              </div>
            </section>

            {/* Sun & Twilight */}
            <section className="space-y-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)]/70 p-3">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 font-semibold text-amber-300">
                  <Sun className="h-3.5 w-3.5" /> 太陽・薄明（時刻クリックでジャンプ）
                </span>
                <span className="font-mono-num text-[10px] text-[var(--text-muted)]">
                  昼 {dashboard.sun.daylight_hours.toFixed(1)}h / 暗夜 {dashboard.sun.dark_night_hours.toFixed(1)}h
                </span>
              </div>

              <div className="grid grid-cols-3 gap-1.5 text-center">
                {[
                  { label: "日の出", str: dashboard.sun.rise_str, jd: dashboard.sun.rise_jd_ut },
                  {
                    label: `南中 (${dashboard.sun.max_alt_deg.toFixed(1)}°)`,
                    str: dashboard.sun.transit_str,
                    jd: dashboard.sun.transit_jd_ut,
                  },
                  { label: "日の入", str: dashboard.sun.set_str, jd: dashboard.sun.set_jd_ut },
                ].map((item) => (
                  <button
                    key={item.label}
                    type="button"
                    disabled={!item.jd}
                    onClick={() => item.jd && jumpToJdUt(item.jd)}
                    className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-1.5 py-1.5 transition hover:border-amber-400/60 disabled:opacity-50"
                  >
                    <div className="text-[10px] text-[var(--text-muted)]">{item.label}</div>
                    <div className="font-mono-num text-xs font-semibold">{item.str ?? "---"}</div>
                  </button>
                ))}
              </div>

              <div className="grid grid-cols-2 gap-1.5 text-[11px]">
                <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)]/70 px-2.5 py-1.5">
                  <div className="text-[10px] text-[var(--text-muted)]">明け方の薄明</div>
                  <div className="mt-0.5 space-y-0.5 font-mono-num">
                    <button
                      type="button"
                      disabled={!dashboard.sun.astro_dawn_jd_ut}
                      onClick={() =>
                        dashboard.sun.astro_dawn_jd_ut && jumpToJdUt(dashboard.sun.astro_dawn_jd_ut)
                      }
                      className="flex w-full justify-between hover:text-[var(--accent-primary)] disabled:opacity-50"
                    >
                      <span>天文</span>
                      <span>{dashboard.sun.astro_dawn_str ?? "---"}</span>
                    </button>
                    <div className="flex justify-between text-[var(--text-secondary)]">
                      <span>航海</span>
                      <span>{dashboard.sun.nautical_dawn_str ?? "---"}</span>
                    </div>
                    <div className="flex justify-between text-[var(--text-secondary)]">
                      <span>市民</span>
                      <span>{dashboard.sun.civil_dawn_str ?? "---"}</span>
                    </div>
                  </div>
                </div>

                <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)]/70 px-2.5 py-1.5">
                  <div className="text-[10px] text-[var(--text-muted)]">夕方の薄明</div>
                  <div className="mt-0.5 space-y-0.5 font-mono-num">
                    <div className="flex justify-between text-[var(--text-secondary)]">
                      <span>市民</span>
                      <span>{dashboard.sun.civil_dusk_str ?? "---"}</span>
                    </div>
                    <div className="flex justify-between text-[var(--text-secondary)]">
                      <span>航海</span>
                      <span>{dashboard.sun.nautical_dusk_str ?? "---"}</span>
                    </div>
                    <button
                      type="button"
                      disabled={!dashboard.sun.astro_dusk_jd_ut}
                      onClick={() =>
                        dashboard.sun.astro_dusk_jd_ut && jumpToJdUt(dashboard.sun.astro_dusk_jd_ut)
                      }
                      className="flex w-full justify-between hover:text-[var(--accent-primary)] disabled:opacity-50"
                    >
                      <span>天文</span>
                      <span>{dashboard.sun.astro_dusk_str ?? "---"}</span>
                    </button>
                  </div>
                </div>
              </div>
            </section>

            {/* Moon */}
            <section className="space-y-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)]/70 p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2.5">
                  <MoonPhaseSvg
                    illuminatedFraction={dashboard.moon.illuminated_fraction}
                    waxing={dashboard.moon.waxing}
                    size={38}
                    title={dashboard.moon.phase_name_ja}
                  />
                  <div>
                    <div className="flex items-center gap-1.5 font-semibold">
                      <Moon className="h-3.5 w-3.5 text-slate-300" />
                      <span>{dashboard.moon.phase_name_ja}</span>
                    </div>
                    <div className="font-mono-num text-[11px] text-[var(--text-muted)]">
                      月齢(21時) {dashboard.moon.moon_age_21h.toFixed(1)}日 ・輝面比{" "}
                      {(dashboard.moon.illuminated_fraction * 100).toFixed(0)}%
                    </div>
                  </div>
                </div>
                <span className="font-mono-num text-[10px] text-[var(--text-muted)]">
                  {Math.round(dashboard.moon.distance_km).toLocaleString()} km
                </span>
              </div>

              <div className="grid grid-cols-3 gap-1.5 text-center">
                {[
                  { label: "月の出", str: dashboard.moon.rise_str, jd: dashboard.moon.rise_jd_ut },
                  {
                    label: `南中 (${dashboard.moon.max_alt_deg.toFixed(0)}°)`,
                    str: dashboard.moon.transit_str,
                    jd: dashboard.moon.transit_jd_ut,
                  },
                  { label: "月の入", str: dashboard.moon.set_str, jd: dashboard.moon.set_jd_ut },
                ].map((item) => (
                  <button
                    key={item.label}
                    type="button"
                    disabled={!item.jd}
                    onClick={() => item.jd && jumpToJdUt(item.jd)}
                    className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-1.5 py-1.5 transition hover:border-[var(--accent-primary)] disabled:opacity-50"
                  >
                    <div className="text-[10px] text-[var(--text-muted)]">{item.label}</div>
                    <div className="font-mono-num text-xs font-semibold">{item.str ?? "---"}</div>
                  </button>
                ))}
              </div>
            </section>

            {/* Today's Phenomena */}
            <section className="space-y-1.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)]/70 p-3">
              <div className="flex items-center gap-1.5 font-semibold text-[var(--accent-primary)]">
                <Sparkles className="h-3.5 w-3.5" /> 本日の主な天文現象
              </div>
              {dashboard.phenomena.length === 0 ? (
                <p className="text-[11px] text-[var(--text-muted)]">
                  特筆すべき食・接近・節気イベントはありません。
                </p>
              ) : (
                <div className="space-y-1">
                  {dashboard.phenomena.map((ph, idx) => (
                    <button
                      key={`${ph.kind}-${idx}`}
                      type="button"
                      onClick={() => {
                        jumpToJdUt(ph.jd_ut);
                        if (ph.target_ra_deg !== null && ph.target_dec_deg !== null) {
                          centerOnSkyCoords(ph.target_ra_deg, ph.target_dec_deg);
                        }
                      }}
                      className="flex w-full items-start justify-between gap-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)]/80 px-2.5 py-1.5 text-left transition hover:border-[var(--accent-primary)]"
                    >
                      <div className="min-w-0">
                        <div className="truncate font-semibold">{ph.title_ja}</div>
                        <div className="truncate text-[10px] text-[var(--text-muted)]">
                          {ph.detail_ja}
                        </div>
                      </div>
                      {ph.time_str && (
                        <span className="shrink-0 font-mono-num text-[10px] text-[var(--accent-primary)]">
                          {ph.time_str}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </section>

            {/* Tonight's Planets */}
            <section className="space-y-1.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)]/70 p-3">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 font-semibold text-[var(--text-secondary)]">
                  <Compass className="h-3.5 w-3.5" /> 今夜の主要惑星 (21時基準)
                </span>
                <span className="text-[10px] text-[var(--text-muted)]">クリックで導入</span>
              </div>
              <div className="space-y-1">
                {dashboard.planets.map((pl) => (
                  <button
                    key={pl.id}
                    type="button"
                    onClick={() => {
                      selectObject(
                        {
                          kind: "planet",
                          id: pl.id,
                          name_ja: pl.name_ja,
                          name_en: pl.id,
                          constellation: null,
                          mag: pl.mag,
                          ra_deg: pl.ra_deg,
                          dec_deg: pl.dec_deg,
                          az_deg: pl.az_21h_deg,
                          alt_deg: pl.alt_21h_deg,
                          dist_text: `離角 ${pl.elongation_deg.toFixed(0)}°`,
                          angular_sep_deg: 0,
                          extra_info: pl.visibility_ja,
                        },
                        true,
                      );
                    }}
                    className="grid w-full grid-cols-[3rem_3.2rem_1fr_3.6rem] items-center gap-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)]/80 px-2 py-1.5 text-left text-[11px] transition hover:border-[var(--accent-primary)]"
                  >
                    <span className="font-semibold">{pl.name_ja}</span>
                    <span className="font-mono-num text-[var(--text-secondary)]">
                      {pl.mag.toFixed(1)}等
                    </span>
                    <span className="truncate font-mono-num text-[10px] text-[var(--text-muted)]">
                      出{pl.rise_str ?? "--"} 没{pl.set_str ?? "--"}
                    </span>
                    <span
                      className={`text-right font-mono-num text-[10px] font-semibold ${
                        pl.alt_21h_deg > 10
                          ? "text-[var(--status-ok)]"
                          : pl.alt_21h_deg > 0
                            ? "text-amber-300"
                            : "text-[var(--text-muted)]"
                      }`}
                    >
                      {pl.alt_21h_deg >= 0 ? `+${pl.alt_21h_deg.toFixed(0)}°` : `${pl.alt_21h_deg.toFixed(0)}°`}
                    </span>
                  </button>
                ))}
              </div>
            </section>

            {/* Open-Meteo Cloud & Weather Forecast (Phase 8 Whitelisted Official Sync) */}
            <section className="space-y-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)]/80 p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-xs font-semibold text-sky-300">
                  <Cloud className="h-3.5 w-3.5" /> 今夜の雲量予報
                </span>
                <div className="flex items-center gap-1">
                  {offlineMode && (
                    <button
                      type="button"
                      onClick={() => setOfflineMode(false)}
                      className="flex items-center gap-0.5 rounded-full border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 text-[10px] text-amber-200"
                    >
                      <WifiOff className="h-2.5 w-2.5" />
                      <span>遮断中</span>
                    </button>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-6 px-2.5 text-[10px]"
                    disabled={weatherLoading || offlineMode}
                    onClick={handleFetchWeather}
                  >
                    {weatherLoading ? "取得中..." : "取得"}
                  </Button>
                </div>
              </div>

              {weatherErr && (
                <div className="rounded border border-rose-500/40 bg-rose-500/15 px-2 py-1 text-[10px] text-rose-200">
                  {weatherErr}
                </div>
              )}

              {weather ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="font-semibold text-emerald-300">{weather.rating_ja}</span>
                    <span className="font-mono-num text-[var(--text-secondary)]">
                      夜間平均雲量 {weather.tonight_avg_cloud_pct.toFixed(0)}%
                    </span>
                  </div>
                  <div className="grid grid-cols-8 gap-1">
                    {weather.hours.slice(0, 16).map((h) => {
                      const clearPct = Math.max(0, 100 - h.cloud_cover_pct);
                      return (
                        <div
                          key={h.time_iso}
                          title={`${h.label} 雲量${h.cloud_cover_pct.toFixed(0)}% (下${h.cloud_low_pct.toFixed(0)}/中${h.cloud_mid_pct.toFixed(0)}/上${h.cloud_high_pct.toFixed(0)}) 気温${formatTempC(h.temp_c, unitSystem)} 湿度${h.humidity_pct.toFixed(0)}% 風${formatWindKmh(h.wind_kmh, unitSystem)}`}
                          className="flex flex-col items-center rounded bg-[var(--bg-surface-elevated)] px-0.5 py-1 font-mono-num"
                        >
                          <div className="relative h-8 w-2.5 overflow-hidden rounded-sm bg-slate-800">
                            <div
                              className="absolute right-0 bottom-0 left-0 bg-slate-400"
                              style={{ height: `${Math.min(100, h.cloud_cover_pct)}%` }}
                            />
                            <div
                              className="absolute top-0 right-0 left-0 bg-sky-400/50"
                              style={{ height: `${Math.min(100, clearPct)}%` }}
                            />
                          </div>
                          <span className="mt-0.5 text-[8px] text-[var(--text-muted)]">
                            {h.label.slice(0, 2)}h
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <p className="text-[10px] text-[var(--text-muted)]">
                  観測地の夜間雲量・気温・風速を取得します
                </p>
              )}
            </section>
          </>
        )}
      </div>

      {/* Footer Quick Panel Links */}
      <div className="grid grid-cols-2 gap-1.5 border-t border-[var(--border-subtle)] px-4 py-2.5">
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 text-xs"
          onClick={() => setActivePanel("moon_calendar")}
        >
          <CalendarDays className="h-3.5 w-3.5" />
          月齢カレンダー
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 text-xs"
          onClick={() => setActivePanel("meteors")}
        >
          <Sparkles className="h-3.5 w-3.5" />
          流星群一覧
        </Button>
      </div>
    </aside>
  );
}
