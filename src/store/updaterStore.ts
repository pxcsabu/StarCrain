import { getVersion } from "@tauri-apps/api/app";
import { isTauri } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { create } from "zustand";
import { useSkyStore } from "@/store/skyStore";

export type UpdaterStatus =
  | "idle"
  | "checking"
  | "downloading"
  | "ready"
  | "installing"
  | "up-to-date"
  | "error";

interface UpdaterState {
  status: UpdaterStatus;
  currentVersion: string;
  availableVersion: string | null;
  releaseNotes: string | null;
  progressPct: number | null;
  errorMessage: string | null;
  dismissed: boolean;
  lastCheckedAt: number | null;
  initVersion: () => Promise<void>;
  checkAndAutoDownload: (manual?: boolean) => Promise<void>;
  installAndRestart: () => Promise<void>;
  dismissNotification: () => void;
}

let pendingUpdate: Update | null = null;
let checkInFlight = false;

export function isDesktopUpdaterSupported(): boolean {
  return (
    isTauri() &&
    typeof navigator !== "undefined" &&
    !/Android|iPhone|iPad/i.test(navigator.userAgent)
  );
}

export const useUpdaterStore = create<UpdaterState>((set, get) => ({
  status: "idle",
  currentVersion: "0.1.0",
  availableVersion: null,
  releaseNotes: null,
  progressPct: null,
  errorMessage: null,
  dismissed: false,
  lastCheckedAt: null,

  initVersion: async () => {
    if (!isTauri()) return;
    try {
      const v = await getVersion();
      if (v) set({ currentVersion: v });
    } catch {
      // Fallback to default version string
    }
  },

  checkAndAutoDownload: async (manual = false) => {
    if (!isDesktopUpdaterSupported() || checkInFlight) return;
    if (!manual && useSkyStore.getState().offlineMode) return;
    if (get().status === "ready" && pendingUpdate) {
      if (manual) set({ dismissed: false });
      return;
    }

    checkInFlight = true;
    try {
      await get().initVersion();
      set({
        status: "checking",
        errorMessage: null,
        progressPct: null,
      });

      const update = await check({ timeout: 15000 });
      if (!update) {
        set({
          status: manual ? "up-to-date" : "idle",
          availableVersion: null,
          releaseNotes: null,
          progressPct: null,
          lastCheckedAt: Date.now(),
        });
        return;
      }

      if (pendingUpdate && pendingUpdate !== update) {
        await pendingUpdate.close().catch(() => {});
      }
      pendingUpdate = update;

      set({
        status: "downloading",
        availableVersion: update.version,
        releaseNotes: update.body ?? null,
        currentVersion: update.currentVersion || get().currentVersion,
        progressPct: 0,
        lastCheckedAt: Date.now(),
      });

      let contentLength = 0;
      let downloaded = 0;
      await update.download((ev) => {
        if (ev.event === "Started") {
          contentLength = ev.data.contentLength ?? 0;
          set({ progressPct: contentLength > 0 ? 0 : null });
        } else if (ev.event === "Progress") {
          downloaded += ev.data.chunkLength;
          if (contentLength > 0) {
            const pct = Math.min(99, Math.round((downloaded / contentLength) * 100));
            set({ progressPct: pct });
          }
        } else if (ev.event === "Finished") {
          set({ progressPct: 100 });
        }
      });

      set({
        status: "ready",
        progressPct: 100,
        dismissed: false,
      });
    } catch (err) {
      if (pendingUpdate) {
        await pendingUpdate.close().catch(() => {});
        pendingUpdate = null;
      }
      if (manual) {
        set({
          status: "error",
          errorMessage: err instanceof Error ? err.message : String(err),
          lastCheckedAt: Date.now(),
        });
      } else {
        // Stay silent in background if offline / release manifest not published yet
        set({ status: "idle", progressPct: null });
      }
    } finally {
      checkInFlight = false;
    }
  },

  installAndRestart: async () => {
    if (!pendingUpdate || get().status === "installing") return;
    set({ status: "installing", errorMessage: null });
    try {
      await pendingUpdate.install({ restartAfterInstall: true });
      await relaunch();
    } catch (err) {
      set({
        status: "error",
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  },

  dismissNotification: () => set({ dismissed: true }),
}));
