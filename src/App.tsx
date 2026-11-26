import { memo, useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Bell, RefreshCw, X } from "lucide-react";
import { SkyCanvas } from "@/components/canvas/SkyCanvas";
import { CommandPalette } from "@/components/layout/CommandPalette";
import { FloatingPanelWindow } from "@/components/layout/FloatingPanelWindow";
import {
  CompassSheet,
  DesktopNavigationRail,
  type DockOverlayMode,
  MobileBottomNav,
  ToolLauncherSheet,
} from "@/components/layout/LeftDock";
import { TimelineBar } from "@/components/layout/TimelineBar";
import { TopBar } from "@/components/layout/TopBar";
import { useKeyboardShortcuts } from "@/components/layout/useKeyboardShortcuts";
import { AstroCalculator } from "@/components/panels/AstroCalculator";
import { AltitudePlanner } from "@/components/panels/AltitudePlanner";
import { ClockTimer } from "@/components/panels/ClockTimer";
import { CometSatManager } from "@/components/panels/CometSatManager";
import { DisplaySettings } from "@/components/panels/DisplaySettings";
import { EclipseFinder } from "@/components/panels/EclipseFinder";
import { Encyclopedia } from "@/components/panels/Encyclopedia";
import { FovOverlayPanel } from "@/components/panels/FovOverlayPanel";
import { LocationManager } from "@/components/panels/LocationManager";
import { MeteorShowers } from "@/components/panels/MeteorShowers";
import { MoonCalendar } from "@/components/panels/MoonCalendar";
import { ObjectInspector } from "@/components/panels/ObjectInspector";
import { ObservationData } from "@/components/panels/ObservationData";
import { PlanetTools } from "@/components/panels/PlanetTools";
import { PrintExport } from "@/components/panels/PrintExport";
import { SearchDialog } from "@/components/panels/SearchDialog";
import { SettingsPanel } from "@/components/panels/SettingsPanel";
import { SimulationControl } from "@/components/panels/SimulationControl";
import { TimeControl } from "@/components/panels/TimeControl";
import { VariableStars } from "@/components/panels/VariableStars";
import { IssEarthView } from "@/components/solar3d/IssEarthView";
import { Planet3DViewerModal } from "@/components/solar3d/Planet3DViewerModal";
import { SolarSystem3D } from "@/components/solar3d/SolarSystem3D";
import { useClockStore } from "@/store/clockStore";
import { useSkyStore } from "@/store/skyStore";
import { useThemeStore } from "@/store/themeStore";
import {
  findChangelogEntry,
  normalizeVersionString,
  parseReleaseNotesLines,
} from "@/lib/changelog";
import {
  isAndroidUpdaterSupported,
  isUpdaterSupported,
  useUpdaterStore,
} from "@/store/updaterStore";
import type { ActivePanelId } from "@/types/sky";

function renderPanelBody(id: Exclude<ActivePanelId, null>) {
  switch (id) {
    case "observation":
      return <ObservationData />;
    case "moon_calendar":
      return <MoonCalendar />;
    case "meteors":
      return <MeteorShowers />;
    case "planets":
      return <PlanetTools />;
    case "solar3d":
      return <SolarSystem3D />;
    case "iss_view":
      return <IssEarthView />;
    case "eclipses":
      return <EclipseFinder />;
    case "comets":
      return <CometSatManager />;
    case "fov":
      return <FovOverlayPanel />;
    case "print":
      return <PrintExport />;
    case "altitude_graph":
      return <AltitudePlanner />;
    case "variables":
      return <VariableStars />;
    case "encyclopedia":
      return <Encyclopedia />;
    case "calculator":
      return <AstroCalculator />;
    case "clock":
      return <ClockTimer />;
    case "display":
      return <DisplaySettings />;
    case "time":
      return <TimeControl />;
    case "simulation":
      return <SimulationControl />;
    case "locations":
      return <LocationManager />;
    case "search":
      return <SearchDialog />;
    case "settings":
      return <SettingsPanel />;
  }
}

