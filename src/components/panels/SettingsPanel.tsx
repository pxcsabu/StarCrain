import { useEffect, useState, type ChangeEvent } from "react";
import {
  CheckCircle2,
  Copy,
  Download,
  FileJson,
  Globe,
  RefreshCw,
  RotateCcw,
  Settings,
  ShieldCheck,
  Sliders,
  Upload,
  Volume2,
  VolumeX,
  WifiOff,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useClockStore, type HourlyChimeMode } from "@/store/clockStore";
import { useSkyStore } from "@/store/skyStore";
import { type ThemeMode, useThemeStore } from "@/store/themeStore";
import {
  isAndroidUpdaterSupported,
  isUpdaterSupported,
  useUpdaterStore,
} from "@/store/updaterStore";
import type { AngleFormat, UnitSystem } from "@/types/sky";

type SettingsTab = "general" | "profile" | "licenses";

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
  { name: "Tauri v2 / Rust / React / Three.js", desc: "アプリ基盤・自動更新・VSOP87・SGP4・SQLite・rustls", license: "MIT / Apache-2.0" },
];

export function SettingsPanel() {
  const [tab, setTab] = useState<SettingsTab>("general");
  const [profileText, setProfileText] = useState("");
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);

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
      <div className="grid grid-cols-3 gap-1 border-b border-[var(--border-subtle)] bg-white/[0.03] p-1.5 text-[11px]">
        <button
          type="button"
          onClick={() => setTab("general")}
          className={`flex items-center justify-center gap-1 rounded-full py-1.5 font-medium transition-colors ${
            tab === "general"
              ? "m3-tonal-active"
              : "text-[var(--text-secondary)] hover:bg-white/10"
          }`}
        >
          <Sliders className="h-3.5 w-3.5" />
          <span>一般・単位</span>
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
          <FileJson className="h-3.5 w-3.5" />
          <span>プロファイル</span>
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
          <ShieldCheck className="h-3.5 w-3.5" />
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
                  自動アップデート機能はデスクトップインストーラー版で利用できます。
                </div>
              )}
            </section>
          </>
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
