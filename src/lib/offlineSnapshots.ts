import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  clearHipsMemoryCache,
  collectAllSkyHipsTiles,
  collectRegionHipsTiles,
} from "@/lib/hipsSurvey";
import {
  effectiveFovDeg,
  horizontalToEquatorialFast,
  raDecToVec3,
} from "@/lib/projection";
import { useSkyStore } from "@/store/skyStore";
import type {
  HipsSurveyId,
  OfflineCacheStats,
  OfflineObservationSnapshot,
  OfflineSnapshotMeta,
  PrefetchHipsResult,
  SnapshotBodyEntry,
  SnapshotBookmark,
} from "@/types/sky";

const BROWSER_SNAPSHOT_KEY = "starcrane-offline-snapshots-v1";

export function formatBytesCompact(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export async function getOfflineCacheStats(): Promise<OfflineCacheStats> {
  if (!isTauri()) {
    const list = loadBrowserSnapshots();
    return {
      hips_tile_count: 0,
      hips_bytes: 0,
      photo_count: 0,
      photo_bytes: 0,
      snapshot_count: list.length,
      snapshot_bytes: JSON.stringify(list).length,
      total_bytes: JSON.stringify(list).length,
      surveys: [],
    };
  }
  return invoke<OfflineCacheStats>("get_offline_cache_stats_cmd");
}

export async function clearOfflineCacheTarget(
  target: "hips" | "photos" | "all_images" | "snapshots",
): Promise<OfflineCacheStats> {
  if (target === "hips" || target === "all_images") {
    clearHipsMemoryCache();
  }
  if (!isTauri()) {
    if (target === "snapshots") {
      window.localStorage.removeItem(BROWSER_SNAPSHOT_KEY);
    }
    return getOfflineCacheStats();
  }
  return invoke<OfflineCacheStats>("clear_offline_cache_cmd", { target });
}

export async function prefetchHipsTileBatches(
  surveyId: HipsSurveyId,
  tiles: [number, number][],
  offlineMode: boolean,
  onProgress?: (done: number, total: number, summary: PrefetchHipsResult) => void,
): Promise<PrefetchHipsResult> {
  if (!isTauri()) {
    throw new Error("ローカルディスク保存はデスクトップ / Android アプリ版で利用できます。");
  }
  const agg: PrefetchHipsResult = {
    survey_id: surveyId,
    requested: tiles.length,
    already_cached: 0,
    downloaded: 0,
    failed: 0,
    bytes_added: 0,
  };
  const chunkSize = 36;
  let processed = 0;
  for (let i = 0; i < tiles.length; i += chunkSize) {
    const chunk = tiles.slice(i, i + chunkSize);
    const res = await invoke<PrefetchHipsResult>("prefetch_hips_tiles_cmd", {
      surveyId,
      tiles: chunk,
      offlineMode,
    });
    agg.already_cached += res.already_cached;
    agg.downloaded += res.downloaded;
    agg.failed += res.failed;
    agg.bytes_added += res.bytes_added;
    processed += chunk.length;
    onProgress?.(processed, tiles.length, { ...agg });
  }
  return agg;
}

export async function prefetchAllSkyHipsPack(
  surveyId: HipsSurveyId,
  offlineMode: boolean,
  onProgress?: (done: number, total: number, summary: PrefetchHipsResult) => void,
): Promise<PrefetchHipsResult> {
  const tiles = collectAllSkyHipsTiles(2); // Order 0..2 = 252 all-sky base tiles
  return prefetchHipsTileBatches(surveyId, tiles, offlineMode, onProgress);
}

export async function prefetchCurrentViewHips(
  surveyId: HipsSurveyId,
  offlineMode: boolean,
  onProgress?: (done: number, total: number, summary: PrefetchHipsResult) => void,
): Promise<PrefetchHipsResult> {
  const st = useSkyStore.getState();
  let appRa = st.centerRaDeg;
  let appDec = st.centerDecDeg;
  if (st.projectionMode !== "star_chart" && st.skyFrame) {
    const eq = horizontalToEquatorialFast(
      st.centerAzDeg,
      st.centerAltDeg,
      st.location.lat_deg,
      st.skyFrame.last_deg,
    );
    appRa = eq.raDeg;
    appDec = eq.decDeg;
  }
  const [ax, ay, az] = raDecToVec3(appRa, appDec);
  let jx = ax;
  let jy = ay;
  let jz = az;
  if (st.skyFrame?.j2000_to_apparent_matrix) {
    const m = st.skyFrame.j2000_to_apparent_matrix;
    jx = m[0][0] * ax + m[1][0] * ay + m[2][0] * az;
    jy = m[0][1] * ax + m[1][1] * ay + m[2][1] * az;
    jz = m[0][2] * ax + m[1][2] * ay + m[2][2] * az;
  }
  const effFov = effectiveFovDeg(st.projectionMode, st.fovDeg) / Math.max(0.5, st.zoom);
  const halfConeRad = (Math.max(8, Math.min(35, effFov * 0.7)) * Math.PI) / 180;
  const tiles = collectRegionHipsTiles([jx, jy, jz], halfConeRad, 2, 5, 180);
  return prefetchHipsTileBatches(surveyId, tiles, offlineMode, onProgress);
}

function loadBrowserSnapshots(): OfflineObservationSnapshot[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(BROWSER_SNAPSHOT_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function buildCurrentObservationSnapshot(
  title: string,
  note: string,
): OfflineObservationSnapshot {
  const st = useSkyStore.getState();
  const bodies: SnapshotBodyEntry[] = (st.skyFrame?.bodies ?? []).map((b) => ({
    id: b.id,
    kind: b.kind,
    name_ja: b.name_ja,
    name_en: b.name_en,
    ra_deg: b.ra_deg,
    dec_deg: b.dec_deg,
    az_deg: b.az_deg,
    alt_deg: b.alt_deg,
    mag: Number.isFinite(b.visual_magnitude) ? b.visual_magnitude : null,
    extra:
      b.angular_diameter_arcsec > 0.5
        ? `視直径 ${b.angular_diameter_arcsec.toFixed(1)}″`
        : "",
  }));

  for (const sat of st.satellites.slice(0, 24)) {
    bodies.push({
      id: `sat:${sat.norad_id}`,
      kind: "satellite",
      name_ja: sat.name,
      name_en: sat.name,
      ra_deg: sat.ra_deg,
      dec_deg: sat.dec_deg,
      az_deg: sat.az_deg,
      alt_deg: sat.alt_deg,
      mag: null,
      extra: `${Math.round(sat.range_km)} km / ${sat.is_sunlit ? "日照" : "地球影"}`,
    });
  }

  const bookmarks: SnapshotBookmark[] = [];
  if (st.selectedObject) {
    bookmarks.push({
      id: st.selectedObject.id,
      kind: st.selectedObject.kind,
      name_ja: st.selectedObject.name_ja,
      ra_deg: st.selectedObject.ra_deg,
      dec_deg: st.selectedObject.dec_deg,
      mag: st.selectedObject.mag,
      note: st.selectedObject.extra_info,
    });
  }
  for (const tgt of st.altitudeTargets) {
    if (!bookmarks.some((b) => b.id === tgt.id)) {
      bookmarks.push({
        id: tgt.id,
        kind: tgt.kind,
        name_ja: tgt.nameJa,
        ra_deg: tgt.raDeg,
        dec_deg: tgt.decDeg,
        mag: null,
        note: "高度グラフ観測対象",
      });
    }
  }

  const cleanTitle = title.trim() || `${st.location.name_ja} 観測記録`;
  const id = `snap_${Date.now()}`;
  return {
    id,
    title: cleanTitle,
    created_at_iso: new Date().toISOString(),
    note: note.trim(),
    jd_ut: st.jdUt,
    location: st.location,
    view: {
      projectionMode: st.projectionMode,
      centerAzDeg: st.centerAzDeg,
      centerAltDeg: st.centerAltDeg,
      centerRaDeg: st.centerRaDeg,
      centerDecDeg: st.centerDecDeg,
      fovDeg: st.fovDeg,
      zoom: st.zoom,
    },
    bodies,
    bookmarks,
  };
}

export async function saveOfflineSnapshot(
  snapshot: OfflineObservationSnapshot,
): Promise<OfflineSnapshotMeta> {
  if (!isTauri()) {
    const existing = loadBrowserSnapshots().filter((s) => s.id !== snapshot.id);
    existing.unshift(snapshot);
    window.localStorage.setItem(BROWSER_SNAPSHOT_KEY, JSON.stringify(existing.slice(0, 30)));
    return {
      id: snapshot.id,
      title: snapshot.title,
      created_at_iso: snapshot.created_at_iso,
      note: snapshot.note,
      jd_ut: snapshot.jd_ut,
      location_name: snapshot.location.name_ja,
      body_count: snapshot.bodies.length,
      bookmark_count: snapshot.bookmarks.length,
    };
  }
  return invoke<OfflineSnapshotMeta>("save_offline_snapshot_cmd", { snapshot });
}

export async function listOfflineSnapshots(): Promise<OfflineSnapshotMeta[]> {
  if (!isTauri()) {
    return loadBrowserSnapshots().map((s) => ({
      id: s.id,
      title: s.title,
      created_at_iso: s.created_at_iso,
      note: s.note,
      jd_ut: s.jd_ut,
      location_name: s.location.name_ja,
      body_count: s.bodies.length,
      bookmark_count: s.bookmarks.length,
    }));
  }
  return invoke<OfflineSnapshotMeta[]>("list_offline_snapshots_cmd");
}

export async function loadOfflineSnapshot(id: string): Promise<OfflineObservationSnapshot> {
  if (!isTauri()) {
    const found = loadBrowserSnapshots().find((s) => s.id === id);
    if (!found) throw new Error("スナップショットが見つかりません");
    return found;
  }
  return invoke<OfflineObservationSnapshot>("load_offline_snapshot_cmd", { id });
}

export async function deleteOfflineSnapshot(id: string): Promise<void> {
  if (!isTauri()) {
    const next = loadBrowserSnapshots().filter((s) => s.id !== id);
    window.localStorage.setItem(BROWSER_SNAPSHOT_KEY, JSON.stringify(next));
    return;
  }
  await invoke("delete_offline_snapshot_cmd", { id });
}

export function restoreOfflineSnapshotToStore(snap: OfflineObservationSnapshot): void {
  const st = useSkyStore.getState();
  st.setLocation(snap.location);
  useSkyStore.setState({
    projectionMode: snap.view.projectionMode,
    centerAzDeg: snap.view.centerAzDeg,
    centerAltDeg: snap.view.centerAltDeg,
    centerRaDeg: snap.view.centerRaDeg,
    centerDecDeg: snap.view.centerDecDeg,
    fovDeg: snap.view.fovDeg,
    zoom: snap.view.zoom,
    jdUt: snap.jd_ut,
  });
  void useSkyStore.getState().refreshFrame();
}