const MemoPanelBody = memo(function MemoPanelBody({
  id,
}: {
  id: Exclude<ActivePanelId, null>;
}) {
  return renderPanelBody(id);
});

const MemoObjectInspector = memo(function MemoObjectInspector() {
  return <ObjectInspector />;
});

const WINDOW_RESIZE_HANDLES: {
  direction:
    | "North"
    | "South"
    | "East"
    | "West"
    | "NorthWest"
    | "NorthEast"
    | "SouthWest"
    | "SouthEast";
  className: string;
}[] = [
  { direction: "North", className: "top-0 inset-x-2.5 h-1 cursor-ns-resize" },
  { direction: "South", className: "bottom-0 inset-x-2.5 h-1 cursor-ns-resize" },
  { direction: "West", className: "left-0 inset-y-2.5 w-1 cursor-ew-resize" },
  { direction: "East", className: "right-0 inset-y-2.5 w-1 cursor-ew-resize" },
  { direction: "NorthWest", className: "top-0 left-0 h-2.5 w-2.5 cursor-nwse-resize" },
  { direction: "NorthEast", className: "top-0 right-0 h-2.5 w-2.5 cursor-nesw-resize" },
  { direction: "SouthWest", className: "bottom-0 left-0 h-2.5 w-2.5 cursor-nesw-resize" },
  { direction: "SouthEast", className: "bottom-0 right-0 h-2.5 w-2.5 cursor-nwse-resize" },
];

