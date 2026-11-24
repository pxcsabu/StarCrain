import { useMemo, useState } from "react";
import { Crosshair, Eye, Moon, Plus, Search, Trash2, TrendingUp, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  applyStandardRefractionDeg,
  equatorialToHorizontalFast,
  wrapDeg360,
} from "@/lib/projection";
import { localYmdHmsToJdUt, useSkyStore } from "@/store/skyStore";
import type { AltitudeTargetItem } from "@/types/sky";

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
const SAMPLE_COUNT = 85; // 17:00 -> 07:00 (14 hours at 10-min steps)

function gmstDegAtJdUt(jdUt: number): number {
  const t = (jdUt - 2451545.0) / 36525.0;
  return wrapDeg360(
    280.46061837 +
      360.98564736629 * (jdUt - 2451545.0) +
      0.000387933 * t * t -
      (t * t * t) / 38710000.0,
  );
}

function sunEqAtJdTt(jdTt: number): { raDeg: number; decDeg: number } {
  const T = (jdTt - 2451545.0) / 36525.0;
  const L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T;
  const M = (357.52911 + 35999.05029 * T - 0.0001537 * T * T) * DEG2RAD;
  const C =
    (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(M) +
    (0.019993 - 0.000101 * T) * Math.sin(2 * M) +
    0.000289 * Math.sin(3 * M);
  const om = (125.04 - 1934.136 * T) * DEG2RAD;
  const lam = (L0 + C - 0.00569 - 0.00478 * Math.sin(om)) * DEG2RAD;
  const eps = (23.439291 - 0.0130042 * T) * DEG2RAD;
  const raDeg = wrapDeg360(Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam)) * RAD2DEG);
  const decDeg = Math.asin(Math.max(-1, Math.min(1, Math.sin(eps) * Math.sin(lam)))) * RAD2DEG;
  return { raDeg, decDeg };
}

function moonEqAtJdTt(jdTt: number): { raDeg: number; decDeg: number } {
  const T = (jdTt - 2451545.0) / 36525.0;
  const Lp = wrapDeg360(218.3164477 + 481267.88123421 * T);
  const D = wrapDeg360(297.8501921 + 445267.1114034 * T) * DEG2RAD;
  const M = wrapDeg360(357.5291092 + 35999.0502909 * T) * DEG2RAD;
  const Mp = wrapDeg360(134.9633964 + 477198.8675055 * T) * DEG2RAD;
  const F = wrapDeg360(93.272095 + 483202.0175233 * T) * DEG2RAD;

  const lam =
    (Lp +
      6.289 * Math.sin(Mp) -
      1.274 * Math.sin(Mp - 2 * D) +
      0.658 * Math.sin(2 * D) +
      0.214 * Math.sin(2 * Mp) -
      0.186 * Math.sin(M) -
      0.114 * Math.sin(2 * F)) *
    DEG2RAD;
  const beta =
    (5.128 * Math.sin(F) +
      0.281 * Math.sin(Mp + F) -
      0.278 * Math.sin(F - Mp) -
      0.173 * Math.sin(2 * D - F)) *
    DEG2RAD;
  const eps = (23.439291 - 0.0130042 * T) * DEG2RAD;

  const cosB = Math.cos(beta);
  const sinB = Math.sin(beta);
  const sinL = Math.sin(lam);
  const cosL = Math.cos(lam);
  const cosE = Math.cos(eps);
  const sinE = Math.sin(eps);

  const y = sinL * cosE - (sinB / Math.max(1e-6, cosB)) * sinE;
  const x = cosL;
  const raDeg = wrapDeg360(Math.atan2(y, x) * RAD2DEG);
  const decDeg = Math.asin(Math.max(-1, Math.min(1, sinB * cosE + cosB * sinE * sinL))) * RAD2DEG;
  return { raDeg, decDeg };
}

function j2000ToApparentRaDec(
  raDeg: number,
  decDeg: number,
  m: number[][] | undefined,
): { raDeg: number; decDeg: number } {
  if (!m || m.length < 3) return { raDeg, decDeg };
  const ra = raDeg * DEG2RAD;
  const dec = decDeg * DEG2RAD;
  const cd = Math.cos(dec);
  const vx = cd * Math.cos(ra);
  const vy = cd * Math.sin(ra);
  const vz = Math.sin(dec);
  const ax = m[0][0] * vx + m[0][1] * vy + m[0][2] * vz;
  const ay = m[1][0] * vx + m[1][1] * vy + m[1][2] * vz;
  const az = m[2][0] * vx + m[2][1] * vy + m[2][2] * vz;
  return {
    raDeg: wrapDeg360(Math.atan2(ay, ax) * RAD2DEG),
    decDeg: Math.asin(Math.max(-1, Math.min(1, az))) * RAD2DEG,
  };
}

