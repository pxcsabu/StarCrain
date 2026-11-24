import { useEffect, useMemo, useState } from "react";
import {
  Bell,
  BellOff,
  Clock,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Timer,
  Trash2,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { playTestBeep } from "@/lib/audioChime";
import { wrapDeg360 } from "@/lib/projection";
import { type ClockThemeId, type HourlyChimeMode, useClockStore } from "@/store/clockStore";
import { nowUtcJd, useSkyStore } from "@/store/skyStore";

const THEME_STYLES: Record<
  ClockThemeId,
  {
    label: string;
    bg: string;
    face: string;
    ring: string;
    tick: string;
    handHour: string;
    handMin: string;
    handSec: string;
    text: string;
  }
> = {
  starry: {
    label: "星空",
    bg: "rgba(3, 7, 18, 0.36)",
    face: "rgba(11, 19, 38, 0.56)",
    ring: "#38bdf8",
    tick: "#94a3b8",
    handHour: "#f8fafc",
    handMin: "#e2e8f0",
    handSec: "#38bdf8",
    text: "#cbd5e1",
  },
  observatory: {
    label: "天文台",
    bg: "rgba(18, 16, 14, 0.40)",
    face: "rgba(28, 25, 23, 0.58)",
    ring: "#fbbf24",
    tick: "#a8a29e",
    handHour: "#fef3c7",
    handMin: "#fde68a",
    handSec: "#f59e0b",
    text: "#d6d3d1",
  },
  night: {
    label: "赤色暗順応",
    bg: "rgba(12, 2, 2, 0.45)",
    face: "rgba(20, 3, 3, 0.62)",
    ring: "#dc2626",
    tick: "#991b1b",
    handHour: "#fca5a5",
    handMin: "#f87171",
    handSec: "#ef4444",
    text: "#f87171",
  },
  light: {
    label: "ライト",
    bg: "rgba(226, 232, 240, 0.72)",
    face: "rgba(255, 255, 255, 0.80)",
    ring: "#0284c7",
    tick: "#475569",
    handHour: "#0f172a",
    handMin: "#1e293b",
    handSec: "#e11d48",
    text: "#334155",
  },
};

function formatDurationHms(ms: number): string {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function liveLstHms(jdUt: number, lonDeg: number): string {
  const t = (jdUt - 2451545.0) / 36525.0;
  const gmst =
    280.46061837 +
    360.98564736629 * (jdUt - 2451545.0) +
    0.000387933 * t * t -
    (t * t * t) / 38710000.0;
  const lst = wrapDeg360(gmst + lonDeg);
  const totalSec = (lst / 15) * 3600;
  const h = Math.floor(totalSec / 3600) % 24;
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.floor(totalSec % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function ClockTimer() {
  const location = useSkyStore((s) => s.location);
  const setActivePanel = useSkyStore((s) => s.setActivePanel);

  const soundEnabled = useClockStore((s) => s.soundEnabled);
  const clockTheme = useClockStore((s) => s.clockTheme);
  const hourlyChime = useClockStore((s) => s.hourlyChime);
  const timerDurationSec = useClockStore((s) => s.timerDurationSec);
  const timerRemainingMs = useClockStore((s) => s.timerRemainingMs);
  const timerRunning = useClockStore((s) => s.timerRunning);
  const timerLabel = useClockStore((s) => s.timerLabel);
  const alarms = useClockStore((s) => s.alarms);

  const setSoundEnabled = useClockStore((s) => s.setSoundEnabled);
  const setClockTheme = useClockStore((s) => s.setClockTheme);
  const setHourlyChime = useClockStore((s) => s.setHourlyChime);
  const setTimerDuration = useClockStore((s) => s.setTimerDuration);
  const setTimerLabel = useClockStore((s) => s.setTimerLabel);
  const startTimer = useClockStore((s) => s.startTimer);
  const pauseTimer = useClockStore((s) => s.pauseTimer);
  const resetTimer = useClockStore((s) => s.resetTimer);
  const addAlarm = useClockStore((s) => s.addAlarm);
  const toggleAlarm = useClockStore((s) => s.toggleAlarm);
  const deleteAlarm = useClockStore((s) => s.deleteAlarm);

  const [nowMs, setNowMs] = useState(() => Date.now());
  const [customMin, setCustomMin] = useState("5");
  const [customSec, setCustomSec] = useState("0");
  const [newAlarmHm, setNewAlarmHm] = useState("21:00");
  const [newAlarmLabel, setNewAlarmLabel] = useState("観望開始");

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 50);
    return () => window.clearInterval(id);
  }, []);

  const nowDate = useMemo(() => new Date(nowMs), [nowMs]);
  const jdNow = nowUtcJd();
  const lstStr = liveLstHms(jdNow, location.lon_deg);

  const secs = nowDate.getSeconds() + nowDate.getMilliseconds() / 1000;
  const mins = nowDate.getMinutes() + secs / 60;
  const hrs = (nowDate.getHours() % 12) + mins / 60;

  const secAngle = secs * 6;
  const minAngle = mins * 6;
  const hourAngle = hrs * 30;

  const palette = THEME_STYLES[clockTheme];
  const progress = timerDurationSec > 0 ? Math.max(0, Math.min(1, timerRemainingMs / (timerDurationSec * 1000))) : 0;

  const localStr = `${String(nowDate.getHours()).padStart(2, "0")}:${String(nowDate.getMinutes()).padStart(2, "0")}:${String(nowDate.getSeconds()).padStart(2, "0")}`;
  const utcStr = `${String(nowDate.getUTCHours()).padStart(2, "0")}:${String(nowDate.getUTCMinutes()).padStart(2, "0")}:${String(nowDate.getUTCSeconds()).padStart(2, "0")}`;
  const dateStr = `${nowDate.getFullYear()}-${String(nowDate.getMonth() + 1).padStart(2, "0")}-${String(nowDate.getDate()).padStart(2, "0")}`;

  return (
    <aside className="flex h-full w-[26.5rem] max-w-[calc(100vw-5.5rem)] flex-col rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface-glass)] text-[var(--text-primary)] shadow-2xl backdrop-blur-md">
      {/* Header */}
      <div className="flex items-start justify-between gap-2 border-b border-[var(--border-subtle)] px-4 py-3">
        <div>
          <h2 className="flex items-center gap-1.5 text-sm font-semibold tracking-tight">
            <Clock className="h-4 w-4 text-sky-400" /> 時計・時報＆観測タイマー
          </h2>
          <p className="text-[11px] text-[var(--text-muted)]">
            秒針アナログ/デジタル時計・地方恒星時・Web Audio 通知音
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant={soundEnabled ? "outline" : "ghost"}
            size="sm"
            className="h-7 gap-1 px-2 text-[11px]"
            onClick={() => setSoundEnabled(!soundEnabled)}
            title="音 ON/OFF 切替"
          >
            {soundEnabled ? (
              <Volume2 className="h-3.5 w-3.5 text-emerald-400" />
            ) : (
              <VolumeX className="h-3.5 w-3.5 text-[var(--text-muted)]" />
            )}
            {soundEnabled ? "音ON" : "音OFF"}
          </Button>
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
      </div>

      {/* Body */}
      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3 text-xs">
        {/* Analog & Digital Clock Card */}
        <div
          className="space-y-3 rounded-xl border border-[var(--border-subtle)] p-3"
          style={{ backgroundColor: palette.bg }}
        >
          <div className="flex items-center justify-between gap-1">
            <div className="flex gap-1">
              {(Object.keys(THEME_STYLES) as ClockThemeId[]).map((tid) => (
                <button
                  key={tid}
                  type="button"
                  onClick={() => setClockTheme(tid)}
                  className={`rounded border px-2 py-0.5 text-[10px] font-medium transition ${
                    clockTheme === tid
                      ? "border-[var(--accent-primary)] bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]"
                      : "border-white/15 bg-black/25 text-slate-300"
                  }`}
                >
                  {THEME_STYLES[tid].label}
                </button>
              ))}
            </div>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[10px] text-slate-300"
              onClick={() => {
                if (soundEnabled) playTestBeep();
              }}
              disabled={!soundEnabled}
            >
              テスト音
            </Button>
          </div>

          <div className="flex items-center gap-4">
            {/* Analog Clock SVG */}
            <svg viewBox="0 0 140 140" className="h-32 w-32 shrink-0">
              <circle
                cx="70"
                cy="70"
                r="64"
                fill={palette.face}
                stroke={palette.ring}
                strokeWidth="2.2"
                strokeOpacity="0.65"
              />
              {Array.from({ length: 60 }).map((_, idx) => {
                const isHour = idx % 5 === 0;
                const ang = (idx * 6 - 90) * (Math.PI / 180);
                const rOuter = 59;
                const rInner = isHour ? 51 : 55;
                return (
                  <line
                    key={idx}
                    x1={70 + Math.cos(ang) * rInner}
                    y1={70 + Math.sin(ang) * rInner}
                    x2={70 + Math.cos(ang) * rOuter}
                    y2={70 + Math.sin(ang) * rOuter}
                    stroke={palette.tick}
                    strokeWidth={isHour ? 1.8 : 0.8}
                    opacity={isHour ? 0.95 : 0.45}
                  />
                );
              })}
              {/* Hour hand */}
              <line
                x1="70"
                y1="70"
                x2="70"
                y2="34"
                stroke={palette.handHour}
                strokeWidth="3.2"
                strokeLinecap="round"
                transform={`rotate(${hourAngle} 70 70)`}
              />
              {/* Minute hand */}
              <line
                x1="70"
                y1="70"
                x2="70"
                y2="22"
                stroke={palette.handMin}
                strokeWidth="2.2"
                strokeLinecap="round"
                transform={`rotate(${minAngle} 70 70)`}
              />
              {/* Second hand */}
              <line
                x1="70"
                y1="82"
                x2="70"
                y2="16"
                stroke={palette.handSec}
                strokeWidth="1.3"
                strokeLinecap="round"
                transform={`rotate(${secAngle} 70 70)`}
              />
              <circle cx="70" cy="70" r="3.2" fill={palette.handSec} />
            </svg>

            {/* Digital Clock Readout */}
            <div className="min-w-0 flex-1 space-y-1.5 font-mono-num" style={{ color: palette.text }}>
              <div className="text-[10px] opacity-80">
                {dateStr} · {location.name_ja} ({location.tz_name})
              </div>
              <div className="text-2xl font-bold tracking-wider" style={{ color: palette.handHour }}>
                {localStr}
              </div>
              <div className="grid grid-cols-1 gap-0.5 text-[11px]">
                <div className="flex justify-between">
                  <span className="opacity-75">UTC:</span>
                  <span>{utcStr}</span>
                </div>
                <div className="flex justify-between">
                  <span className="opacity-75">LST (恒星時):</span>
                  <span style={{ color: palette.handSec }}>{lstStr}</span>
                </div>
                <div className="flex justify-between">
                  <span className="opacity-75">JD:</span>
                  <span>{jdNow.toFixed(5)}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Time Signal Control */}
          <div className="flex items-center justify-between gap-2 border-t border-white/10 pt-2">
            <span className="text-[11px]" style={{ color: palette.text }}>
              時報 (チャイム):
            </span>
            <div className="flex gap-1">
              {(
                [
                  { id: "off", label: "OFF" },
                  { id: "hourly", label: "毎正時" },
                  { id: "half_hourly", label: "30分毎" },
                ] as { id: HourlyChimeMode; label: string }[]
              ).map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setHourlyChime(m.id)}
                  className={`rounded border px-2 py-0.5 text-[10px] font-medium ${
                    hourlyChime === m.id
                      ? "border-[var(--accent-primary)] bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]"
                      : "border-white/15 bg-black/25 text-slate-300"
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Countdown Timer */}
        <div className="space-y-2.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 font-semibold">
              <Timer className="h-3.5 w-3.5 text-amber-300" />
              残り時間タイマー (露出・撮影カウントダウン)
            </span>
            <span className="font-mono-num text-[10px] text-[var(--text-muted)]">
              {(progress * 100).toFixed(0)}%
            </span>
          </div>

          <div className="flex items-center justify-between gap-3 rounded-lg bg-[var(--bg-surface-elevated)] px-3 py-2">
            <div className="space-y-1">
              <input
                type="text"
                value={timerLabel}
                onChange={(e) => setTimerLabel(e.target.value)}
                placeholder="タイマー名"
                className="h-6 w-36 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 text-[11px]"
              />
              <div className="font-mono-num text-2xl font-bold text-amber-200">
                {formatDurationHms(timerRemainingMs)}
              </div>
            </div>
            <div className="flex gap-1.5">
              {!timerRunning ? (
                <Button type="button" size="sm" className="h-8 gap-1 px-3 text-xs" onClick={startTimer}>
                  <Play className="h-3.5 w-3.5" />
                  開始
                </Button>
              ) : (
                <Button type="button" size="sm" variant="outline" className="h-8 gap-1 px-3 text-xs" onClick={pauseTimer}>
                  <Pause className="h-3.5 w-3.5" />
                  一時停止
                </Button>
              )}
              <Button type="button" size="sm" variant="ghost" className="h-8 w-8 p-0" onClick={resetTimer} title="リセット">
                <RotateCcw className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>

          <div className="h-1.5 overflow-hidden rounded-full bg-slate-800">
            <div
              className="h-full rounded-full bg-amber-400 transition-all"
              style={{ width: `${progress * 100}%` }}
            />
          </div>

          <div className="flex flex-wrap gap-1">
            {[
              { label: "1分", sec: 60 },
              { label: "3分", sec: 180 },
              { label: "5分", sec: 300 },
              { label: "10分", sec: 600 },
              { label: "15分", sec: 900 },
              { label: "30分", sec: 1800 },
              { label: "60分", sec: 3600 },
            ].map((p) => (
              <button
                key={p.sec}
                type="button"
                onClick={() => setTimerDuration(p.sec)}
                className={`rounded border px-2 py-0.5 font-mono-num text-[10px] ${
                  timerDurationSec === p.sec
                    ? "border-[var(--accent-primary)] bg-[var(--accent-primary)]/20 text-[var(--text-primary)]"
                    : "border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] text-[var(--text-secondary)]"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1.5 pt-0.5 font-mono-num">
            <input
              type="number"
              min={0}
              max={1440}
              value={customMin}
              onChange={(e) => setCustomMin(e.target.value)}
              className="h-7 w-16 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] px-2 text-[11px]"
            />
            <span className="text-[11px] text-[var(--text-muted)]">分</span>
            <input
              type="number"
              min={0}
              max={59}
              value={customSec}
              onChange={(e) => setCustomSec(e.target.value)}
              className="h-7 w-16 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] px-2 text-[11px]"
            />
            <span className="text-[11px] text-[var(--text-muted)]">秒</span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="ml-auto h-7 px-2.5 text-[11px]"
              onClick={() => setTimerDuration((Number(customMin) || 0) * 60 + (Number(customSec) || 0))}
            >
              セット
            </Button>
          </div>
        </div>

        {/* Scheduled Alarms */}
        <div className="space-y-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
          <div className="flex items-center gap-1.5 font-semibold">
            <Bell className="h-3.5 w-3.5 text-emerald-400" />
            指定時刻アラーム
          </div>
          <div className="flex items-center gap-1.5">
            <input
              type="time"
              value={newAlarmHm}
              onChange={(e) => setNewAlarmHm(e.target.value)}
              className="h-7 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] px-2 font-mono-num text-[11px]"
            />
            <input
              type="text"
              value={newAlarmLabel}
              onChange={(e) => setNewAlarmLabel(e.target.value)}
              placeholder="ラベル (例: 火星南中)"
              className="h-7 flex-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] px-2 text-[11px]"
            />
            <Button
              type="button"
              size="sm"
              className="h-7 gap-1 px-2.5 text-[11px]"
              onClick={() => addAlarm(newAlarmHm, newAlarmLabel)}
            >
              <Plus className="h-3 w-3" />
              追加
            </Button>
          </div>

          <div className="space-y-1">
            {alarms.map((a) => (
              <div
                key={a.id}
                className="flex items-center justify-between gap-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] px-2.5 py-1.5"
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono-num font-bold text-emerald-300">{a.timeHm}</span>
                  <span className="text-[11px]">{a.label}</span>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => toggleAlarm(a.id)}
                    className={`rounded p-1 ${
                      a.enabled ? "text-emerald-400" : "text-[var(--text-muted)]"
                    }`}
                    title={a.enabled ? "有効" : "無効"}
                  >
                    {a.enabled ? <Bell className="h-3.5 w-3.5" /> : <BellOff className="h-3.5 w-3.5" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => deleteAlarm(a.id)}
                    className="rounded p-1 text-rose-400 hover:text-rose-300"
                    title="削除"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))}
            {alarms.length === 0 && (
              <p className="text-[11px] text-[var(--text-muted)]">
                アラームはまだ登録されていません。
              </p>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}
