import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  Compass,
  Download,
  Edit3,
  Eye,
  EyeOff,
  FileUp,
  Flame,
  Globe,
  Plus,
  Radar,
  RotateCcw,
  Satellite,
  Search,
  Trash2,
  TrendingUp,
  WifiOff,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatDistanceKm, formatVelocityKmS } from "@/lib/units";
import { localYmdHmsToJdUt, useSkyStore } from "@/store/skyStore";
import type {
  CometRecord,
  CometWithEphemeris,
  OnlineSyncResult,
  SatellitePass,
  SatelliteSkyPos,
} from "@/types/sky";

function jdToUtcString(jd: number): string {
  const z = Math.floor(jd + 0.5);
  const f = jd + 0.5 - z;
  let a = z;
  if (z >= 2299161) {
    const alpha = Math.floor((z - 1867216.25) / 36524.25);
    a = z + 1 + alpha - Math.floor(alpha / 4);
  }
  const b = a + 1524;
  const c = Math.floor((b - 122.1) / 365.25);
  const d = Math.floor(365.25 * c);
  const e = Math.floor((b - d) / 30.6001);
  const day = b - d - Math.floor(30.6001 * e);
  const month = e < 14 ? e - 1 : e - 13;
  const year = month > 2 ? c - 4716 : c - 4715;
  const totalMin = Math.round(f * 1440);
  const hh = Math.floor(totalMin / 60) % 24;
  const mm = totalMin % 60;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")} ${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function parseUtcDateToJd(raw: string): number | null {
  const m = raw
    .trim()
    .match(/^(-?\d{1,5})[-/](\d{1,2})[-/](\d{1,2})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const h = m[4] ? Number(m[4]) : 0;
  const mi = m[5] ? Number(m[5]) : 0;
  const s = m[6] ? Number(m[6]) : 0;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  return localYmdHmsToJdUt(y, mo, d, h, mi, s, 0);
}

interface CometFormState {
  id: string;
  name: string;
  periDateUtc: string;
  epoch_perihelion_jd: string;
  perihelion_dist_au: string;
  eccentricity: string;
  inclination_deg: string;
  arg_periapsis_deg: string;
  ascending_node_deg: string;
  abs_mag_h: string;
  slope_param_k: string;
  enabled: boolean;
  notes: string;
}

function emptyFormState(defaultJd: number): CometFormState {
  return {
    id: "",
    name: "",
    periDateUtc: jdToUtcString(defaultJd),
    epoch_perihelion_jd: defaultJd.toFixed(4),
    perihelion_dist_au: "0.8000",
    eccentricity: "0.9500",
    inclination_deg: "25.00",
    arg_periapsis_deg: "180.00",
    ascending_node_deg: "90.00",
    abs_mag_h: "6.5",
    slope_param_k: "10.0",
    enabled: true,
    notes: "",
  };
}

function recordToFormState(r: CometRecord): CometFormState {
  return {
    id: r.id,
    name: r.name,
    periDateUtc: jdToUtcString(r.epoch_perihelion_jd),
    epoch_perihelion_jd: r.epoch_perihelion_jd.toFixed(5),
    perihelion_dist_au: String(r.perihelion_dist_au),
    eccentricity: String(r.eccentricity),
    inclination_deg: String(r.inclination_deg),
    arg_periapsis_deg: String(r.arg_periapsis_deg),
    ascending_node_deg: String(r.ascending_node_deg),
    abs_mag_h: String(r.abs_mag_h),
    slope_param_k: String(r.slope_param_k),
    enabled: r.enabled,
    notes: r.notes,
  };
}

export function CometSatManager() {
  const comets = useSkyStore((s) => s.comets);
  const satellites = useSkyStore((s) => s.satellites);
  const showSatellites = useSkyStore((s) => s.showSatellites);
  const highlightedSatPass = useSkyStore((s) => s.highlightedSatPass);
  const offlineMode = useSkyStore((s) => s.offlineMode);
  const jdUt = useSkyStore((s) => s.jdUt);
  const location = useSkyStore((s) => s.location);
  const unitSystem = useSkyStore((s) => s.unitSystem);
  const refractionEnabled = useSkyStore((s) => s.refractionEnabled);
  const refreshComets = useSkyStore((s) => s.refreshComets);
  const notifyCometsChanged = useSkyStore((s) => s.notifyCometsChanged);
  const refreshSatellites = useSkyStore((s) => s.refreshSatellites);
  const notifySatellitesChanged = useSkyStore((s) => s.notifySatellitesChanged);
  const setShowSatellites = useSkyStore((s) => s.setShowSatellites);
  const setHighlightedSatPass = useSkyStore((s) => s.setHighlightedSatPass);
  const setOfflineMode = useSkyStore((s) => s.setOfflineMode);
  const jumpToJdUt = useSkyStore((s) => s.jumpToJdUt);
  const lookAtDirection = useSkyStore((s) => s.lookAtDirection);
  const selectObject = useSkyStore((s) => s.selectObject);
  const setActivePanel = useSkyStore((s) => s.setActivePanel);

  const [tab, setTab] = useState<"comets" | "satellites">("comets");
  const [query, setQuery] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  const [form, setForm] = useState<CometFormState>(() => emptyFormState(jdUt));
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [replaceAllOnImport, setReplaceAllOnImport] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Satellite UI state
  const [satQuery, setSatQuery] = useState("");
  const [tlePasteOpen, setTlePasteOpen] = useState(false);
  const [tleText, setTleText] = useState("");
  const [celestrakGroup, setCelestrakGroup] = useState<"stations" | "visual" | "weather">("stations");
  const [selectedSatIdForPasses, setSelectedSatIdForPasses] = useState<string>("sat:25544");
  const [visibleOnlyPasses, setVisibleOnlyPasses] = useState<boolean>(false);
  const [passes, setPasses] = useState<SatellitePass[]>([]);

  useEffect(() => {
    void refreshComets();
    void refreshSatellites();
  }, [jdUt, location.lat_deg, location.lon_deg, location.alt_m, refractionEnabled, refreshComets, refreshSatellites]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return comets;
    return comets.filter(
      (c) =>
        c.record.name.toLowerCase().includes(q) ||
        c.record.id.toLowerCase().includes(q) ||
        c.record.notes.toLowerCase().includes(q),
    );
  }, [comets, query]);

  const openAddForm = () => {
    setForm(emptyFormState(jdUt));
    setErrorMsg(null);
    setStatusMsg(null);
    setEditorOpen(true);
    setImportOpen(false);
  };

  const openEditForm = (rec: CometRecord) => {
    setForm(recordToFormState(rec));
    setErrorMsg(null);
    setStatusMsg(null);
    setEditorOpen(true);
    setImportOpen(false);
  };

  const handleSave = async () => {
    if (!isTauri()) return;
    setErrorMsg(null);
    setStatusMsg(null);
    const record: CometRecord = {
      id: form.id.trim(),
      name: form.name.trim(),
      epoch_perihelion_jd: Number(form.epoch_perihelion_jd),
      perihelion_dist_au: Number(form.perihelion_dist_au),
      eccentricity: Number(form.eccentricity),
      inclination_deg: Number(form.inclination_deg),
      arg_periapsis_deg: Number(form.arg_periapsis_deg),
      ascending_node_deg: Number(form.ascending_node_deg),
      abs_mag_h: Number(form.abs_mag_h),
      slope_param_k: Number(form.slope_param_k),
      enabled: form.enabled,
      notes: form.notes.trim(),
    };

    setBusy(true);
    try {
      const saved = await invoke<CometRecord>("upsert_comet_cmd", { record });
      await notifyCometsChanged();
      setEditorOpen(false);
      setStatusMsg(`「${saved.name}」を SQLite に保存し、星図・3D太陽系へ反映しました。`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleToggleEnabled = async (c: CometWithEphemeris) => {
    if (!isTauri()) return;
    setErrorMsg(null);
    try {
      await invoke("set_comet_enabled_cmd", {
        id: c.record.id,
        enabled: !c.record.enabled,
      });
      await notifyCometsChanged();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDelete = async (c: CometWithEphemeris) => {
    if (!isTauri()) return;
    setErrorMsg(null);
    setStatusMsg(null);
    try {
      await invoke<boolean>("delete_comet_cmd", { id: c.record.id });
      await notifyCometsChanged();
      setStatusMsg(`「${c.record.name}」を削除しました。`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleExportJson = async () => {
    if (!isTauri()) return;
    setErrorMsg(null);
    try {
      const jsonText = await invoke<string>("export_comets_json_cmd");
      const blob = new Blob([jsonText], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "starcrane-comets.json";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setStatusMsg(`登録彗星 ${comets.length} 件を JSON エクスポートしました。`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleImportSubmit = async () => {
    if (!isTauri()) return;
    setErrorMsg(null);
    setStatusMsg(null);
    setBusy(true);
    try {
      const count = await invoke<number>("import_comets_json_cmd", {
        jsonText: importText,
        replaceAll: replaceAllOnImport,
      });
      await notifyCometsChanged();
      setImportOpen(false);
      setImportText("");
      setStatusMsg(`${count} 件の彗星軌道要素を SQLite にインポートしました。`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleRestoreDefaults = async () => {
    if (!isTauri()) return;
    setErrorMsg(null);
    setStatusMsg(null);
    try {
      const n = await invoke<number>("reset_default_comets_cmd", { replaceAll: false });
      await notifyCometsChanged();
      setStatusMsg(`既定彗星 ${n} 件を復元しました。`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleJumpSky = (c: CometWithEphemeris) => {
    selectObject(
      {
        kind: "comet",
        id: c.record.id,
        name_ja: c.record.name,
        name_en: c.record.name,
        constellation: null,
        mag: c.visual_magnitude,
        ra_deg: c.ra_deg,
        dec_deg: c.dec_deg,
        az_deg: c.az_deg,
        alt_deg: c.alt_deg,
        dist_text: `${c.geo_au.toFixed(4)} AU`,
        angular_sep_deg: 0,
        extra_info: `日心 ${c.helio_au.toFixed(3)} AU / 離角 ${c.elongation_deg.toFixed(1)}°`,
      },
      true,
    );
  };

  const handleSyncMpc = async () => {
    if (!isTauri()) return;
    setErrorMsg(null);
    setStatusMsg(null);
    setBusy(true);
    try {
      const res = await invoke<OnlineSyncResult>("sync_mpc_comets_cmd", {
        offlineMode,
        replaceAll: false,
        maxCount: 150,
      });
      await notifyCometsChanged();
      setStatusMsg(res.summary_ja);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleSyncCelesTrak = async () => {
    if (!isTauri()) return;
    setErrorMsg(null);
    setStatusMsg(null);
    setBusy(true);
    try {
      const res = await invoke<OnlineSyncResult>("sync_celestrak_tle_cmd", {
        offlineMode,
        group: celestrakGroup,
      });
      await notifySatellitesChanged();
      setStatusMsg(res.summary_ja);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleImportTle = async () => {
    if (!isTauri() || !tleText.trim()) return;
    setErrorMsg(null);
    setStatusMsg(null);
    setBusy(true);
    try {
      const count = await invoke<number>("import_tle_text_cmd", {
        tleText,
        category: "custom",
      });
      await notifySatellitesChanged();
      setTlePasteOpen(false);
      setTleText("");
      setStatusMsg(`${count} 機の人工衛星 TLE を SQLite へ登録しました。`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handlePredictPasses = async (satId: string) => {
    if (!isTauri()) return;
    setSelectedSatIdForPasses(satId);
    setErrorMsg(null);
    setBusy(true);
    try {
      const res = await invoke<SatellitePass[]>("predict_satellite_passes_cmd", {
        req: {
          sat_id: satId,
          start_jd_ut: jdUt,
          hours: 48,
          min_max_alt_deg: 10,
          visible_only: visibleOnlyPasses,
          lat_deg: location.lat_deg,
          lon_deg: location.lon_deg,
          alt_m: location.alt_m,
          tz_offset_min: location.tz_offset_min,
        },
      });
      setPasses(res);
      setStatusMsg(
        res.length > 0
          ? `${res[0].sat_name} の今後48時間・${res.length} 件の通過パスを計算しました。`
          : "今後48時間以内に条件を満たす通過パスはありません。",
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const filteredSats = useMemo(() => {
    const q = satQuery.trim().toLowerCase();
    if (!q) return satellites;
    return satellites.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        String(s.norad_id).includes(q) ||
        s.category.toLowerCase().includes(q),
    );
  }, [satellites, satQuery]);

  return (
    <aside className="flex h-full w-[29.5rem] max-w-[calc(100vw-5.5rem)] flex-col rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface-glass)] text-[var(--text-primary)] shadow-2xl backdrop-blur-md">
      {/* Header */}
      <div className="flex items-start justify-between gap-2 border-b border-[var(--border-subtle)] px-4 py-3">
        <div>
          <h2 className="flex items-center gap-1.5 text-sm font-semibold tracking-tight">
            {tab === "comets" ? (
              <Flame className="h-4 w-4 text-emerald-400" />
            ) : (
              <Satellite className="h-4 w-4 text-cyan-400" />
            )}
            彗星データ &amp; 人工衛星・ISS 追跡
          </h2>
          <p className="text-[11px] text-[var(--text-muted)]">
            SQLite 永続化・SGP4 通過予報・公式 HTTPS ホワイトリスト同期対応
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setOfflineMode(!offlineMode)}
            className={`flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] font-medium ${
              offlineMode
                ? "border-amber-500/40 bg-amber-500/15 text-amber-200"
                : "border-emerald-500/40 bg-emerald-500/15 text-emerald-200"
            }`}
            title="オフラインモードと公式ドメイン通信の切替"
          >
            {offlineMode ? <WifiOff className="h-3 w-3" /> : <Globe className="h-3 w-3" />}
            {offlineMode ? "オフライン" : "公式通信可"}
          </button>
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

      {/* Mode Switch Tabs */}
      <div className="flex gap-1 border-b border-[var(--border-subtle)] px-4 py-2 text-xs">
        <button
          type="button"
          onClick={() => {
            setTab("comets");
            setErrorMsg(null);
            setStatusMsg(null);
          }}
          className={`flex items-center gap-1 rounded-lg px-3 py-1 font-medium transition ${
            tab === "comets"
              ? "bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]"
              : "bg-[var(--bg-surface)] text-[var(--text-secondary)]"
          }`}
        >
          <Flame className="h-3.5 w-3.5" />
          彗星 ({comets.length})
        </button>
        <button
          type="button"
          onClick={() => {
            setTab("satellites");
            setErrorMsg(null);
            setStatusMsg(null);
          }}
          className={`flex items-center gap-1 rounded-lg px-3 py-1 font-medium transition ${
            tab === "satellites"
              ? "bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]"
              : "bg-[var(--bg-surface)] text-[var(--text-secondary)]"
          }`}
        >
          <Satellite className="h-3.5 w-3.5" />
          人工衛星・ISS ({satellites.length})
        </button>
      </div>

      {tab === "comets" ? (
        <>
          {/* Comet Toolbar */}
          <div className="space-y-2 border-b border-[var(--border-subtle)] px-4 py-2.5 text-xs">
            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                type="button"
                size="sm"
                variant="default"
                className="h-7 gap-1 px-2.5 text-[11px]"
                onClick={openAddForm}
              >
                <Plus className="h-3.5 w-3.5" />
                新規彗星
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 gap-1 px-2 text-[11px]"
                disabled={busy || offlineMode}
                onClick={() => void handleSyncMpc()}
                title="minorplanetcenter.net 公式Soft00Cmtから最新軌道を取得"
              >
                <Globe className="h-3.5 w-3.5 text-sky-400" />
                MPC公式同期
              </Button>
              <Button
                type="button"
                size="sm"
                variant={importOpen ? "default" : "outline"}
                className="h-7 gap-1 px-2 text-[11px]"
                onClick={() => {
                  setImportOpen(!importOpen);
                  setEditorOpen(false);
                }}
              >
                <FileUp className="h-3.5 w-3.5" />
                JSON
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 gap-1 px-2 text-[11px]"
                onClick={() => void handleExportJson()}
              >
                <Download className="h-3.5 w-3.5" />
                書出
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 gap-1 px-2 text-[11px]"
                onClick={() => void handleRestoreDefaults()}
                title="既定の5彗星を再登録"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                復元
              </Button>
            </div>

        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="彗星名・符号・メモで絞り込み..."
            className="h-8 w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] pr-3 pl-8 text-xs outline-none focus:border-[var(--accent-primary)]"
          />
        </div>

        {statusMsg && (
          <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/15 px-2.5 py-1.5 text-[11px] text-emerald-200">
            {statusMsg}
          </div>
        )}
        {errorMsg && (
          <div className="rounded-lg border border-rose-500/40 bg-rose-500/15 px-2.5 py-1.5 text-[11px] text-rose-200">
            {errorMsg}
          </div>
        )}
      </div>

      {/* Main Scrollable Content */}
      <div className="flex-1 space-y-2.5 overflow-y-auto px-4 py-3 text-xs">
        {/* Inline JSON Import Modal */}
        {importOpen && (
          <div className="space-y-2 rounded-xl border border-[var(--accent-primary)]/40 bg-[var(--bg-surface-elevated)] p-3">
            <div className="flex items-center justify-between">
              <span className="font-semibold">彗星JSONインポート</span>
              <div className="flex items-center gap-1.5">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".json,.txt"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    void file.text().then((txt) => setImportText(txt));
                  }}
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-6 px-2 text-[10px]"
                  onClick={() => fileInputRef.current?.click()}
                >
                  ファイル選択
                </Button>
              </div>
            </div>
            <textarea
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              rows={5}
              placeholder='[{"name":"C/2025 XX","epoch_perihelion_jd":2461100.5,"perihelion_dist_au":0.65,"eccentricity":0.99,"inclination_deg":42,"arg_periapsis_deg":110,"ascending_node_deg":220,"abs_mag_h":6.0,"slope_param_k":10.0}]'
              className="w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-2 font-mono-num text-[11px] outline-none focus:border-[var(--accent-primary)]"
            />
            <div className="flex items-center justify-between gap-2">
              <label className="flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)]">
                <input
                  type="checkbox"
                  checked={replaceAllOnImport}
                  onChange={(e) => setReplaceAllOnImport(e.target.checked)}
                />
                既存データを置換する
              </label>
              <div className="flex gap-1.5">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2.5 text-[11px]"
                  onClick={() => setImportOpen(false)}
                >
                  キャンセル
                </Button>
                <Button
                  type="button"
                  size="sm"
                  className="h-7 px-3 text-[11px]"
                  disabled={busy || !importText.trim()}
                  onClick={() => void handleImportSubmit()}
                >
                  インポート実行
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Inline Add / Edit Form */}
        {editorOpen && (
          <div className="space-y-2 rounded-xl border border-emerald-500/40 bg-[var(--bg-surface-elevated)] p-3">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-emerald-300">
                {form.id ? "軌道要素の編集" : "新しい彗星を登録"}
              </span>
              <label className="flex items-center gap-1.5 text-[11px]">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
                />
                星図・3Dに表示
              </label>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <label className="col-span-2 space-y-0.5">
                <span className="text-[10px] text-[var(--text-muted)]">彗星名 / 符号</span>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="例: C/2026 A1 (Atlas)"
                  className="h-7 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 text-xs"
                />
              </label>

              <label className="space-y-0.5">
                <span className="text-[10px] text-[var(--text-muted)]">近日点通過 UTC</span>
                <input
                  type="text"
                  value={form.periDateUtc}
                  onChange={(e) => {
                    const v = e.target.value;
                    const parsed = parseUtcDateToJd(v);
                    setForm((prev) => ({
                      ...prev,
                      periDateUtc: v,
                      epoch_perihelion_jd:
                        parsed !== null ? parsed.toFixed(5) : prev.epoch_perihelion_jd,
                    }));
                  }}
                  placeholder="YYYY-MM-DD HH:MM"
                  className="h-7 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 font-mono-num text-[11px]"
                />
              </label>

              <label className="space-y-0.5">
                <span className="text-[10px] text-[var(--text-muted)]">近日点通過時刻 T (JD)</span>
                <input
                  type="number"
                  step="0.001"
                  value={form.epoch_perihelion_jd}
                  onChange={(e) => {
                    const v = e.target.value;
                    const num = Number(v);
                    setForm((prev) => ({
                      ...prev,
                      epoch_perihelion_jd: v,
                      periDateUtc: Number.isFinite(num) && num > 1000 ? jdToUtcString(num) : prev.periDateUtc,
                    }));
                  }}
                  className="h-7 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 font-mono-num text-[11px]"
                />
              </label>

              <label className="space-y-0.5">
                <span className="text-[10px] text-[var(--text-muted)]">近日点距離 q (AU)</span>
                <input
                  type="number"
                  step="0.0001"
                  value={form.perihelion_dist_au}
                  onChange={(e) => setForm({ ...form, perihelion_dist_au: e.target.value })}
                  className="h-7 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 font-mono-num text-[11px]"
                />
              </label>

              <label className="space-y-0.5">
                <span className="text-[10px] text-[var(--text-muted)]">離心率 e</span>
                <input
                  type="number"
                  step="0.0001"
                  value={form.eccentricity}
                  onChange={(e) => setForm({ ...form, eccentricity: e.target.value })}
                  className="h-7 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 font-mono-num text-[11px]"
                />
              </label>

              <label className="space-y-0.5">
                <span className="text-[10px] text-[var(--text-muted)]">軌道傾斜角 i (°)</span>
                <input
                  type="number"
                  step="0.01"
                  value={form.inclination_deg}
                  onChange={(e) => setForm({ ...form, inclination_deg: e.target.value })}
                  className="h-7 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 font-mono-num text-[11px]"
                />
              </label>

              <label className="space-y-0.5">
                <span className="text-[10px] text-[var(--text-muted)]">近日点引数 ω (°)</span>
                <input
                  type="number"
                  step="0.01"
                  value={form.arg_periapsis_deg}
                  onChange={(e) => setForm({ ...form, arg_periapsis_deg: e.target.value })}
                  className="h-7 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 font-mono-num text-[11px]"
                />
              </label>

              <label className="space-y-0.5">
                <span className="text-[10px] text-[var(--text-muted)]">昇交点黄経 Ω (°)</span>
                <input
                  type="number"
                  step="0.01"
                  value={form.ascending_node_deg}
                  onChange={(e) => setForm({ ...form, ascending_node_deg: e.target.value })}
                  className="h-7 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 font-mono-num text-[11px]"
                />
              </label>

              <div className="grid grid-cols-2 gap-1.5">
                <label className="space-y-0.5">
                  <span className="text-[10px] text-[var(--text-muted)]">絶対等級 H</span>
                  <input
                    type="number"
                    step="0.1"
                    value={form.abs_mag_h}
                    onChange={(e) => setForm({ ...form, abs_mag_h: e.target.value })}
                    className="h-7 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 font-mono-num text-[11px]"
                  />
                </label>
                <label className="space-y-0.5">
                  <span className="text-[10px] text-[var(--text-muted)]">光度係数 K</span>
                  <input
                    type="number"
                    step="0.5"
                    value={form.slope_param_k}
                    onChange={(e) => setForm({ ...form, slope_param_k: e.target.value })}
                    className="h-7 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 font-mono-num text-[11px]"
                  />
                </label>
              </div>

              <label className="col-span-2 space-y-0.5">
                <span className="text-[10px] text-[var(--text-muted)]">メモ</span>
                <input
                  type="text"
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  placeholder="特徴や観測条件など"
                  className="h-7 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 text-xs"
                />
              </label>
            </div>

            <div className="flex justify-end gap-1.5 pt-1">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 px-2.5 text-[11px]"
                onClick={() => setEditorOpen(false)}
              >
                閉じる
              </Button>
              <Button
                type="button"
                size="sm"
                className="h-7 px-3 text-[11px]"
                disabled={busy}
                onClick={() => void handleSave()}
              >
                保存して即時反映
              </Button>
            </div>
          </div>
        )}

        {/* Comet Cards List */}
        {filtered.map((c) => {
          const aboveHorizon = c.alt_deg >= 0;
          return (
            <div
              key={c.record.id}
              className={`space-y-2 rounded-xl border p-3 transition ${
                c.record.enabled
                  ? "border-[var(--border-subtle)] bg-[var(--bg-surface)]"
                  : "border-[var(--border-subtle)]/50 bg-[var(--bg-surface)]/45 opacity-75"
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate font-semibold text-emerald-300">{c.record.name}</span>
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                        aboveHorizon
                          ? "bg-emerald-500/20 text-emerald-300"
                          : "bg-slate-500/20 text-slate-300"
                      }`}
                    >
                      高度 {c.alt_deg.toFixed(1)}°
                    </span>
                  </div>
                  <div className="mt-0.5 text-[10px] text-[var(--text-muted)]">
                    {c.orbit_type_ja} · 近日点 {c.perihelion_date_str}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void handleToggleEnabled(c)}
                  className={`flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] ${
                    c.record.enabled
                      ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-200"
                      : "border-[var(--border-subtle)] text-[var(--text-muted)]"
                  }`}
                  title={c.record.enabled ? "クリックで非表示" : "クリックで表示"}
                >
                  {c.record.enabled ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                  {c.record.enabled ? "表示中" : "非表示"}
                </button>
              </div>

              <div className="grid grid-cols-4 gap-1.5 rounded-lg bg-[var(--bg-surface-elevated)] px-2 py-1.5 font-mono-num text-[11px]">
                <div>
                  <div className="text-[9px] text-[var(--text-muted)]">予想光度</div>
                  <div className="font-semibold text-amber-200">{c.visual_magnitude.toFixed(1)}等</div>
                </div>
                <div>
                  <div className="text-[9px] text-[var(--text-muted)]">日心距離 r</div>
                  <div>{c.helio_au.toFixed(3)} AU</div>
                </div>
                <div>
                  <div className="text-[9px] text-[var(--text-muted)]">地心距離 Δ</div>
                  <div>{c.geo_au.toFixed(3)} AU</div>
                </div>
                <div>
                  <div className="text-[9px] text-[var(--text-muted)]">離角 / q</div>
                  <div>
                    {c.elongation_deg.toFixed(0)}° / {c.record.perihelion_dist_au.toFixed(2)}
                  </div>
                </div>
              </div>

              {c.record.notes && (
                <p className="text-[11px] leading-relaxed text-[var(--text-secondary)]">
                  {c.record.notes}
                </p>
              )}

              <div className="flex flex-wrap items-center justify-between gap-1 pt-0.5">
                <div className="flex flex-wrap gap-1">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-6 gap-1 px-2 text-[10px]"
                    onClick={() => handleJumpSky(c)}
                  >
                    <Compass className="h-3 w-3" />
                    星図で表示
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-6 gap-1 px-2 text-[10px]"
                    onClick={() => setActivePanel("solar3d")}
                  >
                    <Box className="h-3 w-3" />
                    3D
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-6 gap-1 px-2 text-[10px]"
                    onClick={() => setActivePanel("planets")}
                  >
                    <TrendingUp className="h-3 w-3" />
                    光度曲線
                  </Button>
                </div>

                <div className="flex gap-1">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-6 w-6 p-0"
                    onClick={() => openEditForm(c.record)}
                    title="編集"
                  >
                    <Edit3 className="h-3 w-3" />
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-6 w-6 p-0 text-rose-400 hover:text-rose-300"
                    onClick={() => void handleDelete(c)}
                    title="削除"
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            </div>
          );
        })}

        {filtered.length === 0 && (
          <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-6 text-center text-xs text-[var(--text-muted)]">
            該当する彗星が見つかりません。「新規彗星」または「復元」から登録してください。
          </div>
        )}
      </div>
        </>
      ) : (
        <>
          {/* Satellite Toolbar */}
          <div className="space-y-2 border-b border-[var(--border-subtle)] px-4 py-2.5 text-xs">
            <div className="flex flex-wrap items-center gap-1.5">
              <select
                value={celestrakGroup}
                onChange={(e) => setCelestrakGroup(e.target.value as "stations" | "visual" | "weather")}
                className="h-7 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 text-[11px]"
              >
                <option value="stations">宇宙ステーション (ISS等)</option>
                <option value="visual">明るい可視衛星 (上位)</option>
                <option value="weather">気象衛星 (NOAA等)</option>
              </select>
              <Button
                type="button"
                size="sm"
                variant="default"
                className="h-7 gap-1 px-2 text-[11px]"
                disabled={busy || offlineMode}
                onClick={() => void handleSyncCelesTrak()}
                title="celestrak.org 公式GPテキストから最新TLEを取得"
              >
                <Globe className="h-3.5 w-3.5" />
                CelesTrak同期
              </Button>
              <Button
                type="button"
                size="sm"
                variant={tlePasteOpen ? "default" : "outline"}
                className="h-7 gap-1 px-2 text-[11px]"
                onClick={() => setTlePasteOpen(!tlePasteOpen)}
              >
                <Plus className="h-3.5 w-3.5" />
                TLE貼付
              </Button>
              <Button
                type="button"
                size="sm"
                variant={showSatellites ? "outline" : "ghost"}
                className="h-7 gap-1 px-2 text-[11px]"
                onClick={() => setShowSatellites(!showSatellites)}
              >
                {showSatellites ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                星図{showSatellites ? "ON" : "OFF"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 w-7 p-0"
                onClick={() => {
                  if (!isTauri()) return;
                  void invoke<number>("reset_default_satellites_cmd").then(() => notifySatellitesChanged());
                }}
                title="既定衛星を復元"
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </Button>
            </div>

            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]" />
                <input
                  type="text"
                  value={satQuery}
                  onChange={(e) => setSatQuery(e.target.value)}
                  placeholder="衛星名・NORAD ID で絞り込み..."
                  className="h-8 w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] pr-3 pl-8 text-xs outline-none focus:border-[var(--accent-primary)]"
                />
              </div>
              {highlightedSatPass && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-[10px]"
                  onClick={() => setHighlightedSatPass(null)}
                >
                  通過線クリア
                </Button>
              )}
            </div>

            {statusMsg && (
              <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/15 px-2.5 py-1.5 text-[11px] text-emerald-200">
                {statusMsg}
              </div>
            )}
            {errorMsg && (
              <div className="rounded-lg border border-rose-500/40 bg-rose-500/15 px-2.5 py-1.5 text-[11px] text-rose-200">
                {errorMsg}
              </div>
            )}
          </div>

          <div className="flex-1 space-y-2.5 overflow-y-auto px-4 py-3 text-xs">
            {tlePasteOpen && (
              <div className="space-y-2 rounded-xl border border-cyan-500/40 bg-[var(--bg-surface-elevated)] p-3">
                <span className="font-semibold">3行 / 2行 TLE テキスト登録</span>
                <textarea
                  value={tleText}
                  onChange={(e) => setTleText(e.target.value)}
                  rows={4}
                  placeholder={"ISS (ZARYA)\n1 25544U ...\n2 25544 ..."}
                  className="w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-2 font-mono-num text-[11px]"
                />
                <div className="flex justify-end gap-1.5">
                  <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={() => setTlePasteOpen(false)}>
                    閉じる
                  </Button>
                  <Button type="button" size="sm" className="h-7 px-3 text-[11px]" disabled={busy} onClick={() => void handleImportTle()}>
                    解析して登録
                  </Button>
                </div>
              </div>
            )}

            {/* Pass Prediction Results */}
            <div className="space-y-2 rounded-xl border border-cyan-500/35 bg-[var(--bg-surface-elevated)] p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 font-semibold text-cyan-300">
                  <Radar className="h-3.5 w-3.5" />
                  今後48時間の可視パス予報 ({location.name_ja})
                </span>
                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-1 text-[10px] text-[var(--text-secondary)]">
                    <input
                      type="checkbox"
                      checked={visibleOnlyPasses}
                      onChange={(e) => setVisibleOnlyPasses(e.target.checked)}
                    />
                    肉眼可視のみ
                  </label>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-[10px]"
                    disabled={busy}
                    onClick={() => void handlePredictPasses(selectedSatIdForPasses)}
                  >
                    再計算
                  </Button>
                </div>
              </div>

              {passes.length > 0 ? (
                <div className="max-h-44 space-y-1.5 overflow-y-auto">
                  {passes.map((p, idx) => (
                    <div
                      key={`${p.sat_id}-${idx}`}
                      className="flex items-center justify-between gap-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2.5 py-1.5 text-[11px]"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 font-mono-num">
                          <span className="font-bold text-cyan-200">{p.max_str}</span>
                          <span className="text-amber-200">最大 {p.max_alt_deg.toFixed(0)}°</span>
                          <span className="text-[10px] text-[var(--text-muted)]">
                            ({p.aos_str}→{p.los_str})
                          </span>
                          {p.is_visible && (
                            <span className="rounded bg-amber-500/20 px-1 py-0.2 text-[9px] font-semibold text-amber-200">
                              可視!
                            </span>
                          )}
                        </div>
                        <div className="text-[10px] text-[var(--text-muted)]">
                          昇方位 {p.aos_az_deg.toFixed(0)}° → 最頂方位 {p.max_az_deg.toFixed(0)}° → 没方位 {p.los_az_deg.toFixed(0)}° · {(p.duration_sec / 60).toFixed(1)}分
                        </div>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        className="h-6 shrink-0 px-2 text-[10px]"
                        onClick={() => {
                          setHighlightedSatPass(p);
                          jumpToJdUt(p.max_jd_ut);
                          lookAtDirection(p.max_az_deg, p.max_alt_deg);
                        }}
                      >
                        通過再生
                      </Button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-[11px] text-[var(--text-muted)]">
                  下の一覧から衛星の「パス予報」を押すと、AOS / 最大仰角 / LOS と星図軌道を算出します。
                </p>
              )}
            </div>

            {/* Live Satellite Positions */}
            {filteredSats.map((s: SatelliteSkyPos) => (
              <div
                key={s.id}
                className={`space-y-2 rounded-xl border p-3 transition ${
                  s.enabled
                    ? "border-[var(--border-subtle)] bg-[var(--bg-surface)]"
                    : "border-[var(--border-subtle)]/50 bg-[var(--bg-surface)]/45 opacity-70"
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="truncate font-semibold text-cyan-200">{s.name}</span>
                      <span className="font-mono-num text-[10px] text-[var(--text-muted)]">
                        #{s.norad_id}
                      </span>
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                          s.alt_deg >= 0
                            ? "bg-emerald-500/20 text-emerald-300"
                            : "bg-slate-500/20 text-slate-300"
                        }`}
                      >
                        高度 {s.alt_deg.toFixed(1)}°
                      </span>
                      {s.is_visible && (
                        <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-amber-200">
                          現在可視
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 font-mono-num text-[10px] text-[var(--text-muted)]">
                      地上高度 {formatDistanceKm(s.altitude_km, unitSystem)} · 距離 {formatDistanceKm(s.range_km, unitSystem)} · 速度 {formatVelocityKmS(s.velocity_km_s, unitSystem)} · 直下 {s.subpoint_lat_deg.toFixed(1)}°, {s.subpoint_lon_deg.toFixed(1)}°
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      if (!isTauri()) return;
                      void invoke("set_satellite_enabled_cmd", { id: s.id, enabled: !s.enabled }).then(() =>
                        notifySatellitesChanged(),
                      );
                    }}
                    className={`rounded border px-2 py-0.5 text-[10px] ${
                      s.enabled
                        ? "border-cyan-500/40 bg-cyan-500/15 text-cyan-200"
                        : "border-[var(--border-subtle)] text-[var(--text-muted)]"
                    }`}
                  >
                    {s.enabled ? "表示中" : "非表示"}
                  </button>
                </div>

                <div className="flex items-center justify-between gap-1.5">
                  <div className="flex gap-1">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-6 gap-1 px-2 text-[10px]"
                      onClick={() => lookAtDirection(s.az_deg, Math.max(-20, s.alt_deg))}
                    >
                      <Compass className="h-3 w-3" />
                      現在位置へ
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      className="h-6 gap-1 px-2 text-[10px]"
                      onClick={() => void handlePredictPasses(s.id)}
                    >
                      <Radar className="h-3 w-3" />
                      パス予報
                    </Button>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      if (!isTauri()) return;
                      void invoke("delete_satellite_cmd", { id: s.id }).then(() =>
                        notifySatellitesChanged(),
                      );
                    }}
                    className="rounded p-1 text-rose-400 hover:text-rose-300"
                    title="削除"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </aside>
  );
}
