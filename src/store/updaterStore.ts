import { getVersion } from "@tauri-apps/api/app";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { create } from "zustand";
import { useSkyStore } from "@/store/skyStore";

declare global {
  interface Window {
    StarCraneAndroidUpdater?: {
      canInstallPackages: () => boolean;
      installApk: (filePath: string) => string;
    };
  }
}

export type UpdaterStatus =
  | "idle"
  | "checking"
  | "downloading"
  | "ready"
  | "installing"
  | "up-to-date"
  | "error";

interface AndroidUpdateCheckResult {
  has_update: boolean;
  current_version: string;
  latest_version: string | null;
  release_notes: string | null;
  release_url: string | null;
  apk_name: string | null;
  apk_url: string | null;
  apk_size: number | null;
}

interface AndroidDownloadedApk {
  file_path: string;
  file_name: string;
  size_bytes: number;
}

interface AndroidDownloadProgress {
  downloaded_bytes: number;
  total_bytes: number | null;
  percent: number | null;
}

interface UpdaterState {
  status: UpdaterStatus;
  currentVersion: string;
  availableVersion: string | null;
  releaseNotes: string | null;
  progressPct: number | null;
  errorMessage: string | null;
  noticeMessage: string | null;
  dismissed: boolean;
  lastCheckedAt: number | null;
  initVersion: () => Promise<void>;
  checkAndAutoDownload: (manual?: boolean) => Promise<void>;
  installAndRestart: () => Promise<void>;
  dismissNotification: () => void;
}

let pendingUpdate: Update | null = null;
let pendingAndroidApkPath: string | null = null;
let checkInFlight = false;

function isVersionNewer(current: string, latest: string): boolean {
  const parse = (v: string) => {
    const clean = v.trim().replace(/^[vV]/, "").split(/[-+]/)[0] ?? "";
    const parts = clean.split(".").map((n) => Number.parseInt(n, 10));
    if (parts.length === 0 || parts.some((n) => !Number.isFinite(n))) return null;
    return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0] as const;
  };
  const a = parse(current);
  const b = parse(latest);
  if (!a || !b) return false;
  if (b[0] !== a[0]) return b[0] > a[0];
  if (b[1] !== a[1]) return b[1] > a[1];
  return b[2] > a[2];
}

export function isDesktopUpdaterSupported(): boolean {
  return (
    isTauri() &&
    typeof navigator !== "undefined" &&
    !/Android|iPhone|iPad/i.test(navigator.userAgent)
  );
}

export function isAndroidUpdaterSupported(): boolean {
  return (
    isTauri() &&
    typeof navigator !== "undefined" &&
    /Android/i.test(navigator.userAgent)
  );
}

export function isUpdaterSupported(): boolean {
  return isDesktopUpdaterSupported() || isAndroidUpdaterSupported();
}

export const useUpdaterStore = create<UpdaterState>((set, get) => ({
  status: "idle",
  currentVersion: "0.2.1",
  availableVersion: null,
  releaseNotes: null,
  progressPct: null,
  errorMessage: null,
  noticeMessage: null,
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
    if (!isUpdaterSupported() || checkInFlight) return;
    const offlineMode = useSkyStore.getState().offlineMode;
    if (offlineMode) {
      if (manual) {
        set({
          status: "error",
          errorMessage: "オフラインモードが有効なためアップデートを確認できません",
          noticeMessage: null,
        });
      }
      return;
    }

    const isAndroid = isAndroidUpdaterSupported();
    if (isAndroid) {
      if (get().status === "ready" && pendingAndroidApkPath) {
        if (manual) set({ dismissed: false });
        return;
      }
    } else if (get().status === "ready" && pendingUpdate) {
      if (manual) set({ dismissed: false });
      return;
    }

    checkInFlight = true;
    try {
      await get().initVersion();
      set({
        status: "checking",
        errorMessage: null,
        noticeMessage: null,
        progressPct: null,
      });

      if (isAndroid) {
        const res = await invoke<AndroidUpdateCheckResult>("check_android_update_cmd", {
          offlineMode,
        });
        const curVer = res.current_version || get().currentVersion;
        if (!res.has_update || !res.apk_url) {
          const hasTagWithoutApk =
            manual &&
            res.latest_version !== null &&
            isVersionNewer(curVer, res.latest_version) &&
            !res.apk_url;
          set({
            status: manual ? "up-to-date" : "idle",
            currentVersion: curVer,
            availableVersion: null,
            releaseNotes: null,
            progressPct: null,
            noticeMessage: hasTagWithoutApk
              ? `最新版 v${res.latest_version} は公開されていますが、Android用APKがまだ添付されていません。`
              : null,
            lastCheckedAt: Date.now(),
          });
          return;
        }

        set({
          status: "downloading",
          currentVersion: curVer,
          availableVersion: res.latest_version,
          releaseNotes: res.release_notes ?? null,
          progressPct: 0,
          noticeMessage: null,
          lastCheckedAt: Date.now(),
        });

        const unlisten = await listen<AndroidDownloadProgress>(
          "android-update-progress",
          (ev) => {
            if (typeof ev.payload.percent === "number") {
              set({ progressPct: ev.payload.percent });
            }
          },
        );
        try {
          const downloaded = await invoke<AndroidDownloadedApk>(
            "download_android_update_apk_cmd",
            {
              apkUrl: res.apk_url,
              apkName: res.apk_name ?? "StarCrane-update.apk",
              offlineMode,
            },
          );
          pendingAndroidApkPath = downloaded.file_path;
        } finally {
          unlisten();
        }

        set({
          status: "ready",
          progressPct: 100,
          dismissed: false,
          noticeMessage: null,
        });
        return;
      }

      const update = await check({ timeout: 15000 });
      if (!update) {
        set({
          status: manual ? "up-to-date" : "idle",
          availableVersion: null,
          releaseNotes: null,
          progressPct: null,
          noticeMessage: null,
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
        noticeMessage: null,
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
          noticeMessage: null,
          lastCheckedAt: Date.now(),
        });
      } else {
        // Stay silent in background if offline / release manifest not published yet
        set({ status: "idle", progressPct: null, noticeMessage: null });
      }
    } finally {
      checkInFlight = false;
    }
  },

  installAndRestart: async () => {
    if (get().status === "installing") return;

    if (isAndroidUpdaterSupported()) {
      if (!pendingAndroidApkPath) {
        set({
          status: "error",
          errorMessage: "ダウンロード済みAPKが見つかりません。もう一度確認してください。",
        });
        return;
      }
      const bridge = window.StarCraneAndroidUpdater;
      if (!bridge) {
        set({
          status: "error",
          errorMessage: "Androidインストーラー連携の初期化に失敗しました。",
        });
        return;
      }

      set({ status: "installing", errorMessage: null, noticeMessage: null });
      try {
        const res = bridge.installApk(pendingAndroidApkPath);
        if (res === "NEED_PERMISSION") {
          set({
            status: "ready",
            noticeMessage:
              "Androidの設定画面で「この提供元のアプリを許可」をオンにして戻った後、もう一度「今すぐインストールして更新」を押してください。",
          });
        } else if (res === "OK") {
          set({
            status: "ready",
            noticeMessage:
              "Androidのインストーラーを起動しました。画面の案内に従って更新してください。",
          });
        } else {
          set({
            status: "error",
            errorMessage: res.startsWith("ERR:") ? res.slice(4) : res,
          });
        }
      } catch (err) {
        set({
          status: "error",
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    if (!pendingUpdate) return;
    set({ status: "installing", errorMessage: null, noticeMessage: null });
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
