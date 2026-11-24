import { memo } from "react";
import {
  Activity,
  BookOpen,
  Box,
  Calculator,
  CalendarDays,
  Clock,
  Compass,
  Eclipse,
  Flame,
  Globe,
  Grid3x3,
  Layers,
  LayoutGrid,
  MapPin,
  Minus,
  Moon,
  Orbit,
  Plus,
  Printer,
  RotateCcw,
  Scan,
  Search,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Tag,
  Timer,
  TrendingUp,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSkyStore } from "@/store/skyStore";
import type { ActivePanelId } from "@/types/sky";

export type DockOverlayMode = "tools" | "compass" | null;

const TOOL_ITEMS: { id: Exclude<ActivePanelId, null>; label: string; icon: typeof Sun }[] = [
  { id: "moon_calendar", label: "月齢暦", icon: CalendarDays },
  { id: "meteors", label: "流星群", icon: Moon },
  { id: "planets", label: "惑星解析", icon: Globe },
  { id: "solar3d", label: "3D太陽系", icon: Box },
  { id: "eclipses", label: "食・星食", icon: Eclipse },
  { id: "comets", label: "彗星・衛星", icon: Flame },
  { id: "fov", label: "視野角 FOV", icon: Scan },
  { id: "print", label: "印刷・出力", icon: Printer },
  { id: "variables", label: "変光星", icon: Activity },
  { id: "encyclopedia", label: "星座・図鑑", icon: BookOpen },
  { id: "calculator", label: "天文計算", icon: Calculator },
  { id: "clock", label: "時計・タイマー", icon: Timer },
  { id: "altitude_graph", label: "高度グラフ", icon: TrendingUp },
  { id: "time", label: "日時・薄明", icon: Clock },
  { id: "simulation", label: "時間アニメ", icon: Orbit },
  { id: "locations", label: "観測地", icon: MapPin },
];

const QUICK_DIRS: { label: string; az: number; alt: number }[] = [
  { label: "北西", az: 315, alt: 25 },
  { label: "北", az: 0, alt: 25 },
  { label: "北東", az: 45, alt: 25 },
  { label: "西", az: 270, alt: 25 },
  { label: "天頂", az: 180, alt: 89.5 },
  { label: "東", az: 90, alt: 25 },
  { label: "南西", az: 225, alt: 25 },
  { label: "南", az: 180, alt: 25 },
  { label: "南東", az: 135, alt: 25 },
];

function RailItem({
  active,
  label,
  icon: Icon,
  onClick,
}: {
  active: boolean;
  label: string;
  icon: typeof Sun;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex flex-col items-center gap-1 py-1 text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
      title={label}
    >
      <span
        className={`flex h-8 w-12 items-center justify-center rounded-full transition-all duration-150 ${
          active
            ? "m3-tonal-active shadow-sm"
            : "group-hover:bg-white/10"
        }`}
      >
        <Icon className="h-[18px] w-[18px]" />
      </span>
      <span
        className={`text-[10px] leading-none font-medium ${
          active ? "text-[var(--tonal-fg)] font-semibold" : ""
        }`}
      >
        {label}
      </span>
    </button>
  );
}

