import { useEffect } from "react";
import { useSkyStore } from "@/store/skyStore";
import { useThemeStore } from "@/store/themeStore";

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

export function useKeyboardShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const s = useSkyStore.getState();

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        s.setCommandPaletteOpen(!s.commandPaletteOpen);
        return;
      }

      if (e.key === "Escape") {
        if (s.commandPaletteOpen) {
          s.setCommandPaletteOpen(false);
        } else if (s.activePanel !== null) {
          s.setActivePanel(null);
        } else if (s.selectedObject) {
          s.clearSelection();
        }
        return;
      }

      if (s.commandPaletteOpen || isTypingTarget(e.target)) {
        return;
      }

      switch (e.key) {
        case " ":
          e.preventDefault();
          s.toggleSimPlaying();
          break;
        case "r":
        case "R": {
          e.preventDefault();
          const curTheme = useThemeStore.getState().theme;
          const next = curTheme === "night-vision" ? "dark" : "night-vision";
          useThemeStore.getState().setTheme(next);
          void s.refreshFrame(next === "night-vision");
          break;
        }
        case "c":
        case "C":
          s.setConstellationLineMode(s.layers.constellationLines === "off" ? "standard" : "off");
          break;
        case "l":
        case "L": {
          const on = !s.layers.constellationNames;
          useSkyStore.setState((prev) => ({
            layers: {
              ...prev.layers,
              constellationNames: on,
              starNames: on,
              planetNames: on,
              dsoNames: on,
            },
          }));
          break;
        }
        case "g":
        case "G": {
          const on = !s.layers.equatorialGrid;
          useSkyStore.setState((prev) => ({
            layers: {
              ...prev.layers,
              equatorialGrid: on,
              horizontalGrid: on,
            },
          }));
          break;
        }
        case "[":
          s.stepTimeMinutes(-Math.abs(s.simStepMinutes));
          break;
        case "]":
          s.stepTimeMinutes(Math.abs(s.simStepMinutes));
          break;
        case "+":
        case "=":
          s.zoomBy(1.25);
          break;
        case "-":
          s.zoomBy(1 / 1.25);
          break;
        default:
          break;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
