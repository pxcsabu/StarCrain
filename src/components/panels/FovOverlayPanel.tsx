import { useEffect, useState } from "react";
import {
  ArrowDownWideNarrow,
  Camera,
  Check,
  Compass,
  Download,
  Grid,
  Plus,
  RotateCcw,
  Scan,
  Trash2,
  X,
  ZoomIn,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { computeFovDimensions } from "@/lib/fovMath";
import { PROJECTION_META, type FovPresetType, type ImagingPlanItem } from "@/types/sky";
import { useSkyStore } from "@/store/skyStore";

const IMAGING_PLAN_KEY = "starcrane-imaging-plan-v1";

function loadImagingPlan(): ImagingPlanItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(IMAGING_PLAN_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ImagingPlanItem[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function formatTotalIntegration(sec: number): string {
  const m = Math.round(sec / 60);
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return h > 0 ? `${h}時間${rem}分` : `${rem}分`;
}

function formatRaHm(raDeg: number): string {
  const h = (((raDeg % 360) + 360) % 360) / 15;
  const hh = Math.floor(h);
  const mm = Math.floor((h - hh) * 60);
  return `${String(hh).padStart(2, "0")}h${String(mm).padStart(2, "0")}m`;
}

const SENSOR_QUICK_FILLS: { label: string; w: number; h: number }[] = [
  { label: "フルサイズ (36×24)", w: 36, h: 24 },
  { label: "APS-C (23.5×15.6)", w: 23.5, h: 15.6 },
  { label: "M4/3 (17.3×13)", w: 17.3, h: 13 },
  { label: "IMX533 (11.3×11.3)", w: 11.3, h: 11.3 },
  { label: "1型 (13.2×8.8)", w: 13.2, h: 8.8 },
];

export function FovOverlayPanel() {
  const fovPresets = useSkyStore((s) => s.fovPresets);
  const projectionMode = useSkyStore((s) => s.projectionMode);
  const selectedObject = useSkyStore((s) => s.selectedObject);
  const centerRaDeg = useSkyStore((s) => s.centerRaDeg);
  const centerDecDeg = useSkyStore((s) => s.centerDecDeg);
  const toggleFovPreset = useSkyStore((s) => s.toggleFovPreset);
  const setFovRotation = useSkyStore((s) => s.setFovRotation);
  const addFovPreset = useSkyStore((s) => s.addFovPreset);
  const updateFovPreset = useSkyStore((s) => s.updateFovPreset);
  const deleteFovPreset = useSkyStore((s) => s.deleteFovPreset);
  const resetFovPresets = useSkyStore((s) => s.resetFovPresets);
  const setZoomMultiplier = useSkyStore((s) => s.setZoomMultiplier);
  const centerOnSkyCoords = useSkyStore((s) => s.centerOnSkyCoords);
  const closePanel = useSkyStore((s) => s.closePanel);

  const [tab, setTab] = useState<"fov" | "planner">("fov");
  const [plan, setPlan] = useState<ImagingPlanItem[]>(() => loadImagingPlan());
  const [planAddedHint, setPlanAddedHint] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(IMAGING_PLAN_KEY, JSON.stringify(plan));
    }
  }, [plan]);
  const [kind, setKind] = useState<FovPresetType>("camera");
  const [name, setName] = useState("マイ機材 400mm");
  const [color, setColor] = useState("#f43f5e");
  const [sensorW, setSensorW] = useState("23.5");
  const [sensorH, setSensorH] = useState("15.6");
  const [focalMm, setFocalMm] = useState("400");
  const [reducer, setReducer] = useState("1.0");
  const [epMm, setEpMm] = useState("20");
  const [afov, setAfov] = useState("68");
  const [binoMag, setBinoMag] = useState("10");
  const [binoAp, setBinoAp] = useState("50");
  const [binoField, setBinoField] = useState("6.5");

  const frameFovInSky = (widthDeg: number, heightDeg: number) => {
    const baseFov = PROJECTION_META.find((m) => m.mode === projectionMode)?.defaultFovDeg ?? 90;
    const targetFov = Math.max(widthDeg, heightDeg) * 1.45;
    const zoom = Math.max(0.5, Math.min(20, baseFov / Math.max(0.3, targetFov)));
    setZoomMultiplier(zoom);
  };

  const handleCreate = () => {
    addFovPreset({
      name: name.trim() || "カスタム視野角",
      kind,
      enabled: true,
      color,
      rotationDeg: 0,
      sensorWidthMm: Number(sensorW) || 23.5,
      sensorHeightMm: Number(sensorH) || 15.6,
      focalLengthMm: Number(focalMm) || 400,
      reducerFactor: Number(reducer) || 1.0,
      eyepieceFocalMm: Number(epMm) || 20,
      afovDeg: Number(afov) || 68,
      binoMag: Number(binoMag) || 10,
      binoApertureMm: Number(binoAp) || 50,
      binoFieldDeg: Number(binoField) || 6.5,
    });
    setAddOpen(false);
  };

  const handleAddCurrentToPlan = (preset: (typeof fovPresets)[number]) => {
    const dims = computeFovDimensions(preset);
    const cols = Math.max(1, Math.min(5, Math.round(preset.mosaicCols ?? 1)));
    const rows = Math.max(1, Math.min(5, Math.round(preset.mosaicRows ?? 1)));
    const targetName =
      selectedObject?.name_ja ||
      `RA ${formatRaHm(centerRaDeg)} Dec ${centerDecDeg.toFixed(1)}°`;
    const raDeg = selectedObject?.ra_deg ?? centerRaDeg;
    const decDeg = selectedObject?.dec_deg ?? centerDecDeg;
    const item: ImagingPlanItem = {
      id: `plan:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`,
      name: targetName,
      raDeg,
      decDeg,
      presetName: preset.name,
      fovWidthDeg: dims.widthDeg,
      fovHeightDeg: dims.heightDeg,
      rotationDeg: preset.rotationDeg,
      mosaicCols: cols,
      mosaicRows: rows,
      subExposureSec: 180,
      subFrames: 30,
      notes: "",
    };
    setPlan((prev) => [...prev, item]);
    setPlanAddedHint(`「${targetName}」を撮影計画へ追加しました`);
    setTimeout(() => setPlanAddedHint(null), 2600);
  };

  const sortPlanWestToEast = () => {
    setPlan((prev) => [...prev].sort((a, b) => a.raDeg - b.raDeg));
  };

  const exportPlanJson = () => {
    const blob = new Blob([JSON.stringify(plan, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `starcrane-imaging-plan-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <aside className="flex h-full w-[28rem] max-w-[calc(100vw-4rem)] flex-col rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface-glass)] text-[var(--text-primary)] shadow-2xl backdrop-blur-md">
      {/* Header */}
      <div className="flex items-start justify-between gap-2 border-b border-[var(--border-subtle)] px-4 py-3">
        <div>
          <h2 className="flex items-center gap-1.5 text-sm font-semibold tracking-tight">
            <Scan className="h-4 w-4 text-rose-400" /> 天体撮影 FOV・モザイク・計画
          </h2>
          <p className="text-[11px] text-[var(--text-muted)]">
            センサー枠・モザイク構図・赤道儀回転角(PA)と今夜の撮影タイムライン
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => closePanel("fov")}
          title="閉じる"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Mode Tabs */}
      <div className="flex items-center justify-between gap-2 border-b border-[var(--border-subtle)] px-4 py-2 text-xs">
        <div className="flex gap-1">
          <Button
            type="button"
            size="sm"
            variant={tab === "fov" ? "default" : "outline"}
            className="h-7 gap-1 px-2.5 text-[11px]"
            onClick={() => setTab("fov")}
          >
            <Grid className="h-3.5 w-3.5" />
            視野枠・モザイク
          </Button>
          <Button
            type="button"
            size="sm"
            variant={tab === "planner" ? "default" : "outline"}
            className="h-7 gap-1 px-2.5 text-[11px]"
            onClick={() => setTab("planner")}
          >
            <Camera className="h-3.5 w-3.5" />
            撮影計画 ({plan.length})
          </Button>
        </div>

        {tab === "fov" && (
          <div className="flex items-center gap-1">
            <Button
              type="button"
              size="sm"
              className="h-7 gap-1 px-2 text-[10.5px]"
              onClick={() => setAddOpen(!addOpen)}
            >
              <Plus className="h-3 w-3" />
              追加
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 w-7 p-0"
              onClick={resetFovPresets}
              title="初期セットに戻す"
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
      </div>

      <div className="flex-1 space-y-2.5 overflow-y-auto px-4 py-3 text-xs">
        {planAddedHint && (
          <div className="flex items-center gap-1.5 rounded-lg border border-emerald-400/40 bg-emerald-500/15 px-2.5 py-1.5 text-[11px] text-emerald-200">
            <Check className="h-3.5 w-3.5 shrink-0" />
            <span>{planAddedHint}</span>
          </div>
        )}

        {tab === "planner" ? (
          <div className="space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-1.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)]/80 px-3 py-2 text-[11px]">
              <span>
                合計{" "}
                <strong className="font-mono-num text-[var(--accent-primary)]">
                  {formatTotalIntegration(
                    plan.reduce(
                      (acc, p) => acc + p.mosaicCols * p.mosaicRows * p.subExposureSec * p.subFrames,
                      0,
                    ),
                  )}
                </strong>{" "}
                (全{plan.reduce((acc, p) => acc + p.mosaicCols * p.mosaicRows, 0)}パネル)
              </span>
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-6 gap-1 px-2 text-[10px]"
                  onClick={sortPlanWestToEast}
                  disabled={plan.length < 2}
                  title="西へ傾きやすい低赤経天体から昇順に並び替え"
                >
                  <ArrowDownWideNarrow className="h-3 w-3" />
                  西→東順に並替
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-6 gap-1 px-2 text-[10px]"
                  onClick={exportPlanJson}
                  disabled={plan.length === 0}
                >
                  <Download className="h-3 w-3" />
                  JSON
                </Button>
              </div>
            </div>

            {plan.length === 0 ? (
              <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)]/60 p-4 text-center text-[11px] text-[var(--text-muted)]">
                「視野枠・モザイク」タブのカメラ枠にある「撮影計画に追加」ボタンから、選択天体または現在の星図中心をシーケンスへ追加できます。
              </div>
            ) : (
              plan.map((item, idx) => (
                <div
                  key={item.id}
                  className="space-y-1.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)]/85 p-2.5"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="flex items-center gap-1.5 font-semibold">
                        <span className="rounded bg-[var(--accent-primary)]/20 px-1.5 py-0.2 font-mono-num text-[10px] text-[var(--accent-primary)]">
                          #{idx + 1}
                        </span>
                        <span>{item.name}</span>
                      </div>
                      <div className="font-mono-num text-[10px] text-[var(--text-muted)]">
                        RA {formatRaHm(item.raDeg)} · Dec {item.decDeg.toFixed(1)}° · {item.presetName}{" "}
                        ({item.mosaicCols}×{item.mosaicRows}, PA {item.rotationDeg}°)
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-6 gap-1 px-2 text-[10px]"
                        onClick={() => centerOnSkyCoords(item.raDeg, item.decDeg)}
                      >
                        <Compass className="h-3 w-3" />
                        導入
                      </Button>
                      <button
                        type="button"
                        onClick={() => setPlan((prev) => prev.filter((x) => x.id !== item.id))}
                        className="rounded p-1 text-rose-400 hover:text-rose-300"
                        title="削除"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-1.5 text-[10px]">
                    <label className="flex flex-col gap-0.5">
                      <span className="text-[var(--text-muted)]">1枚露光 (秒)</span>
                      <input
                        type="number"
                        min={1}
                        max={3600}
                        value={item.subExposureSec}
                        onChange={(e) =>
                          setPlan((prev) =>
                            prev.map((x) =>
                              x.id === item.id
                                ? { ...x, subExposureSec: Math.max(1, Number(e.target.value) || 60) }
                                : x,
                            ),
                          )
                        }
                        className="h-6 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-1.5 font-mono-num text-[11px]"
                      />
                    </label>
                    <label className="flex flex-col gap-0.5">
                      <span className="text-[var(--text-muted)]">枚数/パネル</span>
                      <input
                        type="number"
                        min={1}
                        max={500}
                        value={item.subFrames}
                        onChange={(e) =>
                          setPlan((prev) =>
                            prev.map((x) =>
                              x.id === item.id
                                ? { ...x, subFrames: Math.max(1, Number(e.target.value) || 1) }
                                : x,
                            ),
                          )
                        }
                        className="h-6 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-1.5 font-mono-num text-[11px]"
                      />
                    </label>
                    <div className="flex flex-col justify-end rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 py-1 text-right font-mono-num text-[10.5px]">
                      <span className="text-[9px] text-[var(--text-muted)]">総露光</span>
                      <span className="font-semibold text-[var(--accent-primary)]">
                        {formatTotalIntegration(
                          item.mosaicCols * item.mosaicRows * item.subExposureSec * item.subFrames,
                        )}
                      </span>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        ) : (
          <>
            {addOpen && (
          <div className="space-y-2.5 rounded-xl border border-rose-400/40 bg-[var(--bg-surface-elevated)] p-3">
            <div className="flex flex-wrap gap-1">
              {(
                [
                  { id: "camera", label: "カメラ＋望遠" },
                  { id: "eyepiece", label: "望遠鏡＋アイピース" },
                  { id: "binoculars", label: "双眼鏡" },
                  { id: "telrad", label: "テルラド" },
                ] as const
              ).map((k) => (
                <button
                  key={k.id}
                  type="button"
                  onClick={() => setKind(k.id)}
                  className={`rounded border px-2 py-0.5 text-[10px] font-medium ${
                    kind === k.id
                      ? "border-[var(--accent-primary)] bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]"
                      : "border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)]"
                  }`}
                >
                  {k.label}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-3 gap-2">
              <label className="col-span-2 space-y-0.5">
                <span className="text-[10px] text-[var(--text-muted)]">プリセット名</span>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="h-7 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 text-xs"
                />
              </label>
              <label className="space-y-0.5">
                <span className="text-[10px] text-[var(--text-muted)]">枠の色</span>
                <input
                  type="color"
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                  className="h-7 w-full cursor-pointer rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-0.5"
                />
              </label>
            </div>

            {kind === "camera" && (
              <div className="space-y-2">
                <div className="flex flex-wrap gap-1">
                  {SENSOR_QUICK_FILLS.map((s) => (
                    <button
                      key={s.label}
                      type="button"
                      onClick={() => {
                        setSensorW(String(s.w));
                        setSensorH(String(s.h));
                      }}
                      className="rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-1.5 py-0.5 text-[9px] hover:border-[var(--accent-primary)]"
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
                <div className="grid grid-cols-4 gap-1.5 font-mono-num">
                  <label className="space-y-0.5">
                    <span className="text-[9px] text-[var(--text-muted)]">センサー幅mm</span>
                    <input
                      type="number"
                      step="0.1"
                      value={sensorW}
                      onChange={(e) => setSensorW(e.target.value)}
                      className="h-7 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-1.5 text-[11px]"
                    />
                  </label>
                  <label className="space-y-0.5">
                    <span className="text-[9px] text-[var(--text-muted)]">高さmm</span>
                    <input
                      type="number"
                      step="0.1"
                      value={sensorH}
                      onChange={(e) => setSensorH(e.target.value)}
                      className="h-7 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-1.5 text-[11px]"
                    />
                  </label>
                  <label className="space-y-0.5">
                    <span className="text-[9px] text-[var(--text-muted)]">焦点距離mm</span>
                    <input
                      type="number"
                      step="10"
                      value={focalMm}
                      onChange={(e) => setFocalMm(e.target.value)}
                      className="h-7 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-1.5 text-[11px]"
                    />
                  </label>
                  <label className="space-y-0.5">
                    <span className="text-[9px] text-[var(--text-muted)]">補正倍率</span>
                    <input
                      type="number"
                      step="0.05"
                      value={reducer}
                      onChange={(e) => setReducer(e.target.value)}
                      className="h-7 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-1.5 text-[11px]"
                    />
                  </label>
                </div>
              </div>
            )}

            {kind === "eyepiece" && (
              <div className="grid grid-cols-3 gap-1.5 font-mono-num">
                <label className="space-y-0.5">
                  <span className="text-[9px] text-[var(--text-muted)]">鏡筒焦点mm</span>
                  <input
                    type="number"
                    value={focalMm}
                    onChange={(e) => setFocalMm(e.target.value)}
                    className="h-7 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 text-[11px]"
                  />
                </label>
                <label className="space-y-0.5">
                  <span className="text-[9px] text-[var(--text-muted)]">アイピースmm</span>
                  <input
                    type="number"
                    step="0.5"
                    value={epMm}
                    onChange={(e) => setEpMm(e.target.value)}
                    className="h-7 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 text-[11px]"
                  />
                </label>
                <label className="space-y-0.5">
                  <span className="text-[9px] text-[var(--text-muted)]">見掛視界°</span>
                  <input
                    type="number"
                    value={afov}
                    onChange={(e) => setAfov(e.target.value)}
                    className="h-7 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 text-[11px]"
                  />
                </label>
              </div>
            )}

            {kind === "binoculars" && (
              <div className="grid grid-cols-3 gap-1.5 font-mono-num">
                <label className="space-y-0.5">
                  <span className="text-[9px] text-[var(--text-muted)]">倍率</span>
                  <input
                    type="number"
                    value={binoMag}
                    onChange={(e) => setBinoMag(e.target.value)}
                    className="h-7 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 text-[11px]"
                  />
                </label>
                <label className="space-y-0.5">
                  <span className="text-[9px] text-[var(--text-muted)]">口径mm</span>
                  <input
                    type="number"
                    value={binoAp}
                    onChange={(e) => setBinoAp(e.target.value)}
                    className="h-7 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 text-[11px]"
                  />
                </label>
                <label className="space-y-0.5">
                  <span className="text-[9px] text-[var(--text-muted)]">実視界°</span>
                  <input
                    type="number"
                    step="0.1"
                    value={binoField}
                    onChange={(e) => setBinoField(e.target.value)}
                    className="h-7 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 text-[11px]"
                  />
                </label>
              </div>
            )}

            <div className="flex justify-end gap-1.5">
              <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={() => setAddOpen(false)}>
                閉じる
              </Button>
              <Button type="button" size="sm" className="h-7 px-3 text-[11px]" onClick={handleCreate}>
                追加して星図表示
              </Button>
            </div>
          </div>
        )}

        {/* Preset Cards */}
        {fovPresets.map((p) => {
          const dims = computeFovDimensions(p);
          return (
            <div
              key={p.id}
              className={`space-y-2 rounded-xl border p-3 transition ${
                p.enabled
                  ? "border-[var(--accent-primary)]/50 bg-[var(--bg-surface-elevated)]"
                  : "border-[var(--border-subtle)] bg-[var(--bg-surface)]"
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <label className="flex cursor-pointer items-start gap-2">
                  <input
                    type="checkbox"
                    checked={p.enabled}
                    onChange={() => toggleFovPreset(p.id)}
                    className="mt-1"
                  />
                  <div>
                    <div className="flex items-center gap-1.5 font-semibold">
                      <span
                        className="inline-block h-2.5 w-2.5 rounded-full"
                        style={{ backgroundColor: p.color }}
                      />
                      <span>{p.name}</span>
                    </div>
                    <div className="font-mono-num text-[11px] text-[var(--text-muted)]">
                      {dims.summaryText}
                    </div>
                  </div>
                </label>

                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-6 gap-1 px-2 text-[10px]"
                    onClick={() => {
                      if (!p.enabled) toggleFovPreset(p.id);
                      frameFovInSky(dims.widthDeg, dims.heightDeg);
                    }}
                    title="星図をこの視野枠に合わせて拡大"
                  >
                    <ZoomIn className="h-3 w-3" />
                    倍率合せ
                  </Button>
                  <button
                    type="button"
                    onClick={() => deleteFovPreset(p.id)}
                    className="rounded p-1 text-rose-400 hover:text-rose-300"
                    title="削除"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>

              {p.kind === "camera" && (
                <div className="space-y-1.5 border-t border-[var(--border-subtle)] pt-1.5 text-[11px]">
                  <div className="flex items-center gap-2">
                    <span className="shrink-0 text-[var(--text-muted)]">回転角:</span>
                    <input
                      type="range"
                      min={0}
                      max={360}
                      step={1}
                      value={p.rotationDeg}
                      onChange={(e) => setFovRotation(p.id, Number(e.target.value))}
                      className="flex-1 accent-[var(--accent-primary)]"
                    />
                    <span className="w-10 text-right font-mono-num">{p.rotationDeg}°</span>
                    <input
                      type="color"
                      value={p.color}
                      onChange={(e) => updateFovPreset({ ...p, color: e.target.value })}
                      className="h-5 w-6 cursor-pointer rounded border border-[var(--border-subtle)] bg-transparent p-0"
                      title="枠の色を変更"
                    />
                  </div>
                  <div className="grid grid-cols-3 gap-1.5 text-[10px]">
                    <label className="flex items-center justify-between gap-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-1.5 py-0.5">
                      <span className="text-[var(--text-muted)]">列</span>
                      <input
                        type="number"
                        min={1}
                        max={5}
                        value={p.mosaicCols ?? 1}
                        onChange={(e) =>
                          updateFovPreset({
                            ...p,
                            mosaicCols: Math.max(1, Math.min(5, Math.round(Number(e.target.value) || 1))),
                          })
                        }
                        className="w-9 bg-transparent text-right font-mono-num outline-none"
                      />
                    </label>
                    <label className="flex items-center justify-between gap-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-1.5 py-0.5">
                      <span className="text-[var(--text-muted)]">行</span>
                      <input
                        type="number"
                        min={1}
                        max={5}
                        value={p.mosaicRows ?? 1}
                        onChange={(e) =>
                          updateFovPreset({
                            ...p,
                            mosaicRows: Math.max(1, Math.min(5, Math.round(Number(e.target.value) || 1))),
                          })
                        }
                        className="w-9 bg-transparent text-right font-mono-num outline-none"
                      />
                    </label>
                    <label className="flex items-center justify-between gap-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-1.5 py-0.5">
                      <span className="text-[var(--text-muted)]">重%</span>
                      <input
                        type="number"
                        min={0}
                        max={40}
                        value={p.mosaicOverlapPct ?? 15}
                        onChange={(e) =>
                          updateFovPreset({
                            ...p,
                            mosaicOverlapPct: Math.max(0, Math.min(40, Math.round(Number(e.target.value) || 0))),
                          })
                        }
                        className="w-9 bg-transparent text-right font-mono-num outline-none"
                      />
                    </label>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-6 w-full gap-1 text-[10.5px]"
                    onClick={() => handleAddCurrentToPlan(p)}
                  >
                    <Camera className="h-3 w-3 text-rose-400" />
                    {selectedObject ? `「${selectedObject.name_ja}」を撮影計画に追加` : "現在の星図中心を撮影計画に追加"}
                  </Button>
                </div>
              )}
            </div>
          );
        })}
          </>
        )}
      </div>
    </aside>
  );
}
