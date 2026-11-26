import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  Award,
  Bell,
  BookOpen,
  CheckCircle2,
  Compass,
  Download,
  Eclipse,
  Play,
  Plus,
  Satellite,
  Sparkles,
  Star,
  Timer,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { useClockStore } from "@/store/clockStore";
import { nowUtcJd, useSkyStore } from "@/store/skyStore";
import type {
  LunarEclipseView,
  ObservationLogRecord,
  SatellitePass,
  SolarEclipseView,
  TonightBestObject,
} from "@/types/sky";

type GuideTab = "best" | "logbook" | "events";
type GearKind = "naked_eye" | "binoculars" | "telescope";

const FALLBACK_LOGS_KEY = "starcrane-observation-logs-v1";

function loadFallbackLogs(): ObservationLogRecord[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(FALLBACK_LOGS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as ObservationLogRecord[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveFallbackLogs(logs: ObservationLogRecord[]): void {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(FALLBACK_LOGS_KEY, JSON.stringify(logs));
  }
}

function jdToLocalHm(jd: number, tzOffsetMin: number): string {
  const ms = (jd - 2440587.5) * 86400000 + tzOffsetMin * 60000;
  const d = new Date(ms);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

function jdToLocalDateTime(jd: number, tzOffsetMin: number): string {
  const ms = (jd - 2440587.5) * 86400000 + tzOffsetMin * 60000;
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate(),
  ).padStart(2, "0")} ${String(d.getUTCHours()).padStart(2, "0")}:${String(
    d.getUTCMinutes(),
  ).padStart(2, "0")}`;
}

function formatCountdownSec(totalSec: number): string {
  if (totalSec <= 0) return "発生中 / 通過直前";
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.floor(totalSec % 60);
  if (d > 0) return `${d}日 ${h}時間 ${m}分`;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function TonightGuide() {
  const closePanel = useSkyStore((s) => s.closePanel);
  const location = useSkyStore((s) => s.location);
  const jdUt = useSkyStore((s) => s.jdUt);
  const staticAssets = useSkyStore((s) => s.staticAssets);
  const selectedObject = useSkyStore((s) => s.selectedObject);
  const liveWeather = useSkyStore((s) => s.liveWeather);
  const centerOnSkyCoords = useSkyStore((s) => s.centerOnSkyCoords);
  const jumpToJdUt = useSkyStore((s) => s.jumpToJdUt);
  const setHighlightedSatPass = useSkyStore((s) => s.setHighlightedSatPass);
  const setShowSatellites = useSkyStore((s) => s.setShowSatellites);
  const setSimTarget = useSkyStore((s) => s.setSimTarget);
  const setSimDirection = useSkyStore((s) => s.setSimDirection);
  const setSimStepMinutes = useSkyStore((s) => s.setSimStepMinutes);
  const setSimPlaying = useSkyStore((s) => s.setSimPlaying);
  const lookAtDirection = useSkyStore((s) => s.lookAtDirection);
  const selectObject = useSkyStore((s) => s.selectObject);

  const addAlarm = useClockStore((s) => s.addAlarm);

  const [tab, setTab] = useState<GuideTab>("best");
  const [gear, setGear] = useState<GearKind>("telescope");
  const [bestList, setBestList] = useState<TonightBestObject[]>([]);
  const [bestLoading, setBestLoading] = useState(false);

  const [logs, setLogs] = useState<ObservationLogRecord[]>([]);
  const [logObjId, setLogObjId] = useState(selectedObject?.id ?? "");
  const [logObjName, setLogObjName] = useState(selectedObject?.name_ja ?? "");
  const [logObjKind, setLogObjKind] = useState<string>(selectedObject?.kind ?? "dso");
  const [logEquip, setLogEquip] = useState("双眼鏡 10×50 / 天体望遠鏡");
  const [logRating, setLogRating] = useState(5);
  const [logNotes, setLogNotes] = useState("");
  const [logStatus, setLogStatus] = useState<string | null>(null);

  const [issPasses, setIssPasses] = useState<SatellitePass[]>([]);
  const [solarEclipses, setSolarEclipses] = useState<SolarEclipseView[]>([]);
  const [lunarEclipses, setLunarEclipses] = useState<LunarEclipseView[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [nowJdTick, setNowJdTick] = useState(() => nowUtcJd());
  const [alarmNotice, setAlarmNotice] = useState<string | null>(null);

  // Sync selected object into quick-log fields if user switches object
  useEffect(() => {
    if (selectedObject) {
      setLogObjId(selectedObject.id);
      setLogObjName(selectedObject.name_ja);
      setLogObjKind(selectedObject.kind);
    }
  }, [selectedObject]);

  // Load Tonight Best 10
  const loadBestObjects = useCallback(async () => {
    setBestLoading(true);
    try {
      if (isTauri()) {
        const res = await invoke<TonightBestObject[]>("get_tonight_best_objects_cmd", {
          req: {
            jd_ut: jdUt,
            lat_deg: location.lat_deg,
            lon_deg: location.lon_deg,
            alt_m: location.alt_m,
            tz_offset_min: location.tz_offset_min,
            gear,
          },
        });
        setBestList(res);
      } else {
        const fallbackDsos = (staticAssets?.dsos ?? [])
          .filter((d) => d.messier != null)
          .slice(0, 12)
          .map((d, i) => ({
            id: `M${d.messier}`,
            name_ja: `M${d.messier} ${d.name_ja || d.name_en}`,
            name_en: d.name_en,
            kind: "dso",
            constellation: d.constellation,
            mag: d.mag ?? 6.5,
            ra_deg: d.ra_deg,
            dec_deg: d.dec_deg,
            az_deg: 180,
            alt_deg: 45,
            max_alt_deg: 65,
            transit_str: "21:30",
            score: Math.max(50, 95 - i * 3),
            reason_ja: "メシエ人気ターゲット（ブラウザプレビュー）",
            recommended_gear: gear === "naked_eye" ? "肉眼" : "双眼鏡〜望遠鏡",
          }));
        setBestList(fallbackDsos);
      }
    } finally {
      setBestLoading(false);
    }
  }, [jdUt, location, gear, staticAssets]);

  useEffect(() => {
    if (tab === "best") {
      void loadBestObjects();
    }
  }, [tab, loadBestObjects]);

  // Load SQLite observation logs
  const loadLogs = useCallback(async () => {
    if (isTauri()) {
      try {
        const res = await invoke<ObservationLogRecord[]>("list_observation_logs_cmd");
        setLogs(res);
      } catch {
        setLogs(loadFallbackLogs());
      }
    } else {
      setLogs(loadFallbackLogs());
    }
  }, []);

  useEffect(() => {
    void loadLogs();
  }, [loadLogs]);

  // Load ISS passes + upcoming solar/lunar eclipses for Reminders/Timelapse
  useEffect(() => {
    if (tab !== "events") return;
    const timer = window.setInterval(() => setNowJdTick(nowUtcJd()), 1000);
    return () => window.clearInterval(timer);
  }, [tab]);

  useEffect(() => {
    if (tab !== "events" || !isTauri()) return;
    let cancelled = false;
    setEventsLoading(true);
    const startJd = nowUtcJd();
    const curYear = new Date().getUTCFullYear();
    Promise.all([
      invoke<SatellitePass[]>("predict_satellite_passes_cmd", {
        req: {
          sat_id: "sat:25544",
          start_jd_ut: startJd,
          hours: 72,
          min_max_alt_deg: 12,
          visible_only: false,
          lat_deg: location.lat_deg,
          lon_deg: location.lon_deg,
          alt_m: location.alt_m,
          tz_offset_min: location.tz_offset_min,
        },
      }).catch(() => [] as SatellitePass[]),
      invoke<SolarEclipseView[]>("search_solar_eclipses_cmd", {
        req: {
          start_year: curYear,
          end_year: curYear + 3,
          lat_deg: location.lat_deg,
          lon_deg: location.lon_deg,
          alt_m: location.alt_m,
          tz_offset_min: location.tz_offset_min,
        },
      }).catch(() => [] as SolarEclipseView[]),
      invoke<LunarEclipseView[]>("search_lunar_eclipses_cmd", {
        req: {
          start_year: curYear,
          end_year: curYear + 3,
          lat_deg: location.lat_deg,
          lon_deg: location.lon_deg,
          alt_m: location.alt_m,
          tz_offset_min: location.tz_offset_min,
        },
      }).catch(() => [] as LunarEclipseView[]),
    ])
      .then(([passes, solars, lunars]) => {
        if (cancelled) return;
        setIssPasses(passes.slice(0, 6));
        setSolarEclipses(solars.filter((e) => e.visible_locally && e.local_max_jd_ut >= startJd - 1).slice(0, 3));
        setLunarEclipses(lunars.filter((e) => e.visible_locally && e.max_jd_ut >= startJd - 1).slice(0, 3));
      })
      .finally(() => {
        if (!cancelled) setEventsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tab, location]);

  const messierUniqueCount = useMemo(() => {
    const setIds = new Set<number>();
    for (const l of logs) {
      const m = /^M\s*(\d+)/i.exec(l.object_id.trim()) ?? /^M\s*(\d+)/i.exec(l.object_name.trim());
      if (m) {
        const n = Number(m[1]);
        if (n >= 1 && n <= 110) setIds.add(n);
      }
    }
    return setIds.size;
  }, [logs]);

  const handleSaveLog = async (overrideObj?: {
    id: string;
    name: string;
    kind: string;
    notes?: string;
  }) => {
    const objName = (overrideObj?.name ?? logObjName).trim();
    const objId = (overrideObj?.id ?? logObjId).trim() || objName;
    if (!objName) return;
    const rec: ObservationLogRecord = {
      id: "",
      object_id: objId,
      object_name: objName,
      object_kind: overrideObj?.kind ?? logObjKind,
      observed_at_iso: jdToLocalDateTime(jdUt, location.tz_offset_min),
      location_name: location.name_ja,
      equipment: logEquip.trim() || "肉眼 / 望遠鏡",
      rating: logRating,
      notes: (overrideObj?.notes ?? logNotes).trim(),
      created_at: Math.floor(Date.now() / 1000),
    };

    if (isTauri()) {
      const saved = await invoke<ObservationLogRecord>("upsert_observation_log_cmd", { record: rec });
      setLogs((prev) => [saved, ...prev]);
    } else {
      const saved = { ...rec, id: `obs:${Date.now()}` };
      const next = [saved, ...logs];
      setLogs(next);
      saveFallbackLogs(next);
    }
    if (!overrideObj) setLogNotes("");
    setLogStatus(`「${objName}」を観望ログに記録しました`);
    setTimeout(() => setLogStatus(null), 2600);
  };

  const handleDeleteLog = async (id: string) => {
    if (isTauri()) {
      await invoke<boolean>("delete_observation_log_cmd", { id });
      setLogs((prev) => prev.filter((x) => x.id !== id));
    } else {
      const next = logs.filter((x) => x.id !== id);
      setLogs(next);
      saveFallbackLogs(next);
    }
  };

  const handleExportLogs = () => {
    const blob = new Blob([JSON.stringify(logs, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `starcrane-observation-logs-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const startIssPassTimelapse = (p: SatellitePass) => {
    setShowSatellites(true);
    setHighlightedSatPass(p);
    jumpToJdUt(p.aos_jd_ut - 0.5 / 1440);
    lookAtDirection(p.max_az_deg, Math.max(15, p.max_alt_deg * 0.75));
    setSimTarget("time");
    setSimDirection(1);
    setSimStepMinutes(0.25); // 15s / tick smooth orbital transit
    setSimPlaying(true);
  };

  const schedulePassAlarm = (passJd: number, label: string) => {
    const remindJd = passJd - 10 / 1440; // 10 minutes before
    const hm = jdToLocalHm(remindJd, location.tz_offset_min);
    addAlarm(hm, `${label} 10分前`);
    setAlarmNotice(`${hm} に「${label} 10分前」のアラームを時計に登録しました`);
    setTimeout(() => setAlarmNotice(null), 3200);
  };

  return (
    <aside className="flex h-[34rem] max-h-[calc(100dvh-10.5rem)] w-[29rem] max-w-[calc(100vw-4rem)] flex-col text-[var(--text-primary)] max-sm:h-[82dvh] max-sm:max-h-none max-sm:w-full max-sm:max-w-none">
      {/* Header */}
      <div className="flex items-start justify-between gap-2 border-b border-[var(--border-subtle)] px-4 py-2.5">
        <div>
          <h2 className="flex items-center gap-1.5 text-sm font-semibold tracking-tight">
            <Award className="h-4 w-4 text-amber-300" />
            <span>今夜のガイド・観望ログ・速報再生</span>
          </h2>
          <p className="text-[11px] text-[var(--text-muted)]">
            見頃ベスト10 · メシエ {messierUniqueCount}/110 踏破 · ISS/食タイムラプス
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => closePanel("tonight_guide")}
          title="閉じる"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Tabs */}
      <div className="grid grid-cols-3 gap-1 border-b border-[var(--border-subtle)] px-4 py-2 text-xs">
        <Button
          type="button"
          size="sm"
          variant={tab === "best" ? "default" : "outline"}
          className="h-7 gap-1 px-1.5 text-[11px]"
          onClick={() => setTab("best")}
        >
          <Sparkles className="h-3.5 w-3.5" />
          今夜ベスト10
        </Button>
        <Button
          type="button"
          size="sm"
          variant={tab === "logbook" ? "default" : "outline"}
          className="h-7 gap-1 px-1.5 text-[11px]"
          onClick={() => setTab("logbook")}
        >
          <BookOpen className="h-3.5 w-3.5" />
          観望ログ ({logs.length})
        </Button>
        <Button
          type="button"
          size="sm"
          variant={tab === "events" ? "default" : "outline"}
          className="h-7 gap-1 px-1.5 text-[11px]"
          onClick={() => setTab("events")}
        >
          <Timer className="h-3.5 w-3.5" />
          速報・再生
        </Button>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-4 py-3 text-xs">
        {logStatus && (
          <div className="flex items-center gap-1.5 rounded-lg border border-emerald-400/40 bg-emerald-500/15 px-2.5 py-1.5 text-[11px] text-emerald-200">
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
            <span>{logStatus}</span>
          </div>
        )}
        {alarmNotice && (
          <div className="flex items-center gap-1.5 rounded-lg border border-sky-400/40 bg-sky-500/15 px-2.5 py-1.5 text-[11px] text-sky-200">
            <Bell className="h-3.5 w-3.5 shrink-0" />
            <span>{alarmNotice}</span>
          </div>
        )}

        {/* TAB 1: Tonight's Best 10 */}
        {tab === "best" && (
          <>
            <div className="flex items-center justify-between gap-2">
              <div className="flex gap-1">
                {(
                  [
                    { id: "naked_eye", label: "肉眼" },
                    { id: "binoculars", label: "双眼鏡" },
                    { id: "telescope", label: "望遠鏡" },
                  ] as const
                ).map((g) => (
                  <Button
                    key={g.id}
                    type="button"
                    size="sm"
                    variant={gear === g.id ? "default" : "outline"}
                    className="h-6 px-2 text-[10.5px]"
                    onClick={() => setGear(g.id)}
                  >
                    {g.label}
                  </Button>
                ))}
              </div>
              {liveWeather && (
                <span className="font-mono-num text-[10px] text-sky-300">
                  今夜の雲量 {liveWeather.tonight_avg_cloud_pct.toFixed(0)}% · 指数{" "}
                  {liveWeather.tonight_stargazing_score}点
                </span>
              )}
            </div>

            {bestLoading ? (
              <div className="py-10 text-center text-[var(--text-muted)]">見頃天体を算出中...</div>
            ) : (
              <div className="space-y-1.5">
                {bestList.map((obj, idx) => (
                  <div
                    key={obj.id}
                    className="space-y-1 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)]/80 px-3 py-2"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 font-semibold">
                          <span className="rounded bg-amber-500/20 px-1.5 py-0.2 font-mono-num text-[10px] text-amber-300">
                            #{idx + 1}
                          </span>
                          <span className="truncate">{obj.name_ja}</span>
                          {obj.constellation && (
                            <span className="text-[10px] font-normal text-[var(--text-muted)]">
                              ({obj.constellation})
                            </span>
                          )}
                        </div>
                        <div className="text-[10.5px] text-[var(--text-secondary)]">
                          {obj.reason_ja}
                        </div>
                        <div className="font-mono-num text-[10px] text-[var(--text-muted)]">
                          {obj.mag.toFixed(1)}等 · 現在高度 {obj.alt_deg.toFixed(0)}° / 最高{" "}
                          {obj.max_alt_deg.toFixed(0)}°
                          {obj.transit_str ? ` (南中 ${obj.transit_str})` : ""} · {obj.recommended_gear}
                        </div>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        <span className="rounded border border-emerald-400/35 bg-emerald-500/15 px-1.5 py-0.2 font-mono-num text-[10px] font-semibold text-emerald-300">
                          {obj.score}点
                        </span>
                        <div className="flex gap-1">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-6 gap-1 px-1.5 text-[10px]"
                            onClick={() => {
                              selectObject(
                                {
                                  kind:
                                    obj.kind === "planet"
                                      ? "planet"
                                      : obj.kind === "star"
                                        ? "star"
                                        : "dso",
                                  id: obj.id,
                                  name_ja: obj.name_ja,
                                  name_en: obj.name_en,
                                  constellation: obj.constellation,
                                  mag: obj.mag,
                                  ra_deg: obj.ra_deg,
                                  dec_deg: obj.dec_deg,
                                  az_deg: obj.az_deg,
                                  alt_deg: obj.alt_deg,
                                  dist_text: "",
                                  angular_sep_deg: 0,
                                  extra_info: obj.reason_ja,
                                },
                                true,
                              );
                            }}
                          >
                            <Compass className="h-3 w-3" />
                            導入
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-6 px-1.5 text-[10px] text-amber-300"
                            onClick={() =>
                              void handleSaveLog({
                                id: obj.id,
                                name: obj.name_ja,
                                kind: obj.kind,
                                notes: `${obj.reason_ja} (最高高度 ${obj.max_alt_deg.toFixed(0)}°)`,
                              })
                            }
                            title="ワンクリックで観望ログに記録"
                          >
                            記録
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {/* TAB 2: Observation Logbook + Messier Progress */}
        {tab === "logbook" && (
          <>
            <section className="space-y-1.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)]/85 p-2.5">
              <div className="flex items-center justify-between text-[11px]">
                <span className="font-semibold text-amber-300">メシエ天体ビンゴ進捗</span>
                <span className="font-mono-num font-semibold">{messierUniqueCount} / 110</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-slate-800">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-sky-400 to-amber-400 transition-all"
                  style={{ width: `${Math.min(100, (messierUniqueCount / 110) * 100)}%` }}
                />
              </div>
            </section>

            {/* Quick Log Entry Form */}
            <section className="space-y-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)]/75 p-3">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-[var(--accent-primary)]">
                  新しい観望記録を追加
                </span>
                <span className="text-[10px] text-[var(--text-muted)]">{location.name_ja}</span>
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                <input
                  value={logObjName}
                  onChange={(e) => {
                    setLogObjName(e.target.value);
                    if (!logObjId) setLogObjId(e.target.value);
                  }}
                  placeholder="天体名 (例: M42 オリオン大星雲)"
                  className="col-span-2 h-7 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 text-xs outline-none"
                />
                <input
                  value={logEquip}
                  onChange={(e) => setLogEquip(e.target.value)}
                  placeholder="使用機材 (例: 80mm F6)"
                  className="h-7 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 text-[11px] outline-none"
                />
                <div className="flex items-center justify-center gap-1 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2">
                  {[1, 2, 3, 4, 5].map((st) => (
                    <button
                      key={st}
                      type="button"
                      onClick={() => setLogRating(st)}
                      className={st <= logRating ? "text-amber-300" : "text-slate-600"}
                    >
                      <Star className="h-3.5 w-3.5 fill-current" />
                    </button>
                  ))}
                </div>
                <input
                  value={logNotes}
                  onChange={(e) => setLogNotes(e.target.value)}
                  placeholder="見え方・シーイング・メモ..."
                  className="col-span-2 h-7 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 text-[11px] outline-none"
                />
              </div>
              <div className="flex justify-between gap-1.5">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 gap-1 px-2 text-[10.5px]"
                  onClick={handleExportLogs}
                  disabled={logs.length === 0}
                >
                  <Download className="h-3 w-3" />
                  JSON出力
                </Button>
                <Button
                  type="button"
                  size="sm"
                  className="h-7 gap-1 px-3 text-[11px]"
                  disabled={!logObjName.trim()}
                  onClick={() => void handleSaveLog()}
                >
                  <Plus className="h-3.5 w-3.5" />
                  観望済みに記録
                </Button>
              </div>
            </section>

            {/* Saved Logs List */}
            <div className="space-y-1.5">
              {logs.length === 0 ? (
                <div className="py-6 text-center text-[11px] text-[var(--text-muted)]">
                  まだ観望記録がありません。天体詳細または「今夜ベスト10」からワンタップで記帳できます。
                </div>
              ) : (
                logs.map((l) => (
                  <div
                    key={l.id}
                    className="flex items-start justify-between gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)]/80 px-2.5 py-2"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 font-semibold">
                        <span className="truncate">{l.object_name}</span>
                        <span className="font-mono-num text-[10px] text-amber-300">
                          {"★".repeat(l.rating)}
                        </span>
                      </div>
                      <div className="text-[10px] text-[var(--text-muted)]">
                        {l.observed_at_iso} · {l.location_name} · {l.equipment}
                      </div>
                      {l.notes && (
                        <div className="mt-0.5 text-[10.5px] text-[var(--text-secondary)]">
                          {l.notes}
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleDeleteLog(l.id)}
                      className="rounded p-1 text-rose-400 hover:text-rose-300"
                      title="削除"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))
              )}
            </div>
          </>
        )}

        {/* TAB 3: Reminders & Timelapse Playback */}
        {tab === "events" && (
          <div className="space-y-3">
            {eventsLoading && (
              <div className="py-8 text-center text-[var(--text-muted)]">
                今後のISS通過・日食・月食を計算中...
              </div>
            )}

            {/* Next ISS Pass Live Countdown */}
            <section className="space-y-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)]/85 p-3">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 font-semibold text-sky-300">
                  <Satellite className="h-3.5 w-3.5" /> 今後72時間の ISS 通過 &amp; タイムラプス
                </span>
                <span className="text-[10px] text-[var(--text-muted)]">{location.name_ja}</span>
              </div>

              {issPasses.length === 0 ? (
                <div className="text-[11px] text-[var(--text-muted)]">
                  今後72時間以内に仰角12°以上のISS通過予報はありません。
                </div>
              ) : (
                issPasses.map((p, idx) => {
                  const secLeft = (p.aos_jd_ut - nowJdTick) * 86400;
                  return (
                    <div
                      key={p.aos_jd_ut}
                      className="space-y-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)]/75 px-2.5 py-2"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div>
                          <div className="flex items-center gap-1.5 font-semibold">
                            <span>{p.aos_str}</span>
                            {p.is_visible && (
                              <span className="rounded bg-emerald-500/20 px-1.5 py-0.2 text-[9.5px] text-emerald-300">
                                肉眼可視
                              </span>
                            )}
                          </div>
                          <div className="font-mono-num text-[10px] text-[var(--text-muted)]">
                            最高仰角 {p.max_alt_deg.toFixed(0)}° (方位 {p.max_az_deg.toFixed(0)}°) · 約
                            {(p.duration_sec / 60).toFixed(1)}分
                          </div>
                        </div>
                        {idx === 0 && (
                          <div className="rounded border border-sky-400/35 bg-sky-500/15 px-2 py-0.5 font-mono-num text-[10.5px] text-sky-200">
                            あと {formatCountdownSec(secLeft)}
                          </div>
                        )}
                      </div>

                      <div className="flex gap-1.5">
                        <Button
                          type="button"
                          size="sm"
                          className="h-6 flex-1 gap-1 text-[10px]"
                          onClick={() => startIssPassTimelapse(p)}
                        >
                          <Play className="h-3 w-3" />
                          タイムラプス再生
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-6 gap-1 px-2 text-[10px]"
                          onClick={() => schedulePassAlarm(p.aos_jd_ut, `ISS通過 (${p.aos_str})`)}
                        >
                          <Bell className="h-3 w-3" />
                          10分前アラーム
                        </Button>
                      </div>
                    </div>
                  );
                })
              )}
            </section>

            {/* Local Visible Solar & Lunar Eclipses Quick Timelapse */}
            <section className="space-y-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)]/85 p-3">
              <div className="flex items-center gap-1.5 font-semibold text-amber-300">
                <Eclipse className="h-3.5 w-3.5" /> 今後の現地観測可能な日食・月食
              </div>
              {solarEclipses.length === 0 && lunarEclipses.length === 0 ? (
                <div className="text-[11px] text-[var(--text-muted)]">
                  今後3年間に現地で観測可能な食イベントはありません。
                </div>
              ) : (
                <div className="space-y-1.5">
                  {solarEclipses.map((e) => (
                    <div
                      key={`sol-${e.global_max_jd_ut}`}
                      className="flex items-center justify-between gap-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)]/75 px-2.5 py-1.5"
                    >
                      <div className="min-w-0">
                        <div className="font-semibold">
                          日食 ({e.local_type_ja}) · {e.date_local_str}
                        </div>
                        <div className="font-mono-num text-[10px] text-[var(--text-muted)]">
                          最大 {e.max_time_str} · 食分 {e.local_magnitude.toFixed(2)} (面積{" "}
                          {e.max_obscuration_pct.toFixed(0)}%)
                        </div>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        className="h-6 shrink-0 gap-1 px-2 text-[10px]"
                        onClick={() => {
                          jumpToJdUt(e.local_max_jd_ut - 30 / 1440);
                          centerOnSkyCoords(e.ra_deg, e.dec_deg, e.max_sun_az_deg, e.max_sun_alt_deg);
                          setSimTarget("time");
                          setSimDirection(1);
                          setSimStepMinutes(2);
                          setSimPlaying(true);
                        }}
                      >
                        <Play className="h-3 w-3" />
                        食再生
                      </Button>
                    </div>
                  ))}
                  {lunarEclipses.map((e) => (
                    <div
                      key={`lun-${e.max_jd_ut}`}
                      className="flex items-center justify-between gap-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)]/75 px-2.5 py-1.5"
                    >
                      <div className="min-w-0">
                        <div className="font-semibold">
                          月食 ({e.eclipse_type_ja}) · {e.date_local_str}
                        </div>
                        <div className="font-mono-num text-[10px] text-[var(--text-muted)]">
                          食最大 {e.max_str} · 本影食分 {e.umbral_magnitude.toFixed(2)} · 高度{" "}
                          {e.max_moon_alt_deg.toFixed(0)}°
                        </div>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        className="h-6 shrink-0 gap-1 px-2 text-[10px]"
                        onClick={() => {
                          jumpToJdUt(e.max_jd_ut - 45 / 1440);
                          setSimTarget("time");
                          setSimDirection(1);
                          setSimStepMinutes(3);
                          setSimPlaying(true);
                        }}
                      >
                        <Play className="h-3 w-3" />
                        月食再生
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </aside>
  );
}
