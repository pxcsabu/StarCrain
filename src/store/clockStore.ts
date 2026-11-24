import { create } from "zustand";
import { playAlarmRing, playTimeSignal, playTimerComplete } from "@/lib/audioChime";

export type ClockThemeId = "starry" | "observatory" | "night" | "light";
export type HourlyChimeMode = "off" | "hourly" | "half_hourly";

export interface AlarmItem {
  id: string;
  timeHm: string;
  label: string;
  enabled: boolean;
  lastTriggeredDate: string | null;
}

export interface ClockAlertBanner {
  id: string;
  title: string;
  message: string;
}

interface PersistedClockPrefs {
  soundEnabled: boolean;
  clockTheme: ClockThemeId;
  hourlyChime: HourlyChimeMode;
  timerDurationSec: number;
  timerLabel: string;
  alarms: AlarmItem[];
}

const STORAGE_KEY = "starcrane-clock-v1";

function loadClockPrefs(): PersistedClockPrefs {
  const fallback: PersistedClockPrefs = {
    soundEnabled: true,
    clockTheme: "starry",
    hourlyChime: "off",
    timerDurationSec: 300,
    timerLabel: "ガイド露出",
    alarms: [],
  };
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<PersistedClockPrefs>;
    return {
      soundEnabled: parsed.soundEnabled ?? fallback.soundEnabled,
      clockTheme: parsed.clockTheme ?? fallback.clockTheme,
      hourlyChime: parsed.hourlyChime ?? fallback.hourlyChime,
      timerDurationSec: parsed.timerDurationSec ?? fallback.timerDurationSec,
      timerLabel: parsed.timerLabel ?? fallback.timerLabel,
      alarms: Array.isArray(parsed.alarms) ? parsed.alarms : [],
    };
  } catch {
    return fallback;
  }
}

function saveClockPrefs(s: PersistedClockPrefs): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // Ignore storage quota error
  }
}

