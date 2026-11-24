import {
  Clock,
  Compass,
  Globe,
  Pause,
  Play,
  RotateCcw,
  SkipBack,
  SkipForward,
  Sparkles,
  Sunrise,
  Sunset,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSkyStore } from "@/store/skyStore";
import type { SimulationLockMode, SimulationTarget } from "@/types/sky";

const TIME_STEP_PRESETS = [
  { label: "1分", minutes: 1 },
  { label: "5分", minutes: 5 },
  { label: "15分", minutes: 15 },
  { label: "1時間", minutes: 60 },
  { label: "6時間", minutes: 360 },
  { label: "1日", minutes: 1440 },
  { label: "7日", minutes: 10080 },
  { label: "30日", minutes: 43200 },
  { label: "1恒星日", minutes: 1436.068 },
];

const LAT_STEP_PRESETS = [0.5, 1, 2, 5, 10];
const AZ_STEP_PRESETS = [1, 2, 5, 10, 15];

const PLANET_LOCK_TARGETS = [
  { id: "sun", label: "太陽" },
  { id: "moon", label: "月" },
  { id: "mercury", label: "水星" },
  { id: "venus", label: "金星" },
  { id: "mars", label: "火星" },
  { id: "jupiter", label: "木星" },
  { id: "saturn", label: "土星" },
  { id: "uranus", label: "天王星" },
  { id: "neptune", label: "海王星" },
];

