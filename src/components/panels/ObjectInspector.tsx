import { useMemo, useRef, useState } from "react";
import {
  Clock,
  Compass,
  Crosshair,
  Eye,
  Lock,
  Moon,
  Radar,
  Sun,
  TrendingUp,
  X,
} from "lucide-react";
import { CelestialVisualSvg } from "@/components/panels/CelestialVisualSvg";
import { Button } from "@/components/ui/button";
import { wrapDeg360 } from "@/lib/projection";
import { useSkyStore } from "@/store/skyStore";
import type { AltitudeSample, ObjectDetails, PickedObject } from "@/types/sky";

const CARDINAL_16_JA = [
  "北",
  "北北東",
  "北東",
  "東北東",
  "東",
  "東南東",
  "南東",
  "南南東",
  "南",
  "南南西",
  "南西",
  "西南西",
  "西",
  "西北西",
  "北西",
  "北北西",
];

const KIND_LABELS_JA: Record<string, string> = {
  sun: "太陽",
  moon: "月",
  planet: "惑星",
  dwarf_planet: "準惑星",
  comet: "彗星",
  star: "恒星",
  dso: "星雲・星団",
};

function formatRaHms(raDeg: number): string {
  const totalSec = (wrapDeg360(raDeg) / 15) * 3600;
  const h = Math.floor(totalSec / 3600) % 24;
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${String(h).padStart(2, "0")}h ${String(m).padStart(2, "0")}m ${s.toFixed(1).padStart(4, "0")}s`;
}

function formatDecDms(decDeg: number): string {
  const sign = decDeg >= 0 ? "+" : "-";
  const abs = Math.abs(decDeg);
  const d = Math.floor(abs);
  const rem = (abs - d) * 60;
  const m = Math.floor(rem);
  const s = Math.round((rem - m) * 60);
  return `${sign}${String(d).padStart(2, "0")}° ${String(m).padStart(2, "0")}' ${String(s % 60).padStart(2, "0")}"`;
}

function azimuthCardinalJa(azDeg: number): string {
  const idx = Math.round(wrapDeg360(azDeg) / 22.5) % 16;
  return CARDINAL_16_JA[idx] ?? "北";
}

function twilightLabelJa(sunAltDeg: number): string {
  if (sunAltDeg >= 0) return "昼間";
  if (sunAltDeg >= -6) return "市民薄明";
  if (sunAltDeg >= -12) return "航海薄明";
  if (sunAltDeg >= -18) return "天文薄明";
  return "暗夜（観測好機）";
}

function twilightBandColor(sunAltDeg: number): string {
  if (sunAltDeg >= 0) return "rgba(56, 189, 248, 0.24)";
  if (sunAltDeg >= -6) return "rgba(99, 102, 241, 0.26)";
  if (sunAltDeg >= -12) return "rgba(37, 99, 235, 0.22)";
  if (sunAltDeg >= -18) return "rgba(30, 58, 138, 0.28)";
  return "rgba(2, 6, 23, 0.72)";
}

