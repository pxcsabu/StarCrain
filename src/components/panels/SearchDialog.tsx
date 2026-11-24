import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import { Compass, Image, MapPin, Radar, Search, Sparkles, X } from "lucide-react";
import { CelestialVisualSvg } from "@/components/panels/CelestialVisualSvg";
import { Button } from "@/components/ui/button";
import { useSkyStore } from "@/store/skyStore";
import type {
  DsoEntry,
  NearbyObjectItem,
  SearchResultItem,
  SolarSystemBodyRender,
} from "@/types/sky";

const SEARCH_CATEGORIES = [
  { id: "all", label: "すべて" },
  { id: "constellation", label: "星座" },
  { id: "planet", label: "太陽系" },
  { id: "comet", label: "彗星" },
  { id: "star", label: "恒星" },
  { id: "variable", label: "変光星" },
  { id: "dso", label: "星雲・星団" },
  { id: "asterism", label: "星空の目印" },
] as const;

const RA_RANGES = [
  { id: "all", label: "全天 (0–24h)", min: null, max: null },
  { id: "0_6", label: "0–6h (秋〜冬)", min: 0, max: 6 },
  { id: "6_12", label: "6–12h (冬〜春)", min: 6, max: 12 },
  { id: "12_18", label: "12–18h (春〜夏)", min: 12, max: 18 },
  { id: "18_24", label: "18–24h (夏〜秋)", min: 18, max: 24 },
] as const;

type GalleryFilter = "all" | "solar" | "galaxy" | "globular" | "open" | "nebula";

function classifyDso(objType: string): GalleryFilter {
  const lower = objType.toLowerCase();
  if (lower === "gx" || lower === "g" || lower.includes("galax")) return "galaxy";
  if (lower === "gc" || lower.includes("glob")) return "globular";
  if (lower === "oc" || lower.includes("open")) return "open";
  return "nebula";
}

function dsoCatalogId(d: DsoEntry): string {
  return d.messier ? `M${d.messier}` : d.id;
}

function angularDistDeg(ra1Deg: number, dec1Deg: number, ra2Deg: number, dec2Deg: number): number {
  const toRad = Math.PI / 180;
  const d1 = dec1Deg * toRad;
  const d2 = dec2Deg * toRad;
  const dr = (ra1Deg - ra2Deg) * toRad;
  const cosA = Math.sin(d1) * Math.sin(d2) + Math.cos(d1) * Math.cos(d2) * Math.cos(dr);
  return (Math.acos(Math.max(-1, Math.min(1, cosA))) * 180) / Math.PI;
}

