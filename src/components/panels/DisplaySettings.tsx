import { Image as ImageIcon, Palette, SlidersHorizontal, Sparkles, Trash2, Upload, X } from "lucide-react";
import { type ChangeEvent, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  clearCustomPanoramaStorage,
  hasLoadedCustomPanorama,
  importCustomPanoramaFile,
  rebuildCustomPanoramaMask,
} from "@/lib/panoramaLandscape";
import { effectiveFovDeg } from "@/lib/projection";
import { useSkyStore } from "@/store/skyStore";
import {
  COLOR_PRESETS,
  type ConstellationLineMode,
  type CustomColorPalette,
  type CustomPanoramaMaskMode,
  type LandscapePresetId,
  OBSERVER_BODIES,
  OTHER_STAR_PRESETS,
  PROJECTION_META,
  type ProjectionMode,
  type SkyLayerVisibility,
  type SkyViewMode,
} from "@/types/sky";

const VIEW_MODES: { id: SkyViewMode; label: string; desc: string }[] = [
  { id: "normal", label: "通常", desc: "現在・近代の精密星空" },
  { id: "precession", label: "歳差＋極軸", desc: "±1万5千年の極軸変化" },
  { id: "proper_motion", label: "固有運動", desc: "±10万年の星座変形" },
  { id: "other_planet", label: "別の惑星", desc: "月・火星等からの空" },
  { id: "other_star", label: "別の恒星", desc: "3D星間飛行・異星系" },
];

const LINE_MODES: { value: ConstellationLineMode; label: string }[] = [
  { value: "off", label: "OFF" },
  { value: "simple", label: "簡易" },
  { value: "standard", label: "標準" },
  { value: "detailed", label: "詳細" },
];

const LAYER_TOGGLES: {
  key: Exclude<keyof SkyLayerVisibility, "constellationLines">;
  label: string;
}[] = [
  { key: "constellationNames", label: "星座名" },
  { key: "constellationBoundaries", label: "星座境界線" },
  { key: "constellationArtwork", label: "星座絵" },
  { key: "milkyWay", label: "天の川" },
  { key: "asterisms", label: "大三角・四辺形" },
  { key: "starNames", label: "恒星名" },
  { key: "planetNames", label: "惑星・太陽・月名" },
  { key: "dsoMarkers", label: "星雲・星団" },
  { key: "dsoNames", label: "星雲・星団名" },
  { key: "meteorRadiants", label: "流星群放射点" },
  { key: "zoomTextures", label: "拡大天体テクスチャ" },
  { key: "ecliptic", label: "黄道" },
  { key: "celestialEquator", label: "天の赤道" },
  { key: "equatorialGrid", label: "赤経・赤緯線" },
  { key: "horizontalGrid", label: "方位・高度線" },
  { key: "gridLabels", label: "数値目盛" },
  { key: "zenithMark", label: "天頂マーク" },
  { key: "horizonAndCardinals", label: "地平線・方位" },
];

const COLOR_CHANNELS: { key: keyof CustomColorPalette; label: string }[] = [
  { key: "constellationLines", label: "星座線" },
  { key: "constellationNames", label: "星座名" },
  { key: "constellationBoundaries", label: "星座境界線" },
  { key: "asterisms", label: "大三角等" },
  { key: "ecliptic", label: "黄道" },
  { key: "celestialEquator", label: "天の赤道" },
  { key: "grids", label: "経緯グリッド" },
  { key: "dso", label: "星雲・星団" },
];