export function App() {
  const initSky = useSkyStore((s) => s.initSky);
  const activePanel = useSkyStore((s) => s.activePanel);
  const openPanels = useSkyStore((s) => s.openPanels);
  const selectedObject = useSkyStore((s) => s.selectedObject);
  const simPlaying = useSkyStore((s) => s.simPlaying);
  const autoRunRealtime = useSkyStore((s) => s.autoRunRealtime);
  const showSatellites = useSkyStore((s) => s.showSatellites);
  const focusPanel = useSkyStore((s) => s.focusPanel);
  const closeAllPanels = useSkyStore((s) => s.closeAllPanels);
  const clearSelection = useSkyStore((s) => s.clearSelection);
  const theme = useThemeStore((s) => s.theme);
  const timerRunning = useClockStore((s) => s.timerRunning);
  const hourlyChime = useClockStore((s) => s.hourlyChime);
  const alarms = useClockStore((s) => s.alarms);
  const activeAlert = useClockStore((s) => s.activeAlert);
  const dismissAlert = useClockStore((s) => s.dismissAlert);

  const updaterStatus = useUpdaterStore((s) => s.status);
  const updaterCurrentVersion = useUpdaterStore((s) => s.currentVersion);
  const updaterVersion = useUpdaterStore((s) => s.availableVersion);
  const updaterNotes = useUpdaterStore((s) => s.releaseNotes);
  const updaterDismissed = useUpdaterStore((s) => s.dismissed);
  const updaterError = useUpdaterStore((s) => s.errorMessage);
  const updaterNotice = useUpdaterStore((s) => s.noticeMessage);
  const installAndRestart = useUpdaterStore((s) => s.installAndRestart);
  const dismissUpdateNotification = useUpdaterStore((s) => s.dismissNotification);
  const updaterSupported = isUpdaterSupported();
  const androidUpdater = isAndroidUpdaterSupported();
  const [postUpdateVersion, setPostUpdateVersion] = useState<string | null>(null);

  const [dockOverlay, setDockOverlay] = useState<DockOverlayMode>(null);
  const [inspectorOnTop, setInspectorOnTop] = useState(true);
  const [exitingPanels, setExitingPanels] = useState<Exclude<ActivePanelId, null>[]>([]);
  const prevOpenPanelsRef = useRef<Exclude<ActivePanelId, null>[]>(openPanels);
  const exitTimersRef = useRef<Map<string, number>>(new Map());
  const [inspectorMounted, setInspectorMounted] = useState(() => selectedObject !== null);
  const [inspectorClosing, setInspectorClosing] = useState(false);
  const inspectorTimerRef = useRef<number | null>(null);
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

  useKeyboardShortcuts();

  useEffect(() => {
    void initSky();
  }, [initSky]);

  useEffect(() => {
    void useSkyStore.getState().refreshFrame(theme === "night-vision");
  }, [theme]);

  useEffect(() => {
    if (selectedObject) {
      setInspectorOnTop(true);
      if (inspectorTimerRef.current !== null) {
        window.clearTimeout(inspectorTimerRef.current);
        inspectorTimerRef.current = null;
      }
      setInspectorMounted(true);
      setInspectorClosing(false);
    } else if (inspectorMounted) {
      setInspectorClosing(true);
      if (inspectorTimerRef.current !== null) {
        window.clearTimeout(inspectorTimerRef.current);
      }
      inspectorTimerRef.current = window.setTimeout(() => {
        setInspectorMounted(false);
        setInspectorClosing(false);
        inspectorTimerRef.current = null;
      }, 145);
    }
  }, [selectedObject, inspectorMounted]);

  useEffect(() => {
    const prev = prevOpenPanelsRef.current;
    prevOpenPanelsRef.current = openPanels;

    for (const id of openPanels) {
      const pending = exitTimersRef.current.get(id);
      if (pending !== undefined) {
        window.clearTimeout(pending);
        exitTimersRef.current.delete(id);
      }
    }

    const removed = prev.filter((id) => !openPanels.includes(id));
    if (removed.length > 0) {
      setExitingPanels((cur) => Array.from(new Set([...cur, ...removed])));
      for (const id of removed) {
        const prevTimer = exitTimersRef.current.get(id);
        if (prevTimer !== undefined) {
          window.clearTimeout(prevTimer);
        }
        const timerId = window.setTimeout(() => {
          exitTimersRef.current.delete(id);
          setExitingPanels((cur) => cur.filter((x) => x !== id));
        }, 145);
        exitTimersRef.current.set(id, timerId);
      }
    } else {
      setExitingPanels((cur) => cur.filter((x) => !openPanels.includes(x)));
    }
  }, [openPanels]);

  useEffect(() => {
    return () => {
      if (inspectorTimerRef.current !== null) {
        window.clearTimeout(inspectorTimerRef.current);
      }
      for (const timerId of exitTimersRef.current.values()) {
        window.clearTimeout(timerId);
      }
      exitTimersRef.current.clear();
    };
  }, []);

  useEffect(() => {
    if (!simPlaying) return;
    const timer = window.setInterval(() => {
      const st = useSkyStore.getState();
      if (st.simTarget === "viewpoint") return;
      void st.advanceSimulationTick();
    }, 55);
    return () => window.clearInterval(timer);
  }, [simPlaying]);

  useEffect(() => {
    if (!autoRunRealtime) return;
    const timer = window.setInterval(() => {
      useSkyStore.getState().setNow();
    }, 1000);
    return () => window.clearInterval(timer);
  }, [autoRunRealtime]);

  const cometsOpen = openPanels.includes("comets");
  useEffect(() => {
    if (!showSatellites || autoRunRealtime || !cometsOpen) return;
    const timer = window.setInterval(() => {
      void useSkyStore.getState().refreshSatellites();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [showSatellites, autoRunRealtime, cometsOpen]);

  const clockEngineActive =
    timerRunning || hourlyChime !== "off" || alarms.some((a) => a.enabled);

  useEffect(() => {
    if (!clockEngineActive) return;
    const id = window.setInterval(() => {
      useClockStore.getState().tickClockEngine(Date.now());
    }, 250);
    return () => window.clearInterval(id);
  }, [clockEngineActive]);

  useEffect(() => {
    if (!updaterSupported) return;
    let active = true;
    void useUpdaterStore
      .getState()
      .initVersion()
      .then(() => {
        if (!active || typeof window === "undefined") return;
        const ver = normalizeVersionString(useUpdaterStore.getState().currentVersion);
        if (!ver) return;
        const lastSeen = window.localStorage.getItem("starcrane-last-seen-version");
        if (!lastSeen) {
          window.localStorage.setItem("starcrane-last-seen-version", ver);
        } else if (lastSeen !== ver && findChangelogEntry(ver)) {
          setPostUpdateVersion(ver);
        } else {
          window.localStorage.setItem("starcrane-last-seen-version", ver);
        }
      });
    const initialTimer = window.setTimeout(() => {
      void useUpdaterStore.getState().checkAndAutoDownload(false);
    }, 3000);
    const periodicTimer = window.setInterval(() => {
      void useUpdaterStore.getState().checkAndAutoDownload(false);
    }, 4 * 60 * 60 * 1000);
    return () => {
      active = false;
      window.clearTimeout(initialTimer);
      window.clearInterval(periodicTimer);
    };
  }, [updaterSupported]);

  const hasMobileSheet = dockOverlay !== null || activePanel !== null || selectedObject !== null;

  const dismissMobileSheets = () => {
    setDockOverlay(null);
    closeAllPanels();
    clearSelection();
  };

  const handleFocusFloatingPanel = useCallback(
    (panelId: string) => {
      if (panelId === "__inspector__") {
        setInspectorOnTop(true);
        return;
      }
      focusPanel(panelId as Exclude<ActivePanelId, null>);
      setInspectorOnTop(false);
    },
    [focusPanel],
  );

  const defaultInspectorX =
    typeof window !== "undefined" ? Math.max(96, window.innerWidth - 368) : 900;
  const floatingCount = openPanels.length + (selectedObject ? 1 : 0);
  const renderedPanels = [
    ...openPanels,
    ...exitingPanels.filter((id) => !openPanels.includes(id)),
  ];

  return (
    <main
      className={`relative h-[100dvh] w-screen overflow-hidden bg-[var(--bg-canvas)] text-[var(--text-primary)] ${
        isDesktopWindow && !isMaximized ? "ring-1 ring-inset ring-white/10" : ""
      }`}
    >
      <SkyCanvas />

      {/* Desktop / Tablet Free-Floating Multi-Window Layer */}
      <div className="pointer-events-none fixed inset-0 z-20 hidden sm:block">
        {renderedPanels.map((panelId, idx) => {
          const isExiting = !openPanels.includes(panelId);
          const isTopPanel =
            !isExiting &&
            idx === openPanels.length - 1 &&
            (!selectedObject || !inspectorOnTop);
          return (
            <FloatingPanelWindow
              key={panelId}
              id={panelId}
              zIndex={isExiting ? 1 : 2 + idx}
              defaultX={96 + (idx % 5) * 34}
              defaultY={72 + (idx % 5) * 28}
              isFocused={isTopPanel}
              openCount={floatingCount}
              closing={isExiting}
              onFocusPanel={handleFocusFloatingPanel}
            >
              <MemoPanelBody id={panelId} />
            </FloatingPanelWindow>
          );
        })}

        {inspectorMounted && (
          <FloatingPanelWindow
            key="__inspector__"
            id="__inspector__"
            zIndex={inspectorOnTop ? 2 + openPanels.length : 1}
            defaultX={defaultInspectorX}
            defaultY={72}
            isFocused={!inspectorClosing && (inspectorOnTop || openPanels.length === 0)}
            openCount={floatingCount}
            closing={inspectorClosing}
            onFocusPanel={handleFocusFloatingPanel}
          >
            <MemoObjectInspector />
          </FloatingPanelWindow>
        )}
      </div>

      {/* Main Chrome & Mobile Sheet Stage */}
      <div className="pointer-events-none absolute inset-0 z-40 flex flex-col justify-between gap-2 pl-[max(0.625rem,env(safe-area-inset-left))] pr-[max(0.625rem,env(safe-area-inset-right))] pt-[max(0.625rem,env(safe-area-inset-top))] pb-[max(0.625rem,env(safe-area-inset-bottom))] sm:pl-[max(0.75rem,env(safe-area-inset-left))] sm:pr-[max(0.75rem,env(safe-area-inset-right))] sm:pt-[max(0.75rem,env(safe-area-inset-top))] sm:pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <TopBar />

        <div className="relative flex min-h-0 flex-1 flex-col justify-end sm:flex-row sm:items-start sm:justify-between sm:gap-3">
          {hasMobileSheet && (
            <button
              type="button"
              aria-label="閉じる"
              onClick={dismissMobileSheets}
              className="starcrane-fade-enter pointer-events-auto fixed inset-0 z-0 bg-black/45 backdrop-blur-md sm:hidden"
              style={{ WebkitBackdropFilter: "blur(12px)" }}
            />
          )}

          <div className="relative z-10 flex w-full flex-col items-stretch gap-2 sm:h-full sm:w-auto sm:min-h-0 sm:flex-row sm:items-start sm:gap-2.5">
            <DesktopNavigationRail overlay={dockOverlay} setOverlay={setDockOverlay} />

            {/* Mobile Tool / Compass / Active Sheet */}
            {dockOverlay === "tools" && (
              <div className="starcrane-sheet-enter sm:hidden">
                <ToolLauncherSheet onClose={() => setDockOverlay(null)} />
              </div>
            )}
            {dockOverlay === "compass" && (
              <div className="starcrane-sheet-enter sm:hidden">
                <CompassSheet onClose={() => setDockOverlay(null)} />
              </div>
            )}

            {activePanel !== null && dockOverlay === null && (
              <div className="starcrane-sheet-enter starcrane-panel-host pointer-events-auto w-full sm:hidden">
                {renderPanelBody(activePanel)}
              </div>
            )}
          </div>

          {selectedObject && dockOverlay === null && activePanel === null && (
            <div className="starcrane-sheet-enter starcrane-panel-host pointer-events-auto relative z-10 w-full sm:hidden">
              <ObjectInspector />
            </div>
          )}
        </div>

        <TimelineBar />
        <MobileBottomNav overlay={dockOverlay} setOverlay={setDockOverlay} />
      </div>

      <Planet3DViewerModal />
      <CommandPalette />

      {(activeAlert ||
        postUpdateVersion ||
        (updaterStatus === "ready" && !updaterDismissed) ||
        updaterStatus === "installing") && (
        <div className="fixed top-16 right-3 left-3 sm:left-auto sm:right-4 z-50 flex sm:max-w-sm flex-col gap-2">
          {((updaterStatus === "ready" && !updaterDismissed) || updaterStatus === "installing") && (() => {
            const notesList = parseReleaseNotesLines(updaterNotes, updaterVersion);
            return (
              <div className="starcrane-win-enter liquid-glass-sheet flex items-start gap-2.5 px-3.5 py-2.5 text-xs text-[var(--text-primary)]">
                <RefreshCw
                  className={`mt-0.5 h-4 w-4 shrink-0 text-[var(--accent-primary)] ${
                    updaterStatus === "installing" ? "animate-spin" : ""
                  }`}
                />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="font-semibold">
                    {updaterStatus === "installing"
                      ? `StarCrane v${updaterVersion} を適用中...`
                      : `アップデート v${updaterVersion} の準備完了`}
                  </div>
                  <div className="text-[11px] text-[var(--text-secondary)]">
                    {updaterStatus === "installing"
                      ? androidUpdater
                        ? "Androidのインストーラーを起動しています。"
                        : "インストーラーを起動して自動再起動します。"
                      : androidUpdater
                        ? "最新APKのダウンロードが完了しました。タップしてインストーラーを起動します。"
                        : "バックグラウンドでダウンロードが完了しました。再起動すると最新版が反映されます。"}
                  </div>
                  {notesList.length > 0 && (
                    <div className="max-h-36 overflow-y-auto rounded-lg border border-white/10 bg-black/35 px-2.5 py-1.5 text-[10.5px]">
                      <div className="mb-1 font-semibold text-[var(--accent-primary)]">
                        v{updaterVersion} チェンジリスト
                      </div>
                      <ul className="list-disc space-y-0.5 pl-4 text-[var(--text-secondary)]">
                        {notesList.map((line, i) => (
                          <li key={i}>{line}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {updaterNotice && (
                    <div className="text-[10.5px] text-amber-300">{updaterNotice}</div>
                  )}
                  {updaterError && (
                    <div className="text-[10.5px] text-[var(--status-danger)]">{updaterError}</div>
                  )}
                  {updaterStatus === "ready" && (
                    <div className="flex items-center gap-1.5 pt-0.5">
                      <button
                        type="button"
                        onClick={() => void installAndRestart()}
                        className="rounded-full bg-[var(--accent-primary)] px-3 py-1 text-[11px] font-semibold text-[var(--accent-primary-fg)] transition-opacity hover:opacity-90"
                      >
                        {androidUpdater ? "今すぐインストールして更新" : "今すぐ再起動して更新"}
                      </button>
                      <button
                        type="button"
                        onClick={dismissUpdateNotification}
                        className="rounded-full px-2.5 py-1 text-[11px] text-[var(--text-secondary)] hover:bg-white/10 hover:text-[var(--text-primary)]"
                      >
                        あとで
                      </button>
                    </div>
                  )}
                </div>
                {updaterStatus === "ready" && (
                  <button
                    type="button"
                    onClick={dismissUpdateNotification}
                    className="rounded-full p-1 text-[var(--text-muted)] hover:bg-white/10 hover:text-[var(--text-primary)]"
                    title="閉じる"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            );
          })()}

          {postUpdateVersion && (() => {
            const entry = findChangelogEntry(postUpdateVersion);
            if (!entry) return null;
            const dismissPostUpdate = () => {
              if (typeof window !== "undefined") {
                window.localStorage.setItem(
                  "starcrane-last-seen-version",
                  normalizeVersionString(updaterCurrentVersion) || postUpdateVersion,
                );
              }
              setPostUpdateVersion(null);
            };
            return (
              <div className="starcrane-win-enter liquid-glass-sheet flex items-start gap-2.5 px-3.5 py-2.5 text-xs text-[var(--text-primary)]">
                <RefreshCw className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="font-semibold">
                    StarCrane v{entry.version} に更新されました
                  </div>
                  <div className="text-[10.5px] font-medium text-[var(--accent-primary)]">
                    {entry.title}
                  </div>
                  <ul className="max-h-32 list-disc space-y-0.5 overflow-y-auto pl-4 text-[10.5px] text-[var(--text-secondary)]">
                    {entry.items.map((item, i) => (
                      <li key={i}>{item}</li>
                    ))}
                  </ul>
                  <div className="pt-0.5">
                    <button
                      type="button"
                      onClick={dismissPostUpdate}
                      className="rounded-full bg-white/10 px-3 py-1 text-[11px] font-medium hover:bg-white/20"
                    >
                      OK
                    </button>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={dismissPostUpdate}
                  className="rounded-full p-1 text-[var(--text-muted)] hover:bg-white/10 hover:text-[var(--text-primary)]"
                  title="閉じる"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })()}

          {activeAlert && (
            <div className="starcrane-win-enter liquid-glass-sheet flex items-start gap-2.5 px-3.5 py-2.5 text-xs text-[var(--text-primary)]">
              <Bell className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent-secondary)]" />
              <div className="min-w-0 flex-1">
                <div className="font-semibold">{activeAlert.title}</div>
                <div className="mt-0.5 text-[11px] text-[var(--text-secondary)]">{activeAlert.message}</div>
              </div>
              <button
                type="button"
                onClick={dismissAlert}
                className="rounded-full p-1 text-[var(--text-muted)] hover:bg-white/10 hover:text-[var(--text-primary)]"
                title="閉じる"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </div>
      )}
      {isDesktopWindow &&
        !isMaximized &&
        WINDOW_RESIZE_HANDLES.map((h) => (
          <div
            key={h.direction}
            role="presentation"
            onPointerDown={(e) => {
              if (e.pointerType === "mouse" && e.button !== 0) return;
              e.preventDefault();
              void getCurrentWindow().startResizeDragging(h.direction);
            }}
            style={{ touchAction: "none" }}
            className={`fixed z-50 ${h.className}`}
          />
        ))}
    </main>
  );
}

export default App;