export function SearchDialog() {
  const staticAssets = useSkyStore((s) => s.staticAssets);
  const skyFrame = useSkyStore((s) => s.skyFrame);
  const location = useSkyStore((s) => s.location);
  const jdUt = useSkyStore((s) => s.jdUt);
  const simPlaying = useSkyStore((s) => s.simPlaying);
  const limitingMag = useSkyStore((s) => s.limitingMag);
  const refractionEnabled = useSkyStore((s) => s.refractionEnabled);
  const centerRaDeg = useSkyStore((s) => s.centerRaDeg);
  const centerDecDeg = useSkyStore((s) => s.centerDecDeg);
  const selectedObject = useSkyStore((s) => s.selectedObject);
  const searchInitialTab = useSkyStore((s) => s.searchInitialTab);
  const nearbyTarget = useSkyStore((s) => s.nearbyTarget);

  const setSearchInitialTab = useSkyStore((s) => s.setSearchInitialTab);
  const selectObject = useSkyStore((s) => s.selectObject);
  const centerOnSkyCoords = useSkyStore((s) => s.centerOnSkyCoords);
  const setActivePanel = useSkyStore((s) => s.setActivePanel);

  // Tab 1: Name / Filtered search state
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>("all");
  const [magMax, setMagMax] = useState<number | null>(null);
  const [raRangeId, setRaRangeId] = useState<string>("all");
  const [onlyVariables, setOnlyVariables] = useState(false);
  const [results, setResults] = useState<SearchResultItem[]>([]);
  const [searching, setSearching] = useState(false);

  // Tab 2: Photo / Visual gallery state
  const [galleryFilter, setGalleryFilter] = useState<GalleryFilter>("all");
  const [galleryQuery, setGalleryQuery] = useState("");

  // Tab 3: Nearby search state
  const [nearbySource, setNearbySource] = useState<"custom" | "center" | "selected" | "sun" | "moon">(
    nearbyTarget ? "custom" : selectedObject ? "selected" : "center",
  );
  const [nearbyRadius, setNearbyRadius] = useState<number>(15);
  const [nearbyWideMag, setNearbyWideMag] = useState<boolean>(true);
  const [nearbyItems, setNearbyItems] = useState<NearbyObjectItem[]>([]);
  const [nearbyLoading, setNearbyLoading] = useState(false);

  useEffect(() => {
    if (nearbyTarget) {
      setNearbySource("custom");
    }
  }, [nearbyTarget]);

  const raRange = RA_RANGES.find((r) => r.id === raRangeId) ?? RA_RANGES[0];

  // Execute Tab 1 search (Tauri IPC with offline fallback; paused during active time simulation)
  useEffect(() => {
    if (searchInitialTab !== "name" || simPlaying) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        setSearching(true);
        try {
          if (isTauri()) {
            const list = await invoke<SearchResultItem[]>("search_sky_objects", {
              req: {
                query,
                category,
                mag_max: magMax,
                ra_min_h: raRange.min,
                ra_max_h: raRange.max,
                only_variables: onlyVariables || category === "variable",
                jd_ut: jdUt,
                lat_deg: location.lat_deg,
                lon_deg: location.lon_deg,
                refraction: refractionEnabled,
                limit: 90,
              },
            });
            if (!cancelled) setResults(list);
          } else {
            const q = query.trim().toLowerCase();
            const fallback: SearchResultItem[] = [];
            for (const b of useSkyStore.getState().skyFrame?.bodies ?? []) {
              if (!q || b.name_ja.toLowerCase().includes(q) || b.name_en.toLowerCase().includes(q)) {
                fallback.push({
                  kind: b.kind,
                  id: b.id,
                  name_ja: b.name_ja,
                  name_en: b.name_en,
                  constellation: null,
                  obj_type: "太陽系天体",
                  mag: b.visual_magnitude,
                  ra_deg: b.ra_deg,
                  dec_deg: b.dec_deg,
                  az_deg: b.az_deg,
                  alt_deg: b.alt_deg,
                  extra: `${b.geo_au.toFixed(3)} AU`,
                });
              }
            }
            if (!cancelled) setResults(fallback);
          }
        } catch {
          if (!cancelled) setResults([]);
        } finally {
          if (!cancelled) setSearching(false);
        }
      })();
    }, 110);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    searchInitialTab,
    simPlaying,
    query,
    category,
    magMax,
    raRange.min,
    raRange.max,
    onlyVariables,
    jdUt,
    location.lat_deg,
    location.lon_deg,
    refractionEnabled,
  ]);

  const resolvedNearbyOrigin = useMemo(() => {
    if (nearbySource === "custom" && nearbyTarget) {
      return {
        label: nearbyTarget.name,
        raDeg: nearbyTarget.raDeg,
        decDeg: nearbyTarget.decDeg,
      };
    }
    if (nearbySource === "selected" && selectedObject) {
      return {
        label: selectedObject.name_ja,
        raDeg: selectedObject.ra_deg,
        decDeg: selectedObject.dec_deg,
      };
    }
    if (nearbySource === "sun") {
      const sun = skyFrame?.bodies.find((b) => b.id === "sun");
      if (sun) return { label: "太陽の近傍", raDeg: sun.ra_deg, decDeg: sun.dec_deg };
    }
    if (nearbySource === "moon") {
      const moon = skyFrame?.bodies.find((b) => b.id === "moon");
      if (moon) return { label: "月の近傍", raDeg: moon.ra_deg, decDeg: moon.dec_deg };
    }
    return {
      label: "現在の視野中心",
      raDeg: centerRaDeg,
      decDeg: centerDecDeg,
    };
  }, [nearbySource, nearbyTarget, selectedObject, skyFrame?.bodies, centerRaDeg, centerDecDeg]);

  // Execute Tab 3 Nearby Search (paused during active time simulation)
  useEffect(() => {
    if (searchInitialTab !== "nearby" || simPlaying) return;
    let cancelled = false;
    void (async () => {
      setNearbyLoading(true);
      try {
        if (isTauri()) {
          const list = await invoke<NearbyObjectItem[]>("find_nearby_objects", {
            req: {
              ra_deg: resolvedNearbyOrigin.raDeg,
              dec_deg: resolvedNearbyOrigin.decDeg,
              radius_deg: nearbyRadius,
              jd_ut: jdUt,
              lat_deg: location.lat_deg,
              lon_deg: location.lon_deg,
              limiting_mag: nearbyWideMag ? Math.max(8.5, limitingMag) : limitingMag,
              refraction: refractionEnabled,
            },
          });
          if (!cancelled) setNearbyItems(list);
        } else {
          const fallback: NearbyObjectItem[] = (useSkyStore.getState().skyFrame?.bodies ?? [])
            .map((b) => ({
              kind: b.kind,
              id: b.id,
              name_ja: b.name_ja,
              name_en: b.name_en,
              constellation: null,
              obj_type: "太陽系",
              mag: b.visual_magnitude,
              angular_sep_deg: angularDistDeg(
                resolvedNearbyOrigin.raDeg,
                resolvedNearbyOrigin.decDeg,
                b.ra_deg,
                b.dec_deg,
              ),
              ra_deg: b.ra_deg,
              dec_deg: b.dec_deg,
              az_deg: b.az_deg,
              alt_deg: b.alt_deg,
            }))
            .filter((item) => item.angular_sep_deg <= nearbyRadius)
            .sort((a, b) => a.angular_sep_deg - b.angular_sep_deg);
          if (!cancelled) setNearbyItems(fallback);
        }
      } catch {
        if (!cancelled) setNearbyItems([]);
      } finally {
        if (!cancelled) setNearbyLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    searchInitialTab,
    simPlaying,
    resolvedNearbyOrigin.raDeg,
    resolvedNearbyOrigin.decDeg,
    nearbyRadius,
    nearbyWideMag,
    limitingMag,
    jdUt,
    location.lat_deg,
    location.lon_deg,
    refractionEnabled,
  ]);

  // Tab 2 Gallery Items (Solar System + Messier/Named DSOs)
  const galleryItems = useMemo(() => {
    const q = galleryQuery.trim().toLowerCase();
    const out: Array<{
      kind: "sun" | "moon" | "planet" | "dwarf_planet" | "comet" | "dso";
      id: string;
      title: string;
      sub: string;
      objType: string;
      group: GalleryFilter;
      constellation: string | null;
      mag: number | null;
      raDeg: number;
      decDeg: number;
      azDeg?: number;
      altDeg?: number;
      posAngDeg?: number | null;
      distText: string;
      body?: SolarSystemBodyRender | null;
    }> = [];

    if (galleryFilter === "all" || galleryFilter === "solar") {
      for (const b of skyFrame?.bodies ?? []) {
        if (
          !q ||
          b.name_ja.toLowerCase().includes(q) ||
          b.name_en.toLowerCase().includes(q) ||
          b.id.toLowerCase().includes(q)
        ) {
          out.push({
            kind: b.kind,
            id: b.id,
            title: b.name_ja,
            sub: b.name_en,
            objType:
              b.kind === "moon"
                ? "月"
                : b.kind === "sun"
                  ? "恒星・太陽"
                  : b.kind === "comet"
                    ? "彗星"
                    : "惑星",
            group: "solar",
            constellation: null,
            mag: b.visual_magnitude,
            raDeg: b.ra_deg,
            decDeg: b.dec_deg,
            azDeg: b.az_deg,
            altDeg: b.alt_deg,
            distText: `${b.geo_au.toFixed(3)} AU`,
            body: b,
          });
        }
      }
    }

    if (galleryFilter !== "solar") {
      const dsos = staticAssets?.dsos ?? [];
      for (const d of dsos) {
        if (!d.messier && !d.name_ja) continue;
        const group = classifyDso(d.obj_type);
        if (galleryFilter !== "all" && galleryFilter !== group) continue;
        const cid = dsoCatalogId(d);
        const title = d.name_ja ? `${cid} ${d.name_ja}` : `${cid} ${d.name_en}`;
        if (
          q &&
          !cid.toLowerCase().includes(q) &&
          !d.id.toLowerCase().includes(q) &&
          !title.toLowerCase().includes(q) &&
          !d.constellation.toLowerCase().includes(q)
        ) {
          continue;
        }
        out.push({
          kind: "dso",
          id: cid,
          title,
          sub: `${d.constellation} / ${d.obj_type}`,
          objType: d.obj_type,
          group,
          constellation: d.constellation,
          mag: d.mag,
          raDeg: d.ra_deg,
          decDeg: d.dec_deg,
          posAngDeg: d.pos_ang_deg,
          distText: d.maj_ax_arcmin ? `視径 ${d.maj_ax_arcmin.toFixed(1)}'` : d.obj_type,
        });
      }
    }
    return out.slice(0, 72);
  }, [galleryFilter, galleryQuery, skyFrame?.bodies, staticAssets?.dsos]);

  const handleSelectSearchItem = (item: SearchResultItem) => {
    if (item.kind === "constellation") {
      centerOnSkyCoords(item.ra_deg, item.dec_deg, item.az_deg, item.alt_deg);
      return;
    }
    selectObject(
      {
        kind: item.kind,
        id: item.id,
        name_ja: item.name_ja,
        name_en: item.name_en,
        constellation: item.constellation,
        mag: item.mag,
        ra_deg: item.ra_deg,
        dec_deg: item.dec_deg,
        az_deg: item.az_deg,
        alt_deg: item.alt_deg,
        dist_text: item.extra,
        angular_sep_deg: 0,
        extra_info: item.obj_type,
      },
      true,
    );
  };

  return (
    <aside className="flex h-full w-[25rem] max-w-[calc(100vw-5.5rem)] flex-col rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface-glass)] text-[var(--text-primary)] shadow-2xl backdrop-blur-md">
      {/* Header + 3 Tabs */}
      <div className="border-b border-[var(--border-subtle)] px-4 pt-3 pb-2.5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold tracking-tight">天体検索・ギャラリー</h2>
            <p className="text-[11px] text-[var(--text-muted)]">
              名前・分類・ビジュアル・近傍天体を検索してセンタリング
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

        <div className="mt-2.5 grid grid-cols-3 gap-1 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)]/80 p-1">
          {[
            { id: "name" as const, label: "名前検索", icon: Search },
            { id: "gallery" as const, label: "写真ギャラリー", icon: Image },
            { id: "nearby" as const, label: "近くに見える天体", icon: Radar },
          ].map((tab) => {
            const Icon = tab.icon;
            const active = searchInitialTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setSearchInitialTab(tab.id)}
                className={`flex items-center justify-center gap-1 rounded-lg px-2 py-1.5 text-[11px] font-medium transition ${
                  active
                    ? "bg-[var(--accent-primary)] text-[var(--accent-primary-fg)] shadow-sm"
                    : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                }`}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{tab.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* TAB 1: Name Search */}
      {searchInitialTab === "name" && (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="space-y-2 border-b border-[var(--border-subtle)] px-4 py-2.5 text-xs">
            <div className="relative">
              <Search className="pointer-events-none absolute top-2.5 left-2.5 h-3.5 w-3.5 text-[var(--text-muted)]" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="星座・恒星・M31・オリオン・α星・HIP番号..."
                className="w-full rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] py-1.5 pr-7 pl-8 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent-primary)] focus:outline-none"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  className="absolute top-2 right-2 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            <div className="flex flex-wrap gap-1">
              {SEARCH_CATEGORIES.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setCategory(c.id)}
                  className={`rounded-md border px-2 py-1 text-[10px] font-medium transition ${
                    category === c.id
                      ? "border-[var(--accent-primary)] bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]"
                      : "border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)]/60 text-[var(--text-secondary)] hover:border-[var(--border-strong)]"
                  }`}
                >
                  {c.label}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-2 gap-1.5">
              <select
                value={magMax === null ? "" : String(magMax)}
                onChange={(e) =>
                  setMagMax(e.target.value === "" ? null : Number(e.target.value))
                }
                className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 py-1 text-[11px] text-[var(--text-primary)]"
              >
                <option value="">等級: 指定なし</option>
                <option value="2">2.0等より明るい</option>
                <option value="4">4.0等まで</option>
                <option value="6.5">6.5等まで (肉眼)</option>
                <option value="10">10.0等まで (双眼鏡)</option>
              </select>

              <select
                value={raRangeId}
                onChange={(e) => setRaRangeId(e.target.value)}
                className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 py-1 text-[11px] text-[var(--text-primary)]"
              >
                {RA_RANGES.map((r) => (
                  <option key={r.id} value={r.id}>
                    赤経: {r.label}
                  </option>
                ))}
              </select>
            </div>

            <label className="flex cursor-pointer items-center justify-between text-[11px] text-[var(--text-secondary)]">
              <span>変光星のみに絞り込む</span>
              <input
                type="checkbox"
                checked={onlyVariables}
                onChange={(e) => setOnlyVariables(e.target.checked)}
                className="h-3.5 w-3.5 accent-[var(--accent-primary)]"
              />
            </label>
          </div>

          <div className="flex-1 space-y-1.5 overflow-y-auto px-3 py-2.5">
            {searching && results.length === 0 ? (
              <div className="py-8 text-center text-xs text-[var(--text-muted)]">検索中...</div>
            ) : results.length === 0 ? (
              <div className="py-8 text-center text-xs text-[var(--text-muted)]">
                該当する天体が見つかりませんでした
              </div>
            ) : (
              results.map((item) => (
                <button
                  key={`${item.kind}-${item.id}`}
                  type="button"
                  onClick={() => handleSelectSearchItem(item)}
                  className="flex w-full items-center justify-between gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)]/60 px-3 py-2 text-left transition hover:border-[var(--accent-primary)] hover:bg-[var(--bg-surface-elevated)]"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-xs font-semibold text-[var(--text-primary)]">
                        {item.name_ja}
                      </span>
                      {item.constellation && (
                        <span className="rounded bg-[var(--bg-surface)] px-1 py-0.5 font-mono-num text-[9px] text-[var(--text-muted)]">
                          {item.constellation}
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 truncate text-[10px] text-[var(--text-muted)]">
                      {item.obj_type} {item.extra ? `・${item.extra}` : ""}
                    </div>
                  </div>
                  <div className="shrink-0 text-right font-mono-num">
                    <div className="text-[11px] font-medium">
                      {item.mag !== null ? `${item.mag.toFixed(1)}等` : "--"}
                    </div>
                    <div
                      className={`text-[10px] ${
                        item.alt_deg >= 0 ? "text-[var(--status-ok)]" : "text-[var(--text-muted)]"
                      }`}
                    >
                      高度 {item.alt_deg.toFixed(0)}°
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      )}

      {/* TAB 2: Photo / Visual Gallery */}
      {searchInitialTab === "gallery" && (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="space-y-2 border-b border-[var(--border-subtle)] px-4 py-2.5 text-xs">
            <input
              type="text"
              value={galleryQuery}
              onChange={(e) => setGalleryQuery(e.target.value)}
              placeholder="メシエ番号・愛称で絞り込み (M31, オリオン, 土星...)"
              className="w-full rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-1.5 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent-primary)] focus:outline-none"
            />
            <div className="flex flex-wrap gap-1">
              {[
                { id: "all" as const, label: "すべて" },
                { id: "solar" as const, label: "太陽系" },
                { id: "galaxy" as const, label: "銀河" },
                { id: "globular" as const, label: "球状星団" },
                { id: "open" as const, label: "散開星団" },
                { id: "nebula" as const, label: "星雲" },
              ].map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setGalleryFilter(f.id)}
                  className={`rounded-md border px-2 py-1 text-[10px] font-medium transition ${
                    galleryFilter === f.id
                      ? "border-[var(--accent-primary)] bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]"
                      : "border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)]/60 text-[var(--text-secondary)]"
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          <div className="grid flex-1 grid-cols-2 content-start gap-2 overflow-y-auto p-3">
            {galleryItems.map((g) => (
              <button
                key={`${g.kind}-${g.id}`}
                type="button"
                onClick={() =>
                  selectObject(
                    {
                      kind: g.kind,
                      id: g.id,
                      name_ja: g.title,
                      name_en: g.sub,
                      constellation: g.constellation,
                      mag: g.mag,
                      ra_deg: g.raDeg,
                      dec_deg: g.decDeg,
                      az_deg: g.azDeg ?? 180,
                      alt_deg: g.altDeg ?? 20,
                      dist_text: g.distText,
                      angular_sep_deg: 0,
                      extra_info: g.objType,
                    },
                    true,
                  )
                }
                className="flex flex-col overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)]/70 p-1.5 text-left transition hover:border-[var(--accent-primary)]"
              >
                <CelestialVisualSvg
                  kind={g.kind}
                  id={g.id}
                  title={g.title}
                  objType={g.objType}
                  mag={g.mag}
                  posAngDeg={g.posAngDeg}
                  raDeg={g.raDeg}
                  decDeg={g.decDeg}
                  body={g.body}
                  size="sm"
                />
                <div className="mt-1.5 px-1">
                  <div className="truncate text-[11px] font-semibold">{g.title}</div>
                  <div className="truncate text-[10px] text-[var(--text-muted)]">{g.sub}</div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* TAB 3: Nearby Objects Search */}
      {searchInitialTab === "nearby" && (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="space-y-2 border-b border-[var(--border-subtle)] px-4 py-2.5 text-xs">
            <div className="flex items-center justify-between text-[11px] text-[var(--text-secondary)]">
              <span className="inline-flex items-center gap-1 font-medium">
                <MapPin className="h-3.5 w-3.5 text-[var(--accent-primary)]" />
                基準座標: {resolvedNearbyOrigin.label}
              </span>
              <span className="font-mono-num text-[10px] text-[var(--text-muted)]">
                RA {(resolvedNearbyOrigin.raDeg / 15).toFixed(1)}h / Dec{" "}
                {resolvedNearbyOrigin.decDeg.toFixed(1)}°
              </span>
            </div>

            <div className="flex flex-wrap gap-1">
              {nearbyTarget && (
                <button
                  type="button"
                  onClick={() => setNearbySource("custom")}
                  className={`rounded-md border px-2 py-1 text-[10px] ${
                    nearbySource === "custom"
                      ? "border-[var(--accent-primary)] bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]"
                      : "border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)]"
                  }`}
                >
                  指定: {nearbyTarget.name}
                </button>
              )}
              {selectedObject && (
                <button
                  type="button"
                  onClick={() => setNearbySource("selected")}
                  className={`rounded-md border px-2 py-1 text-[10px] ${
                    nearbySource === "selected"
                      ? "border-[var(--accent-primary)] bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]"
                      : "border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)]"
                  }`}
                >
                  選択天体
                </button>
              )}
              {[
                { id: "center" as const, label: "視野中心", icon: Compass },
                { id: "moon" as const, label: "月", icon: Sparkles },
                { id: "sun" as const, label: "太陽", icon: Sparkles },
              ].map((src) => (
                <button
                  key={src.id}
                  type="button"
                  onClick={() => setNearbySource(src.id)}
                  className={`rounded-md border px-2 py-1 text-[10px] ${
                    nearbySource === src.id
                      ? "border-[var(--accent-primary)] bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]"
                      : "border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)]"
                  }`}
                >
                  {src.label}
                </button>
              ))}
            </div>

            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1">
                <span className="text-[11px] text-[var(--text-muted)]">探索半径:</span>
                {[3, 5, 15, 30, 45].map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setNearbyRadius(r)}
                    className={`rounded border px-1.5 py-0.5 font-mono-num text-[10px] ${
                      nearbyRadius === r
                        ? "border-[var(--accent-primary)] bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]"
                        : "border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)]"
                    }`}
                  >
                    {r}°
                  </button>
                ))}
              </div>
              <label className="flex cursor-pointer items-center gap-1 text-[10px] text-[var(--text-secondary)]">
                <input
                  type="checkbox"
                  checked={nearbyWideMag}
                  onChange={(e) => setNearbyWideMag(e.target.checked)}
                  className="h-3.5 w-3.5 accent-[var(--accent-primary)]"
                />
                8.5等迄
              </label>
            </div>
          </div>

          <div className="flex-1 space-y-1.5 overflow-y-auto px-3 py-2.5">
            {nearbyLoading && nearbyItems.length === 0 ? (
              <div className="py-8 text-center text-xs text-[var(--text-muted)]">
                近傍天体を探索中...
              </div>
            ) : nearbyItems.length === 0 ? (
              <div className="py-8 text-center text-xs text-[var(--text-muted)]">
                半径 {nearbyRadius}° 以内に条件に合う天体はありません
              </div>
            ) : (
              nearbyItems.map((item) => (
                <button
                  key={`${item.kind}-${item.id}-${item.angular_sep_deg.toFixed(3)}`}
                  type="button"
                  onClick={() =>
                    selectObject(
                      {
                        kind: item.kind,
                        id: item.id,
                        name_ja: item.name_ja,
                        name_en: item.name_en,
                        constellation: item.constellation,
                        mag: item.mag,
                        ra_deg: item.ra_deg,
                        dec_deg: item.dec_deg,
                        az_deg: item.az_deg,
                        alt_deg: item.alt_deg,
                        dist_text: `基準から ${item.angular_sep_deg.toFixed(2)}°`,
                        angular_sep_deg: item.angular_sep_deg,
                        extra_info: item.obj_type,
                      },
                      true,
                    )
                  }
                  className="flex w-full items-center justify-between gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)]/60 px-3 py-2 text-left transition hover:border-[var(--accent-primary)] hover:bg-[var(--bg-surface-elevated)]"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-xs font-semibold">{item.name_ja}</span>
                      <span className="rounded bg-[var(--accent-primary)]/15 px-1.5 py-0.5 font-mono-num text-[10px] font-semibold text-[var(--accent-primary)]">
                        {item.angular_sep_deg.toFixed(2)}°
                      </span>
                    </div>
                    <div className="mt-0.5 truncate text-[10px] text-[var(--text-muted)]">
                      {item.obj_type} {item.constellation ? `(${item.constellation})` : ""}
                    </div>
                  </div>
                  <div className="shrink-0 text-right font-mono-num">
                    <div className="text-[11px]">
                      {item.mag !== null ? `${item.mag.toFixed(1)}等` : "--"}
                    </div>
                    <div
                      className={`text-[10px] ${
                        item.alt_deg >= 0 ? "text-[var(--status-ok)]" : "text-[var(--text-muted)]"
                      }`}
                    >
                      高度 {item.alt_deg.toFixed(0)}°
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </aside>
  );
}
