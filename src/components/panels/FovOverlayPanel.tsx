import { useState } from "react";
import { Plus, RotateCcw, Scan, Trash2, X, ZoomIn } from "lucide-react";
import { Button } from "@/components/ui/button";
import { computeFovDimensions } from "@/lib/fovMath";
import { PROJECTION_META } from "@/types/sky";
import { useSkyStore } from "@/store/skyStore";
import type { FovPresetType } from "@/types/sky";

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
  const toggleFovPreset = useSkyStore((s) => s.toggleFovPreset);
  const setFovRotation = useSkyStore((s) => s.setFovRotation);
  const addFovPreset = useSkyStore((s) => s.addFovPreset);
  const updateFovPreset = useSkyStore((s) => s.updateFovPreset);
  const deleteFovPreset = useSkyStore((s) => s.deleteFovPreset);
  const resetFovPresets = useSkyStore((s) => s.resetFovPresets);
  const setZoomMultiplier = useSkyStore((s) => s.setZoomMultiplier);
  const setActivePanel = useSkyStore((s) => s.setActivePanel);

  const [addOpen, setAddOpen] = useState(false);
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

  return (
    <aside className="flex h-full w-[27rem] max-w-[calc(100vw-5.5rem)] flex-col rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface-glass)] text-[var(--text-primary)] shadow-2xl backdrop-blur-md">
      {/* Header */}
      <div className="flex items-start justify-between gap-2 border-b border-[var(--border-subtle)] px-4 py-3">
        <div>
          <h2 className="flex items-center gap-1.5 text-sm font-semibold tracking-tight">
            <Scan className="h-4 w-4 text-rose-400" /> 天体撮影・観望 視野角 (FOV) 枠
          </h2>
          <p className="text-[11px] text-[var(--text-muted)]">
            カメラセンサー＋焦点距離・望遠鏡＋アイピース・双眼鏡・テルラド
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

      {/* Controls */}
      <div className="flex items-center justify-between gap-2 border-b border-[var(--border-subtle)] px-4 py-2.5 text-xs">
        <Button
          type="button"
          size="sm"
          className="h-7 gap-1 px-2.5 text-[11px]"
          onClick={() => setAddOpen(!addOpen)}
        >
          <Plus className="h-3.5 w-3.5" />
          カスタム視野枠を追加
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 gap-1 px-2 text-[11px]"
          onClick={resetFovPresets}
        >
          <RotateCcw className="h-3.5 w-3.5" />
          初期セットに戻す
        </Button>
      </div>

      <div className="flex-1 space-y-2.5 overflow-y-auto px-4 py-3 text-xs">
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
                <div className="flex items-center gap-2 pt-0.5 text-[11px]">
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
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
