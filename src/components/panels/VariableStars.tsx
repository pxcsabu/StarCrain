import { useMemo, useState } from "react";
import { Activity, Compass, Eye, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { wrapDeg360 } from "@/lib/projection";
import { useSkyStore } from "@/store/skyStore";
import type { VariableStar } from "@/types/sky";

type VarClassFilter = "all" | "mira" | "eclipsing" | "cepheid" | "semireg" | "other";
type VarSortKey = "mag_max" | "amplitude" | "period" | "alt";

function classifyVarType(varType: string): VarClassFilter {
  const up = varType.toUpperCase();
  if (up.startsWith("M ") || up.includes("ミラ")) return "mira";
  if (up.startsWith("EA") || up.startsWith("EB") || up.includes("食")) return "eclipsing";
  if (up.includes("CEP") || up.includes("ケフェイド")) return "cepheid";
  if (up.startsWith("SR") || up.startsWith("L") || up.includes("半規則") || up.includes("不規則")) {
    return "semireg";
  }
  return "other";
}

function j2000ToHor(
  raDeg: number,
  decDeg: number,
  mat: number[][],
  latDeg: number,
  lastDeg: number,
): { azDeg: number; altDeg: number; appRaDeg: number; appDecDeg: number } {
  const r = (raDeg * Math.PI) / 180;
  const d = (decDeg * Math.PI) / 180;
  const vx = Math.cos(d) * Math.cos(r);
  const vy = Math.cos(d) * Math.sin(r);
  const vz = Math.sin(d);
  const ax = mat[0][0] * vx + mat[0][1] * vy + mat[0][2] * vz;
  const ay = mat[1][0] * vx + mat[1][1] * vy + mat[1][2] * vz;
  const az = mat[2][0] * vx + mat[2][1] * vy + mat[2][2] * vz;
  const appRaDeg = wrapDeg360((Math.atan2(ay, ax) * 180) / Math.PI);
  const appDecDeg = (Math.asin(Math.max(-1, Math.min(1, az))) * 180) / Math.PI;
  const ha = ((wrapDeg360(lastDeg - appRaDeg + 180) - 180) * Math.PI) / 180;
  const lat = (latDeg * Math.PI) / 180;
  const decR = (appDecDeg * Math.PI) / 180;
  const sinAlt = Math.sin(lat) * Math.sin(decR) + Math.cos(lat) * Math.cos(decR) * Math.cos(ha);
  const altDeg = (Math.asin(Math.max(-1, Math.min(1, sinAlt))) * 180) / Math.PI;
  const y = -Math.sin(ha) * Math.cos(decR);
  const x = Math.cos(lat) * Math.sin(decR) - Math.sin(lat) * Math.cos(decR) * Math.cos(ha);
  const azDeg = wrapDeg360((Math.atan2(y, x) * 180) / Math.PI);
  return { azDeg, altDeg, appRaDeg, appDecDeg };
}

function formatRaShort(raDeg: number): string {
  const totalMin = (wrapDeg360(raDeg) / 15) * 60;
  const h = Math.floor(totalMin / 60) % 24;
  const m = Math.round(totalMin % 60);
  return `${String(h).padStart(2, "0")}h${String(m % 60).padStart(2, "0")}m`;
}

function formatDecShort(decDeg: number): string {
  const sign = decDeg >= 0 ? "+" : "-";
  return `${sign}${Math.abs(decDeg).toFixed(1)}°`;
}

interface VariableStarRow {
  star: VariableStar;
  conJa: string;
  altDeg: number;
  azDeg: number;
  appRaDeg: number;
  appDecDeg: number;
  amplitude: number;
}

export function VariableStars() {
  const staticAssets = useSkyStore((s) => s.staticAssets);
  const skyFrame = useSkyStore((s) => s.skyFrame);
  const jdUt = useSkyStore((s) => s.jdUt);
  const location = useSkyStore((s) => s.location);
  const selectObject = useSkyStore((s) => s.selectObject);
  const setActivePanel = useSkyStore((s) => s.setActivePanel);

  const [query, setQuery] = useState("");
  const [conFilter, setConFilter] = useState("ALL");
  const [classFilter, setClassFilter] = useState<VarClassFilter>("all");
  const [maxPeakMag, setMaxPeakMag] = useState(10.0);
  const [onlyAboveHorizon, setOnlyAboveHorizon] = useState(false);
  const [sortBy, setSortBy] = useState<VarSortKey>("mag_max");
  const [selectedId, setSelectedId] = useState<string>("omi-Cet");

  const conNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of staticAssets?.constellations ?? []) {
      map.set(c.id, c.name_ja);
    }
    return map;
  }, [staticAssets?.constellations]);

  const jdBucket = Math.floor(jdUt * 144);
  const hasSkyFrame = skyFrame !== null;

  const rows = useMemo<VariableStarRow[]>(() => {
    const list = staticAssets?.variable_stars ?? [];
    const latestFrame = useSkyStore.getState().skyFrame;
    const mat = latestFrame?.j2000_to_apparent_matrix ?? [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
    const lastDeg = latestFrame?.last_deg ?? 0;

    return list.map((star) => {
      const pos = j2000ToHor(star.ra_deg, star.dec_deg, mat, location.lat_deg, lastDeg);
      return {
        star,
        conJa: conNameMap.get(star.constellation) ?? star.constellation,
        altDeg: pos.altDeg,
        azDeg: pos.azDeg,
        appRaDeg: pos.appRaDeg,
        appDecDeg: pos.appDecDeg,
        amplitude: Math.max(0, star.mag_min - star.mag_max),
      };
    });
  }, [staticAssets?.variable_stars, hasSkyFrame, jdBucket, location.lat_deg, conNameMap]);

  const constellationOptions = useMemo(() => {
    const seen = new Set<string>();
    const opts: { id: string; label: string }[] = [];
    for (const r of rows) {
      if (!seen.has(r.star.constellation)) {
        seen.add(r.star.constellation);
        opts.push({ id: r.star.constellation, label: `${r.conJa} (${r.star.constellation})` });
      }
    }
    return opts.sort((a, b) => a.label.localeCompare(b.label, "ja"));
  }, [rows]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out = rows.filter((r) => {
      if (conFilter !== "ALL" && r.star.constellation !== conFilter) return false;
      if (classFilter !== "all" && classifyVarType(r.star.var_type) !== classFilter) return false;
      if (r.star.mag_max > maxPeakMag) return false;
      if (onlyAboveHorizon && r.altDeg < 0) return false;
      if (q) {
        const hit =
          r.star.name_ja.toLowerCase().includes(q) ||
          r.star.name_en.toLowerCase().includes(q) ||
          r.star.id.toLowerCase().includes(q) ||
          r.conJa.toLowerCase().includes(q) ||
          r.star.var_type.toLowerCase().includes(q) ||
          `hip ${r.star.hip}`.includes(q);
        if (!hit) return false;
      }
      return true;
    });

    out.sort((a, b) => {
      if (sortBy === "amplitude") return b.amplitude - a.amplitude;
      if (sortBy === "period") return (a.star.period_days ?? 999999) - (b.star.period_days ?? 999999);
      if (sortBy === "alt") return b.altDeg - a.altDeg;
      return a.star.mag_max - b.star.mag_max;
    });
    return out;
  }, [rows, query, conFilter, classFilter, maxPeakMag, onlyAboveHorizon, sortBy]);

  const activeRow =
    filtered.find((r) => r.star.id === selectedId) ??
    rows.find((r) => r.star.id === selectedId) ??
    filtered[0] ??
    null;

  const jumpToStar = (r: VariableStarRow) => {
    selectObject(
      {
        kind: "star",
        id: r.star.hip > 0 ? `HIP ${r.star.hip}` : r.star.id,
        name_ja: r.star.name_ja,
        name_en: r.star.name_en,
        constellation: r.star.constellation,
        mag: r.star.mag_max,
        ra_deg: r.appRaDeg,
        dec_deg: r.appDecDeg,
        az_deg: r.azDeg,
        alt_deg: r.altDeg,
        dist_text: `${r.star.mag_max.toFixed(1)}〜${r.star.mag_min.toFixed(1)}等`,
        angular_sep_deg: 0,
        extra_info: r.star.var_type,
      },
      true,
    );
  };

  return (
    <aside className="flex h-full w-[28rem] max-w-[calc(100vw-5.5rem)] flex-col rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface-glass)] text-[var(--text-primary)] shadow-2xl backdrop-blur-md">
      {/* Header */}
      <div className="flex items-start justify-between gap-2 border-b border-[var(--border-subtle)] px-4 py-3">
        <div>
          <h2 className="flex items-center gap-1.5 text-sm font-semibold tracking-tight">
            <Activity className="h-4 w-4 text-rose-400" /> 変光星検索・GCVSカタログ
          </h2>
          <p className="text-[11px] text-[var(--text-muted)]">
            主要 {rows.length} 天体収録 ・星座 / 星名 / 極大光度で絞り込み・星図ジャンプ
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

      {/* Filters */}
      <div className="space-y-2 border-b border-[var(--border-subtle)] px-4 py-2.5 text-xs">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="星名・星座名・変光型 (ミラ / アルゴル / ケフェウスなど)"
            className="h-8 w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] pr-3 pl-8 text-xs outline-none focus:border-[var(--accent-primary)]"
          />
        </div>

        <div className="flex flex-wrap gap-1">
          {(
            [
              { id: "all", label: "すべて" },
              { id: "mira", label: "ミラ型" },
              { id: "eclipsing", label: "食変光星" },
              { id: "cepheid", label: "ケフェイド" },
              { id: "semireg", label: "半規則・不規則" },
              { id: "other", label: "爆発・その他" },
            ] as const
          ).map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setClassFilter(f.id)}
              className={`rounded-md border px-2 py-0.5 text-[10px] font-medium transition ${
                classFilter === f.id
                  ? "border-[var(--accent-primary)] bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]"
                  : "border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)]"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-2">
          <select
            value={conFilter}
            onChange={(e) => setConFilter(e.target.value)}
            className="h-7 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 text-[11px]"
          >
            <option value="ALL">すべての星座 ({constellationOptions.length})</option>
            {constellationOptions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>

          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as VarSortKey)}
            className="h-7 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 text-[11px]"
          >
            <option value="mag_max">極大光度が明るい順</option>
            <option value="amplitude">変光幅が大きい順</option>
            <option value="period">周期が短い順</option>
            <option value="alt">現在の高度が高い順</option>
          </select>
        </div>

        <div className="flex items-center justify-between gap-2 text-[11px]">
          <label className="flex flex-1 items-center gap-2">
            <span className="shrink-0 text-[var(--text-secondary)]">極大 ≦ {maxPeakMag.toFixed(1)}等</span>
            <input
              type="range"
              min={0}
              max={10}
              step={0.5}
              value={maxPeakMag}
              onChange={(e) => setMaxPeakMag(Number(e.target.value))}
              className="w-full accent-[var(--accent-primary)]"
            />
          </label>
          <label className="flex shrink-0 items-center gap-1 text-[11px] text-[var(--text-secondary)]">
            <input
              type="checkbox"
              checked={onlyAboveHorizon}
              onChange={(e) => setOnlyAboveHorizon(e.target.checked)}
            />
            <Eye className="h-3 w-3" />
            地平線上 ({filtered.length})
          </label>
        </div>
      </div>

      {/* Scrollable Body */}
      <div className="flex-1 space-y-2.5 overflow-y-auto px-4 py-3 text-xs">
        {activeRow && (
          <div className="space-y-2.5 rounded-xl border border-rose-500/35 bg-[var(--bg-surface-elevated)] p-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="rounded bg-rose-500/20 px-1.5 py-0.5 text-[10px] font-medium text-rose-300">
                    {activeRow.conJa}
                  </span>
                  <span className="font-mono-num text-[10px] text-[var(--text-muted)]">
                    HIP {activeRow.star.hip} · {activeRow.star.spectrum}
                  </span>
                </div>
                <h3 className="mt-1 text-sm font-bold">{activeRow.star.name_ja}</h3>
                <p className="text-[11px] text-[var(--text-muted)]">{activeRow.star.var_type}</p>
              </div>
              <Button
                type="button"
                size="sm"
                className="h-7 shrink-0 gap-1 px-2.5 text-[11px]"
                onClick={() => jumpToStar(activeRow)}
              >
                <Compass className="h-3.5 w-3.5" />
                プラネタリウムで表示
              </Button>
            </div>

            {/* Magnitude Range Bar */}
            <div className="space-y-1 rounded-lg bg-[var(--bg-surface)] px-2.5 py-2">
              <div className="flex items-center justify-between text-[11px]">
                <span>
                  変光範囲:{" "}
                  <strong className="font-mono-num text-amber-200">
                    {activeRow.star.mag_max.toFixed(2)} 〜 {activeRow.star.mag_min.toFixed(2)} 等
                  </strong>
                </span>
                <span className="font-mono-num text-[10px] text-rose-300">
                  変光幅 Δ{activeRow.amplitude.toFixed(1)}等
                </span>
              </div>
              <div className="relative h-2 overflow-hidden rounded-full bg-slate-800">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-amber-300 via-rose-400 to-rose-700"
                  style={{
                    width: `${Math.min(100, Math.max(12, activeRow.amplitude * 12))}%`,
                  }}
                />
              </div>
              <div className="grid grid-cols-3 gap-2 pt-1 font-mono-num text-[10px] text-[var(--text-secondary)]">
                <div>
                  周期:{" "}
                  {activeRow.star.period_days !== null
                    ? `${activeRow.star.period_days.toFixed(2)} 日`
                    : "不規則/非周期"}
                </div>
                <div>
                  J2000: {formatRaShort(activeRow.star.ra_deg)} {formatDecShort(activeRow.star.dec_deg)}
                </div>
                <div className={activeRow.altDeg >= 0 ? "text-emerald-300" : "text-[var(--text-muted)]"}>
                  高度 {activeRow.altDeg.toFixed(1)}° / 方位 {activeRow.azDeg.toFixed(0)}°
                </div>
              </div>
            </div>

            <p className="text-[11px] leading-relaxed text-[var(--text-secondary)]">
              {activeRow.star.description_ja}
            </p>
          </div>
        )}

        {/* List */}
        <div className="space-y-1.5">
          {filtered.map((r) => {
            const isSel = activeRow?.star.id === r.star.id;
            return (
              <div
                key={r.star.id}
                onClick={() => setSelectedId(r.star.id)}
                className={`cursor-pointer rounded-xl border px-3 py-2 transition ${
                  isSel
                    ? "border-[var(--accent-primary)] bg-[var(--accent-primary)]/12"
                    : "border-[var(--border-subtle)] bg-[var(--bg-surface)] hover:bg-[var(--bg-surface-elevated)]"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate font-semibold">{r.star.name_ja}</div>
                    <div className="truncate text-[10px] text-[var(--text-muted)]">
                      {r.conJa} · {r.star.var_type}
                    </div>
                  </div>
                  <div className="shrink-0 text-right font-mono-num">
                    <div className="text-[11px] text-amber-200">
                      {r.star.mag_max.toFixed(1)}〜{r.star.mag_min.toFixed(1)}等
                    </div>
                    <div
                      className={`text-[10px] ${
                        r.altDeg >= 0 ? "text-emerald-300" : "text-[var(--text-muted)]"
                      }`}
                    >
                      {r.star.period_days !== null ? `${r.star.period_days.toFixed(1)}日` : "不規則"} ·{" "}
                      {r.altDeg.toFixed(0)}°
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
          {filtered.length === 0 && (
            <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-5 text-center text-[var(--text-muted)]">
              条件に合う変光星が見つかりませんでした。
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