export function ToolLauncherSheet({
  onClose,
  closeOnSelect = true,
}: {
  onClose: () => void;
  closeOnSelect?: boolean;
}) {
  const openPanels = useSkyStore((s) => s.openPanels);
  const layers = useSkyStore((s) => s.layers);
  const meteorAnimationEnabled = useSkyStore((s) => s.meteorAnimationEnabled);
  const landscapeConfig = useSkyStore((s) => s.landscapeConfig);
  const togglePanel = useSkyStore((s) => s.togglePanel);
  const setConstellationLineMode = useSkyStore((s) => s.setConstellationLineMode);
  const toggleLayer = useSkyStore((s) => s.toggleLayer);
  const setMeteorAnimationEnabled = useSkyStore((s) => s.setMeteorAnimationEnabled);
  const setLandscapeConfig = useSkyStore((s) => s.setLandscapeConfig);

  const openTool = (id: Exclude<ActivePanelId, null>) => {
    togglePanel(id);
    if (closeOnSelect) {
      onClose();
    }
  };

  return (
    <div className="liquid-glass-sheet pointer-events-auto flex w-full flex-col gap-3 p-3.5 sm:w-[19.5rem]">
      <div className="flex items-center justify-between px-1">
        <span className="text-xs font-semibold text-[var(--text-primary)]">天文ツール</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => openTool("search")}
            className="flex h-7 items-center gap-1 rounded-full bg-white/5 px-2.5 text-[11px] hover:bg-white/10 sm:hidden"
          >
            <Search className="h-3.5 w-3.5" />
            <span>検索</span>
          </button>
          <button
            type="button"
            onClick={() => openTool("settings")}
            className="flex h-7 items-center gap-1 rounded-full bg-white/5 px-2.5 text-[11px] hover:bg-white/10 sm:hidden"
          >
            <Settings className="h-3.5 w-3.5" />
            <span>設定</span>
          </button>
          <Button type="button" size="icon" variant="ghost" className="h-7 w-7" onClick={onClose}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Quick Filter Chips */}
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={() =>
            setConstellationLineMode(layers.constellationLines === "off" ? "standard" : "off")
          }
          className={`flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
            layers.constellationLines !== "off"
              ? "m3-tonal-active border-transparent"
              : "border-[var(--glass-border)] bg-white/5 text-[var(--text-secondary)] hover:bg-white/10"
          }`}
        >
          <Sparkles className="h-3 w-3" />
          <span>星座線</span>
        </button>

        <button
          type="button"
          onClick={() => {
            const next = !(layers.equatorialGrid || layers.horizontalGrid);
            useSkyStore.setState((prev) => ({
              layers: { ...prev.layers, equatorialGrid: next, horizontalGrid: next },
            }));
          }}
          className={`flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
            layers.equatorialGrid || layers.horizontalGrid
              ? "m3-tonal-active border-transparent"
              : "border-[var(--glass-border)] bg-white/5 text-[var(--text-secondary)] hover:bg-white/10"
          }`}
        >
          <Grid3x3 className="h-3 w-3" />
          <span>グリッド</span>
        </button>

        <button
          type="button"
          onClick={() => toggleLayer("milkyWay")}
          className={`flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
            layers.milkyWay
              ? "m3-tonal-active border-transparent"
              : "border-[var(--glass-border)] bg-white/5 text-[var(--text-secondary)] hover:bg-white/10"
          }`}
        >
          <Layers className="h-3 w-3" />
          <span>天の川</span>
        </button>

        <button
          type="button"
          onClick={() => toggleLayer("constellationNames")}
          className={`flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
            layers.constellationNames
              ? "m3-tonal-active border-transparent"
              : "border-[var(--glass-border)] bg-white/5 text-[var(--text-secondary)] hover:bg-white/10"
          }`}
        >
          <Tag className="h-3 w-3" />
          <span>名前</span>
        </button>

        <button
          type="button"
          onClick={() => toggleLayer("zoomTextures")}
          className={`flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
            layers.zoomTextures
              ? "m3-tonal-active border-transparent"
              : "border-[var(--glass-border)] bg-white/5 text-[var(--text-secondary)] hover:bg-white/10"
          }`}
        >
          <Scan className="h-3 w-3" />
          <span>拡大天体</span>
        </button>

        <button
          type="button"
          onClick={() => setMeteorAnimationEnabled(!meteorAnimationEnabled)}
          className={`flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
            meteorAnimationEnabled
              ? "m3-tonal-active border-transparent"
              : "border-[var(--glass-border)] bg-white/5 text-[var(--text-secondary)] hover:bg-white/10"
          }`}
        >
          <Orbit className="h-3 w-3" />
          <span>流れ星</span>
        </button>

        <button
          type="button"
          onClick={() =>
            setLandscapeConfig({
              preset:
                landscapeConfig.preset === "veil"
                  ? landscapeConfig.customFileName
                    ? "custom"
                    : "mountain"
                  : "veil",
            })
          }
          className={`flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
            landscapeConfig.preset !== "veil"
              ? "m3-tonal-active border-transparent"
              : "border-[var(--glass-border)] bg-white/5 text-[var(--text-secondary)] hover:bg-white/10"
          }`}
        >
          <Globe className="h-3 w-3" />
          <span>風景</span>
        </button>
      </div>

      {/* 3-Column Material You Tonal Tiles */}
      <div className="grid max-h-[52dvh] grid-cols-3 gap-1.5 overflow-y-auto pr-0.5">
        {TOOL_ITEMS.map((item) => {
          const Icon = item.icon;
          const active = openPanels.includes(item.id);
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => openTool(item.id)}
              className={`flex flex-col items-center justify-center gap-1.5 rounded-2xl p-2.5 text-center transition-all active:scale-95 ${
                active
                  ? "m3-tonal-active font-semibold"
                  : "bg-white/[0.04] text-[var(--text-secondary)] hover:bg-white/10 hover:text-[var(--text-primary)]"
              }`}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="text-[10.5px] leading-tight">{item.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function CompassSheet({ onClose }: { onClose: () => void }) {
  const lookAtDirection = useSkyStore((s) => s.lookAtDirection);
  const zoomBy = useSkyStore((s) => s.zoomBy);
  const setZoomMultiplier = useSkyStore((s) => s.setZoomMultiplier);
  const resetView = useSkyStore((s) => s.resetView);
  const gyroEnabled = useSkyStore((s) => s.gyroEnabled);
  const gyroAzOffsetDeg = useSkyStore((s) => s.gyroAzOffsetDeg);
  const gyroStatus = useSkyStore((s) => s.gyroStatus);
  const setGyroEnabled = useSkyStore((s) => s.setGyroEnabled);
  const setGyroAzOffsetDeg = useSkyStore((s) => s.setGyroAzOffsetDeg);

  return (
    <div className="liquid-glass-sheet pointer-events-auto w-full p-3.5 sm:w-56">
      <div className="mb-2 flex items-center justify-between px-0.5">
        <span className="text-xs font-semibold text-[var(--text-primary)]">方角・倍率</span>
        <Button type="button" size="icon" variant="ghost" className="h-7 w-7" onClick={onClose}>
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="mb-2.5 space-y-1.5">
        <Button
          type="button"
          size="sm"
          variant={gyroEnabled ? "tonal" : "outline"}
          className="h-8 w-full justify-center gap-1.5 rounded-2xl text-xs"
          onClick={() => setGyroEnabled(!gyroEnabled)}
        >
          <Compass className="h-3.5 w-3.5" />
          {gyroEnabled ? "センサー追尾 ON" : "ジャイロ・コンパス追尾"}
        </Button>
        {gyroEnabled && (
          <div className="space-y-1 rounded-xl border border-[var(--glass-border)] bg-white/[0.04] px-2 py-1.5">
            {gyroStatus && (
              <div className="text-[10px] leading-tight text-[var(--text-secondary)]">
                {gyroStatus}
              </div>
            )}
            <div className="flex items-center justify-between text-[10px] text-[var(--text-muted)]">
              <span>方位微調整</span>
              <span className="font-mono-num">
                {gyroAzOffsetDeg > 0 ? `+${gyroAzOffsetDeg}` : gyroAzOffsetDeg}°
              </span>
            </div>
            <input
              type="range"
              min={-45}
              max={45}
              step={1}
              value={gyroAzOffsetDeg}
              onChange={(e) => setGyroAzOffsetDeg(Number(e.target.value))}
              className="w-full accent-[var(--accent-primary)]"
            />
          </div>
        )}
      </div>

      <div className="grid grid-cols-3 gap-1.5">
        {QUICK_DIRS.map((d) => (
          <Button
            key={d.label}
            type="button"
            size="sm"
            variant={d.label === "天頂" ? "tonal" : "outline"}
            className="h-9 rounded-2xl text-xs"
            onClick={() => lookAtDirection(d.az, d.alt)}
          >
            {d.label}
          </Button>
        ))}
      </div>

      <div className="my-2.5 h-px bg-[var(--glass-border)]" />

      <div className="grid grid-cols-3 gap-1.5">
        <Button type="button" size="sm" variant="outline" className="h-8" onClick={() => zoomBy(1.25)} title="拡大">
          <Plus className="h-3.5 w-3.5" />
        </Button>
        <Button type="button" size="sm" variant="outline" className="h-8" onClick={() => zoomBy(1 / 1.25)} title="縮小">
          <Minus className="h-3.5 w-3.5" />
        </Button>
        <Button type="button" size="sm" variant="outline" className="h-8" onClick={resetView} title="リセット">
          <RotateCcw className="h-3.5 w-3.5" />
        </Button>
        <Button type="button" size="sm" variant="ghost" className="h-7 font-mono-num text-[11px]" onClick={() => setZoomMultiplier(1)}>
          1×
        </Button>
        <Button type="button" size="sm" variant="ghost" className="h-7 font-mono-num text-[11px]" onClick={() => setZoomMultiplier(2)}>
          2×
        </Button>
        <Button type="button" size="sm" variant="ghost" className="h-7 font-mono-num text-[11px]" onClick={() => setZoomMultiplier(4)}>
          4×
        </Button>
      </div>
    </div>
  );
}

export const DesktopNavigationRail = memo(function DesktopNavigationRail({
  overlay,
  setOverlay,
}: {
  overlay: DockOverlayMode;
  setOverlay: (next: DockOverlayMode) => void;
}) {
  const openPanels = useSkyStore((s) => s.openPanels);
  const togglePanel = useSkyStore((s) => s.togglePanel);

  const openDirect = (id: Exclude<ActivePanelId, null>) => {
    setOverlay(null);
    togglePanel(id);
  };

  return (
    <div className="pointer-events-none hidden items-start gap-2.5 sm:flex">
      <nav
        aria-label="ナビゲーション"
        className="liquid-glass-sheet pointer-events-auto flex w-[68px] flex-col items-center gap-1 py-2.5"
      >
        <RailItem
          active={openPanels.includes("observation")}
          label="観測"
          icon={Sun}
          onClick={() => openDirect("observation")}
        />
        <RailItem
          active={overlay === "tools"}
          label="ツール"
          icon={LayoutGrid}
          onClick={() => setOverlay(overlay === "tools" ? null : "tools")}
        />
        <RailItem
          active={openPanels.includes("display")}
          label="表示"
          icon={SlidersHorizontal}
          onClick={() => openDirect("display")}
        />
        <RailItem
          active={overlay === "compass"}
          label="方角"
          icon={Compass}
          onClick={() => setOverlay(overlay === "compass" ? null : "compass")}
        />
        <RailItem
          active={openPanels.includes("search")}
          label="検索"
          icon={Search}
          onClick={() => openDirect("search")}
        />
        <div className="my-1 h-px w-8 bg-[var(--glass-border)]" />
        <RailItem
          active={openPanels.includes("settings")}
          label="設定"
          icon={Settings}
          onClick={() => openDirect("settings")}
        />
      </nav>

      {overlay === "tools" && (
        <ToolLauncherSheet closeOnSelect={false} onClose={() => setOverlay(null)} />
      )}
      {overlay === "compass" && <CompassSheet onClose={() => setOverlay(null)} />}
    </div>
  );
});

export function MobileBottomNav({
  overlay,
  setOverlay,
}: {
  overlay: DockOverlayMode;
  setOverlay: (next: DockOverlayMode) => void;
}) {
  const activePanel = useSkyStore((s) => s.activePanel);
  const openPanels = useSkyStore((s) => s.openPanels);
  const closeAllPanels = useSkyStore((s) => s.closeAllPanels);
  const togglePanel = useSkyStore((s) => s.togglePanel);
  const clearSelection = useSkyStore((s) => s.clearSelection);

  const isSkyFocus = activePanel === null && overlay === null;

  const toggleMobilePanel = (id: Exclude<ActivePanelId, null>) => {
    setOverlay(null);
    togglePanel(id);
  };

  return (
    <nav
      aria-label="モバイルナビゲーション"
      className="liquid-glass-pill pointer-events-auto grid w-full grid-cols-5 items-center px-1.5 py-1 sm:hidden"
    >
      <RailItem
        active={isSkyFocus}
        label="星空"
        icon={Sparkles}
        onClick={() => {
          setOverlay(null);
          closeAllPanels();
          clearSelection();
        }}
      />
      <RailItem
        active={openPanels.includes("observation") && overlay === null}
        label="観測"
        icon={Sun}
        onClick={() => toggleMobilePanel("observation")}
      />
      <RailItem
        active={overlay === "tools"}
        label="ツール"
        icon={LayoutGrid}
        onClick={() => setOverlay(overlay === "tools" ? null : "tools")}
      />
      <RailItem
        active={openPanels.includes("display") && overlay === null}
        label="表示"
        icon={SlidersHorizontal}
        onClick={() => toggleMobilePanel("display")}
      />
      <RailItem
        active={overlay === "compass"}
        label="方角"
        icon={Compass}
        onClick={() => setOverlay(overlay === "compass" ? null : "compass")}
      />
    </nav>
  );
}
