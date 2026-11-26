import { memo, useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ChevronLeft,
  ChevronRight,
  Clock,
  Compass,
  Eye,
  LocateFixed,
  MapPin,
  Minus,
  Moon,
  Search,
  Settings,
  Square,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSkyStore } from "@/store/skyStore";
import { type ThemeMode, useThemeStore } from "@/store/themeStore";
import {
  OBSERVER_BODIES,
  OTHER_STAR_PRESETS,
  PROJECTION_META,
  type ProjectionMode,
} from "@/types/sky";

const THEME_META: Record<ThemeMode, { label: string; icon: typeof Moon }> = {
  dark: { label: "ダーク", icon: Moon },
  "night-vision": { label: "赤色暗順応", icon: Eye },
};

export const TopBar = memo(function TopBar() {
  const { theme, setTheme } = useThemeStore();
  const skyFrame = useSkyStore((s) => s.skyFrame);
  const location = useSkyStore((s) => s.location);
  const projectionMode = useSkyStore((s) => s.projectionMode);
  const viewMode = useSkyStore((s) => s.viewMode);
  const observerBody = useSkyStore((s) => s.observerBody);
  const originStarHip = useSkyStore((s) => s.originStarHip);
  const openPanels = useSkyStore((s) => s.openPanels);
  const gyroEnabled = useSkyStore((s) => s.gyroEnabled);
  const gpsLoading = useSkyStore((s) => s.gpsLoading);

  const togglePanel = useSkyStore((s) => s.togglePanel);
  const setGyroEnabled = useSkyStore((s) => s.setGyroEnabled);
  const acquireGpsLocation = useSkyStore((s) => s.acquireGpsLocation);
  const setProjectionMode = useSkyStore((s) => s.setProjectionMode);
  const stepTimeMinutes = useSkyStore((s) => s.stepTimeMinutes);
  const setNow = useSkyStore((s) => s.setNow);
  const setCommandPaletteOpen = useSkyStore((s) => s.setCommandPaletteOpen);

  const isDesktopWindow =
    isTauri() &&
    typeof navigator !== "undefined" &&
    !/Android|iPhone|iPad/i.test(navigator.userAgent);
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    if (!isDesktopWindow) return;
    let active = true;
    const win = getCurrentWindow();
    void win.isMaximized().then((m) => {
      if (active) setIsMaximized(m);
    });
    const unlistenPromise = win.onResized(async () => {
      try {
        const m = await win.isMaximized();
        if (active) setIsMaximized(m);
      } catch {
        // Ignore window state query errors during teardown
      }
    });
    return () => {
      active = false;
      void unlistenPromise.then((fn) => fn()).catch(() => {});
    };
  }, [isDesktopWindow]);

  const shortLocation = location.name_ja.replace(/\s*[（(].*?[）)]/g, "").trim() || location.name_ja;
  const dateMd = skyFrame
    ? `${skyFrame.local_dt.month}/${String(skyFrame.local_dt.day).padStart(2, "0")}`
    : "--/--";
  const timeHm = skyFrame
    ? `${String(skyFrame.local_dt.hour).padStart(2, "0")}:${String(skyFrame.local_dt.minute).padStart(2, "0")}`
    : "--:--";

  const viewBadge =
    viewMode === "normal"
      ? null
      : viewMode === "precession"
        ? "歳差"
        : viewMode === "proper_motion"
          ? "固有運動"
          : viewMode === "other_planet"
            ? (OBSERVER_BODIES.find((b) => b.id === observerBody)?.labelJa ?? observerBody)
            : (OTHER_STAR_PRESETS.find((p) => p.hip === originStarHip)?.nameJa ?? `HIP ${originStarHip}`);

  const ThemeIcon = THEME_META[theme].icon;
  const toggleNightVision = () => {
    const next: ThemeMode = theme === "night-vision" ? "dark" : "night-vision";
    setTheme(next);
    void useSkyStore.getState().refreshFrame(next === "night-vision");
  };

  return (
    <header className="pointer-events-none relative z-20 flex flex-nowrap items-center justify-between gap-1.5 sm:gap-2">
      {/* Left Capsule: Date/Time + Quick Step */}
      <div className="liquid-glass-pill pointer-events-auto flex shrink-0 items-center gap-0.5 px-1 py-1 sm:px-1.5">
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-7 w-7 sm:h-8 sm:w-8"
          title="-1時間"
          onClick={() => stepTimeMinutes(-60)}
        >
          <ChevronLeft className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
        </Button>

        <button
          type="button"
          onClick={() => togglePanel("time")}
          className={`flex items-center gap-1 rounded-full px-1.5 py-1 font-mono-num text-[11px] transition-colors sm:gap-1.5 sm:px-2.5 sm:text-xs ${
            openPanels.includes("time")
              ? "m3-tonal-active font-semibold"
              : "hover:bg-white/10"
          }`}
          title="日時設定"
        >
          <Clock className="h-3.5 w-3.5 text-[var(--accent-primary)]" />
          <span className="hidden sm:inline">{dateMd}</span>
          <span>{timeHm}</span>
        </button>

        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-7 w-7 sm:h-8 sm:w-8"
          title="+1時間"
          onClick={() => stepTimeMinutes(60)}
        >
          <ChevronRight className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
        </Button>

        <Button
          type="button"
          size="sm"
          variant="tonal"
          className="ml-0.5 h-7 px-2 text-[10.5px] font-semibold sm:px-2.5 sm:text-[11px]"
          onClick={setNow}
        >
          今
        </Button>

        {viewBadge && (
          <button
            type="button"
            onClick={() => togglePanel("display")}
            className="m3-tonal-active ml-1 hidden rounded-full px-2.5 py-1 text-[11px] font-semibold md:inline-flex"
          >
            {viewBadge}
          </button>
        )}
      </div>

      {isDesktopWindow && (
        <div
          data-tauri-drag-region
          onMouseDown={(e) => {
            if (e.button === 0 && e.detail === 1) {
              void getCurrentWindow().startDragging();
            }
          }}
          onDoubleClick={() => {
            void getCurrentWindow().toggleMaximize();
          }}
          className="pointer-events-auto h-9 min-w-4 flex-1 cursor-default select-none"
          title="ドラッグしてウィンドウ移動 / ダブルクリックで最大化"
        />
      )}

      {/* Right Capsule: Location + Projection + Search + Theme + Settings */}
      <div className="liquid-glass-pill pointer-events-auto flex min-w-0 items-center gap-0.5 px-1 py-1 sm:gap-1 sm:px-1.5">
        <button
          type="button"
          onClick={() => togglePanel("locations")}
          className={`flex min-w-0 items-center gap-1 rounded-full px-1.5 py-1 text-[11px] font-medium transition-colors sm:gap-1.5 sm:px-2.5 sm:py-1.5 sm:text-xs ${
            openPanels.includes("locations")
              ? "m3-tonal-active"
              : "hover:bg-white/10"
          }`}
          title={location.name_ja}
        >
          <MapPin className="h-3.5 w-3.5 shrink-0 text-[var(--accent-secondary)]" />
          <span className="max-w-[3.1rem] truncate sm:max-w-[9rem]">{shortLocation}</span>
        </button>

        <Button
          type="button"
          size="icon"
          variant={gpsLoading ? "tonal" : "ghost"}
          className="h-7 w-7 shrink-0 sm:h-8 sm:w-8"
          onClick={() => void acquireGpsLocation()}
          disabled={gpsLoading}
          title="GPSで現在地を取得"
        >
          <LocateFixed className={`h-3.5 w-3.5 sm:h-4 sm:w-4 ${gpsLoading ? "animate-pulse" : ""}`} />
        </Button>

        <Button
          type="button"
          size="icon"
          variant={gyroEnabled ? "tonal" : "ghost"}
          className="h-7 w-7 shrink-0 sm:h-8 sm:w-8"
          onClick={() => setGyroEnabled(!gyroEnabled)}
          title={gyroEnabled ? "ジャイロ連動を停止" : "ジャイロ・コンパスで向きを合わせる"}
        >
          <Compass className={`h-3.5 w-3.5 sm:h-4 sm:w-4 ${gyroEnabled ? "text-[var(--tonal-fg)]" : ""}`} />
        </Button>

        <select
          aria-label="図法選択"
          value={projectionMode}
          onChange={(e) => setProjectionMode(e.target.value as ProjectionMode)}
          className="hidden h-8 rounded-full bg-white/5 px-2.5 text-xs font-medium text-[var(--text-primary)] outline-none transition-colors hover:bg-white/10 sm:block"
        >
          {PROJECTION_META.map((m) => (
            <option
              key={m.mode}
              value={m.mode}
              className="bg-[#0b1120] text-[#f1f5f9]"
            >
              {m.shortJa}
            </option>
          ))}
        </select>

        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-7 w-7 shrink-0 sm:h-8 sm:w-8"
          onClick={() => setCommandPaletteOpen(true)}
          title="検索"
        >
          <Search className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
        </Button>

        <Button
          type="button"
          size="icon"
          variant={theme === "night-vision" ? "tonal" : "ghost"}
          className="h-7 w-7 shrink-0 sm:h-8 sm:w-8"
          onClick={toggleNightVision}
          title={theme === "night-vision" ? "ダークへ戻す" : "赤色暗順応"}
        >
          <ThemeIcon className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
        </Button>

        <Button
          type="button"
          size="icon"
          variant={openPanels.includes("settings") ? "tonal" : "ghost"}
          className="inline-flex h-7 w-7 shrink-0 sm:h-8 sm:w-8"
          onClick={() => togglePanel("settings")}
          title="環境設定"
        >
          <Settings className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
        </Button>
      </div>

      {isDesktopWindow && (
        <div className="liquid-glass-pill pointer-events-auto flex shrink-0 items-center gap-0.5 px-1.5 py-1">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-8 w-8 rounded-full"
            onClick={() => void getCurrentWindow().minimize()}
            title="最小化"
          >
            <Minus className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-8 w-8 rounded-full"
            onClick={() => void getCurrentWindow().toggleMaximize()}
            title={isMaximized ? "元に戻す" : "最大化"}
          >
            {isMaximized ? (
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                <rect x="2.5" y="4.5" width="7" height="7" rx="1.2" stroke="currentColor" strokeWidth="1.4" />
                <path
                  d="M5 4.5V3.7C5 3.04 5.54 2.5 6.2 2.5H10.3C10.96 2.5 11.5 3.04 11.5 3.7V7.8C11.5 8.46 10.96 9 10.3 9H9.5"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                />
              </svg>
            ) : (
              <Square className="h-3.5 w-3.5" />
            )}
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-8 w-8 rounded-full transition-colors hover:bg-rose-500/85 hover:text-white"
            onClick={() => void getCurrentWindow().close()}
            title="閉じる"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      )}
    </header>
  );
});