export function SimulationControl() {
  const staticAssets = useSkyStore((s) => s.staticAssets);
  const location = useSkyStore((s) => s.location);
  const centerAzDeg = useSkyStore((s) => s.centerAzDeg);
  const centerAltDeg = useSkyStore((s) => s.centerAltDeg);

  const simPlaying = useSkyStore((s) => s.simPlaying);
  const simDirection = useSkyStore((s) => s.simDirection);
  const simTarget = useSkyStore((s) => s.simTarget);
  const simStepMinutes = useSkyStore((s) => s.simStepMinutes);
  const simLatStepDeg = useSkyStore((s) => s.simLatStepDeg);
  const simAzStepDeg = useSkyStore((s) => s.simAzStepDeg);
  const simLockMode = useSkyStore((s) => s.simLockMode);
  const simLockTargetId = useSkyStore((s) => s.simLockTargetId);
  const autoRunRealtime = useSkyStore((s) => s.autoRunRealtime);
  const trailEnabled = useSkyStore((s) => s.trailEnabled);
  const trails = useSkyStore((s) => s.trails);

  const setSimPlaying = useSkyStore((s) => s.setSimPlaying);
  const setSimDirection = useSkyStore((s) => s.setSimDirection);
  const setSimTarget = useSkyStore((s) => s.setSimTarget);
  const setSimStepMinutes = useSkyStore((s) => s.setSimStepMinutes);
  const setSimLatStepDeg = useSkyStore((s) => s.setSimLatStepDeg);
  const setSimAzStepDeg = useSkyStore((s) => s.setSimAzStepDeg);
  const setSimLock = useSkyStore((s) => s.setSimLock);
  const setAutoRunRealtime = useSkyStore((s) => s.setAutoRunRealtime);
  const setTrailEnabled = useSkyStore((s) => s.setTrailEnabled);
  const clearTrails = useSkyStore((s) => s.clearTrails);
  const advanceSimulationTick = useSkyStore((s) => s.advanceSimulationTick);
  const setActivePanel = useSkyStore((s) => s.setActivePanel);

  const trailEntries = Object.values(trails);
  const constellations = staticAssets?.constellations ?? [];

  const handleLockModeChange = (mode: SimulationLockMode) => {
    if (mode === "constellation") {
      const fallback = constellations[0]?.id ?? "Ori";
      const existingValid = constellations.some((c) => c.id === simLockTargetId)
        ? simLockTargetId
        : fallback;
      setSimLock(mode, existingValid);
    } else if (mode === "planet") {
      const existingValid = PLANET_LOCK_TARGETS.some((p) => p.id === simLockTargetId)
        ? simLockTargetId
        : "mars";
      setSimLock(mode, existingValid);
    } else {
      setSimLock(mode, "");
    }
  };

  const handleSingleStep = (dir: 1 | -1) => {
    setSimDirection(dir);
    void advanceSimulationTick();
  };

  const targetOptions: Array<{
    id: SimulationTarget;
    label: string;
    desc: string;
    icon: typeof Clock;
  }> = [
    { id: "time", label: "時間 / 日付", desc: "日時を進行・逆行", icon: Clock },
    { id: "latitude", label: "観測緯度", desc: "北極〜南極へ移動", icon: Globe },
    { id: "viewpoint", label: "視点方位", desc: "水平方位を回転", icon: Compass },
  ];

  const lockOptions: Array<{
    id: SimulationLockMode;
    label: string;
    icon?: typeof Sunrise;
  }> = [
    { id: "none", label: "固定なし" },
    { id: "constellation", label: "星座固定" },
    { id: "planet", label: "惑星固定" },
    { id: "sunrise", label: "日の出固定", icon: Sunrise },
    { id: "sunset", label: "日の入固定", icon: Sunset },
  ];

  return (
    <aside className="flex h-full w-80 flex-col rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface-glass)] text-[var(--text-primary)] shadow-2xl backdrop-blur-md">
      <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold tracking-tight">シミュレーション</h2>
          <p className="text-[11px] text-[var(--text-muted)]">
            連続変化・天体固定・軌跡重ね描き
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

      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-3 text-xs">
        {/* 再生・ステップ操作 */}
        <section className="space-y-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)]/70 p-3">
          <div className="flex items-center justify-between">
            <span className="font-medium text-[var(--text-secondary)]">再生コントロール</span>
            <span className="font-mono-num text-[11px] text-[var(--text-muted)]">
              {simPlaying ? (simDirection === 1 ? "再生中 (+)" : "逆再生 (-)") : "停止中"}
            </span>
          </div>

          <div className="grid grid-cols-4 gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1 px-2 text-xs"
              onClick={() => handleSingleStep(-1)}
              title="1ステップ戻る"
            >
              <SkipBack className="h-3.5 w-3.5" />
              戻る
            </Button>
            <Button
              variant={simPlaying && simDirection === -1 ? "default" : "outline"}
              size="sm"
              className="h-8 gap-1 px-2 text-xs"
              onClick={() => {
                if (simPlaying && simDirection === -1) {
                  setSimPlaying(false);
                } else {
                  setSimDirection(-1);
                  setSimPlaying(true);
                }
              }}
              title="逆再生"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              逆
            </Button>
            <Button
              variant={simPlaying && simDirection === 1 ? "default" : "outline"}
              size="sm"
              className="h-8 gap-1 px-2 text-xs"
              onClick={() => {
                if (simPlaying && simDirection === 1) {
                  setSimPlaying(false);
                } else {
                  setSimDirection(1);
                  setSimPlaying(true);
                }
              }}
              title="再生 / 一時停止"
            >
              {simPlaying && simDirection === 1 ? (
                <Pause className="h-3.5 w-3.5" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )}
              {simPlaying && simDirection === 1 ? "停止" : "再生"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1 px-2 text-xs"
              onClick={() => handleSingleStep(1)}
              title="1ステップ進む"
            >
              進む
              <SkipForward className="h-3.5 w-3.5" />
            </Button>
          </div>

          <label className="flex cursor-pointer items-center justify-between rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)]/80 px-2.5 py-2">
            <div>
              <div className="font-medium">自動運転（リアルタイム追従）</div>
              <div className="text-[10px] text-[var(--text-muted)]">
                1秒ごとに現在時刻へ同期更新
              </div>
            </div>
            <input
              type="checkbox"
              checked={autoRunRealtime}
              onChange={(e) => setAutoRunRealtime(e.target.checked)}
              className="h-4 w-4 accent-[var(--accent-primary)]"
            />
          </label>
        </section>

        {/* 変動対象 */}
        <section className="space-y-2">
          <div className="font-medium text-[var(--text-secondary)]">変動対象</div>
          <div className="grid grid-cols-3 gap-1.5">
            {targetOptions.map((opt) => {
              const Icon = opt.icon;
              const active = simTarget === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setSimTarget(opt.id)}
                  className={`flex flex-col items-center gap-1 rounded-xl border px-2 py-2 text-center transition ${
                    active
                      ? "border-[var(--accent-primary)] bg-[var(--accent-primary)]/15 text-[var(--text-primary)]"
                      : "border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)]/60 text-[var(--text-secondary)] hover:border-[var(--border-strong)]"
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  <span className="text-[11px] font-medium">{opt.label}</span>
                  <span className="text-[9px] text-[var(--text-muted)]">{opt.desc}</span>
                </button>
              );
            })}
          </div>

          {simTarget === "time" && (
            <div className="space-y-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)]/60 p-2.5">
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-[var(--text-secondary)]">時間ステップ幅</span>
                <span className="font-mono-num text-[11px] font-semibold">
                  {simStepMinutes >= 1440
                    ? `${(simStepMinutes / 1440).toFixed(2)} 日`
                    : simStepMinutes >= 60
                      ? `${(simStepMinutes / 60).toFixed(1)} 時間`
                      : `${simStepMinutes} 分`}
                </span>
              </div>
              <div className="flex flex-wrap gap-1">
                {TIME_STEP_PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    onClick={() => setSimStepMinutes(preset.minutes)}
                    className={`rounded-md border px-2 py-1 text-[11px] transition ${
                      Math.abs(simStepMinutes - preset.minutes) < 0.01
                        ? "border-[var(--accent-primary)] bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]"
                        : "border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]"
                    }`}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {simTarget === "latitude" && (
            <div className="space-y-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)]/60 p-2.5">
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-[var(--text-secondary)]">
                  現在緯度: <span className="font-mono-num font-semibold">{location.lat_deg.toFixed(2)}°</span>
                </span>
                <span className="font-mono-num text-[11px] text-[var(--text-muted)]">
                  ±{simLatStepDeg}° / step
                </span>
              </div>
              <div className="flex flex-wrap gap-1">
                {LAT_STEP_PRESETS.map((deg) => (
                  <button
                    key={deg}
                    type="button"
                    onClick={() => setSimLatStepDeg(deg)}
                    className={`rounded-md border px-2 py-1 font-mono-num text-[11px] transition ${
                      simLatStepDeg === deg
                        ? "border-[var(--accent-primary)] bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]"
                        : "border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)]"
                    }`}
                  >
                    {deg}°
                  </button>
                ))}
              </div>
            </div>
          )}

          {simTarget === "viewpoint" && (
            <div className="space-y-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)]/60 p-2.5">
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-[var(--text-secondary)]">
                  方位/高度:{" "}
                  <span className="font-mono-num font-semibold">
                    Az {centerAzDeg.toFixed(1)}° / Alt {centerAltDeg.toFixed(1)}°
                  </span>
                </span>
                <span className="font-mono-num text-[11px] text-[var(--text-muted)]">
                  ±{simAzStepDeg}° / step
                </span>
              </div>
              <div className="flex flex-wrap gap-1">
                {AZ_STEP_PRESETS.map((deg) => (
                  <button
                    key={deg}
                    type="button"
                    onClick={() => setSimAzStepDeg(deg)}
                    className={`rounded-md border px-2 py-1 font-mono-num text-[11px] transition ${
                      simAzStepDeg === deg
                        ? "border-[var(--accent-primary)] bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]"
                        : "border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)]"
                    }`}
                  >
                    {deg}°
                  </button>
                ))}
              </div>
            </div>
          )}
        </section>

        {/* 固定モード */}
        <section className="space-y-2">
          <div className="font-medium text-[var(--text-secondary)]">固定・追尾モード</div>
          <div className="flex flex-wrap gap-1.5">
            {lockOptions.map((opt) => {
              const active = simLockMode === opt.id;
              const Icon = opt.icon;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => handleLockModeChange(opt.id)}
                  className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-[11px] font-medium transition ${
                    active
                      ? "border-[var(--accent-primary)] bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]"
                      : "border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)]/60 text-[var(--text-secondary)] hover:border-[var(--border-strong)]"
                  }`}
                >
                  {Icon && <Icon className="h-3 w-3" />}
                  {opt.label}
                </button>
              );
            })}
          </div>

          {simLockMode === "constellation" && (
            <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)]/60 p-2.5">
              <label className="mb-1 block text-[11px] text-[var(--text-muted)]">
                固定する星座（日周運動を追尾）
              </label>
              <select
                value={simLockTargetId}
                onChange={(e) => setSimLock("constellation", e.target.value)}
                className="w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2.5 py-1.5 text-xs text-[var(--text-primary)]"
              >
                {constellations.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name_ja} ({c.id})
                  </option>
                ))}
              </select>
            </div>
          )}

          {simLockMode === "planet" && (
            <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)]/60 p-2.5">
              <label className="mb-1 block text-[11px] text-[var(--text-muted)]">
                固定する太陽系天体
              </label>
              <select
                value={simLockTargetId}
                onChange={(e) => setSimLock("planet", e.target.value)}
                className="w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2.5 py-1.5 text-xs text-[var(--text-primary)]"
              >
                {PLANET_LOCK_TARGETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          {(simLockMode === "sunrise" || simLockMode === "sunset") && (
            <p className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)]/50 px-2.5 py-2 text-[11px] text-[var(--text-muted)]">
              日付変更（1日ステップ等）ごとに毎日の{simLockMode === "sunrise" ? "日の出" : "日の入"}時刻へ自動スナップし、季節による太陽位置と星座の推移を可視化します。
            </p>
          )}
        </section>

        {/* 重ねて表示（トレイル / 軌跡オーバーレイ） */}
        <section className="space-y-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)]/70 p-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 font-medium text-[var(--text-secondary)]">
              <Sparkles className="h-3.5 w-3.5 text-[var(--accent-primary)]" />
              重ねて表示（軌跡トレイル）
            </div>
            <input
              type="checkbox"
              checked={trailEnabled}
              onChange={(e) => setTrailEnabled(e.target.checked)}
              className="h-4 w-4 accent-[var(--accent-primary)]"
            />
          </div>
          <p className="text-[11px] text-[var(--text-muted)]">
            画面をクリアせず太陽・月・惑星や選択天体の軌跡（順行・逆行・日周運動）を上書き記録します。
          </p>

          <div className="flex items-center justify-between pt-1">
            <span className="font-mono-num text-[11px] text-[var(--text-muted)]">
              記録天体: {trailEntries.length} 種 /{" "}
              {trailEntries.reduce((acc, t) => acc + t.points.length, 0)} 点
            </span>
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1 px-2 text-[11px]"
              onClick={clearTrails}
              disabled={trailEntries.length === 0}
            >
              <Trash2 className="h-3 w-3" />
              軌跡クリア
            </Button>
          </div>

          {trailEntries.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {trailEntries.map((trail) => (
                <span
                  key={trail.id}
                  className="inline-flex items-center gap-1 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 py-0.5 text-[10px]"
                >
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: trail.color }}
                  />
                  {trail.label} ({trail.points.length})
                </span>
              ))}
            </div>
          )}
        </section>
      </div>
    </aside>
  );
}
