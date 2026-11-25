import { useEffect, useState, type ChangeEvent } from "react";
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Compass,
  Copy,
  Database,
  Download,
  FileJson,
  Globe,
  HardDrive,
  History,
  RefreshCw,
  RotateCcw,
  Save,
  Settings,
  ShieldCheck,
  Sliders,
  Trash2,
  Upload,
  Volume2,
  VolumeX,
  WifiOff,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { CHANGELOG_ENTRIES, parseReleaseNotesLines } from "@/lib/changelog";
import {
  buildCurrentObservationSnapshot,
  clearOfflineCacheTarget,
  deleteOfflineSnapshot,
  formatBytesCompact,
  getOfflineCacheStats,
  listOfflineSnapshots,
  loadOfflineSnapshot,
  prefetchAllSkyHipsPack,
  prefetchCurrentViewHips,
  restoreOfflineSnapshotToStore,
  saveOfflineSnapshot,
} from "@/lib/offlineSnapshots";
import { useClockStore, type HourlyChimeMode } from "@/store/clockStore";
import { useSkyStore } from "@/store/skyStore";
import { type ThemeMode, useThemeStore } from "@/store/themeStore";
import {
  isAndroidUpdaterSupported,
  isUpdaterSupported,
  useUpdaterStore,
} from "@/store/updaterStore";
import type {
  AngleFormat,
  OfflineCacheStats,
  OfflineObservationSnapshot,
  OfflineSnapshotMeta,
  UnitSystem,
} from "@/types/sky";

type SettingsTab = "general" | "offline" | "profile" | "licenses";

const OPEN_DATA_LICENSES = [
  { name: "StarCrane Application Code", desc: "プラネタリウム・天文計算・UIソースコード", license: "MIT License" },
  { name: "HYG Database v4.1", desc: "約12万恒星カタログ（Hipparcos / Bright Star / Gliese）", license: "CC BY-SA 4.0" },
  { name: "OpenNGC", desc: "メシエ110天体＋NGC/IC 約1.3万星雲・星団カタログ", license: "CC BY-SA 4.0" },
  { name: "d3-celestial", desc: "全88星座線・IAU星座境界線・天の川ポリゴン・アステリズム", license: "BSD-3-Clause" },
  { name: "Solar System Scope Textures", desc: "惑星・月・太陽・環の高精細表面テクスチャ", license: "CC BY 4.0" },
  { name: "NASA / ESA / NOIRLab Imagery", desc: "同梱メシエ・天体実写イメージ", license: "Public Domain / CC BY" },
  { name: "dataofjapan/land & Natural Earth", desc: "全国47都道府県境界線・世界海岸線ポリゴンデータ", license: "MIT / Public Domain" },
  { name: "IAU Meteor Data Center / GCVS", desc: "年間主要流星群放射点データ・主要変光星カタログ", license: "Public Scientific Data" },
  { name: "MPC / CelesTrak / Open-Meteo", desc: "公式ホワイトリスト同期データ（彗星・TLE・雲量予報）", license: "Public / CC BY 4.0" },
  { name: "CDS Aladin / DSS2 / 2MASS (HiPS)", desc: "全天実写サーベイタイル（DSS2 / 2MASS・オンデマンド/事前キャッシュ）", license: "Public Scientific Data" },
  { name: "Tauri v2 / Rust / React / Three.js", desc: "アプリ基盤・自動更新・VSOP87・SGP4・SQLite・rustls", license: "MIT / Apache-2.0" },
];