function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function localHmKey(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export interface ClockState {
  soundEnabled: boolean;
  clockTheme: ClockThemeId;
  hourlyChime: HourlyChimeMode;
  timerDurationSec: number;
  timerRemainingMs: number;
  timerRunning: boolean;
  timerEndEpochMs: number | null;
  timerLabel: string;
  alarms: AlarmItem[];
  lastChimeSlot: string | null;
  activeAlert: ClockAlertBanner | null;

  setSoundEnabled: (on: boolean) => void;
  setClockTheme: (theme: ClockThemeId) => void;
  setHourlyChime: (mode: HourlyChimeMode) => void;
  setTimerDuration: (seconds: number) => void;
  setTimerLabel: (label: string) => void;
  startTimer: () => void;
  pauseTimer: () => void;
  resetTimer: () => void;
  addAlarm: (timeHm: string, label: string) => void;
  toggleAlarm: (id: string) => void;
  deleteAlarm: (id: string) => void;
  dismissAlert: () => void;
  tickClockEngine: (nowMs: number) => void;
}

const initialPrefs = loadClockPrefs();

export const useClockStore = create<ClockState>((set, get) => {
  const persist = () => {
    const s = get();
    saveClockPrefs({
      soundEnabled: s.soundEnabled,
      clockTheme: s.clockTheme,
      hourlyChime: s.hourlyChime,
      timerDurationSec: s.timerDurationSec,
      timerLabel: s.timerLabel,
      alarms: s.alarms,
    });
  };

  return {
    soundEnabled: initialPrefs.soundEnabled,
    clockTheme: initialPrefs.clockTheme,
    hourlyChime: initialPrefs.hourlyChime,
    timerDurationSec: initialPrefs.timerDurationSec,
    timerRemainingMs: initialPrefs.timerDurationSec * 1000,
    timerRunning: false,
    timerEndEpochMs: null,
    timerLabel: initialPrefs.timerLabel,
    alarms: initialPrefs.alarms,
    lastChimeSlot: null,
    activeAlert: null,

    setSoundEnabled: (soundEnabled) => {
      set({ soundEnabled });
      persist();
    },

    setClockTheme: (clockTheme) => {
      set({ clockTheme });
      persist();
    },

    setHourlyChime: (hourlyChime) => {
      set({ hourlyChime });
      persist();
    },

    setTimerDuration: (seconds) => {
      const clamped = Math.max(1, Math.min(86400, Math.round(seconds)));
      set({
        timerDurationSec: clamped,
        timerRemainingMs: clamped * 1000,
        timerRunning: false,
        timerEndEpochMs: null,
      });
      persist();
    },

    setTimerLabel: (timerLabel) => {
      set({ timerLabel });
      persist();
    },

    startTimer: () => {
      const s = get();
      if (s.timerRunning) return;
      const baseMs = s.timerRemainingMs > 0 ? s.timerRemainingMs : s.timerDurationSec * 1000;
      set({
        timerRunning: true,
        timerRemainingMs: baseMs,
        timerEndEpochMs: Date.now() + baseMs,
      });
    },

    pauseTimer: () => {
      const s = get();
      if (!s.timerRunning) return;
      const rem = s.timerEndEpochMs ? Math.max(0, s.timerEndEpochMs - Date.now()) : s.timerRemainingMs;
      set({
        timerRunning: false,
        timerRemainingMs: rem,
        timerEndEpochMs: null,
      });
    },

    resetTimer: () => {
      const s = get();
      set({
        timerRunning: false,
        timerRemainingMs: s.timerDurationSec * 1000,
        timerEndEpochMs: null,
      });
    },

    addAlarm: (timeHm, label) => {
      const cleanHm = timeHm.trim();
      if (!/^\d{2}:\d{2}$/.test(cleanHm)) return;
      const item: AlarmItem = {
        id: `alarm_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        timeHm: cleanHm,
        label: label.trim() || "天体観測アラーム",
        enabled: true,
        lastTriggeredDate: null,
      };
      set((s) => ({ alarms: [...s.alarms, item] }));
      persist();
    },

    toggleAlarm: (id) => {
      set((s) => ({
        alarms: s.alarms.map((a) => (a.id === id ? { ...a, enabled: !a.enabled } : a)),
      }));
      persist();
    },

    deleteAlarm: (id) => {
      set((s) => ({ alarms: s.alarms.filter((a) => a.id !== id) }));
      persist();
    },

    dismissAlert: () => set({ activeAlert: null }),

    tickClockEngine: (nowMs) => {
      const s = get();
      const now = new Date(nowMs);

      // 1. Countdown Timer
      if (s.timerRunning && s.timerEndEpochMs !== null) {
        const rem = s.timerEndEpochMs - nowMs;
        if (rem <= 0) {
          set({
            timerRunning: false,
            timerRemainingMs: 0,
            timerEndEpochMs: null,
            activeAlert: {
              id: `timer_${nowMs}`,
              title: "タイマー終了",
              message: `${s.timerLabel || "カウントダウン"} (${Math.floor(s.timerDurationSec / 60)}分${s.timerDurationSec % 60}秒) が完了しました。`,
            },
          });
          if (s.soundEnabled) playTimerComplete();
        } else {
          set({ timerRemainingMs: rem });
        }
      }

      // 2. Hourly / Half-Hourly Time Signal (within first 3 seconds of minute 00 / 30)
      const sec = now.getSeconds();
      const min = now.getMinutes();
      if (s.hourlyChime !== "off" && sec < 3) {
        const isHourMark = min === 0;
        const isHalfMark = s.hourlyChime === "half_hourly" && min === 30;
        if (isHourMark || isHalfMark) {
          const slotKey = `${localDateKey(now)} ${localHmKey(now)}`;
          if (s.lastChimeSlot !== slotKey) {
            set({ lastChimeSlot: slotKey });
            if (s.soundEnabled) playTimeSignal(!isHourMark);
          }
        }
      }

      // 3. Scheduled Alarms
      if (s.alarms.length > 0 && sec < 10) {
        const today = localDateKey(now);
        const hm = localHmKey(now);
        let triggeredAlarm: AlarmItem | null = null;
        const updated = s.alarms.map((a) => {
          if (a.enabled && a.timeHm === hm && a.lastTriggeredDate !== today) {
            triggeredAlarm = a;
            return { ...a, lastTriggeredDate: today };
          }
          return a;
        });
        if (triggeredAlarm) {
          const al: AlarmItem = triggeredAlarm;
          set({
            alarms: updated,
            activeAlert: {
              id: `alarm_${al.id}_${nowMs}`,
              title: `アラーム (${al.timeHm})`,
              message: al.label,
            },
          });
          persist();
          if (s.soundEnabled) playAlarmRing();
        }
      }
    },
  };
});