export function DisplaySettings() {
  const skyFrame = useSkyStore((s) => s.skyFrame);
  const projectionMode = useSkyStore((s) => s.projectionMode);
  const viewMode = useSkyStore((s) => s.viewMode);
  const observerBody = useSkyStore((s) => s.observerBody);
  const originStarHip = useSkyStore((s) => s.originStarHip);
  const fovDeg = useSkyStore((s) => s.fovDeg);
  const zoom = useSkyStore((s) => s.zoom);
  const limitingMag = useSkyStore((s) => s.limitingMag);
  const skyRealismLevel = useSkyStore((s) => s.skyRealismLevel);
  const refractionEnabled = useSkyStore((s) => s.refractionEnabled);
  const showBelowHorizon = useSkyStore((s) => s.showBelowHorizon);
  const layers = useSkyStore((s) => s.layers);
  const colorPreset = useSkyStore((s) => s.colorPreset);
  const customColors = useSkyStore((s) => s.customColors);
  const showObservationOnStartup = useSkyStore((s) => s.showObservationOnStartup);
  const landscapeConfig = useSkyStore((s) => s.landscapeConfig);
  const meteorAnimationEnabled = useSkyStore((s) => s.meteorAnimationEnabled);
  const meteorRateMultiplier = useSkyStore((s) => s.meteorRateMultiplier);

  const setProjectionMode = useSkyStore((s) => s.setProjectionMode);
  const setViewMode = useSkyStore((s) => s.setViewMode);
  const setObserverBody = useSkyStore((s) => s.setObserverBody);
  const setOriginStarHip = useSkyStore((s) => s.setOriginStarHip);
  const setZoomMultiplier = useSkyStore((s) => s.setZoomMultiplier);
  const setLimitingMag = useSkyStore((s) => s.setLimitingMag);
  const setSkyRealismLevel = useSkyStore((s) => s.setSkyRealismLevel);
  const setRefractionEnabled = useSkyStore((s) => s.setRefractionEnabled);
  const setShowBelowHorizon = useSkyStore((s) => s.setShowBelowHorizon);
  const setConstellationLineMode = useSkyStore((s) => s.setConstellationLineMode);
  const toggleLayer = useSkyStore((s) => s.toggleLayer);
  const applyColorPreset = useSkyStore((s) => s.applyColorPreset);
  const setCustomColor = useSkyStore((s) => s.setCustomColor);
  const setShowObservationOnStartup = useSkyStore((s) => s.setShowObservationOnStartup);
  const setLandscapeConfig = useSkyStore((s) => s.setLandscapeConfig);
  const bumpLandscapeVersion = useSkyStore((s) => s.bumpLandscapeVersion);
  const setMeteorAnimationEnabled = useSkyStore((s) => s.setMeteorAnimationEnabled);
  const setMeteorRateMultiplier = useSkyStore((s) => s.setMeteorRateMultiplier);
  const jumpToYmdHms = useSkyStore((s) => s.jumpToYmdHms);
  const setActivePanel = useSkyStore((s) => s.setActivePanel);

  const [hipInput, setHipInput] = useState(String(originStarHip));
  const [panoMessage, setPanoMessage] = useState<string | null>(null);
  const panoInputRef = useRef<HTMLInputElement>(null);
  const effFov = effectiveFovDeg(projectionMode, fovDeg) / zoom;
  const bortle = skyFrame?.sky_palette.estimated_bortle ?? 4;

  const handlePanoUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setPanoMessage("360°パノラマを読込中...");
    try {
      const res = await importCustomPanoramaFile(
        file,
        landscapeConfig.maskMode,
        landscapeConfig.skyKeyThreshold,
      );
      setLandscapeConfig({
        preset: "custom",
        customFileName: res.fileName,
        maskMode: res.hasNativeAlpha ? "alpha_only" : "auto_sky_key",
      });
      bumpLandscapeVersion();
      setPanoMessage(`読込完了: ${res.fileName}`);
    } catch (err) {
      setPanoMessage(`読込失敗: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <aside className="pointer-events-auto flex max-h-full w-80 flex-col overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface-glass)] shadow-2xl backdrop-blur-md">
      <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-3.5 py-2.5">
        <div className="flex items-center gap-2 text-xs font-semibold">
          <SlidersHorizontal className="h-4 w-4 text-[var(--accent-primary)]" />
          <span>表示設定</span>
        </div>
        <Button type="button" size="icon" variant="ghost" className="h-6 w-6" onClick={() => setActivePanel(null)}>
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto p-3.5 text-xs">
        {/* View Modes */}
        <section className="space-y-1.5">
          <div className="font-semibold text-[var(--text-secondary)]">表示モード</div>
          <div className="grid grid-cols-2 gap-1">
            {VIEW_MODES.map((m) => (
              <Button
                key={m.id}
                type="button"
                size="sm"
                variant={viewMode === m.id ? "default" : "outline"}
                className="h-auto flex-col items-start px-2 py-1.5 text-left"
                onClick={() => setViewMode(m.id)}
              >
                <span className="text-[11px] font-semibold">{m.label}</span>
                <span className="text-[9px] opacity-80">{m.desc}</span>
              </Button>
            ))}
          </div>

          {viewMode === "precession" && (
            <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-2">
              <div className="mb-1.5 text-[10px] text-[var(--text-secondary)]">歳差テスト年へワンクリック移動</div>
              <div className="flex flex-wrap gap-1">
                {[
                  { y: -13000, label: "BC13000 ベガ" },
                  { y: -3000, label: "BC3000 トゥバン" },
                  { y: 2000, label: "2000 ポラリス" },
                  { y: 7500, label: "7500 アルデラミン" },
                  { y: 14000, label: "14000 ベガ" },
                ].map((ep) => (
                  <Button
                    key={ep.y}
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-6 px-1.5 text-[10px]"
                    onClick={() => jumpToYmdHms(ep.y, 1, 1, 21, 0, 0)}
                  >
                    {ep.label}
                  </Button>
                ))}
              </div>
            </div>
          )}

          {viewMode === "proper_motion" && (
            <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-2">
              <div className="mb-1.5 text-[10px] text-[var(--text-secondary)]">固有運動シミュレーション年</div>
              <div className="flex flex-wrap gap-1">
                {[-100000, -50000, 2000, 52000, 102000].map((y) => (
                  <Button
                    key={y}
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-6 px-1.5 font-mono-num text-[10px]"
                    onClick={() => jumpToYmdHms(y, 1, 1, 21, 0, 0)}
                  >
                    {y === 2000 ? "J2000" : `${y > 2000 ? "+" : ""}${Math.round((y - 2000) / 1000)}万年`}
                  </Button>
                ))}
              </div>
            </div>
          )}

          {viewMode === "other_planet" && (
            <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-2">
              <div className="mb-1.5 text-[10px] text-[var(--text-secondary)]">観測する天体表面</div>
              <div className="grid grid-cols-4 gap-1">
                {OBSERVER_BODIES.map((b) => (
                  <Button
                    key={b.id}
                    type="button"
                    size="sm"
                    variant={observerBody === b.id ? "default" : "outline"}
                    className="h-7 px-1 text-[11px]"
                    title={b.subJa}
                    onClick={() => setObserverBody(b.id)}
                  >
                    {b.labelJa}
                  </Button>
                ))}
              </div>
            </div>
          )}

          {viewMode === "other_star" && (
            <div className="space-y-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-2">
              <div className="text-[10px] text-[var(--text-secondary)]">出発する恒星系（3D再投影）</div>
              <div className="grid grid-cols-2 gap-1">
                {OTHER_STAR_PRESETS.map((st) => (
                  <Button
                    key={st.hip}
                    type="button"
                    size="sm"
                    variant={originStarHip === st.hip ? "default" : "outline"}
                    className="h-7 justify-between px-1.5 text-[10px]"
                    onClick={() => {
                      setHipInput(String(st.hip));
                      setOriginStarHip(st.hip);
                    }}
                  >
                    <span className="truncate">{st.nameJa}</span>
                    <span className="font-mono-num opacity-70">{st.distLy}ly</span>
                  </Button>
                ))}
              </div>
              <form
                className="flex gap-1"
                onSubmit={(e) => {
                  e.preventDefault();
                  const parsed = Number.parseInt(hipInput, 10);
                  if (Number.isFinite(parsed) && parsed > 0) setOriginStarHip(parsed);
                }}
              >
                <input
                  type="number"
                  value={hipInput}
                  onChange={(e) => setHipInput(e.target.value)}
                  placeholder="HIP番号 (例 71683)"
                  className="w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 font-mono-num text-[11px] outline-none"
                />
                <Button type="submit" size="sm" variant="outline" className="h-7 px-2 text-[11px]">
                  移動
                </Button>
              </form>
            </div>
          )}
        </section>

        {/* Projection & Magnification */}
        <section className="space-y-1.5 border-t border-[var(--border-subtle)] pt-3">
          <div className="flex items-center justify-between">
            <span className="font-semibold text-[var(--text-secondary)]">9つの図法・倍率</span>
            <span className="font-mono-num text-[11px] text-[var(--accent-primary)]">FOV {effFov.toFixed(1)}°</span>
          </div>
          <select
            value={projectionMode}
            onChange={(e) => setProjectionMode(e.target.value as ProjectionMode)}
            className="w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 py-1.5 text-xs text-[var(--text-primary)] outline-none"
          >
            {PROJECTION_META.map((m) => (
              <option key={m.mode} value={m.mode}>
                {m.labelJa} — {m.descriptionJa}
              </option>
            ))}
          </select>
          <div className="grid grid-cols-4 gap-1">
            {[1, 2, 4, 8].map((mult) => (
              <Button
                key={mult}
                type="button"
                size="sm"
                variant="outline"
                className="h-7 font-mono-num text-[11px]"
                onClick={() => setZoomMultiplier(mult)}
              >
                {mult}×
              </Button>
            ))}
          </div>
        </section>

        {/* Magnitude & Sky Realism */}
        <section className="space-y-2 border-t border-[var(--border-subtle)] pt-3">
          <div className="flex justify-between">
            <span>最微光星等級</span>
            <span className="font-mono-num text-[var(--accent-primary)]">
              {limitingMag.toFixed(1)} 等 (Bortle {bortle})
            </span>
          </div>
          <input
            type="range"
            min={2.0}
            max={10.5}
            step={0.1}
            value={limitingMag}
            onChange={(e) => setLimitingMag(Number(e.target.value))}
            className="w-full accent-[var(--accent-primary)]"
          />

          <div className="text-[11px] text-[var(--text-secondary)]">リアル空背景レベル</div>
          <div className="grid grid-cols-4 gap-1">
            {["OFF", "弱", "標準", "濃"].map((label, lvl) => (
              <Button
                key={label}
                type="button"
                size="sm"
                variant={skyRealismLevel === lvl ? "default" : "outline"}
                className="h-7 px-1 text-[11px]"
                onClick={() => setSkyRealismLevel(lvl)}
              >
                {label}
              </Button>
            ))}
          </div>

          <div className="text-[11px] text-[var(--text-secondary)]">星座線詳細度</div>
          <div className="grid grid-cols-4 gap-1">
            {LINE_MODES.map((m) => (
              <Button
                key={m.value}
                type="button"
                size="sm"
                variant={layers.constellationLines === m.value ? "default" : "outline"}
                className="h-7 px-1 text-[11px]"
                onClick={() => setConstellationLineMode(m.value)}
              >
                {m.label}
              </Button>
            ))}
          </div>
        </section>

        {/* Layer Checkboxes */}
        <section className="space-y-2 border-t border-[var(--border-subtle)] pt-3">
          <div className="flex flex-col gap-1 text-[11px]">
            <label className="flex cursor-pointer items-center justify-between">
              <span>大気差補正</span>
              <input
                type="checkbox"
                checked={refractionEnabled}
                onChange={(e) => setRefractionEnabled(e.target.checked)}
              />
            </label>
            <label className="flex cursor-pointer items-center justify-between">
              <span>地平線下の星空も表示</span>
              <input
                type="checkbox"
                checked={showBelowHorizon}
                onChange={(e) => setShowBelowHorizon(e.target.checked)}
              />
            </label>
            <label className="flex cursor-pointer items-center justify-between">
              <span>起動時に当日の観測データを表示</span>
              <input
                type="checkbox"
                checked={showObservationOnStartup}
                onChange={(e) => setShowObservationOnStartup(e.target.checked)}
              />
            </label>
          </div>

          <div className="grid grid-cols-2 gap-x-2 gap-y-1.5 text-[11px]">
            {LAYER_TOGGLES.map((item) => (
              <label key={item.key} className="flex cursor-pointer items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={layers[item.key]}
                  onChange={() => toggleLayer(item.key)}
                />
                <span>{item.label}</span>
              </label>
            ))}
          </div>
        </section>

        {/* Horizon 360 Panorama Landscape (Gcam Photo Sphere & Presets) */}
        <section className="space-y-2 border-t border-[var(--border-subtle)] pt-3">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 font-semibold text-[var(--text-secondary)]">
              <ImageIcon className="h-3.5 w-3.5 text-emerald-400" />
              地平線 360° パノラマ風景
            </span>
            <span className="text-[10px] text-[var(--text-muted)]">Gcam / 透過PNG</span>
          </div>

          <div className="grid grid-cols-3 gap-1">
            {(
              [
                { id: "veil", label: "ベール" },
                { id: "mountain", label: "山岳高原" },
                { id: "coast", label: "海辺と岬" },
                { id: "observatory", label: "天文台" },
                { id: "custom", label: "カスタム360°" },
              ] as { id: LandscapePresetId; label: string }[]
            ).map((p) => (
              <Button
                key={p.id}
                type="button"
                size="sm"
                variant={landscapeConfig.preset === p.id ? "default" : "outline"}
                className="h-7 px-1.5 text-[10.5px]"
                onClick={() => setLandscapeConfig({ preset: p.id })}
              >
                {p.label}
              </Button>
            ))}
          </div>

          <div className="flex items-center gap-1.5">
            <input
              ref={panoInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handlePanoUpload}
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 flex-1 gap-1.5 px-2 text-[11px]"
              onClick={() => panoInputRef.current?.click()}
            >
              <Upload className="h-3.5 w-3.5" />
              {landscapeConfig.customFileName
                ? `画像変更 (${landscapeConfig.customFileName})`
                : "Gcam / 360°画像を読込..."}
            </Button>
            {(landscapeConfig.customFileName || hasLoadedCustomPanorama()) && (
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="h-7 w-7 text-[var(--text-muted)] hover:text-rose-400"
                title="カスタム画像を削除"
                onClick={() => {
                  void clearCustomPanoramaStorage().then(() => {
                    setLandscapeConfig({
                      preset: landscapeConfig.preset === "custom" ? "mountain" : landscapeConfig.preset,
                      customFileName: null,
                    });
                    bumpLandscapeVersion();
                    setPanoMessage(null);
                  });
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>

          {panoMessage && (
            <div className="text-[10px] text-[var(--accent-primary)]">{panoMessage}</div>
          )}

          {landscapeConfig.preset === "custom" && (
            <div className="space-y-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-2">
              <div className="text-[10px] text-[var(--text-secondary)]">空領域の切り抜き方式</div>
              <div className="grid grid-cols-3 gap-1">
                {(
                  [
                    { id: "auto_sky_key", label: "自動空抜き" },
                    { id: "horizon_cut", label: "0°水平" },
                    { id: "alpha_only", label: "透過PNG" },
                  ] as { id: CustomPanoramaMaskMode; label: string }[]
                ).map((m) => (
                  <Button
                    key={m.id}
                    type="button"
                    size="sm"
                    variant={landscapeConfig.maskMode === m.id ? "default" : "outline"}
                    className="h-6 px-1 text-[10px]"
                    onClick={() => {
                      setLandscapeConfig({ maskMode: m.id });
                      rebuildCustomPanoramaMask(m.id, landscapeConfig.skyKeyThreshold);
                      bumpLandscapeVersion();
                    }}
                  >
                    {m.label}
                  </Button>
                ))}
              </div>
              {landscapeConfig.maskMode === "auto_sky_key" && (
                <div>
                  <div className="flex justify-between text-[10px] text-[var(--text-muted)]">
                    <span>空抜き感度</span>
                    <span className="font-mono-num">{landscapeConfig.skyKeyThreshold}</span>
                  </div>
                  <input
                    type="range"
                    min={12}
                    max={75}
                    step={1}
                    value={landscapeConfig.skyKeyThreshold}
                    onChange={(e) => {
                      const val = Number(e.target.value);
                      setLandscapeConfig({ skyKeyThreshold: val });
                      rebuildCustomPanoramaMask("auto_sky_key", val);
                      bumpLandscapeVersion();
                    }}
                    className="w-full accent-[var(--accent-primary)]"
                  />
                </div>
              )}
            </div>
          )}

          {landscapeConfig.preset !== "veil" && (
            <div className="space-y-1.5 text-[11px]">
              <div>
                <div className="flex justify-between text-[10px] text-[var(--text-muted)]">
                  <span>北の方位オフセット</span>
                  <span className="font-mono-num">
                    {landscapeConfig.azOffsetDeg > 0 ? "+" : ""}
                    {landscapeConfig.azOffsetDeg.toFixed(0)}°
                  </span>
                </div>
                <input
                  type="range"
                  min={-180}
                  max={180}
                  step={1}
                  value={landscapeConfig.azOffsetDeg}
                  onChange={(e) => setLandscapeConfig({ azOffsetDeg: Number(e.target.value) })}
                  className="w-full accent-[var(--accent-primary)]"
                />
              </div>
              <div>
                <div className="flex justify-between text-[10px] text-[var(--text-muted)]">
                  <span>高さ・傾きオフセット</span>
                  <span className="font-mono-num">
                    {landscapeConfig.altOffsetDeg > 0 ? "+" : ""}
                    {landscapeConfig.altOffsetDeg.toFixed(1)}°
                  </span>
                </div>
                <input
                  type="range"
                  min={-15}
                  max={15}
                  step={0.5}
                  value={landscapeConfig.altOffsetDeg}
                  onChange={(e) => setLandscapeConfig({ altOffsetDeg: Number(e.target.value) })}
                  className="w-full accent-[var(--accent-primary)]"
                />
              </div>
              <div>
                <div className="flex justify-between text-[10px] text-[var(--text-muted)]">
                  <span>風景の不透明度</span>
                  <span className="font-mono-num">{Math.round(landscapeConfig.opacity * 100)}%</span>
                </div>
                <input
                  type="range"
                  min={0.15}
                  max={1.0}
                  step={0.05}
                  value={landscapeConfig.opacity}
                  onChange={(e) => setLandscapeConfig({ opacity: Number(e.target.value) })}
                  className="w-full accent-[var(--accent-primary)]"
                />
              </div>
              <label className="flex cursor-pointer items-center justify-between">
                <span>夜間の空の暗さに連動減光</span>
                <input
                  type="checkbox"
                  checked={landscapeConfig.nightDimming}
                  onChange={(e) => setLandscapeConfig({ nightDimming: e.target.checked })}
                />
              </label>
            </div>
          )}
        </section>

        {/* Live Shooting Star Effect */}
        <section className="space-y-1.5 border-t border-[var(--border-subtle)] pt-3">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 font-semibold text-[var(--text-secondary)]">
              <Sparkles className="h-3.5 w-3.5 text-amber-300" />
              流れ星エフェクト
            </span>
            <label className="flex cursor-pointer items-center gap-1.5 text-[11px]">
              <input
                type="checkbox"
                checked={meteorAnimationEnabled}
                onChange={(e) => setMeteorAnimationEnabled(e.target.checked)}
              />
              <span>有効</span>
            </label>
          </div>
          {meteorAnimationEnabled && (
            <div>
              <div className="flex justify-between text-[10px] text-[var(--text-muted)]">
                <span>出現頻度倍率（季節流星群ZHR・散在流星）</span>
                <span className="font-mono-num">{meteorRateMultiplier.toFixed(1)}×</span>
              </div>
              <input
                type="range"
                min={0.5}
                max={5}
                step={0.5}
                value={meteorRateMultiplier}
                onChange={(e) => setMeteorRateMultiplier(Number(e.target.value))}
                className="w-full accent-[var(--accent-primary)]"
              />
            </div>
          )}
        </section>

        {/* Display Color Customization */}
        <section className="space-y-2 border-t border-[var(--border-subtle)] pt-3">
          <div className="flex items-center gap-1.5 font-semibold text-[var(--text-secondary)]">
            <Palette className="h-3.5 w-3.5 text-[var(--accent-secondary)]" />
            <span>表示色カスタマイズ・プリセット</span>
          </div>
          <div className="grid grid-cols-2 gap-1">
            {COLOR_PRESETS.map((p) => (
              <Button
                key={p.id}
                type="button"
                size="sm"
                variant={colorPreset === p.id ? "default" : "outline"}
                className="h-7 px-2 text-[10px]"
                onClick={() => applyColorPreset(p.id)}
              >
                {p.labelJa}
              </Button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 pt-1 text-[11px]">
            {COLOR_CHANNELS.map((ch) => (
              <label key={ch.key} className="flex items-center justify-between">
                <span>{ch.label}</span>
                <input
                  type="color"
                  value={customColors[ch.key]}
                  onChange={(e) => setCustomColor(ch.key, e.target.value)}
                  className="h-5 w-8 cursor-pointer rounded border border-[var(--border-subtle)] bg-transparent p-0"
                />
              </label>
            ))}
          </div>
        </section>
      </div>
    </aside>
  );
}
