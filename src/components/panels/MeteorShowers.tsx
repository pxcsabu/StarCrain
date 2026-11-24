import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Compass,
  Eye,
  Pause,
  Play,
  Sparkles,
  X,
} from "lucide-react";
import { MoonPhaseSvg } from "@/components/panels/MoonPhaseSvg";
import { Button } from "@/components/ui/button";
import { useSkyStore } from "@/store/skyStore";
import type { MeteorShowerYearInfo } from "@/types/sky";

type ShowerFilter = "all" | "active" | "major" | "favorable";

export function MeteorShowers() {
  const skyFrame = useSkyStore((s) => s.skyFrame);
  const location = useSkyStore((s) => s.location);
  const jdUt = useSkyStore((s) => s.jdUt);
  const layers = useSkyStore((s) => s.layers);
  const selectedMeteorShowerCode = useSkyStore((s) => s.selectedMeteorShowerCode);
  const meteorAnimationEnabled = useSkyStore((s) => s.meteorAnimationEnabled);
  const meteorShowAllRadiants = useSkyStore((s) => s.meteorShowAllRadiants);
  const meteorRateMultiplier = useSkyStore((s) => s.meteorRateMultiplier);

  const jumpToJdUt = useSkyStore((s) => s.jumpToJdUt);
  const toggleLayer = useSkyStore((s) => s.toggleLayer);
  const setSelectedMeteorShower = useSkyStore((s) => s.setSelectedMeteorShower);
  const setMeteorAnimationEnabled = useSkyStore((s) => s.setMeteorAnimationEnabled);
  const setMeteorShowAllRadiants = useSkyStore((s) => s.setMeteorShowAllRadiants);
  const setMeteorRateMultiplier = useSkyStore((s) => s.setMeteorRateMultiplier);
  const setActivePanel = useSkyStore((s) => s.setActivePanel);

  const [year, setYear] = useState<number>(skyFrame?.local_dt.year ?? new Date().getFullYear());
  const [filter, setFilter] = useState<ShowerFilter>("all");
  const [showers, setShowers] = useState<MeteorShowerYearInfo[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isTauri()) {
      setShowers([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void invoke<MeteorShowerYearInfo[]>("get_meteor_showers_for_year", {
      req: {
        year,
        current_jd_ut: jdUt,
        lat_deg: location.lat_deg,
        lon_deg: location.lon_deg,
        alt_m: location.alt_m,
        tz_offset_min: location.tz_offset_min,
      },
    })
      .then((res) => {
        if (!cancelled) {
          setShowers(res);
          if (!selectedMeteorShowerCode && res.length > 0) {
            const preferred =
              res.find((s) => s.is_active_now) ??
              res.find((s) => s.days_to_peak >= -1) ??
              res[0];
            if (preferred) setSelectedMeteorShower(preferred.code, false);
          }
        }
      })
      .catch(() => {
        if (!cancelled) setShowers([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [year, jdUt, location.lat_deg, location.lon_deg, location.alt_m, location.tz_offset_min]);

  const filtered = useMemo(() => {
    return showers.filter((s) => {
      if (filter === "active") return s.is_active_now;
      if (filter === "major") return s.is_major_three;
      if (filter === "favorable") return s.condition_score >= 60;
      return true;
    });
  }, [showers, filter]);

  const selected =
    showers.find((s) => s.code === selectedMeteorShowerCode) ?? filtered[0] ?? showers[0] ?? null;

  const scoreBadgeClass = (score: number) =>
    score >= 80
      ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/30"
      : score >= 60
        ? "bg-sky-500/20 text-sky-300 border-sky-500/30"
        : score >= 40
          ? "bg-amber-500/20 text-amber-300 border-amber-500/30"
          : "bg-rose-500/20 text-rose-300 border-rose-500/30";

  return (
    <aside className="flex h-full w-[26.5rem] max-w-[calc(100vw-5.5rem)] flex-col rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface-glass)] text-[var(--text-primary)] shadow-2xl backdrop-blur-md">
      {/* Header */}
      <div className="flex items-start justify-between gap-2 border-b border-[var(--border-subtle)] px-4 py-3">
        <div>
          <h2 className="flex items-center gap-1.5 text-sm font-semibold tracking-tight">
            <Sparkles className="h-4 w-4 text-sky-400" /> 流星群ガイド &amp; 出現イメージ
          </h2>
          <p className="text-[11px] text-[var(--text-muted)]">
            年間主要 {showers.length || 21} 群・極大月齢条件・放射点アニメーション連携
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

      {/* Year & Global Meteor Animation Controls */}
      <div className="space-y-2 border-b border-[var(--border-subtle)] px-4 py-2.5 text-xs">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon"
              className="h-7 w-7"
              onClick={() => setYear((y) => y - 1)}
              title="前年"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            <span className="px-1.5 font-mono-num text-xs font-bold">{year}年</span>
            <Button
              variant="outline"
              size="icon"
              className="h-7 w-7"
              onClick={() => setYear((y) => y + 1)}
              title="翌年"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>

          <div className="flex items-center gap-1.5">
            <Button
              variant={layers.meteorRadiants || meteorShowAllRadiants ? "default" : "outline"}
              size="sm"
              className="h-7 gap-1 px-2 text-[11px]"
              onClick={() => {
                if (!layers.meteorRadiants) {
                  toggleLayer("meteorRadiants");
                  setMeteorShowAllRadiants(true);
                } else {
                  setMeteorShowAllRadiants(!meteorShowAllRadiants);
                }
              }}
              title="星図に放射点を表示"
            >
              <Eye className="h-3 w-3" />
              {meteorShowAllRadiants ? "全放射点" : "放射点"}
            </Button>
            <Button
              variant={meteorAnimationEnabled ? "default" : "outline"}
              size="sm"
              className="h-7 gap-1 px-2 text-[11px]"
              onClick={() => setMeteorAnimationEnabled(!meteorAnimationEnabled)}
            >
              {meteorAnimationEnabled ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
              出現アニメ
            </Button>
          </div>
        </div>

        <div className="flex items-center justify-between gap-2">
          <div className="flex flex-wrap gap-1">
            {[
              { id: "all" as const, label: "全群" },
              { id: "active" as const, label: "活動中" },
              { id: "major" as const, label: "三大" },
              { id: "favorable" as const, label: "好条件" },
            ].map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setFilter(f.id)}
                className={`rounded-md border px-2 py-0.5 text-[10px] font-medium transition ${
                  filter === f.id
                    ? "border-[var(--accent-primary)] bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]"
                    : "border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)]"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>

          {meteorAnimationEnabled && (
            <div className="flex items-center gap-1 font-mono-num text-[10px]">
              <span className="text-[var(--text-muted)]">頻度:</span>
              {[1, 2, 5].map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMeteorRateMultiplier(m)}
                  className={`rounded border px-1.5 py-0.5 ${
                    meteorRateMultiplier === m
                      ? "border-[var(--accent-primary)] bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]"
                      : "border-[var(--border-subtle)] bg-[var(--bg-surface)]"
                  }`}
                >
                  {m}×
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Selected Shower Detail + Full Table */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {selected && (
          <div className="space-y-2 border-b border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)]/65 px-4 py-3 text-xs">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-bold text-sm">{selected.name_ja}</span>
                  {selected.is_major_three && (
                    <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[9.5px] font-semibold text-amber-300">
                      三大流星群
                    </span>
                  )}
                  {selected.is_active_now && (
                    <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[9.5px] font-semibold text-emerald-300">
                      活動中
                    </span>
                  )}
                </div>
                <div className="text-[10.5px] text-[var(--text-muted)]">
                  {selected.name_en} (IAU #{selected.iau_no}) ・放射点: {selected.constellation_ja} ・母天体: {selected.parent_body}
                </div>
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                <MoonPhaseSvg
                  illuminatedFraction={selected.peak_moon_illumination}
                  waxing={selected.peak_moon_age_days < 14.77}
                  size={24}
                  title={`極大月齢 ${selected.peak_moon_age_days.toFixed(1)}`}
                />
                <span
                  className={`rounded-md border px-1.5 py-0.5 font-mono-num text-[10px] font-semibold ${scoreBadgeClass(
                    selected.condition_score,
                  )}`}
                >
                  {selected.condition_grade} {selected.condition_score}点
                </span>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)]/80 p-2 font-mono-num text-[10.5px]">
              <div>
                <div className="text-[9.5px] text-[var(--text-muted)]">極大予測</div>
                <div className="font-semibold">{selected.peak_local_str}</div>
              </div>
              <div>
                <div className="text-[9.5px] text-[var(--text-muted)]">ZHR / 速度</div>
                <div className="font-semibold">
                  {selected.zhr} / {selected.velocity_km_s}km/s
                </div>
              </div>
              <div>
                <div className="text-[9.5px] text-[var(--text-muted)]">極大時月齢</div>
                <div className="font-semibold">
                  {selected.peak_moon_age_days.toFixed(1)} ({selected.peak_moon_phase_ja})
                </div>
              </div>
            </div>

            <p className="text-[11px] leading-relaxed text-[var(--text-secondary)]">
              {selected.description_ja}
            </p>
            <div className="text-[10.5px] text-[var(--accent-primary)]">
              条件判定: {selected.condition_note_ja}（最大高度 {selected.peak_radiant_max_alt_deg.toFixed(0)}°）
            </div>

            <div className="grid grid-cols-3 gap-1.5 pt-0.5">
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1 px-2 text-[11px]"
                onClick={() => {
                  jumpToJdUt(selected.best_observe_jd_ut);
                  setSelectedMeteorShower(selected.code, true);
                }}
              >
                <Sparkles className="h-3 w-3" />
                極大夜へ
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1 px-2 text-[11px]"
                onClick={() => setSelectedMeteorShower(selected.code, true)}
              >
                <Compass className="h-3 w-3" />
                放射点導入
              </Button>
              <Button
                variant={meteorAnimationEnabled ? "default" : "outline"}
                size="sm"
                className="h-7 gap-1 px-2 text-[11px]"
                onClick={() => {
                  setSelectedMeteorShower(selected.code, true);
                  setMeteorAnimationEnabled(!meteorAnimationEnabled);
                }}
              >
                {meteorAnimationEnabled ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
                {meteorAnimationEnabled ? "アニメ停止" : "出現再生"}
              </Button>
            </div>
          </div>
        )}

        {/* Annual List */}
        <div className="flex-1 space-y-1 overflow-y-auto px-3 py-2.5">
          {loading && showers.length === 0 ? (
            <div className="py-8 text-center text-xs text-[var(--text-muted)]">流星群データを計算中...</div>
          ) : filtered.length === 0 ? (
            <div className="py-8 text-center text-xs text-[var(--text-muted)]">
              該当する流星群はありません
            </div>
          ) : (
            filtered.map((s) => {
              const isSel = selected?.code === s.code;
              return (
                <div
                  key={s.code}
                  className={`flex items-center justify-between gap-2 rounded-xl border px-2.5 py-2 text-xs transition ${
                    isSel
                      ? "border-[var(--accent-primary)] bg-[var(--accent-primary)]/12"
                      : "border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)]/60 hover:border-[var(--border-strong)]"
                  }`}
                >
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onClick={() => setSelectedMeteorShower(s.code, true)}
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="truncate font-semibold">{s.name_ja}</span>
                      {s.is_major_three && (
                        <span className="rounded bg-amber-500/20 px-1 py-0.2 text-[9px] text-amber-300">
                          三大
                        </span>
                      )}
                      {s.is_active_now && (
                        <span className="rounded bg-emerald-500/20 px-1 py-0.2 text-[9px] text-emerald-300">
                          活動中
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 font-mono-num text-[10px] text-[var(--text-muted)]">
                      極大 {s.peak_local_str} ・ZHR {s.zhr} ・月齢 {s.peak_moon_age_days.toFixed(1)} ・期間 {s.active_start}〜{s.active_end}
                    </div>
                  </button>

                  <div className="flex shrink-0 items-center gap-1.5">
                    <span
                      className={`rounded border px-1.5 py-0.5 font-mono-num text-[10px] font-semibold ${scoreBadgeClass(
                        s.condition_score,
                      )}`}
                    >
                      {s.condition_score}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-6 px-2 text-[10px]"
                      onClick={() => {
                        jumpToJdUt(s.best_observe_jd_ut);
                        setSelectedMeteorShower(s.code, true);
                      }}
                      title={`${s.name_ja} 極大夜の観測好機へ移動`}
                    >
                      極大へ
                    </Button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </aside>
  );
}