function OvernightAltitudeChart({
  curve,
  currentJdUt,
  onJumpJdUt,
}: {
  curve: AltitudeSample[];
  currentJdUt: number;
  onJumpJdUt: (jd: number) => void;
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  if (curve.length < 2) {
    return (
      <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)]/50 p-3 text-center text-[11px] text-[var(--text-muted)]">
        高度推移グラフを生成中です...
      </div>
    );
  }

  const width = 300;
  const height = 148;
  const left = 28;
  const right = 290;
  const top = 12;
  const bottom = 120;
  const plotW = right - left;
  const plotH = bottom - top;
  const altMin = -20;
  const altMax = 90;

  const xOf = (idx: number) => left + (idx / (curve.length - 1)) * plotW;
  const yOf = (altDeg: number) => {
    const clamped = Math.max(altMin, Math.min(altMax, altDeg));
    return bottom - ((clamped - altMin) / (altMax - altMin)) * plotH;
  };
  const yHorizon = yOf(0);

  let maxSample = curve[0];
  let maxIdx = 0;
  for (let i = 1; i < curve.length; i += 1) {
    if (curve[i].alt_deg > maxSample.alt_deg) {
      maxSample = curve[i];
      maxIdx = i;
    }
  }

  const linePoints = curve.map((pt, i) => `${xOf(i).toFixed(1)},${yOf(pt.alt_deg).toFixed(1)}`).join(" ");
  const areaPoints = `${xOf(0).toFixed(1)},${yHorizon.toFixed(1)} ${linePoints} ${xOf(
    curve.length - 1,
  ).toFixed(1)},${yHorizon.toFixed(1)}`;

  const startJd = curve[0].jd_ut;
  const endJd = curve[curve.length - 1].jd_ut;
  const nowRatio =
    endJd > startJd && currentJdUt >= startJd && currentJdUt <= endJd
      ? (currentJdUt - startJd) / (endJd - startJd)
      : null;

  const hovered = hoverIdx !== null ? curve[hoverIdx] : null;

  return (
    <div className="space-y-1.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)]/70 p-2.5">
      <div className="flex items-center justify-between text-[11px]">
        <span className="font-medium text-[var(--text-secondary)]">一晩の高度推移（±12時間）</span>
        <span className="font-mono-num text-[10px] text-[var(--text-muted)]">
          {hovered
            ? `${hovered.label} | ${hovered.alt_deg.toFixed(1)}° (${twilightLabelJa(hovered.sun_alt_deg)})`
            : `最高 ${maxSample.alt_deg.toFixed(1)}° (${maxSample.label})`}
        </span>
      </div>

      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full cursor-crosshair select-none rounded-lg border border-[var(--border-subtle)]/70 bg-[#050914]"
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const svgX = ((e.clientX - rect.left) / rect.width) * width;
          const rel = Math.max(0, Math.min(1, (svgX - left) / plotW));
          setHoverIdx(Math.round(rel * (curve.length - 1)));
        }}
        onMouseLeave={() => setHoverIdx(null)}
        onClick={() => {
          if (hoverIdx !== null && curve[hoverIdx]) {
            onJumpJdUt(curve[hoverIdx].jd_ut);
          }
        }}
      >
        <defs>
          <clipPath id="above-horizon-clip">
            <rect x={left} y={top} width={plotW} height={Math.max(0, yHorizon - top)} />
          </clipPath>
        </defs>

        {/* Twilight background bands */}
        {curve.slice(0, -1).map((pt, idx) => {
          const next = curve[idx + 1];
          const midSun = (pt.sun_alt_deg + next.sun_alt_deg) * 0.5;
          const x1 = xOf(idx);
          const x2 = xOf(idx + 1);
          return (
            <rect
              key={idx}
              x={x1}
              y={top}
              width={Math.max(1, x2 - x1 + 0.5)}
              height={plotH}
              fill={twilightBandColor(midSun)}
            />
          );
        })}

        {/* Altitude grid lines */}
        {[60, 30, 0].map((alt) => {
          const y = yOf(alt);
          const isZero = alt === 0;
          return (
            <g key={alt}>
              <line
                x1={left}
                x2={right}
                y1={y}
                y2={y}
                stroke={isZero ? "#34d399" : "rgba(148, 163, 184, 0.25)"}
                strokeWidth={isZero ? 1.2 : 0.7}
                strokeDasharray={isZero ? "4 2" : "2 3"}
              />
              <text
                x={left - 4}
                y={y + 3}
                textAnchor="end"
                fill={isZero ? "#6ee7b7" : "#94a3b8"}
                fontSize="8.5"
                fontFamily="monospace"
              >
                {alt}°
              </text>
            </g>
          );
        })}

        {/* Area fill above horizon */}
        <polygon
          points={areaPoints}
          fill="rgba(56, 189, 248, 0.22)"
          clipPath="url(#above-horizon-clip)"
        />

        {/* Altitude curve */}
        <polyline
          fill="none"
          stroke="#7dd3fc"
          strokeWidth="1.9"
          strokeLinejoin="round"
          strokeLinecap="round"
          points={linePoints}
        />

        {/* Peak marker */}
        <circle
          cx={xOf(maxIdx)}
          cy={yOf(maxSample.alt_deg)}
          r="3"
          fill="#fbbf24"
          stroke="#0f172a"
          strokeWidth="1"
        />

        {/* Current simulation time needle */}
        {nowRatio !== null && (
          <line
            x1={left + nowRatio * plotW}
            x2={left + nowRatio * plotW}
            y1={top}
            y2={bottom}
            stroke="#fbbf24"
            strokeWidth="1.3"
            strokeDasharray="3 2"
          />
        )}

        {/* Hovered cursor vertical + dot */}
        {hoverIdx !== null && curve[hoverIdx] && (
          <g>
            <line
              x1={xOf(hoverIdx)}
              x2={xOf(hoverIdx)}
              y1={top}
              y2={bottom}
              stroke="#e2e8f0"
              strokeWidth="0.9"
              opacity="0.65"
            />
            <circle
              cx={xOf(hoverIdx)}
              cy={yOf(curve[hoverIdx].alt_deg)}
              r="3.4"
              fill="#38bdf8"
              stroke="#ffffff"
              strokeWidth="1"
            />
          </g>
        )}

        {/* Time X-axis labels */}
        {[0, 12, 24, 36, 48]
          .filter((idx) => idx < curve.length)
          .map((idx) => (
            <text
              key={idx}
              x={xOf(idx)}
              y={height - 10}
              textAnchor={idx === 0 ? "start" : idx === curve.length - 1 ? "end" : "middle"}
              fill="#94a3b8"
              fontSize="8.5"
              fontFamily="monospace"
            >
              {curve[idx].label}
            </text>
          ))}
      </svg>

      <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] text-[var(--text-muted)]">
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-sm bg-[#fbbf24]" />
          現在時刻（グラフクリックで日時移動）
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-sm bg-[#020617] ring-1 ring-slate-600" />
          暗夜
          <span className="inline-block h-2 w-2 rounded-sm bg-blue-900" />
          薄明
        </span>
      </div>
    </div>
  );
}

