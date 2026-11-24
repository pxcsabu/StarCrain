import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Clock, Moon, Sparkles, X } from "lucide-react";
import { MoonPhaseSvg } from "@/components/panels/MoonPhaseSvg";
import { Button } from "@/components/ui/button";
import { useSkyStore } from "@/store/skyStore";
import type { MoonCalendarDay, MoonCalendarMonth } from "@/types/sky";

const REF_PRESETS = [
  { label: "00時", h: 0, m: 0 },
  { label: "12時", h: 12, m: 0 },
  { label: "18時", h: 18, m: 0 },
  { label: "21時", h: 21, m: 0 },
];

export function MoonCalendar() {
  const skyFrame = useSkyStore((s) => s.skyFrame);
  const location = useSkyStore((s) => s.location);
  const jumpToJdUt = useSkyStore((s) => s.jumpToJdUt);
  const setActivePanel = useSkyStore((s) => s.setActivePanel);

  const [year, setYear] = useState<number>(skyFrame?.local_dt.year ?? new Date().getFullYear());
  const [month, setMonth] = useState<number>(skyFrame?.local_dt.month ?? new Date().getMonth() + 1);
  const [refHour, setRefHour] = useState<number>(21);
  const [refMinute, setRefMinute] = useState<number>(0);
  const [cal, setCal] = useState<MoonCalendarMonth | null>(null);
  const [selectedDay, setSelectedDay] = useState<MoonCalendarDay | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isTauri()) {
      setCal(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void invoke<MoonCalendarMonth>("get_moon_calendar", {
      req: {
        year,
        month,
        ref_hour: refHour,
        ref_minute: refMinute,
        lat_deg: location.lat_deg,
        lon_deg: location.lon_deg,
        alt_m: location.alt_m,
        tz_offset_min: location.tz_offset_min,
      },
    })
      .then((res) => {
        if (!cancelled) {
          setCal(res);
          const matchDay = skyFrame?.local_dt.year === year && skyFrame?.local_dt.month === month
            ? res.days.find((d) => d.day === skyFrame.local_dt.day) ?? res.days[0]
            : res.days[0];
          setSelectedDay(matchDay ?? null);
        }
      })
      .catch(() => {
        if (!cancelled) setCal(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    year,
    month,
    refHour,
    refMinute,
    location.lat_deg,
    location.lon_deg,
    location.alt_m,
    location.tz_offset_min,
  ]);

  const shiftMonth = (delta: number) => {
    const total = year * 12 + (month - 1) + delta;
    const ny = Math.floor(total / 12);
    const nm = ((total % 12) + 12) % 12 + 1;
    setYear(ny);
    setMonth(nm);
  };

  return (
    <aside className="flex h-full w-[32rem] max-w-[calc(100vw-5.5rem)] flex-col rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface-glass)] text-[var(--text-primary)] shadow-2xl backdrop-blur-md">
      {/* Header */}
      <div className="flex items-start justify-between gap-2 border-b border-[var(--border-subtle)] px-4 py-3">
        <div>
          <h2 className="flex items-center gap-1.5 text-sm font-semibold tracking-tight">
            <Moon className="h-4 w-4 text-amber-300" /> 月齢カレンダー
          </h2>
          <p className="text-[11px] text-[var(--text-muted)]">
            旧暦・六曜・日本の祝日対応 / 日付クリックで星図を該当日に移動
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

      {/* Month & Reference Time Controls */}
      <div className="space-y-2 border-b border-[var(--border-subtle)] px-4 py-2.5 text-xs">
        <div className="flex items-center justify-between gap-1.5">
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon"
              className="h-7 w-7"
              onClick={() => shiftMonth(-1)}
              title="前月"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            <input
              type="number"
              value={year}
              min={1800}
              max={2300}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v) && v >= 1600 && v <= 2400) setYear(Math.trunc(v));
              }}
              className="w-16 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 py-1 text-center font-mono-num text-xs"
            />
            <span className="text-[var(--text-muted)]">年</span>
            <select
              value={month}
              onChange={(e) => setMonth(Number(e.target.value))}
              className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 py-1 font-mono-num text-xs text-[var(--text-primary)]"
            >
              {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                <option key={m} value={m}>
                  {m}月
                </option>
              ))}
            </select>
            <Button
              variant="outline"
              size="icon"
              className="h-7 w-7"
              onClick={() => shiftMonth(1)}
              title="翌月"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>

          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-[11px]"
            onClick={() => {
              const now = new Date();
              setYear(now.getFullYear());
              setMonth(now.getMonth() + 1);
            }}
          >
            今月
          </Button>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex items-center gap-1 text-[11px] text-[var(--text-muted)]">
            <Clock className="h-3 w-3" /> 基準時刻:
          </span>
          <div className="flex items-center gap-1">
            {REF_PRESETS.map((p) => {
              const active = refHour === p.h && refMinute === p.m;
              return (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => {
                    setRefHour(p.h);
                    setRefMinute(p.m);
                  }}
                  className={`rounded-md border px-2 py-0.5 font-mono-num text-[10px] transition ${
                    active
                      ? "border-[var(--accent-primary)] bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]"
                      : "border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)]"
                  }`}
                >
                  {p.label}
                </button>
              );
            })}
            <input
              type="time"
              value={`${String(refHour).padStart(2, "0")}:${String(refMinute).padStart(2, "0")}`}
              onChange={(e) => {
                const [hh, mm] = e.target.value.split(":").map(Number);
                if (Number.isFinite(hh) && Number.isFinite(mm)) {
                  setRefHour(hh);
                  setRefMinute(mm);
                }
              }}
              className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-1.5 py-0.5 font-mono-num text-[10px]"
            />
          </div>
        </div>
      </div>

      {/* Calendar Grid */}
      <div className="flex-1 overflow-y-auto px-3 py-2.5">
        {loading && !cal ? (
          <div className="py-12 text-center text-xs text-[var(--text-muted)]">月齢計算中...</div>
        ) : !cal ? (
          <div className="py-12 text-center text-xs text-[var(--text-muted)]">
            デスクトップ環境で月齢カレンダーを利用できます
          </div>
        ) : (
          <div className="space-y-2">
            {/* Weekday headers */}
            <div className="grid grid-cols-7 gap-1 text-center text-[11px] font-semibold">
              {["日", "月", "火", "水", "木", "金", "土"].map((wd, idx) => (
                <div
                  key={wd}
                  className={`py-1 ${
                    idx === 0 ? "text-rose-400" : idx === 6 ? "text-sky-400" : "text-[var(--text-secondary)]"
                  }`}
                >
                  {wd}
                </div>
              ))}
            </div>

            <div className="grid grid-cols-7 gap-1">
              {Array.from({ length: cal.first_weekday }).map((_, i) => (
                <div key={`pad-${i}`} className="h-24 rounded-lg bg-[var(--bg-surface)]/20" />
              ))}

              {cal.days.map((d) => {
                const isSelected = selectedDay?.day === d.day;
                const isCurrentSkyDay =
                  skyFrame?.local_dt.year === year &&
                  skyFrame?.local_dt.month === month &&
                  skyFrame?.local_dt.day === d.day;
                const dayColor =
                  d.holiday_ja || d.weekday === 0
                    ? "text-rose-400"
                    : d.weekday === 6
                      ? "text-sky-400"
                      : "text-[var(--text-primary)]";

                return (
                  <button
                    key={d.day}
                    type="button"
                    onClick={() => {
                      setSelectedDay(d);
                      jumpToJdUt(d.jd_ut);
                    }}
                    className={`flex h-24 flex-col justify-between rounded-xl border p-1.5 text-left transition ${
                      isSelected || isCurrentSkyDay
                        ? "border-[var(--accent-primary)] bg-[var(--accent-primary)]/15 ring-1 ring-[var(--accent-primary)]/40"
                        : "border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)]/65 hover:border-[var(--border-strong)]"
                    }`}
                  >
                    <div className="flex w-full items-start justify-between gap-0.5">
                      <span className={`font-mono-num text-[11px] font-bold leading-none ${dayColor}`}>
                        {d.day}
                      </span>
                      {d.phase_event_ja && (
                        <span className="rounded bg-amber-500/20 px-1 py-0.2 text-[8.5px] font-bold text-amber-300">
                          {d.phase_event_ja}
                        </span>
                      )}
                    </div>

                    <div className="flex flex-col items-center">
                      <MoonPhaseSvg
                        illuminatedFraction={d.illuminated_fraction}
                        waxing={d.waxing}
                        size={26}
                        title={`${d.date_str} 月齢 ${d.moon_age_days.toFixed(1)}`}
                      />
                      <span className="mt-0.5 font-mono-num text-[9.5px] font-medium text-[var(--text-secondary)]">
                        {d.moon_age_days.toFixed(1)}
                      </span>
                    </div>

                    <div className="w-full space-y-0.5 leading-none">
                      {d.holiday_ja ? (
                        <div className="truncate text-[8.5px] font-semibold text-rose-300">
                          {d.holiday_ja}
                        </div>
                      ) : d.solar_term_ja ? (
                        <div className="truncate text-[8.5px] font-semibold text-emerald-300">
                          {d.solar_term_ja}
                        </div>
                      ) : null}
                      <div className="flex items-center justify-between text-[8.5px] text-[var(--text-muted)]">
                        <span className="truncate">{d.kyureki_label}</span>
                        <span className="shrink-0">{d.rokuyo_ja}</span>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Selected Day Footer */}
      {selectedDay && (
        <div className="flex items-center justify-between gap-3 border-t border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)]/70 px-4 py-2.5 text-xs">
          <div className="flex items-center gap-2.5 min-w-0">
            <MoonPhaseSvg
              illuminatedFraction={selectedDay.illuminated_fraction}
              waxing={selectedDay.waxing}
              size={32}
            />
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 font-semibold">
                <span className="font-mono-num">{selectedDay.date_str}</span>
                {selectedDay.holiday_ja && (
                  <span className="text-[10px] text-rose-300">{selectedDay.holiday_ja}</span>
                )}
                {selectedDay.phase_event_ja && selectedDay.phase_event_time && (
                  <span className="rounded bg-amber-500/20 px-1.5 py-0.5 font-mono-num text-[10px] text-amber-300">
                    {selectedDay.phase_event_ja} {selectedDay.phase_event_time}
                  </span>
                )}
              </div>
              <div className="truncate font-mono-num text-[10px] text-[var(--text-muted)]">
                月齢 {selectedDay.moon_age_days.toFixed(1)} ・輝面 {(selectedDay.illuminated_fraction * 100).toFixed(0)}% ・出 {selectedDay.moonrise_str ?? "--"} ・没 {selectedDay.moonset_str ?? "--"} ・{selectedDay.kyureki_label} ({selectedDay.rokuyo_ja})
              </div>
            </div>
          </div>

          <Button
            variant="outline"
            size="sm"
            className="h-7 shrink-0 gap-1 px-2 text-[11px]"
            onClick={() => {
              jumpToJdUt(selectedDay.jd_ut);
              setActivePanel("observation");
            }}
          >
            <Sparkles className="h-3 w-3" />
            詳細日へ
          </Button>
        </div>
      )}
    </aside>
  );
}
