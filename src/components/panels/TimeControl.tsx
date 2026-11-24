import { invoke, isTauri } from "@tauri-apps/api/core";
import { Calendar, ChevronLeft, ChevronRight, Clock, Moon, Sun, Sunrise, Sunset, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useSkyStore } from "@/store/skyStore";
import type { DaySpecialTimes } from "@/types/sky";

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

export function TimeControl() {
  const skyFrame = useSkyStore((s) => s.skyFrame);
  const location = useSkyStore((s) => s.location);
  const viewMode = useSkyStore((s) => s.viewMode);
  const simPlaying = useSkyStore((s) => s.simPlaying);

  const jumpToYmdHms = useSkyStore((s) => s.jumpToYmdHms);
  const jumpToJdUt = useSkyStore((s) => s.jumpToJdUt);
  const stepTimeMinutes = useSkyStore((s) => s.stepTimeMinutes);
  const setNow = useSkyStore((s) => s.setNow);
  const setActivePanel = useSkyStore((s) => s.setActivePanel);

  const cur = skyFrame?.local_dt ?? {
    year: 2026,
    month: 1,
    day: 1,
    hour: 21,
    minute: 0,
    second: 0,
  };

  const [year, setYear] = useState(cur.year);
  const [month, setMonth] = useState(cur.month);
  const [day, setDay] = useState(cur.day);
  const [hour, setHour] = useState(cur.hour);
  const [minute, setMinute] = useState(cur.minute);
  const [calYear, setCalYear] = useState(cur.year);
  const [calMonth, setCalMonth] = useState(cur.month);
  const [specialTimes, setSpecialTimes] = useState<DaySpecialTimes | null>(null);

  useEffect(() => {
    setYear(cur.year);
    setMonth(cur.month);
    setDay(cur.day);
    setHour(cur.hour);
    setMinute(cur.minute);
    setCalYear(cur.year);
    setCalMonth(cur.month);
  }, [cur.year, cur.month, cur.day, cur.hour, cur.minute]);

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    const delay = simPlaying ? 300 : 0;
    const timer = window.setTimeout(() => {
      void invoke<DaySpecialTimes>("get_day_special_times", {
        req: {
          jd_ut: useSkyStore.getState().jdUt,
          lat_deg: location.lat_deg,
          lon_deg: location.lon_deg,
          alt_m: location.alt_m,
          tz_offset_min: location.tz_offset_min,
          year: cur.year,
          month: cur.month,
          day: cur.day,
        },
      })
        .then((res) => {
          if (!cancelled) setSpecialTimes(res);
        })
        .catch(() => {
          if (!cancelled) setSpecialTimes(null);
        });
    }, delay);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    location.lat_deg,
    location.lon_deg,
    location.alt_m,
    location.tz_offset_min,
    cur.year,
    cur.month,
    cur.day,
    simPlaying,
  ]);

  const firstWeekday = new Date(Date.UTC(calYear, calMonth - 1, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(calYear, calMonth, 0)).getUTCDate();
  const minutesOfDay = cur.hour * 60 + cur.minute;

  const isAncientMode = viewMode === "precession" || viewMode === "proper_motion";

  return (
    <aside className="pointer-events-auto flex max-h-full w-80 flex-col overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface-glass)] shadow-2xl backdrop-blur-md">
      <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-3.5 py-2.5">
        <div className="flex items-center gap-2 text-xs font-semibold">
          <Clock className="h-4 w-4 text-[var(--accent-primary)]" />
          <span>日時コントロール ({location.tz_name})</span>
        </div>
        <Button type="button" size="icon" variant="ghost" className="h-6 w-6" onClick={() => setActivePanel(null)}>
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto p-3.5 text-xs">
        {/* Direct Input */}
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            jumpToYmdHms(year, month, day, hour, minute, 0);
          }}
        >
          <div className="grid grid-cols-5 gap-1">
            <label className="col-span-2 text-[10px] text-[var(--text-secondary)]">
              年
              <input
                type="number"
                value={year}
                onChange={(e) => setYear(Number(e.target.value))}
                className="mt-0.5 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-1.5 py-1 font-mono-num text-xs outline-none"
              />
            </label>
            <label className="text-[10px] text-[var(--text-secondary)]">
              月
              <input
                type="number"
                min={1}
                max={12}
                value={month}
                onChange={(e) => setMonth(Number(e.target.value))}
                className="mt-0.5 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-1.5 py-1 font-mono-num text-xs outline-none"
              />
            </label>
            <label className="text-[10px] text-[var(--text-secondary)]">
              日
              <input
                type="number"
                min={1}
                max={31}
                value={day}
                onChange={(e) => setDay(Number(e.target.value))}
                className="mt-0.5 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-1.5 py-1 font-mono-num text-xs outline-none"
              />
            </label>
            <label className="text-[10px] text-[var(--text-secondary)]">
              時:分
              <div className="mt-0.5 flex items-center gap-0.5">
                <input
                  type="number"
                  min={0}
                  max={23}
                  value={hour}
                  onChange={(e) => setHour(Number(e.target.value))}
                  className="w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-1 py-1 font-mono-num text-xs outline-none"
                />
              </div>
            </label>
          </div>
          <div className="flex items-center gap-1.5">
            <input
              type="number"
              min={0}
              max={59}
              value={minute}
              onChange={(e) => setMinute(Number(e.target.value))}
              className="w-16 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 py-1 font-mono-num text-xs outline-none"
              aria-label="分"
            />
            <span className="text-[11px] text-[var(--text-secondary)]">分</span>
            <Button type="submit" size="sm" className="ml-auto h-7 px-3 text-xs">
              設定
            </Button>
            <Button type="button" size="sm" variant="outline" className="h-7 px-2.5 text-xs" onClick={setNow}>
              現在時刻
            </Button>
          </div>
        </form>

        {/* 24h Slider */}
        <div className="space-y-1 border-t border-[var(--border-subtle)] pt-3">
          <div className="flex justify-between text-[11px]">
            <span>時刻スライダー</span>
            <span className="font-mono-num text-[var(--accent-primary)]">
              {String(cur.hour).padStart(2, "0")}:{String(cur.minute).padStart(2, "0")}
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={1439}
            step={1}
            value={minutesOfDay}
            onChange={(e) => {
              const total = Number(e.target.value);
              const nh = Math.floor(total / 60);
              const nm = total % 60;
              jumpToYmdHms(cur.year, cur.month, cur.day, nh, nm, 0);
            }}
            className="w-full accent-[var(--accent-primary)]"
          />
        </div>

        {/* Interactive Calendar */}
        <div className="space-y-1.5 border-t border-[var(--border-subtle)] pt-3">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1 font-semibold text-[var(--text-secondary)]">
              <Calendar className="h-3.5 w-3.5" />
              カレンダー選択
            </span>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="h-6 w-6"
                onClick={() => {
                  if (calMonth === 1) {
                    setCalYear(calYear - 1);
                    setCalMonth(12);
                  } else {
                    setCalMonth(calMonth - 1);
                  }
                }}
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </Button>
              <span className="font-mono-num text-[11px] font-semibold">
                {calYear}/{String(calMonth).padStart(2, "0")}
              </span>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="h-6 w-6"
                onClick={() => {
                  if (calMonth === 12) {
                    setCalYear(calYear + 1);
                    setCalMonth(1);
                  } else {
                    setCalMonth(calMonth + 1);
                  }
                }}
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-7 gap-0.5 text-center text-[10px]">
            {WEEKDAYS.map((wd, idx) => (
              <div
                key={wd}
                className={`py-0.5 font-semibold ${
                  idx === 0 ? "text-[var(--status-danger)]" : idx === 6 ? "text-[var(--accent-primary)]" : "text-[var(--text-muted)]"
                }`}
              >
                {wd}
              </div>
            ))}
            {Array.from({ length: firstWeekday }).map((_, i) => (
              <div key={`pad-${i}`} />
            ))}
            {Array.from({ length: daysInMonth }).map((_, idx) => {
              const dNum = idx + 1;
              const isSelected = calYear === cur.year && calMonth === cur.month && dNum === cur.day;
              return (
                <button
                  key={dNum}
                  type="button"
                  onClick={() => jumpToYmdHms(calYear, calMonth, dNum, cur.hour, cur.minute, 0)}
                  className={`rounded py-1 font-mono-num text-[11px] transition-colors ${
                    isSelected
                      ? "bg-[var(--accent-primary)] font-bold text-[var(--accent-primary-fg)]"
                      : "hover:bg-[var(--bg-surface-elevated)]"
                  }`}
                >
                  {dNum}
                </button>
              );
            })}
          </div>
        </div>

        {/* Quick Step Buttons */}
        <div className="space-y-1.5 border-t border-[var(--border-subtle)] pt-3">
          <div className="text-[11px] font-semibold text-[var(--text-secondary)]">ステップ移動</div>
          <div className="grid grid-cols-4 gap-1">
            {(isAncientMode
              ? [
                  { label: "-5000年", m: -5000 * 525960 },
                  { label: "-500年", m: -500 * 525960 },
                  { label: "+500年", m: 500 * 525960 },
                  { label: "+5000年", m: 5000 * 525960 },
                ]
              : [
                  { label: "-1ヶ月", m: -43200 },
                  { label: "-1日", m: -1440 },
                  { label: "+1日", m: 1440 },
                  { label: "+1ヶ月", m: 43200 },
                  { label: "-1時間", m: -60 },
                  { label: "-10分", m: -10 },
                  { label: "+10分", m: 10 },
                  { label: "+1時間", m: 60 },
                ]
            ).map((btn) => (
              <Button
                key={btn.label}
                type="button"
                size="sm"
                variant="outline"
                className="h-7 px-1 font-mono-num text-[10px]"
                onClick={() => stepTimeMinutes(btn.m)}
              >
                {btn.label}
              </Button>
            ))}
          </div>
        </div>

        {/* One-Click Special Times */}
        {specialTimes && (
          <div className="space-y-1.5 border-t border-[var(--border-subtle)] pt-3">
            <div className="font-semibold text-[var(--text-secondary)]">
              特定時刻ワンクリック取得 ({specialTimes.date_str})
            </div>
            <div className="grid grid-cols-2 gap-1">
              {[
                { label: "日の出", time: specialTimes.sunrise_str, jd: specialTimes.sunrise_jd_ut, icon: Sunrise },
                { label: "日の入り", time: specialTimes.sunset_str, jd: specialTimes.sunset_jd_ut, icon: Sunset },
                { label: "南中", time: specialTimes.solar_transit_str, jd: specialTimes.solar_transit_jd_ut, icon: Sun },
                { label: "月の出", time: specialTimes.moonrise_str, jd: specialTimes.moonrise_jd_ut, icon: Moon },
                { label: "月の入り", time: specialTimes.moonset_str, jd: specialTimes.moonset_jd_ut, icon: Moon },
                { label: "月の南中", time: specialTimes.lunar_transit_str, jd: specialTimes.lunar_transit_jd_ut, icon: Moon },
                { label: "天文薄明始", time: specialTimes.astro_dawn_str, jd: specialTimes.astro_dawn_jd_ut, icon: Clock },
                { label: "天文薄明終", time: specialTimes.astro_dusk_str, jd: specialTimes.astro_dusk_jd_ut, icon: Clock },
                { label: "航海薄明始", time: specialTimes.nautical_dawn_str, jd: specialTimes.nautical_dawn_jd_ut, icon: Clock },
                { label: "航海薄明終", time: specialTimes.nautical_dusk_str, jd: specialTimes.nautical_dusk_jd_ut, icon: Clock },
                { label: "市民薄明始", time: specialTimes.civil_dawn_str, jd: specialTimes.civil_dawn_jd_ut, icon: Clock },
                { label: "市民薄明終", time: specialTimes.civil_dusk_str, jd: specialTimes.civil_dusk_jd_ut, icon: Clock },
              ].map((item) => {
                const Icon = item.icon;
                return (
                  <Button
                    key={item.label}
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={item.jd == null}
                    className="h-7 justify-between px-2 text-[10px]"
                    onClick={() => item.jd != null && jumpToJdUt(item.jd)}
                  >
                    <span className="flex items-center gap-1">
                      <Icon className="h-3 w-3 text-[var(--accent-secondary)]" />
                      {item.label}
                    </span>
                    <span className="font-mono-num">{item.time ?? "--:--"}</span>
                  </Button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