export function ObjectInspector() {
  const storeSelectedObject = useSkyStore((s) => s.selectedObject);
  const storeSelectedObjectDetails = useSkyStore((s) => s.selectedObjectDetails);
  const snapshotRef = useRef<{ obj: PickedObject; details: ObjectDetails | null } | null>(null);
  if (storeSelectedObject) {
    snapshotRef.current = { obj: storeSelectedObject, details: storeSelectedObjectDetails };
  }
  const selectedObject = storeSelectedObject ?? snapshotRef.current?.obj ?? null;
  const selectedObjectDetails = storeSelectedObject
    ? storeSelectedObjectDetails
    : snapshotRef.current?.details ?? null;
  const staticAssets = useSkyStore((s) => s.staticAssets);
  const skyFrame = useSkyStore((s) => s.skyFrame);
  const jdUt = useSkyStore((s) => s.jdUt);
  const simLockMode = useSkyStore((s) => s.simLockMode);
  const simLockTargetId = useSkyStore((s) => s.simLockTargetId);

  const clearSelection = useSkyStore((s) => s.clearSelection);
  const centerOnSkyCoords = useSkyStore((s) => s.centerOnSkyCoords);
  const openNearbySearch = useSkyStore((s) => s.openNearbySearch);
  const setSimLock = useSkyStore((s) => s.setSimLock);
  const jumpToJdUt = useSkyStore((s) => s.jumpToJdUt);
  const addAltitudeTarget = useSkyStore((s) => s.addAltitudeTarget);
  const openPanel = useSkyStore((s) => s.openPanel);

  const enriched = useMemo(() => {
    if (!selectedObject) {
      return { body: null, dso: null, guide: null, variable: null };
    }
    const idLower = selectedObject.id.toLowerCase();
    const body = skyFrame?.bodies.find((b) => b.id.toLowerCase() === idLower) ?? null;
    const dso =
      selectedObject.kind === "dso"
        ? staticAssets?.dsos.find((d) => {
            const mId = d.messier ? `m${d.messier}` : "";
            return d.id.toLowerCase() === idLower || mId === idLower;
          }) ?? null
        : null;
    const hipMatch = /^HIP\s+(\d+)/i.exec(selectedObject.id);
    const hipNum = hipMatch ? Number(hipMatch[1]) : null;
    const guide =
      hipNum !== null
        ? staticAssets?.star_guides.find((g) => g.hip === hipNum) ?? null
        : null;
    const variable =
      (hipNum !== null
        ? staticAssets?.variable_stars.find((v) => v.hip === hipNum)
        : staticAssets?.variable_stars.find((v) => v.id.toLowerCase() === idLower)) ?? null;
    return { body, dso, guide, variable };
  }, [selectedObject, skyFrame?.bodies, staticAssets]);

  if (!selectedObject) {
    return null;
  }

  const isSolarSystemBody =
    selectedObject.kind === "sun" ||
    selectedObject.kind === "moon" ||
    selectedObject.kind === "planet" ||
    selectedObject.kind === "comet";
  const matchedCon = selectedObject.constellation
    ? staticAssets?.constellations.find(
        (c) =>
          c.id.toLowerCase() === selectedObject.constellation?.toLowerCase() ||
          c.name_ja === selectedObject.constellation,
      )
    : undefined;

  const isTracked =
    (simLockMode === "planet" && simLockTargetId === selectedObject.id) ||
    (simLockMode === "constellation" && matchedCon && simLockTargetId === matchedCon.id);

  const constellationDisplay =
    selectedObjectDetails?.constellation_ja ??
    matchedCon?.name_ja ??
    selectedObject.constellation ??
    null;

  return (
    <aside className="flex h-full w-88 max-w-[calc(100vw-2rem)] flex-col rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface-glass)] text-[var(--text-primary)] shadow-2xl backdrop-blur-md">
      {/* Header */}
      <div className="flex items-start justify-between gap-2 border-b border-[var(--border-subtle)] px-4 py-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="rounded-md bg-[var(--accent-primary)]/20 px-1.5 py-0.5 text-[10px] font-semibold text-[var(--accent-primary)]">
              {enriched.variable
                ? "変光星"
                : KIND_LABELS_JA[selectedObject.kind] ?? selectedObject.kind}
            </span>
            {constellationDisplay && (
              <span className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] px-1.5 py-0.5 text-[10px] text-[var(--text-secondary)]">
                {constellationDisplay}
              </span>
            )}
            <span className="font-mono-num text-[10px] text-[var(--text-muted)]">
              {selectedObject.id}
            </span>
          </div>
          <h2 className="mt-1 truncate text-base font-bold leading-tight">
            {selectedObject.name_ja}
          </h2>
          {selectedObject.name_en !== selectedObject.name_ja && (
            <p className="truncate text-[11px] text-[var(--text-muted)]">
              {selectedObject.name_en}
            </p>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          onClick={clearSelection}
          title="詳細パネルを閉じる"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Scrollable Body */}
      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3 text-xs">
        {/* Real Astronomical Photograph Card */}
        <CelestialVisualSvg
          kind={selectedObject.kind}
          id={selectedObject.id}
          title={selectedObject.name_ja}
          objType={enriched.dso?.obj_type ?? selectedObject.extra_info}
          mag={selectedObject.mag}
          spectrum={selectedObjectDetails?.spectrum ?? enriched.guide?.spectrum ?? enriched.variable?.spectrum}
          posAngDeg={enriched.dso?.pos_ang_deg}
          raDeg={selectedObject.ra_deg}
          decDeg={selectedObject.dec_deg}
          majAxArcmin={enriched.dso?.maj_ax_arcmin}
          body={enriched.body}
          size="lg"
        />

        {/* Quick Actions */}
        <div className="grid grid-cols-2 gap-1.5">
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1 px-2 text-[11px]"
            onClick={() =>
              centerOnSkyCoords(
                selectedObject.ra_deg,
                selectedObject.dec_deg,
                selectedObject.az_deg,
                selectedObject.alt_deg,
              )
            }
          >
            <Crosshair className="h-3.5 w-3.5" />
            中央表示
          </Button>
          <Button
            variant={isTracked ? "default" : "outline"}
            size="sm"
            className="h-8 gap-1 px-2 text-[11px]"
            disabled={!isSolarSystemBody && !matchedCon}
            onClick={() => {
              if (isTracked) {
                setSimLock("none", "");
              } else if (isSolarSystemBody) {
                setSimLock("planet", selectedObject.id);
              } else if (matchedCon) {
                setSimLock("constellation", matchedCon.id);
              }
            }}
            title={
              isSolarSystemBody
                ? "シミュレーション時にこの太陽系天体を画面中央に追跡固定"
                : matchedCon
                  ? `${matchedCon.name_ja}を追跡固定`
                  : "惑星または星座所属天体で追跡可能"
            }
          >
            <Lock className="h-3.5 w-3.5" />
            {isTracked ? "固定中" : "追跡固定"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1 px-2 text-[11px]"
            onClick={() =>
              openNearbySearch(
                selectedObject.name_ja,
                selectedObject.ra_deg,
                selectedObject.dec_deg,
              )
            }
          >
            <Radar className="h-3.5 w-3.5" />
            近傍検索
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1 px-2 text-[11px]"
            onClick={() => {
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
              });
              openPanel("altitude_graph");
            }}
          >
            <TrendingUp className="h-3.5 w-3.5" />
            高度グラフ
          </Button>
        </div>

        {/* Positional Telemetry */}
        <div className="grid grid-cols-2 gap-1.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)]/70 p-2.5">
          <div>
            <div className="text-[10px] text-[var(--text-muted)]">赤経 (RA)</div>
            <div className="font-mono-num text-[11px] font-semibold">
              {formatRaHms(selectedObject.ra_deg)}
            </div>
          </div>
          <div>
            <div className="text-[10px] text-[var(--text-muted)]">赤緯 (Dec)</div>
            <div className="font-mono-num text-[11px] font-semibold">
              {formatDecDms(selectedObject.dec_deg)}
            </div>
          </div>
          <div>
            <div className="flex items-center gap-1 text-[10px] text-[var(--text-muted)]">
              <Compass className="h-3 w-3" /> 方位 (Az)
            </div>
            <div className="font-mono-num text-[11px] font-semibold">
              {selectedObject.az_deg.toFixed(1)}° ({azimuthCardinalJa(selectedObject.az_deg)})
            </div>
          </div>
          <div>
            <div className="flex items-center gap-1 text-[10px] text-[var(--text-muted)]">
              <Eye className="h-3 w-3" /> 高度 (Alt)
            </div>
            <div
              className={`font-mono-num text-[11px] font-semibold ${
                selectedObject.alt_deg >= 0 ? "text-[var(--status-ok)]" : "text-[var(--status-warn)]"
              }`}
            >
              {selectedObject.alt_deg.toFixed(1)}°{" "}
              <span className="text-[10px] font-normal">
                {selectedObject.alt_deg >= 0 ? "地平上" : "地平下"}
              </span>
            </div>
          </div>
          <div>
            <div className="text-[10px] text-[var(--text-muted)]">視等級</div>
            <div className="font-mono-num text-[11px] font-semibold">
              {selectedObject.mag !== null ? `${selectedObject.mag.toFixed(2)} 等` : "---"}
            </div>
          </div>
          <div>
            <div className="text-[10px] text-[var(--text-muted)]">距離</div>
            <div className="font-mono-num text-[11px] font-semibold">
              {selectedObject.dist_text || "---"}
            </div>
          </div>
        </div>

        {/* Ephemeris Rise / Transit / Set + Moon/Sun Separations */}
        <div className="space-y-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)]/70 p-2.5">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1 font-medium text-[var(--text-secondary)]">
              <Clock className="h-3.5 w-3.5" /> 出没・南中・離角
            </span>
            {selectedObjectDetails && (
              <span className="rounded bg-[var(--bg-surface)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]">
                {selectedObjectDetails.status}
              </span>
            )}
          </div>

          <div className="grid grid-cols-3 gap-1.5 text-center">
            <button
              type="button"
              disabled={!selectedObjectDetails?.rise_jd_ut}
              onClick={() =>
                selectedObjectDetails?.rise_jd_ut && jumpToJdUt(selectedObjectDetails.rise_jd_ut)
              }
              className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-1.5 py-1.5 transition hover:border-[var(--accent-primary)] disabled:opacity-50"
              title="クリックでこの時刻へ移動"
            >
              <div className="text-[10px] text-[var(--text-muted)]">出</div>
              <div className="font-mono-num text-[11px] font-semibold">
                {selectedObjectDetails?.rise_str ?? "---"}
              </div>
            </button>
            <button
              type="button"
              disabled={!selectedObjectDetails?.transit_jd_ut}
              onClick={() =>
                selectedObjectDetails?.transit_jd_ut &&
                jumpToJdUt(selectedObjectDetails.transit_jd_ut)
              }
              className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-1.5 py-1.5 transition hover:border-[var(--accent-primary)] disabled:opacity-50"
              title="クリックで南中時刻へ移動"
            >
              <div className="text-[10px] text-[var(--text-muted)]">
                南中 ({selectedObjectDetails ? `${selectedObjectDetails.max_alt_deg.toFixed(0)}°` : "--"})
              </div>
              <div className="font-mono-num text-[11px] font-semibold">
                {selectedObjectDetails?.transit_str ?? "---"}
              </div>
            </button>
            <button
              type="button"
              disabled={!selectedObjectDetails?.set_jd_ut}
              onClick={() =>
                selectedObjectDetails?.set_jd_ut && jumpToJdUt(selectedObjectDetails.set_jd_ut)
              }
              className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-1.5 py-1.5 transition hover:border-[var(--accent-primary)] disabled:opacity-50"
              title="クリックでこの時刻へ移動"
            >
              <div className="text-[10px] text-[var(--text-muted)]">没</div>
              <div className="font-mono-num text-[11px] font-semibold">
                {selectedObjectDetails?.set_str ?? "---"}
              </div>
            </button>
          </div>

          {selectedObjectDetails && (
            <div className="grid grid-cols-2 gap-2 pt-0.5 text-[11px] text-[var(--text-secondary)]">
              <div className="flex items-center gap-1">
                <Moon className="h-3 w-3 text-slate-300" />
                <span>月離角:</span>
                <span className="font-mono-num font-semibold">
                  {selectedObjectDetails.moon_separation_deg.toFixed(1)}°
                </span>
              </div>
              <div className="flex items-center gap-1">
                <Sun className="h-3 w-3 text-amber-400" />
                <span>太陽離角:</span>
                <span className="font-mono-num font-semibold">
                  {selectedObjectDetails.elongation_deg.toFixed(1)}°
                </span>
              </div>
            </div>
          )}
        </div>

        {/* 24h Overnight Altitude Graph */}
        <OvernightAltitudeChart
          curve={selectedObjectDetails?.altitude_curve ?? []}
          currentJdUt={jdUt}
          onJumpJdUt={jumpToJdUt}
        />

        {/* Physical / Variable / Solar System Metadata */}
        {(selectedObject.extra_info || enriched.body || enriched.variable || enriched.dso) && (
          <div className="space-y-1 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)]/60 p-2.5 text-[11px]">
            <div className="font-medium text-[var(--text-secondary)]">天体データ</div>
            {selectedObject.extra_info && (
              <p className="text-[var(--text-primary)]">{selectedObject.extra_info}</p>
            )}
            {enriched.body && (
              <p className="font-mono-num text-[var(--text-muted)]">
                地心 {enriched.body.geo_au.toFixed(4)} AU / 日心 {enriched.body.helio_au.toFixed(3)} AU / 輝面比{" "}
                {(enriched.body.illuminated_fraction * 100).toFixed(1)}%
              </p>
            )}
            {enriched.dso && (enriched.dso.maj_ax_arcmin || enriched.dso.obj_type) && (
              <p className="font-mono-num text-[var(--text-muted)]">
                種別: {enriched.dso.obj_type}
                {enriched.dso.maj_ax_arcmin ? ` / 視径 ${enriched.dso.maj_ax_arcmin.toFixed(1)}'` : ""}
                {enriched.dso.min_ax_arcmin ? ` × ${enriched.dso.min_ax_arcmin.toFixed(1)}'` : ""}
              </p>
            )}
            {enriched.variable && (
              <p className="text-[var(--text-muted)]">
                変光型: {enriched.variable.var_type} ({enriched.variable.mag_max.toFixed(1)}〜
                {enriched.variable.mag_min.toFixed(1)}等
                {enriched.variable.period_days ? `, 周期 ${enriched.variable.period_days.toFixed(2)}日` : ""})
              </p>
            )}
          </div>
        )}

        {/* Commentary & Finding Guide */}
        {(selectedObjectDetails?.commentary_ja ||
          selectedObjectDetails?.how_to_find_ja ||
          enriched.guide?.commentary_ja ||
          enriched.variable?.description_ja) && (
          <div className="space-y-1.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)]/60 p-2.5 text-[11px] leading-relaxed">
            <div className="font-medium text-[var(--text-secondary)]">解説・見つけ方</div>
            <p className="text-[var(--text-primary)]">
              {selectedObjectDetails?.commentary_ja ??
                enriched.guide?.commentary_ja ??
                enriched.variable?.description_ja}
            </p>
            {(selectedObjectDetails?.how_to_find_ja || enriched.guide?.summary_ja) && (
              <p className="text-[var(--text-muted)]">
                {selectedObjectDetails?.how_to_find_ja ?? enriched.guide?.summary_ja}
              </p>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