export function SettingsPanel() {
  const [tab, setTab] = useState<SettingsTab>("general");
  const [profileText, setProfileText] = useState("");
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const [cacheStats, setCacheStats] = useState<OfflineCacheStats | null>(null);
  const [snapshots, setSnapshots] = useState<OfflineSnapshotMeta[]>([]);
  const [expandedSnap, setExpandedSnap] = useState<OfflineObservationSnapshot | null>(null);
  const [snapTitle, setSnapTitle] = useState("");
  const [snapNote, setSnapNote] = useState("");
  const [packProgress, setPackProgress] = useState<{ done: number; total: number; label: string } | null>(null);
  const [changelogOpen, setChangelogOpen] = useState(false);

  const hipsConfig = useSkyStore((s) => s.hipsConfig);
  const centerOnSkyCoords = useSkyStore((s) => s.centerOnSkyCoords);

  const showObservationOnStartup = useSkyStore((s) => s.showObservationOnStartup);
  const startupDemo = useSkyStore((s) => s.startupDemo);
  const offlineMode = useSkyStore((s) => s.offlineMode);
  const unitSystem = useSkyStore((s) => s.unitSystem);
  const angleFormat = useSkyStore((s) => s.angleFormat);
  const locationsList = useSkyStore((s) => s.locationsList);
  const location = useSkyStore((s) => s.location);

  const setShowObservationOnStartup = useSkyStore((s) => s.setShowObservationOnStartup);
  const setStartupDemo = useSkyStore((s) => s.setStartupDemo);
  const setOfflineMode = useSkyStore((s) => s.setOfflineMode);
  const setUnitSystem = useSkyStore((s) => s.setUnitSystem);
  const setAngleFormat = useSkyStore((s) => s.setAngleFormat);
  const setDefaultLocation = useSkyStore((s) => s.setDefaultLocation);
  const exportProfileJson = useSkyStore((s) => s.exportProfileJson);
  const importProfileJson = useSkyStore((s) => s.importProfileJson);
  const resetAllSettings = useSkyStore((s) => s.resetAllSettings);
  const setActivePanel = useSkyStore((s) => s.setActivePanel);

  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);

  const soundEnabled = useClockStore((s) => s.soundEnabled);
  const hourlyChime = useClockStore((s) => s.hourlyChime);
  const setSoundEnabled = useClockStore((s) => s.setSoundEnabled);
  const setHourlyChime = useClockStore((s) => s.setHourlyChime);

  const updaterStatus = useUpdaterStore((s) => s.status);
  const currentVersion = useUpdaterStore((s) => s.currentVersion);
  const availableVersion = useUpdaterStore((s) => s.availableVersion);
  const releaseNotes = useUpdaterStore((s) => s.releaseNotes);
  const progressPct = useUpdaterStore((s) => s.progressPct);
  const updaterError = useUpdaterStore((s) => s.errorMessage);
  const updaterNotice = useUpdaterStore((s) => s.noticeMessage);
  const checkAndAutoDownload = useUpdaterStore((s) => s.checkAndAutoDownload);
  const installAndRestart = useUpdaterStore((s) => s.installAndRestart);
  const updaterSupported = isUpdaterSupported();
  const androidUpdater = isAndroidUpdaterSupported();

  useEffect(() => {
    void useUpdaterStore.getState().initVersion();
  }, []);

  const refreshOfflineOverview = async () => {
    try {
      const [stats, snaps] = await Promise.all([
        getOfflineCacheStats(),
        listOfflineSnapshots(),
      ]);
      setCacheStats(stats);
      setSnapshots(snaps);
    } catch {
      // Ignore stats error
    }
  };

  useEffect(() => {
    if (tab === "offline") {
      void refreshOfflineOverview();
    }
  }, [tab]);

  const currentDefaultLocId =
    locationsList.find((l) => l.is_default)?.id ?? location.id;

  const handleDownloadProfile = () => {
    const json = exportProfileJson();
    setProfileText(json);
    const blob = new Blob([json], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "starcrane-profile-v1.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setFeedback({ ok: true, text: "プロファイルJSONを書き出しました。" });
  };

  const handleCopyProfile = async () => {
    const json = exportProfileJson();
    setProfileText(json);
    try {
      await navigator.clipboard.writeText(json);
      setFeedback({ ok: true, text: "プロファイルJSONをクリップボードへコピーしました。" });
    } catch {
      setFeedback({ ok: true, text: "テキスト欄に現在のプロファイルJSONを生成しました。" });
    }
  };

  const handleFileUpload = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 512 * 1024) {
      setFeedback({ ok: false, text: "ファイルサイズが 512 KB を超えています。" });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const content = typeof reader.result === "string" ? reader.result : "";
      setProfileText(content);
      const res = importProfileJson(content);
      setFeedback({ ok: res.ok, text: res.message });
    };
    reader.readAsText(file, "utf-8");
    e.target.value = "";
  };

  const handleApplyPastedProfile = () => {
    if (!profileText.trim()) {
      setFeedback({ ok: false, text: "復元するJSONテキストを貼り付けてください。" });
      return;
    }
    const res = importProfileJson(profileText);
    setFeedback({ ok: res.ok, text: res.message });
  };

  return (
    <aside className="pointer-events-auto flex max-h-full w-96 max-w-[92vw] flex-col overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface-glass)] shadow-2xl backdrop-blur-md">
      <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-4 py-3">
        <div className="flex items-center gap-2 text-xs font-semibold">
          <Settings className="h-4 w-4 text-[var(--accent-primary)]" />
          <span>設定</span>
        </div>
        <Button type="button" size="icon" variant="ghost" className="h-7 w-7" onClick={() => setActivePanel(null)}>
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Tabs */}
      <div className="grid grid-cols-4 gap-1 border-b border-[var(--border-subtle)] bg-white/[0.03] p-1.5 text-[10.5px]">
        <button
          type="button"
          onClick={() => setTab("general")}
          className={`flex items-center justify-center gap-1 rounded-full py-1.5 font-medium transition-colors ${
            tab === "general"
              ? "m3-tonal-active"
              : "text-[var(--text-secondary)] hover:bg-white/10"
          }`}
        >
          <Sliders className="h-3 w-3" />
          <span>一般</span>
        </button>
        <button
          type="button"
          onClick={() => setTab("offline")}
          className={`flex items-center justify-center gap-1 rounded-full py-1.5 font-medium transition-colors ${
            tab === "offline"
              ? "m3-tonal-active"
              : "text-[var(--text-secondary)] hover:bg-white/10"
          }`}
        >
          <HardDrive className="h-3 w-3" />
          <span>オフライン</span>
        </button>
        <button
          type="button"
          onClick={() => setTab("profile")}
          className={`flex items-center justify-center gap-1 rounded-full py-1.5 font-medium transition-colors ${
            tab === "profile"
              ? "m3-tonal-active"
              : "text-[var(--text-secondary)] hover:bg-white/10"
          }`}
        >
          <FileJson className="h-3 w-3" />
          <span>設定移行</span>
        </button>
        <button
          type="button"
          onClick={() => setTab("licenses")}
          className={`flex items-center justify-center gap-1 rounded-full py-1.5 font-medium transition-colors ${
            tab === "licenses"
              ? "m3-tonal-active"
              : "text-[var(--text-secondary)] hover:bg-white/10"
          }`}
        >
          <ShieldCheck className="h-3 w-3" />
          <span>ライセンス</span>
        </button>
      </div>

      <div className="flex-1 space-y-3.5 overflow-y-auto p-3.5 text-xs">
        {feedback && (
          <div
            className={`flex items-start gap-2 rounded-lg border px-2.5 py-2 text-[11px] ${
              feedback.ok
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
                : "border-rose-500/40 bg-rose-500/10 text-rose-200"
            }`}
          >
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{feedback.text}</span>
          </div>
        )}

        {tab === "general" && (
          <>
            {/* Startup Options */}
            <section className="space-y-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)]/80 p-2.5">
              <div className="font-semibold text-[var(--text-secondary)]">起動時の動作</div>
              <label className="flex cursor-pointer items-center justify-between gap-2 text-[11px]">
                <span>起動時に「観測データ」を初期表示</span>
                <input
                  type="checkbox"
                  checked={showObservationOnStartup}
                  onChange={(e) => setShowObservationOnStartup(e.target.checked)}
                  className="accent-[var(--accent-primary)]"
                />
              </label>
              <label className="flex cursor-pointer items-center justify-between gap-2 text-[11px]">
                <span>起動時リアルタイムデモ（現在時刻追従）</span>
                <input
                  type="checkbox"
                  checked={startupDemo}
                  onChange={(e) => setStartupDemo(e.target.checked)}
                  className="accent-[var(--accent-primary)]"
                />
              </label>
            </section>

            {/* Theme & Audio */}
            <section className="space-y-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)]/80 p-2.5">
              <div className="font-semibold text-[var(--text-secondary)]">外観テーマ・音設定</div>
              <div className="grid grid-cols-2 gap-1.5">
                {(
                  [
                    { id: "dark", label: "ダーク" },
                    { id: "night-vision", label: "赤色暗順応" },
                  ] as { id: ThemeMode; label: string }[]
                ).map((t) => (
                  <Button
                    key={t.id}
                    type="button"
                    size="sm"
                    variant={theme === t.id ? "default" : "outline"}
                    className="h-7 text-[11px]"
                    onClick={() => {
                      setTheme(t.id);
                      void useSkyStore.getState().refreshFrame(t.id === "night-vision");
                    }}
                  >
                    {t.label}
                  </Button>
                ))}
              </div>

              <div className="flex items-center justify-between pt-1">
                <span className="text-[11px]">通知・時報・アラーム音</span>
                <Button
                  type="button"
                  size="sm"
                  variant={soundEnabled ? "default" : "outline"}
                  className="h-7 gap-1 px-2 text-[11px]"
                  onClick={() => setSoundEnabled(!soundEnabled)}
                >
                  {soundEnabled ? <Volume2 className="h-3.5 w-3.5" /> : <VolumeX className="h-3.5 w-3.5" />}
                  <span>{soundEnabled ? "音 ON" : "消音"}</span>
                </Button>
              </div>

              <div className="grid grid-cols-3 gap-1">
                {(
                  [
                    { id: "off", label: "時報 OFF" },
                    { id: "hourly", label: "正時のみ" },
                    { id: "half_hourly", label: "30分毎" },
                  ] as { id: HourlyChimeMode; label: string }[]
                ).map((ch) => (
                  <Button
                    key={ch.id}
                    type="button"
                    size="sm"
                    variant={hourlyChime === ch.id ? "default" : "outline"}
                    className="h-6 text-[10px]"
                    onClick={() => setHourlyChime(ch.id)}
                  >
                    {ch.label}
                  </Button>
                ))}
              </div>
            </section>

            {/* Default Location & Offline */}
            <section className="space-y-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)]/80 p-2.5">
              <div className="font-semibold text-[var(--text-secondary)]">初期観測地・通信設定</div>
              <label className="block space-y-1 text-[11px]">
                <span className="text-[var(--text-secondary)]">起動時のデフォルト観測地</span>
                <select
                  value={currentDefaultLocId}
                  onChange={(e) => {
                    setDefaultLocation(e.target.value);
                    setFeedback({ ok: true, text: "初期観測地を更新しました。" });
                  }}
                  className="w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] px-2 py-1.5 text-xs text-[var(--text-primary)] outline-none"
                >
                  {locationsList.map((loc) => (
                    <option key={loc.id} value={loc.id}>
                      {loc.name_ja} ({loc.lat_deg.toFixed(2)}°N, {loc.lon_deg.toFixed(2)}°E)
                    </option>
                  ))}
                </select>
              </label>

              <div className="flex items-center justify-between pt-1">
                <span className="text-[11px] font-medium">オフラインモード</span>
                <Button
                  type="button"
                  size="sm"
                  variant={offlineMode ? "default" : "outline"}
                  className="h-7 gap-1 px-2.5 text-[11px]"
                  onClick={() => setOfflineMode(!offlineMode)}
                >
                  {offlineMode ? <WifiOff className="h-3.5 w-3.5" /> : <Globe className="h-3.5 w-3.5" />}
                  <span>{offlineMode ? "ON" : "OFF"}</span>
                </Button>
              </div>
            </section>

            {/* Units & Angles */}
            <section className="space-y-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)]/80 p-2.5">
              <div className="font-semibold text-[var(--text-secondary)]">単位系・角度表記</div>
              <div className="grid grid-cols-2 gap-1.5">
                {(
                  [
                    { id: "metric", label: "メートル法 (m / km / °C)" },
                    { id: "imperial", label: "ヤード・ポンド (ft / mi / °F)" },
                  ] as { id: UnitSystem; label: string }[]
                ).map((u) => (
                  <Button
                    key={u.id}
                    type="button"
                    size="sm"
                    variant={unitSystem === u.id ? "default" : "outline"}
                    className="h-7 text-[10px]"
                    onClick={() => setUnitSystem(u.id)}
                  >
                    {u.label}
                  </Button>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                {(
                  [
                    { id: "dms", label: "度分秒 (DMS)" },
                    { id: "deg", label: "小数度 (0.00°)" },
                  ] as { id: AngleFormat; label: string }[]
                ).map((a) => (
                  <Button
                    key={a.id}
                    type="button"
                    size="sm"
                    variant={angleFormat === a.id ? "default" : "outline"}
                    className="h-7 text-[10px]"
                    onClick={() => setAngleFormat(a.id)}
                  >
                    {a.label}
                  </Button>
                ))}
              </div>
            </section>

            {/* Auto Updater (Desktop & Android) */}
            <section className="space-y-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)]/80 p-2.5">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-[var(--text-secondary)]">アプリ更新（自動アップデート）</span>
                <span className="font-mono-num text-[10.5px] text-[var(--text-muted)]">v{currentVersion}</span>
              </div>
              {updaterSupported ? (
                <>
                  <div className="text-[10.5px] text-[var(--text-secondary)]">
                    {updaterStatus === "checking" && "最新バージョンを確認しています..."}
                    {updaterStatus === "downloading" &&
                      `v${availableVersion} をバックグラウンドで取得中 (${progressPct ?? 0}%)`}
                    {updaterStatus === "ready" &&
                      (androidUpdater
                        ? `v${availableVersion} のAPKを取得しました。ボタンからインストーラーを起動して更新できます。`
                        : `v${availableVersion} の更新準備が完了しています。再起動して適用できます。`)}
                    {updaterStatus === "installing" &&
                      (androidUpdater
                        ? `v${availableVersion} のAndroidインストーラーを起動しています...`
                        : `v${availableVersion} をインストールして再起動しています...`)}
                    {updaterStatus === "up-to-date" && "現在のバージョンは最新です。"}
                    {updaterStatus === "error" && (
                      <span className="text-[var(--status-danger)]">
                        確認失敗: {updaterError ?? "ネットワーク未接続または未公開です"}
                      </span>
                    )}
                    {updaterStatus === "idle" &&
                      (androidUpdater
                        ? "更新が見つかった場合は最新APKを取得し、インストーラーの起動をお知らせします。"
                        : "起動時に自動で新版をダウンロードし、準備ができ次第お知らせします。")}
                  </div>
                  {updaterNotice && (
                    <div className="text-[10.5px] text-amber-300">{updaterNotice}</div>
                  )}
                  {availableVersion && (() => {
                    const incomingNotes = parseReleaseNotesLines(releaseNotes, availableVersion);
                    if (incomingNotes.length === 0) return null;
                    return (
                      <div className="rounded-lg border border-white/10 bg-black/25 px-2.5 py-1.5 text-[10px]">
                        <div className="mb-1 font-semibold text-[var(--accent-primary)]">
                          v{availableVersion} の変更点
                        </div>
                        <ul className="list-disc space-y-0.5 pl-4 text-[var(--text-secondary)]">
                          {incomingNotes.map((line, i) => (
                            <li key={i}>{line}</li>
                          ))}
                        </ul>
                      </div>
                    );
                  })()}
                  <div className="flex flex-wrap gap-1.5">
                    {updaterStatus === "ready" && (
                      <Button
                        type="button"
                        size="sm"
                        className="h-7 flex-1 gap-1.5 text-[11px]"
                        onClick={() => void installAndRestart()}
                      >
                        <RefreshCw className="h-3.5 w-3.5" />
                        <span>{androidUpdater ? "今すぐインストールして更新" : "今すぐ再起動して更新"}</span>
                      </Button>
                    )}
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={
                        updaterStatus === "checking" ||
                        updaterStatus === "downloading" ||
                        updaterStatus === "installing"
                      }
                      className="h-7 gap-1.5 px-2.5 text-[11px]"
                      onClick={() => void checkAndAutoDownload(true)}
                    >
                      <RefreshCw
                        className={`h-3.5 w-3.5 ${updaterStatus === "checking" ? "animate-spin" : ""}`}
                      />
                      <span>アップデートを確認</span>
                    </Button>
                  </div>
                </>
              ) : (
                <div className="text-[10.5px] text-[var(--text-muted)]">
                  自動アップデート機能はデスクトップ / Android アプリ版で利用できます。
                </div>
              )}

              <div className="border-t border-[var(--border-subtle)] pt-2">
                <button
                  type="button"
                  onClick={() => setChangelogOpen((v) => !v)}
                  className="flex w-full items-center justify-between text-[11px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                >
                  <span className="flex items-center gap-1.5">
                    <History className="h-3.5 w-3.5 text-[var(--accent-primary)]" />
                    <span>更新履歴 (チェンジリスト)</span>
                  </span>
                  {changelogOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                </button>
                {changelogOpen && (
                  <div className="mt-2 max-h-64 space-y-2 overflow-y-auto pr-1">
                    {CHANGELOG_ENTRIES.map((entry) => (
                      <div
                        key={entry.version}
                        className="rounded-lg border border-[var(--border-subtle)] bg-black/25 p-2 text-[10px]"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-1.5">
                            <span className="font-mono-num font-bold text-[var(--text-primary)]">
                              v{entry.version}
                            </span>
                            <span
                              className={`rounded-full px-1.5 py-0.5 text-[9px] font-semibold ${
                                entry.kind === "feature"
                                  ? "bg-sky-500/20 text-sky-300"
                                  : entry.kind === "fix"
                                    ? "bg-amber-500/20 text-amber-300"
                                    : "bg-emerald-500/20 text-emerald-300"
                              }`}
                            >
                              {entry.kind === "feature"
                                ? "機能追加"
                                : entry.kind === "fix"
                                  ? "改善・修正"
                                  : "初回"}
                            </span>
                          </div>
                          <span className="font-mono-num text-[9.5px] text-[var(--text-muted)]">
                            {entry.date}
                          </span>
                        </div>
                        <div className="mt-0.5 font-medium text-[var(--text-secondary)]">
                          {entry.title}
                        </div>
                        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[var(--text-muted)]">
                          {entry.items.map((item, idx) => (
                            <li key={idx}>{item}</li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>
          </>
        )}

        {tab === "offline" && (
          <div className="space-y-3">
            {/* Local Image Cache & Pre-download Packs */}
            <section className="space-y-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)]/80 p-2.5">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 font-semibold text-[var(--text-secondary)]">
                  <Database className="h-3.5 w-3.5 text-sky-400" />
                  画像ローカルキャッシュ (HiPS / 天体実写)
                </span>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6"
                  title="容量を更新"
                  onClick={() => void refreshOfflineOverview()}
                >
                  <RefreshCw className="h-3 w-3" />
                </Button>
              </div>

              {cacheStats && (
                <div className="grid grid-cols-3 gap-1.5 rounded-lg border border-[var(--border-subtle)] bg-black/25 p-2 text-[10px]">
                  <div>
                    <div className="text-[var(--text-muted)]">HiPS タイル</div>
                    <div className="font-mono-num font-semibold">
                      {cacheStats.hips_tile_count}枚 ({formatBytesCompact(cacheStats.hips_bytes)})
                    </div>
                  </div>
                  <div>
                    <div className="text-[var(--text-muted)]">天体写真</div>
                    <div className="font-mono-num font-semibold">
                      {cacheStats.photo_count}枚 ({formatBytesCompact(cacheStats.photo_bytes)})
                    </div>
                  </div>
                  <div>
                    <div className="text-[var(--text-muted)]">合計使用量</div>
                    <div className="font-mono-num font-semibold text-[var(--accent-primary)]">
                      {formatBytesCompact(cacheStats.total_bytes)}
                    </div>
                  </div>
                </div>
              )}

              {offlineMode && (
                <div className="rounded-lg border border-amber-500/35 bg-amber-500/10 px-2 py-1.5 text-[10.5px] text-amber-200">
                  完全オフラインモードが ON のため新規ダウンロードは停止中です（保存済みタイル・写真・位置データはそのまま利用できます）。
                </div>
              )}

              <div className="space-y-1.5">
                <Button
                  type="button"
                  size="sm"
                  className="h-8 w-full gap-1.5 text-[11px]"
                  disabled={offlineMode || packProgress !== null}
                  onClick={async () => {
                    setPackProgress({ done: 0, total: 252, label: "全天ベースマップを保存中" });
                    try {
                      const res = await prefetchAllSkyHipsPack(
                        hipsConfig.surveyId,
                        offlineMode,
                        (done, total) =>
                          setPackProgress({ done, total, label: "全天ベースマップを保存中" }),
                      );
                      setFeedback({
                        ok: true,
                        text: `全天パック保存完了 (${hipsConfig.surveyId}): 新規 ${res.downloaded} 枚 (${formatBytesCompact(res.bytes_added)}) / 既存 ${res.already_cached} 枚`,
                      });
                      await refreshOfflineOverview();
                    } catch (err) {
                      setFeedback({
                        ok: false,
                        text: err instanceof Error ? err.message : String(err),
                      });
                    } finally {
                      setPackProgress(null);
                    }
                  }}
                >
                  <Download className="h-3.5 w-3.5" />
                  <span>全天ベースマップを事前保存 ({hipsConfig.surveyId} / 252枚)</span>
                </Button>

                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 w-full gap-1.5 text-[11px]"
                  disabled={offlineMode || packProgress !== null}
                  onClick={async () => {
                    setPackProgress({ done: 0, total: 180, label: "現在視野周辺を保存中" });
                    try {
                      const res = await prefetchCurrentViewHips(
                        hipsConfig.surveyId,
                        offlineMode,
                        (done, total) =>
                          setPackProgress({ done, total, label: "現在視野周辺を保存中" }),
                      );
                      setFeedback({
                        ok: true,
                        text: `現在視野保存完了: 新規 ${res.downloaded} 枚 (${formatBytesCompact(res.bytes_added)}) / 既存 ${res.already_cached} 枚`,
                      });
                      await refreshOfflineOverview();
                    } catch (err) {
                      setFeedback({
                        ok: false,
                        text: err instanceof Error ? err.message : String(err),
                      });
                    } finally {
                      setPackProgress(null);
                    }
                  }}
                >
                  <Download className="h-3 w-3" />
                  <span>現在の視野周辺を高精細保存 (Order 2–5)</span>
                </Button>
              </div>

              {packProgress && (
                <div className="space-y-1">
                  <div className="flex justify-between font-mono-num text-[10px] text-[var(--accent-primary)]">
                    <span>{packProgress.label}...</span>
                    <span>
                      {packProgress.done}/{packProgress.total}
                    </span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
                    <div
                      className="h-full bg-[var(--accent-primary)] transition-all"
                      style={{
                        width: `${Math.min(100, Math.round((packProgress.done / Math.max(1, packProgress.total)) * 100))}%`,
                      }}
                    />
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 gap-1.5 pt-1">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 gap-1 text-[10px] text-rose-300"
                  onClick={async () => {
                    const stats = await clearOfflineCacheTarget("hips");
                    setCacheStats(stats);
                    setFeedback({ ok: true, text: "HiPS 画像タイルキャッシュを削除しました。" });
                  }}
                >
                  <Trash2 className="h-3 w-3" />
                  <span>HiPS タイル削除</span>
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 gap-1 text-[10px] text-rose-300"
                  onClick={async () => {
                    const stats = await clearOfflineCacheTarget("photos");
                    setCacheStats(stats);
                    setFeedback({ ok: true, text: "天体実写キャッシュを削除しました。" });
                  }}
                >
                  <Trash2 className="h-3 w-3" />
                  <span>天体写真削除</span>
                </Button>
              </div>
            </section>

            {/* Saved Celestial Positions & Observation Snapshots */}
            <section className="space-y-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)]/80 p-2.5">
              <div className="font-semibold text-[var(--text-secondary)]">
                天体位置・観測状態のローカル保存（スナップショット）
              </div>
              <p className="text-[10px] leading-relaxed text-[var(--text-muted)]">
                現在の観測地・時刻・太陽系天体/衛星の位置・視野方向をローカル保存し、圏外でも後から復元・確認できます。
              </p>

              <input
                type="text"
                value={snapTitle}
                onChange={(e) => setSnapTitle(e.target.value)}
                placeholder={`${location.name_ja} 観測記録`}
                className="w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2.5 py-1.5 text-[11px] outline-none focus:border-[var(--accent-primary)]"
              />
              <input
                type="text"
                value={snapNote}
                onChange={(e) => setSnapNote(e.target.value)}
                placeholder="メモ（任意: 機材、見どころなど）"
                className="w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2.5 py-1.5 text-[11px] outline-none focus:border-[var(--accent-primary)]"
              />

              <Button
                type="button"
                size="sm"
                className="h-8 w-full gap-1.5 text-[11px]"
                onClick={async () => {
                  try {
                    const snap = buildCurrentObservationSnapshot(snapTitle, snapNote);
                    const meta = await saveOfflineSnapshot(snap);
                    setSnapTitle("");
                    setSnapNote("");
                    setExpandedSnap(snap);
                    await refreshOfflineOverview();
                    setFeedback({
                      ok: true,
                      text: `観測スナップショット「${meta.title}」(${meta.body_count}天体) を保存しました。`,
                    });
                  } catch (err) {
                    setFeedback({
                      ok: false,
                      text: err instanceof Error ? err.message : String(err),
                    });
                  }
                }}
              >
                <Save className="h-3.5 w-3.5" />
                <span>現在の空・天体位置をローカル保存</span>
              </Button>

              <div className="space-y-1.5 pt-1">
                {snapshots.length === 0 ? (
                  <div className="py-2 text-center text-[10.5px] text-[var(--text-muted)]">
                    保存済みの観測スナップショットはまだありません
                  </div>
                ) : (
                  snapshots.map((item) => {
                    const isExpanded = expandedSnap?.id === item.id;
                    return (
                      <div
                        key={item.id}
                        className="space-y-1.5 rounded-lg border border-[var(--border-subtle)] bg-black/20 p-2"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="truncate font-semibold text-[11px]">{item.title}</div>
                            <div className="truncate font-mono-num text-[9.5px] text-[var(--text-muted)]">
                              {item.location_name} ・ {item.created_at_iso.slice(0, 16).replace("T", " ")} ・ {item.body_count}天体
                            </div>
                            {item.note && (
                              <div className="truncate text-[10px] text-[var(--text-secondary)]">
                                {item.note}
                              </div>
                            )}
                          </div>
                        </div>

                        <div className="flex flex-wrap gap-1">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-6 px-2 text-[10px]"
                            onClick={async () => {
                              const full = await loadOfflineSnapshot(item.id);
                              restoreOfflineSnapshotToStore(full);
                              setFeedback({
                                ok: true,
                                text: `「${item.title}」の観測日時・観測地・視野を復元しました。`,
                              });
                            }}
                          >
                            時刻・視野を復元
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-6 px-2 text-[10px]"
                            onClick={async () => {
                              if (isExpanded) {
                                setExpandedSnap(null);
                              } else {
                                const full = await loadOfflineSnapshot(item.id);
                                setExpandedSnap(full);
                              }
                            }}
                          >
                            {isExpanded ? "座標を閉じる" : "保存座標一覧"}
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-6 px-2 text-[10px] text-rose-300"
                            onClick={async () => {
                              await deleteOfflineSnapshot(item.id);
                              if (isExpanded) setExpandedSnap(null);
                              await refreshOfflineOverview();
                            }}
                          >
                            削除
                          </Button>
                        </div>

                        {isExpanded && expandedSnap && (
                          <div className="max-h-48 space-y-1 overflow-y-auto border-t border-[var(--border-subtle)] pt-1.5 text-[10px]">
                            {expandedSnap.bodies.slice(0, 30).map((b) => (
                              <div
                                key={`${b.kind}-${b.id}`}
                                className="flex items-center justify-between gap-2 rounded bg-[var(--bg-surface)]/65 px-2 py-1"
                              >
                                <div className="min-w-0">
                                  <div className="truncate font-medium">
                                    {b.name_ja}{" "}
                                    {b.mag !== null && (
                                      <span className="font-mono-num text-[9.5px] text-[var(--text-muted)]">
                                        ({b.mag.toFixed(1)}等)
                                      </span>
                                    )}
                                  </div>
                                  <div className="truncate font-mono-num text-[9px] text-[var(--text-muted)]">
                                    RA {b.ra_deg.toFixed(2)}° Dec {b.dec_deg.toFixed(2)}° / Az {b.az_deg.toFixed(0)}° Alt{" "}
                                    {b.alt_deg.toFixed(0)}°
                                  </div>
                                </div>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="ghost"
                                  className="h-6 shrink-0 gap-1 px-1.5 text-[9.5px]"
                                  onClick={() =>
                                    centerOnSkyCoords(b.ra_deg, b.dec_deg, b.az_deg, b.alt_deg)
                                  }
                                >
                                  <Compass className="h-3 w-3" />
                                  向ける
                                </Button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </section>
          </div>
        )}

        {tab === "profile" && (
          <section className="space-y-3">
            <div className="grid grid-cols-2 gap-1.5">
              <Button type="button" size="sm" variant="outline" className="h-8 gap-1.5 text-[11px]" onClick={handleDownloadProfile}>
                <Download className="h-3.5 w-3.5" />
                <span>JSON 書出</span>
              </Button>
              <Button type="button" size="sm" variant="outline" className="h-8 gap-1.5 text-[11px]" onClick={() => void handleCopyProfile()}>
                <Copy className="h-3.5 w-3.5" />
                <span>JSON コピー</span>
              </Button>
            </div>

            <label className="flex cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-dashed border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-2 text-[11px] font-medium hover:bg-[var(--bg-surface-elevated)]">
              <Upload className="h-3.5 w-3.5 text-[var(--accent-primary)]" />
              <span>JSON ファイルを選択して復元</span>
              <input type="file" accept=".json,application/json" onChange={handleFileUpload} className="hidden" />
            </label>

            <div className="space-y-1.5">
              <textarea
                value={profileText}
                onChange={(e) => setProfileText(e.target.value)}
                rows={7}
                placeholder='{"version": 1, ...} を貼り付けて復元できます'
                className="w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-2 font-mono-num text-[10px] text-[var(--text-primary)] outline-none focus:border-[var(--accent-primary)]"
              />
              <Button type="button" size="sm" className="h-8 w-full text-[11px]" onClick={handleApplyPastedProfile}>
                貼り付けたプロファイルを復元
              </Button>
            </div>

            <div className="border-t border-[var(--border-subtle)] pt-3">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 w-full gap-1.5 border-rose-500/40 text-[11px] text-rose-300 hover:bg-rose-500/15"
                onClick={() => {
                  resetAllSettings();
                  setFeedback({ ok: true, text: "全環境設定を初期状態にリセットしました。" });
                }}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                <span>すべての設定を初期化</span>
              </Button>
            </div>
          </section>
        )}

        {tab === "licenses" && (
          <div className="space-y-2">
            {OPEN_DATA_LICENSES.map((item) => (
              <div
                key={item.name}
                className="rounded-xl border border-[var(--border-subtle)] bg-white/[0.04] px-3 py-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-[var(--text-primary)]">{item.name}</span>
                  <span className="m3-tonal-active rounded-full px-2 py-0.5 font-mono-num text-[9px]">
                    {item.license}
                  </span>
                </div>
                <div className="mt-0.5 text-[10px] text-[var(--text-secondary)]">{item.desc}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
