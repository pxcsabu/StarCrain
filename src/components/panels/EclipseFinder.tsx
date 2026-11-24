import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import {
  Compass,
  Eclipse,
  Moon,
  Pause,
  Play,
  RefreshCw,
  Sparkles,
  Sun,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSkyStore } from "@/store/skyStore";
import type {
  LunarEclipseView,
  LunarOccultationView,
  PlanetaryTransitView,
  SolarEclipseView,
} from "@/types/sky";

type EclipseTab = "solar" | "lunar" | "transit" | "occultation";

const ECLIPSE_TABS: { id: EclipseTab; label: string; icon: typeof Sun }[] = [
  { id: "solar", label: "日食", icon: Sun },
  { id: "lunar", label: "月食", icon: Moon },
  { id: "transit", label: "日面通過", icon: Eclipse },
  { id: "occultation", label: "星食", icon: Sparkles },
];

export function EclipseFinder() {
  const location = useSkyStore((s) => s.location);
  const jdUt = useSkyStore((s) => s.jdUt);
  const jumpToJdUt = useSkyStore((s) => s.jumpToJdUt);
  const centerOnSkyCoords = useSkyStore((s) => s.centerOnSkyCoords);
  const setActivePanel = useSkyStore((s) => s.setActivePanel);

  const [tab, setTab] = useState<EclipseTab>("solar");
  const [visibleOnly, setVisibleOnly] = useState<boolean>(false);

  // Solar eclipse state
  const [solarStartYear, setSolarStartYear] = useState<number>(2026);
  const [solarEndYear, setSolarEndYear] = useState<number>(2035);
  const [solarList, setSolarList] = useState<SolarEclipseView[]>([]);
  const [selectedSolarIdx, setSelectedSolarIdx] = useState<number>(0);
  const [solarLoading, setSolarLoading] = useState<boolean>(false);

  // Lunar eclipse state
  const [lunarStartYear, setLunarStartYear] = useState<number>(2026);
  const [lunarEndYear, setLunarEndYear] = useState<number>(2035);
  const [lunarList, setLunarList] = useState<LunarEclipseView[]>([]);
  const [selectedLunarIdx, setSelectedLunarIdx] = useState<number>(0);
  const [lunarLoading, setLunarLoading] = useState<boolean>(false);

  // Transit state
  const [transitStartYear, setTransitStartYear] = useState<number>(2020);
  const [transitEndYear, setTransitEndYear] = useState<number>(2055);
  const [transitList, setTransitList] = useState<PlanetaryTransitView[]>([]);
  const [selectedTransitIdx, setSelectedTransitIdx] = useState<number>(0);
  const [transitLoading, setTransitLoading] = useState<boolean>(false);

  // Occultation state
  const [occDays, setOccDays] = useState<number>(180);
  const [occMagLimit, setOccMagLimit] = useState<number>(4.0);
  const [occList, setOccList] = useState<LunarOccultationView[]>([]);
  const [occLoading, setOccLoading] = useState<boolean>(false);

  // Playback scrubbers for simulation SVGs
  const [simStep, setSimStep] = useState<number>(10);
  const [simPlaying, setSimPlaying] = useState<boolean>(false);

  useEffect(() => {
    setSimPlaying(false);
    setSimStep(10);
  }, [tab, selectedSolarIdx, selectedLunarIdx, selectedTransitIdx]);

  useEffect(() => {
    if (!simPlaying) return;
    const maxLen =
      tab === "solar"
        ? (filteredSolar[selectedSolarIdx]?.path_samples.length ?? 21)
        : tab === "lunar"
          ? (filteredLunar[selectedLunarIdx]?.path_samples.length ?? 25)
          : (transitList[selectedTransitIdx]?.path_samples.length ?? 19);
    const timer = window.setInterval(() => {
      setSimStep((prev) => (prev + 1) % Math.max(2, maxLen));
    }, 180);
    return () => window.clearInterval(timer);
  }, [simPlaying, tab]);

  // Fetch Solar Eclipses
  useEffect(() => {
    if (tab !== "solar" || !isTauri()) return;
    let cancelled = false;
    setSolarLoading(true);
    void invoke<SolarEclipseView[]>("search_solar_eclipses_cmd", {
      req: {
        start_year: solarStartYear,
        end_year: solarEndYear,
        lat_deg: location.lat_deg,
        lon_deg: location.lon_deg,
        alt_m: location.alt_m,
        tz_offset_min: location.tz_offset_min,
      },
    })
      .then((res) => {
        if (!cancelled) {
          setSolarList(res);
          const firstVis = res.findIndex((e) => e.visible_locally);
          setSelectedSolarIdx(firstVis >= 0 ? firstVis : 0);
        }
      })
      .finally(() => {
        if (!cancelled) setSolarLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tab, solarStartYear, solarEndYear, location]);

  // Fetch Lunar Eclipses
  useEffect(() => {
    if (tab !== "lunar" || !isTauri()) return;
    let cancelled = false;
    setLunarLoading(true);
    void invoke<LunarEclipseView[]>("search_lunar_eclipses_cmd", {
      req: {
        start_year: lunarStartYear,
        end_year: lunarEndYear,
        lat_deg: location.lat_deg,
        lon_deg: location.lon_deg,
        alt_m: location.alt_m,
        tz_offset_min: location.tz_offset_min,
      },
    })
      .then((res) => {
        if (!cancelled) {
          setLunarList(res);
          const firstVis = res.findIndex((e) => e.visible_locally);
          setSelectedLunarIdx(firstVis >= 0 ? firstVis : 0);
        }
      })
      .finally(() => {
        if (!cancelled) setLunarLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tab, lunarStartYear, lunarEndYear, location]);

  // Fetch Planetary Transits
  useEffect(() => {
    if (tab !== "transit" || !isTauri()) return;
    let cancelled = false;
    setTransitLoading(true);
    void invoke<PlanetaryTransitView[]>("search_planetary_transits_cmd", {
      req: {
        start_year: transitStartYear,
        end_year: transitEndYear,
        lat_deg: location.lat_deg,
        lon_deg: location.lon_deg,
        alt_m: location.alt_m,
        tz_offset_min: location.tz_offset_min,
      },
    })
      .then((res) => {
        if (!cancelled) {
          setTransitList(res);
          setSelectedTransitIdx(0);
        }
      })
      .finally(() => {
        if (!cancelled) setTransitLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tab, transitStartYear, transitEndYear, location]);

  // Fetch Lunar Occultations
  useEffect(() => {
    if (tab !== "occultation" || !isTauri()) return;
    let cancelled = false;
    setOccLoading(true);
    void invoke<LunarOccultationView[]>("search_lunar_occultations_cmd", {
      req: {
        start_jd_ut: jdUt,
        days: occDays,
        mag_limit: occMagLimit,
        lat_deg: location.lat_deg,
        lon_deg: location.lon_deg,
        alt_m: location.alt_m,
        tz_offset_min: location.tz_offset_min,
      },
    })
      .then((res) => {
        if (!cancelled) setOccList(res);
      })
      .finally(() => {
        if (!cancelled) setOccLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tab, occDays, occMagLimit, location]);

  const filteredSolar = useMemo(
    () => (visibleOnly ? solarList.filter((e) => e.visible_locally) : solarList),
    [solarList, visibleOnly],
  );
  const activeSolar = filteredSolar[selectedSolarIdx] ?? filteredSolar[0] ?? null;

  const filteredLunar = useMemo(
    () => (visibleOnly ? lunarList.filter((e) => e.visible_locally) : lunarList),
    [lunarList, visibleOnly],
  );
  const activeLunar = filteredLunar[selectedLunarIdx] ?? filteredLunar[0] ?? null;

  const activeTransit = transitList[selectedTransitIdx] ?? transitList[0] ?? null;

  const reproduceInSky = (targetJd: number, raDeg: number, decDeg: number, azDeg?: number, altDeg?: number) => {
    jumpToJdUt(targetJd);
    centerOnSkyCoords(raDeg, decDeg, azDeg, altDeg);
  };

  return (
    <aside className="flex h-full w-[38rem] max-w-[calc(100vw-5.5rem)] flex-col rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface-glass)] text-[var(--text-primary)] shadow-2xl backdrop-blur-md">
      {/* Header & Tabs */}
      <div className="border-b border-[var(--border-subtle)] px-4 pt-3 pb-2">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="flex items-center gap-1.5 text-sm font-semibold tracking-tight">
              <Eclipse className="h-4 w-4 text-amber-400" /> 食現象検索 &amp; シミュレーター
            </h2>
            <p className="text-[11px] text-[var(--text-muted)]">
              {location.name_ja} での日食・月食・日面通過・月星食を精密探索＆再現
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

        <div className="mt-2.5 grid grid-cols-4 gap-1 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)]/80 p-1">
          {ECLIPSE_TABS.map((t) => {
            const Icon = t.icon;
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={`flex items-center justify-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium transition ${
                  active
                    ? "bg-[var(--accent-primary)] text-[var(--accent-primary-fg)] shadow-sm"
                    : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                {t.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3 text-xs">
        {/* TAB 1: Solar Eclipses */}
        {tab === "solar" && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)]/65 px-3 py-2">
              <div className="flex items-center gap-1.5">
                <input
                  type="number"
                  value={solarStartYear}
                  min={1900}
                  max={2200}
                  onChange={(e) => setSolarStartYear(Number(e.target.value) || 2026)}
                  className="w-16 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-1.5 py-0.5 font-mono-num text-xs"
                />
                <span>〜</span>
                <input
                  type="number"
                  value={solarEndYear}
                  min={1900}
                  max={2250}
                  onChange={(e) => setSolarEndYear(Number(e.target.value) || 2035)}
                  className="w-16 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-1.5 py-0.5 font-mono-num text-xs"
                />
                <span>年</span>
              </div>

              <label className="flex cursor-pointer items-center gap-1.5 text-[11px]">
                <input
                  type="checkbox"
                  checked={visibleOnly}
                  onChange={(e) => {
                    setVisibleOnly(e.target.checked);
                    setSelectedSolarIdx(0);
                  }}
                />
                観測地で見える日食のみ
              </label>
            </div>

            {activeSolar && activeSolar.path_samples.length > 0 && (
              <div className="space-y-2 rounded-xl border border-[var(--border-subtle)] bg-[#040712] p-3">
                {(() => {
                  const idx = Math.min(simStep, activeSolar.path_samples.length - 1);
                  const smp = activeSolar.path_samples[idx];
                  const scale = 2.15;
                  const sunR = smp.sun_radius_arcmin * scale;
                  const moonR = smp.moon_radius_arcmin * scale;
                  const cx = 100;
                  const cy = 84;
                  const mx = cx - smp.moon_dx_arcmin * scale;
                  const my = cy - smp.moon_dy_arcmin * scale;

                  // Path bounds for Az-Alt solar continuous track
                  const azList = activeSolar.path_samples.map((p) => p.sun_az_deg);
                  const altList = activeSolar.path_samples.map((p) => p.sun_alt_deg);
                  const minAz = Math.min(...azList) - 4;
                  const maxAz = Math.max(...azList) + 4;
                  const minAlt = Math.min(-5, Math.min(...altList) - 4);
                  const maxAlt = Math.max(10, Math.max(...altList) + 4);
                  const pxOf = (az: number) => 22 + ((az - minAz) / Math.max(1, maxAz - minAz)) * 186;
                  const pyOf = (alt: number) => 145 - ((alt - minAlt) / Math.max(1, maxAlt - minAlt)) * 124;

                  return (
                    <>
                      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                        <span className="font-semibold text-amber-300">
                          {activeSolar.date_local_str} ・{activeSolar.global_type_ja} ({activeSolar.local_type_ja})
                        </span>
                        <span className="font-mono-num text-[10.5px]">
                          最大食分 {activeSolar.local_magnitude.toFixed(3)} ・開始 {activeSolar.start_time_str ?? "--"} / 最大 {activeSolar.max_time_str} / 終了 {activeSolar.end_time_str ?? "--"}
                        </span>
                      </div>

                      <div className="grid grid-cols-2 gap-2">
                        {/* Left: Contact Geometry */}
                        <svg viewBox="0 0 200 168" className="w-full rounded-lg border border-white/10 bg-[#02040a]">
                          <text x="8" y="13" fontSize="8.5" fill="#94a3b8">
                            太陽面・欠け方向 (食分 {smp.local_mag.toFixed(2)})
                          </text>
                          <text x="100" y="25" textAnchor="middle" fontSize="8" fill="#64748b">N</text>
                          {smp.local_mag >= 0.99 && (
                            <circle cx={cx} cy={cy} r={sunR + 12} fill="#fbbf24" opacity="0.22" />
                          )}
                          <circle cx={cx} cy={cy} r={sunR} fill="#fbbf24" />
                          <circle cx={mx} cy={my} r={moonR} fill="#060913" stroke="rgba(226,232,240,0.45)" strokeWidth="0.8" />
                          {activeSolar.first_contact_pa_deg !== null && (
                            <text x="10" y="159" fontSize="8.5" fill="#cbd5e1" fontFamily="monospace">
                              欠け始めPA: {activeSolar.first_contact_pa_deg.toFixed(0)}°
                            </text>
                          )}
                        </svg>

                        {/* Right: Continuous Solar Az-Alt Path */}
                        <svg viewBox="0 0 220 168" className="w-full rounded-lg border border-white/10 bg-[#02040a]">
                          <text x="8" y="13" fontSize="8.5" fill="#94a3b8">
                            太陽経路連続表示 (方位/高度)
                          </text>
                          <line
                            x1="18"
                            x2="210"
                            y1={pyOf(0)}
                            y2={pyOf(0)}
                            stroke="#34d399"
                            strokeWidth="1"
                            strokeDasharray="3 2"
                          />
                          <polyline
                            fill="none"
                            stroke="#f59e0b"
                            strokeWidth="1.5"
                            points={activeSolar.path_samples
                              .map((p) => `${pxOf(p.sun_az_deg).toFixed(1)},${pyOf(p.sun_alt_deg).toFixed(1)}`)
                              .join(" ")}
                          />
                          {activeSolar.path_samples.map((p, i) =>
                            i % 4 === 0 || i === idx ? (
                              <g key={p.jd_ut}>
                                <circle
                                  cx={pxOf(p.sun_az_deg)}
                                  cy={pyOf(p.sun_alt_deg)}
                                  r={i === idx ? 5.5 : 3.5}
                                  fill={i === idx ? "#38bdf8" : "#fbbf24"}
                                />
                              </g>
                            ) : null,
                          )}
                          <text x="10" y="159" fontSize="8.5" fill="#cbd5e1" fontFamily="monospace">
                            Az {smp.sun_az_deg.toFixed(0)}° Alt {smp.sun_alt_deg.toFixed(1)}°
                          </text>
                        </svg>
                      </div>

                      <div className="flex items-center gap-2 pt-1">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 px-2 text-[10.5px]"
                          onClick={() => setSimPlaying((v) => !v)}
                        >
                          {simPlaying ? <Pause className="h-3 w-3 mr-1" /> : <Play className="h-3 w-3 mr-1" />}
                          {simPlaying ? "停止" : "経過再生"}
                        </Button>
                        <input
                          type="range"
                          min={0}
                          max={activeSolar.path_samples.length - 1}
                          value={idx}
                          onChange={(e) => setSimStep(Number(e.target.value))}
                          className="flex-1 accent-amber-400"
                        />
                        <Button
                          size="sm"
                          className="h-7 gap-1 px-2.5 text-[10.5px]"
                          onClick={() =>
                            reproduceInSky(
                              smp.jd_ut,
                              activeSolar.ra_deg,
                              activeSolar.dec_deg,
                              smp.sun_az_deg,
                              smp.sun_alt_deg,
                            )
                          }
                        >
                          <Compass className="h-3 w-3" /> 星図で再現
                        </Button>
                      </div>
                    </>
                  );
                })()}
              </div>
            )}

            <div className="space-y-1">
              {solarLoading ? (
                <div className="py-6 text-center text-[var(--text-muted)]">日食を計算検索中...</div>
              ) : (
                filteredSolar.map((e, i) => (
                  <div
                    key={e.global_max_jd_ut}
                    onClick={() => setSelectedSolarIdx(i)}
                    onDoubleClick={() =>
                      reproduceInSky(e.local_max_jd_ut, e.ra_deg, e.dec_deg, e.max_sun_az_deg, e.max_sun_alt_deg)
                    }
                    className={`flex cursor-pointer items-center justify-between gap-2 rounded-xl border px-3 py-1.5 ${
                      selectedSolarIdx === i
                        ? "border-amber-400 bg-amber-400/12"
                        : "border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)]/60 hover:border-[var(--border-strong)]"
                    }`}
                  >
                    <div>
                      <div className="flex items-center gap-1.5 font-semibold">
                        <span className="font-mono-num">{e.date_local_str}</span>
                        <span>{e.global_type_ja}</span>
                        {e.visible_locally && (
                          <span className="rounded bg-emerald-500/20 px-1.5 py-0.2 text-[9.5px] text-emerald-300">
                            観測可 (食分 {e.local_magnitude.toFixed(2)})
                          </span>
                        )}
                      </div>
                      <div className="font-mono-num text-[10px] text-[var(--text-muted)]">
                        現地: {e.local_type_ja} ・太陽高度 {e.max_sun_alt_deg.toFixed(0)}°
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-6 px-2 text-[10px]"
                      onClick={(ev) => {
                        ev.stopPropagation();
                        reproduceInSky(
                          e.local_max_jd_ut,
                          e.ra_deg,
                          e.dec_deg,
                          e.max_sun_az_deg,
                          e.max_sun_alt_deg,
                        );
                      }}
                    >
                      再現
                    </Button>
                  </div>
                ))
              )}
            </div>
          </>
        )}

        {/* TAB 2: Lunar Eclipses */}
        {tab === "lunar" && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)]/65 px-3 py-2">
              <div className="flex items-center gap-1.5">
                <input
                  type="number"
                  value={lunarStartYear}
                  min={1900}
                  max={2200}
                  onChange={(e) => setLunarStartYear(Number(e.target.value) || 2026)}
                  className="w-16 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-1.5 py-0.5 font-mono-num text-xs"
                />
                <span>〜</span>
                <input
                  type="number"
                  value={lunarEndYear}
                  min={1900}
                  max={2250}
                  onChange={(e) => setLunarEndYear(Number(e.target.value) || 2035)}
                  className="w-16 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-1.5 py-0.5 font-mono-num text-xs"
                />
                <span>年</span>
              </div>
              <label className="flex cursor-pointer items-center gap-1.5 text-[11px]">
                <input
                  type="checkbox"
                  checked={visibleOnly}
                  onChange={(e) => {
                    setVisibleOnly(e.target.checked);
                    setSelectedLunarIdx(0);
                  }}
                />
                観測地で見える月食のみ
              </label>
            </div>

            {activeLunar && activeLunar.path_samples.length > 0 && (
              <div className="space-y-2 rounded-xl border border-[var(--border-subtle)] bg-[#040712] p-3">
                {(() => {
                  const idx = Math.min(simStep, activeLunar.path_samples.length - 1);
                  const smp = activeLunar.path_samples[idx];
                  const maxR = Math.max(85, smp.penumbra_radius_arcmin + 22);
                  const sc = 92 / maxR;
                  const cx = 210;
                  const cy = 104;
                  const mx = cx - smp.dx_arcmin * sc;
                  const my = cy - smp.dy_arcmin * sc;
                  const sep = Math.hypot(smp.dx_arcmin, smp.dy_arcmin);
                  const inUmbra = sep < smp.umbra_radius_arcmin + smp.moon_radius_arcmin * 0.5;

                  return (
                    <>
                      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                        <span className="font-semibold text-rose-300">
                          {activeLunar.date_local_str} ・{activeLunar.eclipse_type_ja}
                        </span>
                        <span className="font-mono-num text-[10.5px]">
                          本影食分 {activeLunar.umbral_magnitude.toFixed(2)} ・半影食分{" "}
                          {activeLunar.penumbral_magnitude.toFixed(2)}
                        </span>
                      </div>

                      <svg viewBox="0 0 420 208" className="w-full rounded-lg border border-white/10 bg-[#02040a]">
                        {/* Penumbra circle */}
                        <circle
                          cx={cx}
                          cy={cy}
                          r={smp.penumbra_radius_arcmin * sc}
                          fill="rgba(148, 163, 184, 0.16)"
                          stroke="rgba(148, 163, 184, 0.45)"
                          strokeDasharray="3 3"
                        />
                        {/* Umbra copper-red circle */}
                        <circle
                          cx={cx}
                          cy={cy}
                          r={smp.umbra_radius_arcmin * sc}
                          fill="rgba(153, 27, 27, 0.45)"
                          stroke="rgba(248, 113, 113, 0.72)"
                        />
                        <text x={cx + 4} y={cy - 4} fontSize="8.5" fill="#fca5a5">本影</text>
                        <text x={cx + smp.penumbra_radius_arcmin * sc - 26} y={cy - 6} fontSize="8.5" fill="#cbd5e1">半影</text>

                        {/* Moon path chord */}
                        <polyline
                          fill="none"
                          stroke="rgba(253, 230, 138, 0.55)"
                          strokeWidth="1.4"
                          strokeDasharray="2 3"
                          points={activeLunar.path_samples
                            .map((s) => `${(cx - s.dx_arcmin * sc).toFixed(1)},${(cy - s.dy_arcmin * sc).toFixed(1)}`)
                            .join(" ")}
                        />

                        {/* Animated Moon */}
                        <circle
                          cx={mx}
                          cy={my}
                          r={smp.moon_radius_arcmin * sc}
                          fill={inUmbra ? "#c2410c" : "#fef3c7"}
                          stroke="#ffffff"
                          strokeWidth="0.9"
                        />
                        <text x="10" y="198" fontSize="9" fill="#cbd5e1" fontFamily="monospace">
                          U1:{activeLunar.u1_str ?? "--"} | U2:{activeLunar.u2_str ?? "--"} | 最大:{activeLunar.max_str} | U3:{activeLunar.u3_str ?? "--"} | U4:{activeLunar.u4_str ?? "--"}
                        </text>
                      </svg>

                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 px-2 text-[10.5px]"
                          onClick={() => setSimPlaying((v) => !v)}
                        >
                          {simPlaying ? <Pause className="h-3 w-3 mr-1" /> : <Play className="h-3 w-3 mr-1" />}
                          {simPlaying ? "停止" : "通過再生"}
                        </Button>
                        <input
                          type="range"
                          min={0}
                          max={activeLunar.path_samples.length - 1}
                          value={idx}
                          onChange={(e) => setSimStep(Number(e.target.value))}
                          className="flex-1 accent-rose-400"
                        />
                        <Button
                          size="sm"
                          className="h-7 gap-1 px-2.5 text-[10.5px]"
                          onClick={() =>
                            reproduceInSky(
                              smp.jd_ut,
                              activeLunar.ra_deg,
                              activeLunar.dec_deg,
                              activeLunar.max_moon_az_deg,
                              smp.moon_alt_deg,
                            )
                          }
                        >
                          <Compass className="h-3 w-3" /> 星図で再現
                        </Button>
                      </div>
                    </>
                  );
                })()}
              </div>
            )}

            <div className="space-y-1">
              {lunarLoading ? (
                <div className="py-6 text-center text-[var(--text-muted)]">月食を計算検索中...</div>
              ) : (
                filteredLunar.map((e, i) => (
                  <div
                    key={e.max_jd_ut}
                    onClick={() => setSelectedLunarIdx(i)}
                    onDoubleClick={() =>
                      reproduceInSky(e.max_jd_ut, e.ra_deg, e.dec_deg, e.max_moon_az_deg, e.max_moon_alt_deg)
                    }
                    className={`flex cursor-pointer items-center justify-between gap-2 rounded-xl border px-3 py-1.5 ${
                      selectedLunarIdx === i
                        ? "border-rose-400 bg-rose-400/12"
                        : "border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)]/60 hover:border-[var(--border-strong)]"
                    }`}
                  >
                    <div>
                      <div className="flex items-center gap-1.5 font-semibold">
                        <span className="font-mono-num">{e.date_local_str}</span>
                        <span>{e.eclipse_type_ja}</span>
                        {e.visible_locally && (
                          <span className="rounded bg-emerald-500/20 px-1.5 py-0.2 text-[9.5px] text-emerald-300">
                            観測可
                          </span>
                        )}
                      </div>
                      <div className="font-mono-num text-[10px] text-[var(--text-muted)]">
                        本影食分 {e.umbral_magnitude.toFixed(2)} ・最大月高度 {e.max_moon_alt_deg.toFixed(0)}°
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-6 px-2 text-[10px]"
                      onClick={(ev) => {
                        ev.stopPropagation();
                        reproduceInSky(
                          e.max_jd_ut,
                          e.ra_deg,
                          e.dec_deg,
                          e.max_moon_az_deg,
                          e.max_moon_alt_deg,
                        );
                      }}
                    >
                      再現
                    </Button>
                  </div>
                ))
              )}
            </div>
          </>
        )}

        {/* TAB 3: Planetary Transits */}
        {tab === "transit" && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)]/65 px-3 py-2">
              <div className="flex items-center gap-1.5">
                <input
                  type="number"
                  value={transitStartYear}
                  min={1850}
                  max={2200}
                  onChange={(e) => setTransitStartYear(Number(e.target.value) || 2020)}
                  className="w-16 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-1.5 py-0.5 font-mono-num text-xs"
                />
                <span>〜</span>
                <input
                  type="number"
                  value={transitEndYear}
                  min={1850}
                  max={2250}
                  onChange={(e) => setTransitEndYear(Number(e.target.value) || 2055)}
                  className="w-16 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-1.5 py-0.5 font-mono-num text-xs"
                />
                <span>年</span>
              </div>
              <div className="flex gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 px-2 text-[10px]"
                  onClick={() => {
                    setTransitStartYear(2020);
                    setTransitEndYear(2055);
                  }}
                >
                  2020–2055
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 px-2 text-[10px]"
                  onClick={() => {
                    setTransitStartYear(2000);
                    setTransitEndYear(2125);
                  }}
                >
                  2000–2125 (金星含む)
                </Button>
              </div>
            </div>

            {activeTransit && activeTransit.path_samples.length > 0 && (
              <div className="space-y-2 rounded-xl border border-[var(--border-subtle)] bg-[#040712] p-3">
                {(() => {
                  const idx = Math.min(simStep, activeTransit.path_samples.length - 1);
                  const smp = activeTransit.path_samples[idx];
                  const sunR = 72;
                  const scale = sunR / Math.max(10, activeTransit.sun_radius_arcmin);
                  const cx = 210;
                  const cy = 96;
                  const px = cx - smp.dx_arcmin * scale;
                  const py = cy - smp.dy_arcmin * scale;
                  const pDotR = activeTransit.planet_id === "venus" ? 4.2 : 2.3;

                  return (
                    <>
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="font-semibold text-amber-300">
                          {activeTransit.date_local_str} ・{activeTransit.planet_name_ja}の日面通過
                        </span>
                        <span className="font-mono-num text-[10.5px]">
                          C1:{activeTransit.c1_str ?? "--"} / 最大:{activeTransit.max_str} / C4:{activeTransit.c4_str ?? "--"}
                        </span>
                      </div>

                      <svg viewBox="0 0 420 192" className="w-full rounded-lg border border-white/10 bg-[#02040a]">
                        <circle cx={cx} cy={cy} r={sunR} fill="#fbbf24" />
                        <polyline
                          fill="none"
                          stroke="rgba(15, 23, 42, 0.55)"
                          strokeWidth="1.2"
                          strokeDasharray="3 2"
                          points={activeTransit.path_samples
                            .map((s) => `${(cx - s.dx_arcmin * scale).toFixed(1)},${(cy - s.dy_arcmin * scale).toFixed(1)}`)
                            .join(" ")}
                        />
                        <circle cx={px} cy={py} r={pDotR} fill="#090d16" />
                        <text x="10" y="182" fontSize="9" fill="#cbd5e1" fontFamily="monospace">
                          最小中心角距離 {activeTransit.min_sep_arcmin.toFixed(1)}&apos; ・太陽高度 {smp.sun_alt_deg.toFixed(1)}°
                        </text>
                      </svg>

                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 px-2 text-[10.5px]"
                          onClick={() => setSimPlaying((v) => !v)}
                        >
                          {simPlaying ? <Pause className="h-3 w-3 mr-1" /> : <Play className="h-3 w-3 mr-1" />}
                          {simPlaying ? "停止" : "通過再生"}
                        </Button>
                        <input
                          type="range"
                          min={0}
                          max={activeTransit.path_samples.length - 1}
                          value={idx}
                          onChange={(e) => setSimStep(Number(e.target.value))}
                          className="flex-1 accent-amber-400"
                        />
                        <Button
                          size="sm"
                          className="h-7 gap-1 px-2.5 text-[10.5px]"
                          onClick={() =>
                            reproduceInSky(smp.jd_ut, activeTransit.ra_deg, activeTransit.dec_deg)
                          }
                        >
                          <Compass className="h-3 w-3" /> 星図で再現
                        </Button>
                      </div>
                    </>
                  );
                })()}
              </div>
            )}

            <div className="space-y-1">
              {transitLoading ? (
                <div className="py-6 text-center text-[var(--text-muted)]">日面通過を探索中...</div>
              ) : transitList.length === 0 ? (
                <div className="py-6 text-center text-[var(--text-muted)]">
                  指定期間内の日面通過はありません
                </div>
              ) : (
                transitList.map((t, i) => (
                  <div
                    key={t.max_jd_ut}
                    onClick={() => setSelectedTransitIdx(i)}
                    onDoubleClick={() => reproduceInSky(t.max_jd_ut, t.ra_deg, t.dec_deg)}
                    className={`flex cursor-pointer items-center justify-between gap-2 rounded-xl border px-3 py-1.5 ${
                      selectedTransitIdx === i
                        ? "border-amber-400 bg-amber-400/12"
                        : "border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)]/60"
                    }`}
                  >
                    <div>
                      <div className="flex items-center gap-1.5 font-semibold">
                        <span className="font-mono-num">{t.date_local_str}</span>
                        <span>{t.planet_name_ja}の日面通過</span>
                        {t.visible_locally && (
                          <span className="rounded bg-emerald-500/20 px-1.5 py-0.2 text-[9.5px] text-emerald-300">
                            観測可
                          </span>
                        )}
                      </div>
                      <div className="font-mono-num text-[10px] text-[var(--text-muted)]">
                        {t.c1_str ?? "--"} 〜 {t.c4_str ?? "--"} ・太陽高度 {t.max_sun_alt_deg.toFixed(0)}°
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-6 px-2 text-[10px]"
                      onClick={(ev) => {
                        ev.stopPropagation();
                        reproduceInSky(t.max_jd_ut, t.ra_deg, t.dec_deg);
                      }}
                    >
                      再現
                    </Button>
                  </div>
                ))
              )}
            </div>
          </>
        )}

        {/* TAB 4: Lunar Occultations */}
        {tab === "occultation" && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)]/65 px-3 py-2">
              <div className="flex items-center gap-1.5">
                <span>期間:</span>
                {[30, 90, 180, 365].map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setOccDays(d)}
                    className={`rounded border px-2 py-0.5 font-mono-num text-[10.5px] ${
                      occDays === d
                        ? "border-[var(--accent-primary)] bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]"
                        : "border-[var(--border-subtle)] bg-[var(--bg-surface)]"
                    }`}
                  >
                    {d}日
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-1.5">
                <span>≦</span>
                <select
                  value={occMagLimit}
                  onChange={(e) => setOccMagLimit(Number(e.target.value))}
                  className="rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 py-0.5 font-mono-num"
                >
                  <option value={2.5}>2.5等 (惑星/1等星)</option>
                  <option value={4.0}>4.0等</option>
                  <option value={5.0}>5.0等 (双眼鏡)</option>
                </select>
                <RefreshCw className={`h-3.5 w-3.5 ${occLoading ? "animate-spin text-[var(--accent-primary)]" : "text-[var(--text-muted)]"}`} />
              </div>
            </div>

            {occLoading ? (
              <div className="py-10 text-center text-[var(--text-muted)]">
                {location.name_ja} での月による星食・惑星食を計算中...
              </div>
            ) : occList.length === 0 ? (
              <div className="py-10 text-center text-[var(--text-muted)]">
                指定期間内に {occMagLimit}等 以下の星食・惑星食はありません（期間を365日等へ延ばしてください）
              </div>
            ) : (
              <div className="space-y-1.5">
                {occList.map((o, i) => (
                  <div
                    key={`${o.target_id}-${i}`}
                    onDoubleClick={() =>
                      reproduceInSky(o.immersion_jd_ut, o.ra_deg, o.dec_deg, o.moon_az_deg, o.moon_alt_deg)
                    }
                    className="flex cursor-pointer items-center justify-between gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)]/60 px-3 py-2 hover:border-[var(--accent-primary)]"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5 font-semibold">
                        <span className="font-mono-num text-[11px] text-[var(--accent-primary)]">
                          {o.date_local_str}
                        </span>
                        <span>{o.target_name_ja}</span>
                        <span className="font-mono-num text-[10px] text-[var(--text-muted)]">
                          ({o.mag.toFixed(1)}等)
                        </span>
                        <span
                          className={`rounded px-1.5 py-0.2 text-[9.5px] ${
                            o.dark_limb_immersion
                              ? "bg-emerald-500/20 text-emerald-300"
                              : "bg-slate-500/20 text-slate-300"
                          }`}
                        >
                          {o.dark_limb_immersion ? "暗縁潜入" : "明縁潜入"}
                        </span>
                      </div>
                      <div className="mt-0.5 font-mono-num text-[10px] text-[var(--text-muted)]">
                        潜入 {o.immersion_str} → 出現 {o.emersion_str} ・月高度 {o.moon_alt_deg.toFixed(0)}° ・輝面 {o.moon_illum_pct.toFixed(0)}% ・太陽 {o.sun_alt_deg.toFixed(0)}°
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 shrink-0 px-2 text-[10.5px]"
                      onClick={() =>
                        reproduceInSky(o.immersion_jd_ut, o.ra_deg, o.dec_deg, o.moon_az_deg, o.moon_alt_deg)
                      }
                    >
                      潜入再現
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