function twilightColor(sunAlt: number): string {
  if (sunAlt >= 0) return "rgba(56, 189, 248, 0.24)";
  if (sunAlt >= -6) return "rgba(249, 115, 22, 0.16)";
  if (sunAlt >= -12) return "rgba(59, 130, 246, 0.13)";
  if (sunAlt >= -18) return "rgba(30, 58, 138, 0.14)";
  return "rgba(2, 6, 20, 0.55)";
}

function twilightLabelJa(sunAlt: number): string {
  if (sunAlt >= 0) return "昼間";
  if (sunAlt >= -6) return "市民薄明";
  if (sunAlt >= -12) return "航海薄明";
  if (sunAlt >= -18) return "天文薄明";
  return "暗夜";
}

function formatOffsetHour(offsetMin: number): string {
  const totalMin = (17 * 60 + offsetMin) % (24 * 60);
  const h = Math.floor(totalMin / 60);
  const m = Math.round(totalMin % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

const QUICK_PICKS: {
  id: string;
  nameJa: string;
  kind: AltitudeTargetItem["kind"];
  raDeg: number;
  decDeg: number;
}[] = [
  { id: "dso:M31", nameJa: "M31 アンドロメダ", kind: "dso", raDeg: 10.6847, decDeg: 41.2688 },
  { id: "dso:M42", nameJa: "M42 オリオン", kind: "dso", raDeg: 83.8221, decDeg: -5.3911 },
  { id: "dso:M45", nameJa: "M45 すばる", kind: "dso", raDeg: 56.75, decDeg: 24.1167 },
  { id: "dso:M13", nameJa: "M13 ヘルクレス", kind: "dso", raDeg: 250.423, decDeg: 36.46 },
  { id: "dso:M51", nameJa: "M51 子持ち銀河", kind: "dso", raDeg: 202.47, decDeg: 47.195 },
  { id: "dso:M8", nameJa: "M8 干潟星雲", kind: "dso", raDeg: 270.92, decDeg: -24.38 },
  { id: "jupiter", nameJa: "木星", kind: "planet", raDeg: 75, decDeg: 22 },
  { id: "saturn", nameJa: "土星", kind: "planet", raDeg: 350, decDeg: -6 },
  { id: "mars", nameJa: "火星", kind: "planet", raDeg: 120, decDeg: 20 },
  { id: "venus", nameJa: "金星", kind: "planet", raDeg: 260, decDeg: -23 },
];

export function AltitudePlanner() {
  const skyFrame = useSkyStore((s) => s.skyFrame);
  const location = useSkyStore((s) => s.location);
  const jdUt = useSkyStore((s) => s.jdUt);
  const staticAssets = useSkyStore((s) => s.staticAssets);
  const refractionEnabled = useSkyStore((s) => s.refractionEnabled);
  const selectedObject = useSkyStore((s) => s.selectedObject);
  const altitudeTargets = useSkyStore((s) => s.altitudeTargets);

  const addAltitudeTarget = useSkyStore((s) => s.addAltitudeTarget);
  const removeAltitudeTarget = useSkyStore((s) => s.removeAltitudeTarget);
  const centerOnSkyCoords = useSkyStore((s) => s.centerOnSkyCoords);
  const jumpToJdUt = useSkyStore((s) => s.jumpToJdUt);
  const setActivePanel = useSkyStore((s) => s.setActivePanel);

  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [showMoonCurve, setShowMoonCurve] = useState(true);
  const [searchText, setSearchText] = useState("");

  const curYear = skyFrame?.local_dt.year ?? new Date().getFullYear();
  const curMonth = skyFrame?.local_dt.month ?? new Date().getMonth() + 1;
  const curDay = skyFrame?.local_dt.day ?? new Date().getDate();
  const hasSkyFrame = skyFrame !== null;

  const nightData = useMemo(() => {
    const latestFrame = useSkyStore.getState().skyFrame;
    const startJd = localYmdHmsToJdUt(
      curYear,
      curMonth,
      curDay,
      17,
      0,
      0,
      location.tz_offset_min,
    );

    const times: { jdUt: number; label: string; lastDeg: number; sunAlt: number; moonAlt: number }[] =
      [];
    for (let i = 0; i < SAMPLE_COUNT; i++) {
      const tJd = startJd + (i * 10) / 1440;
      const jdTt = tJd + 69.2 / 86400;
      const lastDeg = wrapDeg360(gmstDegAtJdUt(tJd) + location.lon_deg);
      const sunEq = sunEqAtJdTt(jdTt);
      const sunHor = equatorialToHorizontalFast(sunEq.raDeg, sunEq.decDeg, location.lat_deg, lastDeg);
      const moonEq = moonEqAtJdTt(jdTt);
      const moonGeo = equatorialToHorizontalFast(
        moonEq.raDeg,
        moonEq.decDeg,
        location.lat_deg,
        lastDeg,
      );
      const moonAlt = moonGeo.altDeg - 0.95 * Math.cos(moonGeo.altDeg * DEG2RAD);
      times.push({
        jdUt: tJd,
        label: formatOffsetHour(i * 10),
        lastDeg,
        sunAlt: sunHor.altDeg,
        moonAlt,
      });
    }

    const curves = altitudeTargets.map((target) => {
      const liveBody =
        target.kind === "planet" ||
        target.kind === "moon" ||
        target.kind === "sun" ||
        target.kind === "comet"
          ? latestFrame?.bodies.find(
              (b) => b.id === target.id || b.id === target.id.replace(/^(planet|moon|sun|comet):/, ""),
            )
          : undefined;
      const eq = liveBody
        ? { raDeg: liveBody.ra_deg, decDeg: liveBody.dec_deg }
        : j2000ToApparentRaDec(
            target.raDeg,
            target.decDeg,
            latestFrame?.j2000_to_apparent_matrix,
          );

      let maxAlt = -90;
      let maxIdx = 0;
      let bestWindowStart: string | null = null;
      let bestWindowEnd: string | null = null;

      const alts = times.map((tp, idx) => {
        const hor = equatorialToHorizontalFast(eq.raDeg, eq.decDeg, location.lat_deg, tp.lastDeg);
        const alt = refractionEnabled ? applyStandardRefractionDeg(hor.altDeg) : hor.altDeg;
        if (alt > maxAlt) {
          maxAlt = alt;
          maxIdx = idx;
        }
        if (alt >= 30 && tp.sunAlt <= -12) {
          if (bestWindowStart === null) bestWindowStart = tp.label;
          bestWindowEnd = tp.label;
        }
        return alt;
      });

      return {
        target,
        eq,
        alts,
        maxAlt,
        transitLabel: times[maxIdx]?.label ?? "--:--",
        bestWindowText:
          bestWindowStart && bestWindowEnd
            ? `${bestWindowStart}〜${bestWindowEnd}`
            : maxAlt >= 15
              ? "低空のみ"
              : "観測不適",
      };
    });

    return {
      dateLabel: `${curYear}-${String(curMonth).padStart(2, "0")}-${String(curDay).padStart(2, "0")}`,
      startJd,
      endJd: times[times.length - 1].jdUt,
      times,
      curves,
    };
  }, [curYear, curMonth, curDay, hasSkyFrame, location.lat_deg, location.lon_deg, location.tz_offset_min, altitudeTargets, refractionEnabled]);

  const searchSuggestions = useMemo(() => {
    const q = searchText.trim().toLowerCase();
    if (!q || !staticAssets) return [];
    const results: Omit<AltitudeTargetItem, "color">[] = [];
    for (const d of staticAssets.dsos) {
      const mLabel = d.messier ? `M${d.messier}` : d.id;
      const hay = `${mLabel} ${d.name_ja ?? ""} ${d.name_en}`.toLowerCase();
      if (hay.includes(q)) {
        results.push({
          id: `dso:${mLabel}`,
          nameJa: d.messier ? `M${d.messier} ${d.name_ja ?? d.name_en}` : d.name_ja ?? d.id,
          kind: "dso",
          raDeg: d.ra_deg,
          decDeg: d.dec_deg,
        });
      }
      if (results.length >= 6) break;
    }
    if (results.length < 8) {
      for (const s of staticAssets.named_stars) {
        const hay = `${s.name_ja ?? ""} ${s.proper_name}`.toLowerCase();
        if (hay.includes(q)) {
          results.push({
            id: `star:${s.hip}`,
            nameJa: s.name_ja ?? s.proper_name,
            kind: "star",
            raDeg: s.ra_deg,
            decDeg: s.dec_deg,
          });
        }
        if (results.length >= 8) break;
      }
    }
    return results;
  }, [searchText, staticAssets]);

  // SVG coordinate system
  const svgW = 560;
  const svgH = 250;
  const padL = 34;
  const padR = 12;
  const padT = 14;
  const padB = 26;
  const plotW = svgW - padL - padR;
  const plotH = svgH - padT - padB;
  const xOf = (idx: number) => padL + (idx / (SAMPLE_COUNT - 1)) * plotW;
  const yOf = (alt: number) => {
    const clamped = Math.max(-5, Math.min(90, alt));
    return padT + plotH - ((clamped + 5) / 95) * plotH;
  };
  const yZero = yOf(0);
  const nowRatio =
    jdUt >= nightData.startJd && jdUt <= nightData.endJd
      ? (jdUt - nightData.startJd) / (nightData.endJd - nightData.startJd)
      : null;

  const hoverTime = hoverIdx !== null ? nightData.times[hoverIdx] : null;

  return (
    <aside className="flex h-full w-[35rem] max-w-[calc(100vw-5.5rem)] flex-col rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface-glass)] text-[var(--text-primary)] shadow-2xl backdrop-blur-md">
      {/* Header */}
      <div className="flex items-start justify-between gap-2 border-b border-[var(--border-subtle)] px-4 py-3">
        <div>
          <h2 className="flex items-center gap-1.5 text-sm font-semibold tracking-tight">
            <TrendingUp className="h-4 w-4 text-sky-400" /> 今夜の高度グラフ・観測プランナー
          </h2>
          <p className="text-[11px] text-[var(--text-muted)]">
            {nightData.dateLabel} 夕〜翌朝 · {location.name_ja}（クリックで星図時刻を移動）
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant={showMoonCurve ? "tonal" : "ghost"}
            size="sm"
            className="h-7 gap-1 px-2 text-[11px]"
            onClick={() => setShowMoonCurve((v) => !v)}
            title="月の高度曲線を表示切替"
          >
            <Moon className="h-3.5 w-3.5" />
            月
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => setActivePanel(null)}
            title="閉じる"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3.5 text-xs">
        {/* Interactive Multi-Target SVG Chart */}
        <div className="flex flex-col gap-1.5 rounded-2xl border border-[var(--border-subtle)] bg-white/[0.03] p-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2 px-0.5 text-[11px]">
            <span className="font-mono-num text-[var(--text-secondary)]">
              {hoverTime
                ? `${hoverTime.label} (${twilightLabelJa(hoverTime.sunAlt)}) · 月高度 ${hoverTime.moonAlt.toFixed(0)}°`
                : "曲線上にカーソルを合わせると高度詳細を表示"}
            </span>
            <span className="text-[10px] text-[var(--text-muted)]">破線 = 高度 30°（好条件目安）</span>
          </div>

          <svg
            viewBox={`0 0 ${svgW} ${svgH}`}
            className="min-h-[195px] w-full cursor-crosshair select-none rounded-xl border border-white/10 bg-[#040814]/70"
            onMouseMove={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const svgX = ((e.clientX - rect.left) / rect.width) * svgW;
              const rel = Math.max(0, Math.min(1, (svgX - padL) / plotW));
              setHoverIdx(Math.round(rel * (SAMPLE_COUNT - 1)));
            }}
            onMouseLeave={() => setHoverIdx(null)}
            onClick={() => {
              if (hoverIdx !== null && nightData.times[hoverIdx]) {
                jumpToJdUt(nightData.times[hoverIdx].jdUt);
              }
            }}
          >
            <defs>
              <clipPath id="planner-plot-clip">
                <rect x={padL} y={padT} width={plotW} height={plotH} />
              </clipPath>
            </defs>

            {/* Twilight vertical bands */}
            {nightData.times.slice(0, -1).map((pt, idx) => {
              const next = nightData.times[idx + 1];
              const x1 = xOf(idx);
              const x2 = xOf(idx + 1);
              return (
                <rect
                  key={idx}
                  x={x1}
                  y={padT}
                  width={Math.max(1, x2 - x1 + 0.5)}
                  height={plotH}
                  fill={twilightColor((pt.sunAlt + next.sunAlt) * 0.5)}
                />
              );
            })}

            {/* Horizontal altitude lines */}
            {[0, 30, 60, 90].map((alt) => {
              const y = yOf(alt);
              const isHor = alt === 0;
              const isMinObs = alt === 30;
              return (
                <g key={alt}>
                  <line
                    x1={padL}
                    x2={padL + plotW}
                    y1={y}
                    y2={y}
                    stroke={
                      isHor
                        ? "#34d399"
                        : isMinObs
                          ? "rgba(56, 189, 248, 0.35)"
                          : "rgba(148, 163, 184, 0.2)"
                    }
                    strokeWidth={isHor ? 1.2 : 0.8}
                    strokeDasharray={isHor ? undefined : "3 3"}
                  />
                  <text
                    x={padL - 5}
                    y={y + 3}
                    textAnchor="end"
                    fill={isHor ? "#6ee7b7" : "#94a3b8"}
                    fontSize="9"
                    fontFamily="monospace"
                  >
                    {alt}°
                  </text>
                </g>
              );
            })}

            {/* Time ticks (every 2 hours: 17, 19, 21, 23, 01, 03, 05, 07) */}
            {nightData.times.map((tp, idx) => {
              if (idx % 12 !== 0) return null;
              const x = xOf(idx);
              return (
                <g key={tp.label}>
                  <line
                    x1={x}
                    x2={x}
                    y1={padT}
                    y2={padT + plotH}
                    stroke="rgba(148, 163, 184, 0.14)"
                    strokeWidth="0.7"
                  />
                  <text
                    x={x}
                    y={svgH - 8}
                    textAnchor="middle"
                    fill="#94a3b8"
                    fontSize="9"
                    fontFamily="monospace"
                  >
                    {tp.label}
                  </text>
                </g>
              );
            })}

            {/* Below-horizon dim fill */}
            <rect
              x={padL}
              y={yZero}
              width={plotW}
              height={Math.max(0, padT + plotH - yZero)}
              fill="rgba(2, 4, 12, 0.45)"
            />

            {/* Optional Moon Curve */}
            {showMoonCurve && (
              <polyline
                fill="none"
                stroke="rgba(226, 232, 240, 0.55)"
                strokeWidth="1.4"
                strokeDasharray="4 3"
                clipPath="url(#planner-plot-clip)"
                points={nightData.times
                  .map((tp, i) => `${xOf(i).toFixed(1)},${yOf(tp.moonAlt).toFixed(1)}`)
                  .join(" ")}
              />
            )}

            {/* Target Altitude Polylines */}
            {nightData.curves.map((c) => (
              <g key={c.target.id} clipPath="url(#planner-plot-clip)">
                <polyline
                  fill="none"
                  stroke={c.target.color}
                  strokeWidth="2.1"
                  strokeLinejoin="round"
                  points={c.alts
                    .map((alt, i) => `${xOf(i).toFixed(1)},${yOf(alt).toFixed(1)}`)
                    .join(" ")}
                />
              </g>
            ))}

            {/* Current simulation time indicator */}
            {nowRatio !== null && (
              <g>
                <line
                  x1={padL + nowRatio * plotW}
                  x2={padL + nowRatio * plotW}
                  y1={padT}
                  y2={padT + plotH}
                  stroke="#fbbf24"
                  strokeWidth="1.3"
                  strokeDasharray="2 2"
                />
                <text
                  x={padL + nowRatio * plotW + 3}
                  y={padT + 10}
                  fill="#fbbf24"
                  fontSize="8.5"
                  fontFamily="sans-serif"
                >
                  現在
                </text>
              </g>
            )}

            {/* Hover crosshair & dots */}
            {hoverIdx !== null && (
              <g>
                <line
                  x1={xOf(hoverIdx)}
                  x2={xOf(hoverIdx)}
                  y1={padT}
                  y2={padT + plotH}
                  stroke="rgba(255, 255, 255, 0.5)"
                  strokeWidth="1"
                />
                {nightData.curves.map((c) => {
                  const a = c.alts[hoverIdx];
                  if (a < -5) return null;
                  return (
                    <circle
                      key={c.target.id}
                      cx={xOf(hoverIdx)}
                      cy={yOf(a)}
                      r="3.5"
                      fill={c.target.color}
                      stroke="#020617"
                      strokeWidth="1"
                    />
                  );
                })}
              </g>
            )}
          </svg>
        </div>

        {/* Target Curves Summary List */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="font-semibold text-[var(--text-secondary)]">
              登録中の観測対象（{nightData.curves.length}/8）
            </span>
            {selectedObject && (
              <Button
                type="button"
                size="sm"
                variant="tonal"
                className="h-7 gap-1 px-2.5 text-[11px]"
                onClick={() =>
                  addAltitudeTarget({
                    id:
                      selectedObject.kind === "planet" ||
                      selectedObject.kind === "moon" ||
                      selectedObject.kind === "sun" ||
                      selectedObject.kind === "comet" ||
                      selectedObject.kind === "dwarf_planet"
                        ? selectedObject.id
                        : `${selectedObject.kind}:${selectedObject.id}`,
                    nameJa: selectedObject.name_ja,
                    kind: selectedObject.kind === "dwarf_planet" ? "planet" : selectedObject.kind,
                    raDeg: selectedObject.ra_deg,
                    decDeg: selectedObject.dec_deg,
                  })
                }
              >
                <Plus className="h-3.5 w-3.5" />
                選択中（{selectedObject.name_ja}）を追加
              </Button>
            )}
          </div>

          <div className="grid gap-1.5 sm:grid-cols-2">
            {nightData.curves.map((c) => {
              const curAlt = hoverIdx !== null ? c.alts[hoverIdx] : null;
              return (
                <div
                  key={c.target.id}
                  className="flex items-center justify-between gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-2.5 py-1.5"
                >
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 text-left hover:opacity-85"
                    onClick={() => centerOnSkyCoords(c.eq.raDeg, c.eq.decDeg)}
                    title="星図の中央へ移動"
                  >
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: c.target.color }}
                    />
                    <div className="min-w-0">
                      <div className="truncate font-semibold">{c.target.nameJa}</div>
                      <div className="truncate font-mono-num text-[10px] text-[var(--text-muted)]">
                        {curAlt !== null
                          ? `高度 ${curAlt.toFixed(1)}°`
                          : `南中 ${c.transitLabel} (${c.maxAlt.toFixed(0)}°) · ${c.bestWindowText}`}
                      </div>
                    </div>
                  </button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-6 w-6 shrink-0"
                    onClick={() => centerOnSkyCoords(c.eq.raDeg, c.eq.decDeg)}
                    title="星図に表示"
                  >
                    <Crosshair className="h-3 w-3" />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-6 w-6 shrink-0 text-[var(--text-muted)] hover:text-rose-400"
                    onClick={() => removeAltitudeTarget(c.target.id)}
                    title="リストから外す"
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              );
            })}
          </div>
        </div>

        {/* Add Target Quick Picks & Search */}
        <div className="space-y-2 border-t border-[var(--border-subtle)] pt-2.5">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]" />
            <input
              type="text"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder="天体を追加検索（例: M31, NGC7000, オリオン, シリウス...）"
              className="w-full rounded-xl border border-white/10 bg-black/25 py-1.5 pr-3 pl-8 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none focus:border-[var(--accent-primary)]"
            />
          </div>

          {searchSuggestions.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {searchSuggestions.map((s) => (
                <Button
                  key={s.id}
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-6 gap-1 px-2 text-[10.5px]"
                  onClick={() => {
                    addAltitudeTarget(s);
                    setSearchText("");
                  }}
                >
                  <Plus className="h-3 w-3" />
                  {s.nameJa}
                </Button>
              ))}
            </div>
          )}

          <div className="flex flex-wrap gap-1">
            {QUICK_PICKS.map((p) => {
              const exists = altitudeTargets.some((t) => t.id === p.id);
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() =>
                    exists ? removeAltitudeTarget(p.id) : addAltitudeTarget(p)
                  }
                  className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] transition ${
                    exists
                      ? "m3-tonal-active border-transparent font-medium"
                      : "border-white/10 bg-white/[0.04] text-[var(--text-secondary)] hover:bg-white/10"
                  }`}
                >
                  {exists ? <Eye className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
                  {p.nameJa}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </aside>
  );
}
