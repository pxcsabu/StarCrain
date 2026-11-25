import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  ChevronLeft,
  ChevronRight,
  Compass,
  Disc,
  Globe,
  Orbit,
  RefreshCw,
  Route,
  Search,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { PlanetDiskSvg } from "@/components/panels/PlanetDiskSvg";
import { Button } from "@/components/ui/button";
import { NumberInput } from "@/components/ui/number-input";
import { useSkyStore } from "@/store/skyStore";
import type {
  ConjunctionRow,
  GalileanViewData,
  InnerPlanetOffsetResult,
  MagnitudeCurveSeries,
  PlanetAppearanceData,
  PlanetOverviewItem,
  PlanetTrackPoint,
  PlanetaryPhenomenonRow,
} from "@/types/sky";

type PlanetToolTab =
  | "info"
  | "appearance"
  | "track"
  | "inner_offset"
  | "magnitude"
  | "phenomena"
  | "galilean";

const TABS: { id: PlanetToolTab; label: string; icon: typeof Globe }[] = [
  { id: "info", label: "惑星情報", icon: Globe },
  { id: "appearance", label: "惑星の形", icon: Disc },
  { id: "track", label: "惑星の経路", icon: Route },
  { id: "inner_offset", label: "内惑星太陽差", icon: Orbit },
  { id: "magnitude", label: "光度曲線", icon: Activity },
  { id: "phenomena", label: "現象・接近", icon: Search },
  { id: "galilean", label: "ガリレオ衛星", icon: Sparkles },
];

const PLANET_COLORS: Record<string, string> = {
  mercury: "#cbd5e1",
  venus: "#fef08a",
  mars: "#fb7154",
  jupiter: "#fdba74",
  saturn: "#fde68a",
  uranus: "#67e8f9",
  neptune: "#60a5fa",
  pluto: "#a8a29e",
  moon: "#e2e8f0",
};

const BRIGHT_STAR_OPTIONS: { hip: number | null; label: string }[] = [
  { hip: null, label: "全1等星 (自動)" },
  { hip: 21421, label: "アルデバラン (おうし座)" },
  { hip: 49669, label: "レグルス (しし座)" },
  { hip: 65474, label: "スピカ (おとめ座)" },
  { hip: 80763, label: "アンタレス (さそり座)" },
  { hip: 37826, label: "ポルックス (ふたご座)" },
  { hip: 113368, label: "フォーマルハウト" },
];

const MAG_BODY_OPTIONS: { id: string; label: string }[] = [
  { id: "mercury", label: "水星" },
  { id: "venus", label: "金星" },
  { id: "mars", label: "火星" },
  { id: "jupiter", label: "木星" },
  { id: "saturn", label: "土星" },
  { id: "uranus", label: "天王星" },
  { id: "neptune", label: "海王星" },
];

function ymdToJdUtSimple(year: number, month: number, day: number, tzOffsetMin: number): number {
  let y = year;
  let m = month;
  if (m <= 2) {
    y -= 1;
    m += 12;
  }
  const a = Math.floor(y / 100);
  const b = 2 - a + Math.floor(a / 4);
  const jdLocal = Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + day + b - 1524.5;
  return jdLocal - tzOffsetMin / 1440;
}

export function PlanetTools() {
  const skyFrame = useSkyStore((s) => s.skyFrame);
  const location = useSkyStore((s) => s.location);
  const jdUt = useSkyStore((s) => s.jdUt);
  const simPlaying = useSkyStore((s) => s.simPlaying);
  const planetTracks = useSkyStore((s) => s.planetTracks);
  const comets = useSkyStore((s) => s.comets);
  const cometsVersion = useSkyStore((s) => s.cometsVersion);

  const magBodyOptions = useMemo(() => {
    const cometOpts = comets.map((c) => ({
      id: c.record.id,
      label: c.record.enabled ? c.record.name : `${c.record.name} (非表示)`,
    }));
    return [...MAG_BODY_OPTIONS, ...cometOpts];
  }, [comets]);

  const stepTimeMinutes = useSkyStore((s) => s.stepTimeMinutes);
  const setNow = useSkyStore((s) => s.setNow);
  const jumpToJdUt = useSkyStore((s) => s.jumpToJdUt);
  const centerOnSkyCoords = useSkyStore((s) => s.centerOnSkyCoords);
  const selectObject = useSkyStore((s) => s.selectObject);
  const setPlanetTrack = useSkyStore((s) => s.setPlanetTrack);
  const clearPlanetTracks = useSkyStore((s) => s.clearPlanetTracks);
  const setActivePanel = useSkyStore((s) => s.setActivePanel);

  const [tab, setTab] = useState<PlanetToolTab>("info");

  // Tab 1: Overview
  const [overview, setOverview] = useState<PlanetOverviewItem[]>([]);

  // Tab 2: Appearance
  const [appBody, setAppBody] = useState<string>("jupiter");
  const [appOrientation, setAppOrientation] = useState<"equatorial" | "horizontal">("equatorial");
  const [appearance, setAppearance] = useState<PlanetAppearanceData | null>(null);
  const [grsLon, setGrsLon] = useState<number>(65);

  // Tab 3: Sky Track
  const [trackBody, setTrackBody] = useState<string>("mars");
  const [trackDays, setTrackDays] = useState<number>(180);
  const [trackInnerShapes, setTrackInnerShapes] = useState<boolean>(true);
  const [trackOverlayAppend, setTrackOverlayAppend] = useState<boolean>(true);
  const [trackPoints, setTrackPoints] = useState<PlanetTrackPoint[]>([]);
  const [trackName, setTrackName] = useState<string>("火星");

  // Tab 4: Inner Planet Solar Offset
  const [innerBody, setInnerBody] = useState<"mercury" | "venus">("venus");
  const [innerDays, setInnerDays] = useState<number>(365);
  const [innerShowShapes, setInnerShowShapes] = useState<boolean>(true);
  const [innerData, setInnerData] = useState<InnerPlanetOffsetResult | null>(null);

  // Tab 5: Magnitude Curve
  const [magBodies, setMagBodies] = useState<string[]>(["venus", "mars", "jupiter", "saturn"]);
  const [magDays, setMagDays] = useState<number>(180);
  const [magStartJd, setMagStartJd] = useState<number>(jdUt - 30);
  const [magSeries, setMagSeries] = useState<MagnitudeCurveSeries[]>([]);
  const [magHoverIdx, setMagHoverIdx] = useState<number | null>(null);

  // Tab 6: Phenomena & Conjunctions
  const [phenMode, setPhenMode] = useState<"phenomena" | "planet_planet" | "planet_cluster" | "planet_star">(
    "phenomena",
  );
  const [phenStartYear, setPhenStartYear] = useState<number>(skyFrame?.local_dt.year ?? 2026);
  const [phenSpanYears, setPhenSpanYears] = useState<number>(1);
  const [phenPlanetFilter, setPhenPlanetFilter] = useState<string>("all");
  const [conjMaxSep, setConjMaxSep] = useState<number>(3.0);
  const [conjIncludeMoon, setConjIncludeMoon] = useState<boolean>(false);
  const [clusterMaxSpan, setClusterMaxSpan] = useState<number>(25);
  const [clusterMinCount, setClusterMinCount] = useState<number>(3);
  const [starHip, setStarHip] = useState<number | null>(null);
  const [phenRows, setPhenRows] = useState<PlanetaryPhenomenonRow[]>([]);
  const [conjRows, setConjRows] = useState<ConjunctionRow[]>([]);
  const [phenLoading, setPhenLoading] = useState<boolean>(false);

  // Tab 7: Galilean Moons
  const [galSpanDays, setGalSpanDays] = useState<number>(7);
  const [galInverted, setGalInverted] = useState<boolean>(false);
  const [galView, setGalView] = useState<GalileanViewData | null>(null);

  const simTimeBucket = simPlaying ? Math.floor(performance.now() / 380) : jdUt;
  const slowSimBucket = simPlaying ? Math.floor(performance.now() / 700) : jdUt;

  // Tab 1 fetch
  useEffect(() => {
    if (tab !== "info" || !isTauri()) return;
    let cancelled = false;
    void invoke<PlanetOverviewItem[]>("get_planets_overview", {
      req: {
        jd_ut: useSkyStore.getState().jdUt,
        lat_deg: location.lat_deg,
        lon_deg: location.lon_deg,
        alt_m: location.alt_m,
        tz_offset_min: location.tz_offset_min,
      },
    }).then((res) => {
      if (!cancelled) setOverview(res);
    });
    return () => {
      cancelled = true;
    };
  }, [tab, simTimeBucket, location.lat_deg, location.lon_deg, location.alt_m, location.tz_offset_min]);

  // Tab 2 fetch
  useEffect(() => {
    if (tab !== "appearance" || !isTauri()) return;
    let cancelled = false;
    void invoke<PlanetAppearanceData>("get_planet_appearance", {
      req: {
        planet_id: appBody,
        jd_ut: useSkyStore.getState().jdUt,
        lat_deg: location.lat_deg,
        lon_deg: location.lon_deg,
        alt_m: location.alt_m,
        grs_sys2_lon_deg: grsLon,
      },
    }).then((res) => {
      if (!cancelled) setAppearance(res);
    });
    return () => {
      cancelled = true;
    };
  }, [tab, appBody, simTimeBucket, location.lat_deg, location.lon_deg, location.alt_m, grsLon]);

  // Tab 3 fetch & optional overlay apply
  const fetchTrack = async (pushToSky: boolean, isCancelled?: () => boolean) => {
    if (!isTauri()) return;
    const stepHours = trackBody === "moon" ? 6 : trackDays <= 60 ? 24 : 48;
    const res = await invoke<{ id: string; name_ja: string; points: PlanetTrackPoint[] }>(
      "get_planet_track",
      {
        req: {
          planet_id: trackBody,
          start_jd_ut: useSkyStore.getState().jdUt,
          days: trackDays,
          step_hours: stepHours,
          lat_deg: location.lat_deg,
          lon_deg: location.lon_deg,
          alt_m: location.alt_m,
          tz_offset_min: location.tz_offset_min,
        },
      },
    );
    if (isCancelled?.()) return;
    setTrackPoints(res.points);
    setTrackName(res.name_ja);
    if (pushToSky) {
      setPlanetTrack(
        {
          id: res.id,
          name_ja: res.name_ja,
          color: PLANET_COLORS[res.id] ?? "#38bdf8",
          showInnerShapes: trackInnerShapes && (res.id === "mercury" || res.id === "venus"),
          points: res.points,
        },
        trackOverlayAppend,
      );
    }
  };

  useEffect(() => {
    if (tab !== "track") return;
    let cancelled = false;
    void fetchTrack(false, () => cancelled);
    return () => {
      cancelled = true;
    };
  }, [tab, trackBody, trackDays, slowSimBucket, location.lat_deg, location.lon_deg]);

  // Tab 4 fetch
  useEffect(() => {
    if (tab !== "inner_offset" || !isTauri()) return;
    let cancelled = false;
    void invoke<InnerPlanetOffsetResult>("get_inner_planet_sun_offset", {
      req: {
        planet_id: innerBody,
        start_jd_ut: useSkyStore.getState().jdUt,
        days: innerDays,
        step_days: innerDays <= 180 ? 3 : 5,
        tz_offset_min: location.tz_offset_min,
      },
    }).then((res) => {
      if (!cancelled) setInnerData(res);
    });
    return () => {
      cancelled = true;
    };
  }, [tab, innerBody, innerDays, slowSimBucket, location.tz_offset_min]);

  // Tab 5 fetch
  useEffect(() => {
    if (tab !== "magnitude" || !isTauri() || magBodies.length === 0) {
      if (magBodies.length === 0) setMagSeries([]);
      return;
    }
    let cancelled = false;
    void invoke<MagnitudeCurveSeries[]>("get_magnitude_curve", {
      req: {
        body_ids: magBodies,
        start_jd_ut: magStartJd,
        days: magDays,
        tz_offset_min: location.tz_offset_min,
      },
    }).then((res) => {
      if (!cancelled) setMagSeries(res);
    });
    return () => {
      cancelled = true;
    };
  }, [tab, magBodies, magStartJd, magDays, location.tz_offset_min, cometsVersion]);

  // Tab 6 fetch
  const runPhenomenaSearch = () => {
    if (!isTauri()) return;
    setPhenLoading(true);
    const startJd = ymdToJdUtSimple(phenStartYear, 1, 1, location.tz_offset_min);
    const endJd = ymdToJdUtSimple(phenStartYear + phenSpanYears, 1, 1, location.tz_offset_min);

    if (phenMode === "phenomena") {
      void invoke<PlanetaryPhenomenonRow[]>("search_planet_phenomena_cmd", {
        req: {
          start_jd_ut: startJd,
          end_jd_ut: endJd,
          planet_id: phenPlanetFilter === "all" ? null : phenPlanetFilter,
          lat_deg: location.lat_deg,
          lon_deg: location.lon_deg,
          alt_m: location.alt_m,
          tz_offset_min: location.tz_offset_min,
        },
      })
        .then((res) => setPhenRows(res))
        .finally(() => setPhenLoading(false));
    } else {
      void invoke<ConjunctionRow[]>("search_conjunctions_cmd", {
        req: {
          mode: phenMode,
          start_jd_ut: startJd,
          end_jd_ut: endJd,
          max_sep_deg: phenMode === "planet_cluster" ? clusterMaxSpan : conjMaxSep,
          include_moon: conjIncludeMoon,
          min_cluster_count: clusterMinCount,
          star_hip: phenMode === "planet_star" ? starHip : null,
          lat_deg: location.lat_deg,
          lon_deg: location.lon_deg,
          tz_offset_min: location.tz_offset_min,
        },
      })
        .then((res) => setConjRows(res))
        .finally(() => setPhenLoading(false));
    }
  };

  useEffect(() => {
    if (tab !== "phenomena") return;
    runPhenomenaSearch();
  }, [tab, phenMode, phenStartYear, phenSpanYears, phenPlanetFilter, conjIncludeMoon, starHip]);

  // Tab 7 fetch
  useEffect(() => {
    if (tab !== "galilean" || !isTauri()) return;
    let cancelled = false;
    void invoke<GalileanViewData>("get_galilean_moons_view", {
      req: {
        jd_ut: useSkyStore.getState().jdUt,
        span_days: galSpanDays,
        grs_sys2_lon_deg: grsLon,
        lat_deg: location.lat_deg,
        lon_deg: location.lon_deg,
        alt_m: location.alt_m,
        tz_offset_min: location.tz_offset_min,
      },
    }).then((res) => {
      if (!cancelled) setGalView(res);
    });
    return () => {
      cancelled = true;
    };
  }, [tab, simTimeBucket, galSpanDays, grsLon, location.lat_deg, location.lon_deg, location.alt_m, location.tz_offset_min]);

  // Track SVG bounds
  const trackBounds = useMemo(() => {
    if (trackPoints.length === 0) return null;
    const refRa = trackPoints[0].ra_deg;
    const unwrapped = trackPoints.map((p) => {
      let d = p.ra_deg - refRa;
      while (d > 180) d -= 360;
      while (d < -180) d += 360;
      return { ...p, uRa: refRa + d };
    });
    const minRa = Math.min(...unwrapped.map((p) => p.uRa));
    const maxRa = Math.max(...unwrapped.map((p) => p.uRa));
    const minDec = Math.min(...unwrapped.map((p) => p.dec_deg));
    const maxDec = Math.max(...unwrapped.map((p) => p.dec_deg));
    const padRa = Math.max(4, (maxRa - minRa) * 0.14);
    const padDec = Math.max(4, (maxDec - minDec) * 0.14);
    return {
      points: unwrapped,
      ra0: minRa - padRa,
      ra1: maxRa + padRa,
      dec0: minDec - padDec,
      dec1: maxDec + padDec,
    };
  }, [trackPoints]);

  const jumpAndCenter = (targetJd: number, raDeg: number, decDeg: number, azDeg?: number, altDeg?: number) => {
    jumpToJdUt(targetJd);
    centerOnSkyCoords(raDeg, decDeg, azDeg, altDeg);
  };

  return (
    <aside className="flex h-full w-[37rem] max-w-[calc(100vw-5.5rem)] flex-col rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface-glass)] text-[var(--text-primary)] shadow-2xl backdrop-blur-md">
      {/* Header + 7 Tabs */}
      <div className="border-b border-[var(--border-subtle)] px-4 pt-3 pb-2">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="flex items-center gap-1.5 text-sm font-semibold tracking-tight">
              <Globe className="h-4 w-4 text-[var(--accent-primary)]" /> 惑星解析ツール群 &amp; ガリレオ衛星
            </h2>
            <p className="text-[11px] text-[var(--text-muted)]">
              位置・形状・経路・内惑星太陽差・光度曲線・現象検索・木星衛星/GRS
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

        <div className="mt-2.5 flex flex-wrap gap-1 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)]/80 p-1">
          {TABS.map((t) => {
            const Icon = t.icon;
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={`flex items-center gap-1 rounded-lg px-2 py-1 text-[10.5px] font-medium transition ${
                  active
                    ? "bg-[var(--accent-primary)] text-[var(--accent-primary-fg)] shadow-sm"
                    : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                }`}
              >
                <Icon className="h-3 w-3" />
                {t.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3 text-xs">
        {/* TAB 1: Planet Info */}
        {tab === "info" && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-1 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)]/65 px-2.5 py-2">
              <span className="text-[11px] text-[var(--text-muted)]">ステップ:</span>
              <div className="flex flex-wrap gap-1">
                {[
                  { label: "-30日", m: -43200 },
                  { label: "-7日", m: -10080 },
                  { label: "-1日", m: -1440 },
                  { label: "-1時", m: -60 },
                ].map((b) => (
                  <button
                    key={b.label}
                    type="button"
                    onClick={() => stepTimeMinutes(b.m)}
                    className="rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-1.5 py-0.5 font-mono-num text-[10px] hover:border-[var(--accent-primary)]"
                  >
                    {b.label}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={setNow}
                  className="rounded border border-[var(--accent-primary)]/40 bg-[var(--accent-primary)]/15 px-2 py-0.5 text-[10px] font-semibold text-[var(--accent-primary)]"
                >
                  今
                </button>
                {[
                  { label: "+1時", m: 60 },
                  { label: "+1日", m: 1440 },
                  { label: "+7日", m: 10080 },
                  { label: "+30日", m: 43200 },
                ].map((b) => (
                  <button
                    key={b.label}
                    type="button"
                    onClick={() => stepTimeMinutes(b.m)}
                    className="rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-1.5 py-0.5 font-mono-num text-[10px] hover:border-[var(--accent-primary)]"
                  >
                    {b.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="overflow-x-auto rounded-xl border border-[var(--border-subtle)]">
              <table className="w-full text-left text-[11px]">
                <thead className="bg-[var(--bg-surface-elevated)] text-[10px] text-[var(--text-muted)]">
                  <tr>
                    <th className="px-2 py-1.5">天体</th>
                    <th className="px-2 py-1.5 text-right">等級</th>
                    <th className="px-2 py-1.5 text-right">地心AU</th>
                    <th className="px-2 py-1.5 text-right">視径&quot;</th>
                    <th className="px-2 py-1.5 text-right">離角</th>
                    <th className="px-2 py-1.5 text-right">高度</th>
                    <th className="px-2 py-1.5 text-right">出 / 南中 / 没</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border-subtle)]">
                  {overview.map((item) => (
                    <tr
                      key={item.id}
                      onClick={() =>
                        selectObject(
                          {
                            kind: item.kind,
                            id: item.id,
                            name_ja: item.name_ja,
                            name_en: item.name_en,
                            constellation: null,
                            mag: item.mag,
                            ra_deg: item.ra_deg,
                            dec_deg: item.dec_deg,
                            az_deg: item.az_deg,
                            alt_deg: item.alt_deg,
                            dist_text: `${item.geo_au.toFixed(3)} AU`,
                            angular_sep_deg: 0,
                            extra_info: `視直径 ${item.angular_diameter_arcsec.toFixed(1)}" / 離角 ${item.elongation_deg.toFixed(1)}°`,
                          },
                          true,
                        )
                      }
                      className="cursor-pointer transition hover:bg-[var(--bg-surface-elevated)]/70"
                    >
                      <td className="px-2 py-1.5 font-semibold">{item.name_ja}</td>
                      <td className="px-2 py-1.5 text-right font-mono-num">{item.mag.toFixed(1)}</td>
                      <td className="px-2 py-1.5 text-right font-mono-num">{item.geo_au.toFixed(3)}</td>
                      <td className="px-2 py-1.5 text-right font-mono-num">
                        {item.angular_diameter_arcsec >= 100
                          ? `${(item.angular_diameter_arcsec / 60).toFixed(1)}'`
                          : `${item.angular_diameter_arcsec.toFixed(1)}"`}
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono-num">
                        {item.elongation_deg.toFixed(0)}°
                      </td>
                      <td
                        className={`px-2 py-1.5 text-right font-mono-num font-semibold ${
                          item.alt_deg >= 0 ? "text-[var(--status-ok)]" : "text-[var(--text-muted)]"
                        }`}
                      >
                        {item.alt_deg.toFixed(1)}°
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono-num text-[10px] text-[var(--text-secondary)]">
                        {item.rise_str ?? "--"} / {item.transit_str ?? "--"} / {item.set_str ?? "--"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {/* TAB 2: Planet Shape / Appearance */}
        {tab === "appearance" && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap gap-1">
                {[
                  { id: "mercury", label: "水星" },
                  { id: "venus", label: "金星" },
                  { id: "mars", label: "火星" },
                  { id: "moon", label: "月" },
                  { id: "jupiter", label: "木星" },
                  { id: "saturn", label: "土星" },
                ].map((b) => (
                  <button
                    key={b.id}
                    type="button"
                    onClick={() => setAppBody(b.id)}
                    className={`rounded-lg border px-2.5 py-1 text-[11px] font-medium ${
                      appBody === b.id
                        ? "border-[var(--accent-primary)] bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]"
                        : "border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)]"
                    }`}
                  >
                    {b.label}
                  </button>
                ))}
              </div>

              <div className="flex rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-0.5 text-[10.5px]">
                <button
                  type="button"
                  onClick={() => setAppOrientation("equatorial")}
                  className={`rounded-md px-2 py-0.5 ${
                    appOrientation === "equatorial"
                      ? "bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]"
                      : "text-[var(--text-secondary)]"
                  }`}
                >
                  赤経赤緯 (北上)
                </button>
                <button
                  type="button"
                  onClick={() => setAppOrientation("horizontal")}
                  className={`rounded-md px-2 py-0.5 ${
                    appOrientation === "horizontal"
                      ? "bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]"
                      : "text-[var(--text-secondary)]"
                  }`}
                >
                  地平 (天頂上)
                </button>
              </div>
            </div>

            <div className="flex items-center justify-center gap-1.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)]/55 py-1.5">
              {[
                { label: "-7日", m: -10080 },
                { label: "-1日", m: -1440 },
                { label: "-1h", m: -60 },
                { label: "+1h", m: 60 },
                { label: "+1日", m: 1440 },
                { label: "+7日", m: 10080 },
              ].map((s) => (
                <button
                  key={s.label}
                  type="button"
                  onClick={() => stepTimeMinutes(s.m)}
                  className="rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 py-0.5 font-mono-num text-[10.5px] hover:border-[var(--accent-primary)]"
                >
                  {s.label}
                </button>
              ))}
            </div>

            {appearance && (
              <div className="grid grid-cols-[13.5rem_1fr] items-center gap-3">
                <PlanetDiskSvg
                  id={appearance.id}
                  illuminatedFraction={appearance.illuminated_fraction}
                  brightLimbPaDeg={appearance.bright_limb_pa_deg}
                  polePaDeg={appearance.pole_pa_deg}
                  parallacticAngleDeg={appearance.parallactic_angle_deg}
                  orientation={appOrientation}
                  ringTiltDeg={appearance.saturn_ring_tilt_deg}
                  jupiterPhys={appearance.jupiter_phys}
                  galileanMoons={appearance.galilean_moons}
                  waxing={appearance.waxing}
                  size={212}
                />

                <div className="space-y-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)]/70 p-3 text-[11px]">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-bold">{appearance.name_ja}</span>
                    <span className="font-mono-num text-[10.5px] text-[var(--accent-primary)]">
                      {appearance.mag.toFixed(2)} 等
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-1.5 font-mono-num text-[10.5px]">
                    <div>
                      <span className="text-[var(--text-muted)]">視直径: </span>
                      {appearance.angular_diameter_arcsec >= 120
                        ? `${(appearance.angular_diameter_arcsec / 60).toFixed(2)}'`
                        : `${appearance.angular_diameter_arcsec.toFixed(2)}"`}
                    </div>
                    <div>
                      <span className="text-[var(--text-muted)]">輝面比: </span>
                      {(appearance.illuminated_fraction * 100).toFixed(1)}%
                    </div>
                    <div>
                      <span className="text-[var(--text-muted)]">位相角: </span>
                      {appearance.phase_angle_deg.toFixed(1)}°
                    </div>
                    <div>
                      <span className="text-[var(--text-muted)]">太陽離角: </span>
                      {appearance.elongation_deg.toFixed(1)}°
                    </div>
                    <div>
                      <span className="text-[var(--text-muted)]">地心距離: </span>
                      {appearance.geo_au.toFixed(4)} AU
                    </div>
                    <div>
                      <span className="text-[var(--text-muted)]">視差角 q: </span>
                      {appearance.parallactic_angle_deg.toFixed(1)}°
                    </div>
                  </div>

                  {appearance.saturn_ring_tilt_deg !== null && (
                    <div className="rounded-lg bg-[var(--bg-surface)] px-2.5 py-1.5 font-mono-num">
                      土星の環の傾き B: <strong>{appearance.saturn_ring_tilt_deg.toFixed(2)}°</strong>{" "}
                      ({appearance.saturn_ring_tilt_deg >= 0 ? "北面見頃" : "南面見頃"})
                    </div>
                  )}

                  {appearance.jupiter_phys && (
                    <div className="space-y-1 rounded-lg bg-[var(--bg-surface)] px-2.5 py-1.5 font-mono-num text-[10.5px]">
                      <div>
                        CM I {appearance.jupiter_phys.cm_sys1_deg.toFixed(1)}° / CM II{" "}
                        {appearance.jupiter_phys.cm_sys2_deg.toFixed(1)}°
                      </div>
                      <div className="flex items-center justify-between">
                        <span>大赤斑 (GRS {grsLon}°):</span>
                        <span
                          className={
                            appearance.jupiter_phys.grs_visible
                              ? "font-semibold text-[var(--status-ok)]"
                              : "text-[var(--text-muted)]"
                          }
                        >
                          {appearance.jupiter_phys.grs_visible
                            ? `正面 (${appearance.jupiter_phys.grs_offset_deg.toFixed(0)}°)`
                            : "裏側"}
                        </span>
                      </div>
                    </div>
                  )}

                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 w-full gap-1 text-[11px]"
                    onClick={() =>
                      centerOnSkyCoords(
                        appearance.ra_deg,
                        appearance.dec_deg,
                        appearance.az_deg,
                        appearance.alt_deg,
                      )
                    }
                  >
                    <Compass className="h-3 w-3" /> 星図でこの天体を中央表示
                  </Button>
                </div>
              </div>
            )}
          </>
        )}

        {/* TAB 3: Planetary Path / Sky Track */}
        {tab === "track" && (
          <>
            <div className="space-y-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)]/65 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <select
                  value={trackBody}
                  onChange={(e) => setTrackBody(e.target.value)}
                  className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2.5 py-1 text-xs"
                >
                  <option value="mercury">水星</option>
                  <option value="venus">金星</option>
                  <option value="mars">火星</option>
                  <option value="jupiter">木星</option>
                  <option value="saturn">土星</option>
                  <option value="uranus">天王星</option>
                  <option value="neptune">海王星</option>
                  <option value="pluto">冥王星</option>
                  <option value="moon">月</option>
                </select>

                <div className="flex gap-1">
                  {[30, 90, 180, 365].map((d) => (
                    <button
                      key={d}
                      type="button"
                      onClick={() => setTrackDays(d)}
                      className={`rounded-md border px-2 py-1 font-mono-num text-[10.5px] ${
                        trackDays === d
                          ? "border-[var(--accent-primary)] bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]"
                          : "border-[var(--border-subtle)] bg-[var(--bg-surface)]"
                      }`}
                    >
                      {d}日
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                <label className="flex cursor-pointer items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={trackOverlayAppend}
                    onChange={(e) => setTrackOverlayAppend(e.target.checked)}
                    className="h-3.5 w-3.5 accent-[var(--accent-primary)]"
                  />
                  複数惑星を上書き重ね描き
                </label>
                <label className="flex cursor-pointer items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={trackInnerShapes}
                    onChange={(e) => setTrackInnerShapes(e.target.checked)}
                    className="h-3.5 w-3.5 accent-[var(--accent-primary)]"
                  />
                  内惑星の形を表示
                </label>
              </div>

              <div className="flex flex-wrap gap-1.5">
                <Button
                  size="sm"
                  className="h-7 gap-1 px-2.5 text-[11px]"
                  onClick={() => void fetchTrack(true)}
                >
                  <Route className="h-3.5 w-3.5" /> 星図に経路を描画
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1 px-2.5 text-[11px]"
                  disabled={Object.keys(planetTracks).length === 0}
                  onClick={clearPlanetTracks}
                >
                  <Trash2 className="h-3.5 w-3.5" /> 経路クリア ({Object.keys(planetTracks).length})
                </Button>
              </div>
            </div>

            {trackBounds && (
              <div className="space-y-1.5 rounded-xl border border-[var(--border-subtle)] bg-[#040712] p-2.5">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="font-semibold">
                    {trackName} 経路プレビュー ({trackPoints.length}点・赤点は逆行区間)
                  </span>
                  <span className="text-[10px] text-[var(--text-muted)]">点クリックで再現</span>
                </div>

                <svg viewBox="0 0 420 200" className="w-full rounded-lg border border-white/10">
                  <polyline
                    fill="none"
                    stroke={PLANET_COLORS[trackBody] ?? "#38bdf8"}
                    strokeWidth="2"
                    points={trackBounds.points
                      .map((p) => {
                        const x =
                          395 - ((p.uRa - trackBounds.ra0) / Math.max(1, trackBounds.ra1 - trackBounds.ra0)) * 370;
                        const y =
                          180 -
                          ((p.dec_deg - trackBounds.dec0) / Math.max(1, trackBounds.dec1 - trackBounds.dec0)) *
                            160;
                        return `${x.toFixed(1)},${y.toFixed(1)}`;
                      })
                      .join(" ")}
                  />
                  {trackBounds.points.map((p, idx) => {
                    const x =
                      395 - ((p.uRa - trackBounds.ra0) / Math.max(1, trackBounds.ra1 - trackBounds.ra0)) * 370;
                    const y =
                      180 -
                      ((p.dec_deg - trackBounds.dec0) / Math.max(1, trackBounds.dec1 - trackBounds.dec0)) *
                        160;
                    const showLabel = idx % Math.max(1, Math.floor(trackBounds.points.length / 7)) === 0;
                    return (
                      <g
                        key={p.jd_ut}
                        className="cursor-pointer"
                        onClick={() => jumpAndCenter(p.jd_ut, p.ra_deg, p.dec_deg, p.az_deg, p.alt_deg)}
                      >
                        <circle
                          cx={x}
                          cy={y}
                          r={showLabel ? 3.5 : p.is_retrograde ? 2.2 : 1.5}
                          fill={p.is_retrograde ? "#fb7185" : PLANET_COLORS[trackBody] ?? "#38bdf8"}
                        />
                        {showLabel && (
                          <text x={x + 4} y={y - 4} fontSize="8.5" fill="#cbd5e1" fontFamily="monospace">
                            {p.date_label}
                          </text>
                        )}
                      </g>
                    );
                  })}
                </svg>
              </div>
            )}
          </>
        )}

        {/* TAB 4: Inner Planet Solar Offset */}
        {tab === "inner_offset" && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex gap-1">
                {[
                  { id: "mercury" as const, label: "水星 (対太陽)" },
                  { id: "venus" as const, label: "金星 (対太陽)" },
                ].map((b) => (
                  <button
                    key={b.id}
                    type="button"
                    onClick={() => setInnerBody(b.id)}
                    className={`rounded-lg border px-2.5 py-1 text-[11px] font-medium ${
                      innerBody === b.id
                        ? "border-[var(--accent-primary)] bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]"
                        : "border-[var(--border-subtle)] bg-[var(--bg-surface)]"
                    }`}
                  >
                    {b.label}
                  </button>
                ))}
              </div>

              <div className="flex gap-1">
                {[90, 180, 365, 584].map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setInnerDays(d)}
                    className={`rounded border px-2 py-0.5 font-mono-num text-[10.5px] ${
                      innerDays === d
                        ? "border-[var(--accent-primary)] bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]"
                        : "border-[var(--border-subtle)] bg-[var(--bg-surface)]"
                    }`}
                  >
                    {d}日
                  </button>
                ))}
              </div>
            </div>

            <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-[var(--text-secondary)]">
              <input
                type="checkbox"
                checked={innerShowShapes}
                onChange={(e) => setInnerShowShapes(e.target.checked)}
                className="h-3.5 w-3.5 accent-[var(--accent-primary)]"
              />
              軌道上の各位置に視直径・満ち欠けの形を重畳表示（クリックで日時移動）
            </label>

            {innerData && innerData.samples.length > 0 && (
              <div className="rounded-xl border border-[var(--border-subtle)] bg-[#040712] p-2.5">
                {(() => {
                  const maxSpan = innerBody === "mercury" ? 32 : 52;
                  const W = 440;
                  const H = 250;
                  const cx = W * 0.5;
                  const cy = H * 0.5;
                  const scale = 195 / maxSpan;
                  // Astronomical orientation: East (+DeltaRA, evening star) LEFT, West (-DeltaRA, morning star) RIGHT
                  const ptX = (dra: number) => cx - dra * scale;
                  const ptY = (ddec: number) => cy - ddec * scale;
                  const shapeStep = Math.max(1, Math.floor(innerData.samples.length / 10));

                  return (
                    <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
                      {[15, 30, 45]
                        .filter((r) => r < maxSpan)
                        .map((r) => (
                          <circle
                            key={r}
                            cx={cx}
                            cy={cy}
                            r={r * scale}
                            fill="none"
                            stroke="rgba(148,163,184,0.16)"
                            strokeDasharray="3 3"
                          />
                        ))}
                      <line x1="15" y1={cy} x2={W - 15} y2={cy} stroke="rgba(148,163,184,0.28)" />
                      <line x1={cx} y1="15" x2={cx} y2={H - 15} stroke="rgba(148,163,184,0.28)" />

                      <text x="16" y={cy - 5} fill="#fbbf24" fontSize="9.5">← 東 (+ΔRA 夕)</text>
                      <text x={W - 16} y={cy - 5} textAnchor="end" fill="#38bdf8" fontSize="9.5">西 (-ΔRA 朝) →</text>
                      <text x={cx + 5} y="22" fill="#94a3b8" fontSize="9.5">+ΔDec (北)</text>
                      <text x={cx + 5} y={H - 12} fill="#94a3b8" fontSize="9.5">-ΔDec (南)</text>

                      {/* Sun at origin */}
                      <circle cx={cx} cy={cy} r="7" fill="#fbbf24" />
                      <circle cx={cx} cy={cy} r="12" fill="#fbbf24" opacity="0.22" />

                      <polyline
                        fill="none"
                        stroke={innerBody === "mercury" ? "#cbd5e1" : "#fef08a"}
                        strokeWidth="1.8"
                        points={innerData.samples
                          .map((s) => `${ptX(s.delta_ra_deg).toFixed(1)},${ptY(s.delta_dec_deg).toFixed(1)}`)
                          .join(" ")}
                      />

                      {innerData.samples.map((s, idx) => {
                        const x = ptX(s.delta_ra_deg);
                        const y = ptY(s.delta_dec_deg);
                        const drawShape = idx % shapeStep === 0 || idx === innerData.samples.length - 1;
                        if (!drawShape) return null;
                        const rDisp = Math.max(4, Math.min(11, s.angular_diameter_arcsec * 0.22));
                        return (
                          <g
                            key={s.jd_ut}
                            className="cursor-pointer"
                            onClick={() => jumpToJdUt(s.jd_ut)}
                          >
                            {innerShowShapes ? (
                              <g transform={`translate(${x - rDisp}, ${y - rDisp})`}>
                                <PlanetDiskSvg
                                  id={innerBody}
                                  illuminatedFraction={s.illuminated_fraction}
                                  waxing={s.waxing}
                                  size={rDisp * 2}
                                  simple
                                />
                              </g>
                            ) : (
                              <circle cx={x} cy={y} r="3.2" fill="#38bdf8" />
                            )}
                            <text x={x + 8} y={y - 4} fontSize="8.5" fill="#cbd5e1" fontFamily="monospace">
                              {s.date_label}
                            </text>
                          </g>
                        );
                      })}
                    </svg>
                  );
                })()}
              </div>
            )}
          </>
        )}

        {/* TAB 5: Magnitude Curves */}
        {tab === "magnitude" && (
          <>
            <div className="space-y-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)]/65 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex gap-1">
                  {[
                    { label: "1M", d: 30 },
                    { label: "3M", d: 90 },
                    { label: "6M", d: 180 },
                    { label: "1Y", d: 365 },
                  ].map((p) => (
                    <button
                      key={p.label}
                      type="button"
                      onClick={() => setMagDays(p.d)}
                      className={`rounded border px-2 py-0.5 font-mono-num text-[10.5px] ${
                        magDays === p.d
                          ? "border-[var(--accent-primary)] bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]"
                          : "border-[var(--border-subtle)] bg-[var(--bg-surface)]"
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>

                <div className="flex items-center gap-1">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 px-2 text-[10px]"
                    onClick={() => setMagStartJd((j) => j - Math.round(magDays * 0.5))}
                  >
                    <ChevronLeft className="h-3 w-3" /> 前
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 px-2 text-[10px]"
                    onClick={() => setMagStartJd(jdUt - 15)}
                  >
                    現在付近
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 px-2 text-[10px]"
                    onClick={() => setMagStartJd((j) => j + Math.round(magDays * 0.5))}
                  >
                    次 <ChevronRight className="h-3 w-3" />
                  </Button>
                </div>
              </div>

              <div className="flex flex-wrap gap-1">
                {magBodyOptions.map((b) => {
                  const checked = magBodies.includes(b.id);
                  return (
                    <button
                      key={b.id}
                      type="button"
                      onClick={() =>
                        setMagBodies((prev) =>
                          checked ? prev.filter((x) => x !== b.id) : [...prev, b.id],
                        )
                      }
                      className={`rounded-md border px-2 py-0.5 text-[10px] ${
                        checked
                          ? "border-[var(--accent-primary)] bg-[var(--accent-primary)]/20 text-[var(--text-primary)]"
                          : "border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-muted)]"
                      }`}
                    >
                      {b.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {magSeries.length > 0 && (
              <div className="space-y-2 rounded-xl border border-[var(--border-subtle)] bg-[#040712] p-2.5">
                {(() => {
                  const allMags = magSeries.flatMap((s) => s.points.map((p) => p.mag));
                  const minMag = Math.floor(Math.min(...allMags, -2) - 0.5);
                  const maxMag = Math.ceil(Math.max(...allMags, 4) + 0.5);
                  const W = 440;
                  const H = 210;
                  const L = 34;
                  const R = 425;
                  const T = 14;
                  const B = 184;
                  const pw = R - L;
                  const ph = B - T;
                  const nPts = magSeries[0]?.points.length ?? 2;
                  const xOf = (idx: number) => L + (idx / Math.max(1, nPts - 1)) * pw;
                  const yOf = (m: number) => T + ((m - minMag) / Math.max(1, maxMag - minMag)) * ph;

                  const stepTick = Math.max(1, Math.floor((maxMag - minMag) / 5));
                  const ticks: number[] = [];
                  for (let m = minMag; m <= maxMag; m += stepTick) ticks.push(m);

                  return (
                    <>
                      <svg
                        viewBox={`0 0 ${W} ${H}`}
                        className="w-full cursor-crosshair"
                        onMouseMove={(e) => {
                          const rect = e.currentTarget.getBoundingClientRect();
                          const sx = ((e.clientX - rect.left) / rect.width) * W;
                          const rel = Math.max(0, Math.min(1, (sx - L) / pw));
                          setMagHoverIdx(Math.round(rel * (nPts - 1)));
                        }}
                        onMouseLeave={() => setMagHoverIdx(null)}
                        onClick={() => {
                          if (magHoverIdx !== null && magSeries[0]?.points[magHoverIdx]) {
                            jumpToJdUt(magSeries[0].points[magHoverIdx].jd_ut);
                          }
                        }}
                      >
                        {ticks.map((m) => (
                          <g key={m}>
                            <line
                              x1={L}
                              x2={R}
                              y1={yOf(m)}
                              y2={yOf(m)}
                              stroke="rgba(148,163,184,0.2)"
                              strokeDasharray="2 3"
                            />
                            <text x={L - 4} y={yOf(m) + 3} textAnchor="end" fontSize="8.5" fill="#94a3b8" fontFamily="monospace">
                              {m}等
                            </text>
                          </g>
                        ))}

                        {magSeries.map((ser) => (
                          <polyline
                            key={ser.id}
                            fill="none"
                            stroke={ser.color}
                            strokeWidth="1.9"
                            points={ser.points
                              .map((p, idx) => `${xOf(idx).toFixed(1)},${yOf(p.mag).toFixed(1)}`)
                              .join(" ")}
                          />
                        ))}

                        {magHoverIdx !== null && (
                          <line
                            x1={xOf(magHoverIdx)}
                            x2={xOf(magHoverIdx)}
                            y1={T}
                            y2={B}
                            stroke="#e2e8f0"
                            strokeWidth="1"
                            opacity="0.6"
                          />
                        )}

                        {[0, Math.floor((nPts - 1) / 2), nPts - 1].map((idx) =>
                          magSeries[0]?.points[idx] ? (
                            <text
                              key={idx}
                              x={xOf(idx)}
                              y={H - 8}
                              textAnchor={idx === 0 ? "start" : idx === nPts - 1 ? "end" : "middle"}
                              fontSize="8.5"
                              fill="#94a3b8"
                              fontFamily="monospace"
                            >
                              {magSeries[0].points[idx].date_label}
                            </text>
                          ) : null,
                        )}
                      </svg>

                      <div className="flex flex-wrap items-center gap-2 text-[10.5px]">
                        {magSeries.map((ser) => {
                          const pt =
                            magHoverIdx !== null ? ser.points[magHoverIdx] : ser.points[0];
                          return (
                            <span key={ser.id} className="inline-flex items-center gap-1 font-mono-num">
                              <span
                                className="h-2 w-2 rounded-full"
                                style={{ backgroundColor: ser.color }}
                              />
                              {ser.name_ja}: {pt ? `${pt.mag.toFixed(1)}等` : "--"}
                            </span>
                          );
                        })}
                      </div>
                    </>
                  );
                })()}
              </div>
            )}
          </>
        )}

        {/* TAB 6: Phenomena & Conjunction Finder */}
        {tab === "phenomena" && (
          <>
            <div className="space-y-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)]/65 p-3">
              <div className="flex flex-wrap gap-1">
                {[
                  { id: "phenomena" as const, label: "惑星現象 (衝/合/留/最大離角)" },
                  { id: "planet_planet" as const, label: "惑星接近" },
                  { id: "planet_cluster" as const, label: "複数惑星集合" },
                  { id: "planet_star" as const, label: "惑星と恒星接近" },
                ].map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => setPhenMode(m.id)}
                    className={`rounded-md border px-2 py-1 text-[10.5px] font-medium ${
                      phenMode === m.id
                        ? "border-[var(--accent-primary)] bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]"
                        : "border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)]"
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>

              <div className="flex flex-wrap items-center gap-2 text-[11px]">
                <label className="flex items-center gap-1">
                  開始年:
                  <NumberInput
                    integer
                    value={phenStartYear}
                    min={1900}
                    max={2200}
                    commitMin={1800}
                    commitMax={2300}
                    clampOnBlur
                    fallback={2026}
                    onValueChange={setPhenStartYear}
                    className="w-16 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-1.5 py-0.5 font-mono-num"
                  />
                </label>

                <select
                  value={phenSpanYears}
                  onChange={(e) => setPhenSpanYears(Number(e.target.value))}
                  className="rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 py-0.5"
                >
                  <option value={1}>1年間</option>
                  <option value={2}>2年間</option>
                  <option value={3}>3年間</option>
                </select>

                {phenMode === "phenomena" && (
                  <select
                    value={phenPlanetFilter}
                    onChange={(e) => setPhenPlanetFilter(e.target.value)}
                    className="rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 py-0.5"
                  >
                    <option value="all">全惑星</option>
                    <option value="mercury">水星</option>
                    <option value="venus">金星</option>
                    <option value="mars">火星</option>
                    <option value="jupiter">木星</option>
                    <option value="saturn">土星</option>
                    <option value="uranus">天王星</option>
                    <option value="neptune">海王星</option>
                  </select>
                )}

                {phenMode === "planet_planet" && (
                  <>
                    <label className="flex items-center gap-1">
                      離角≦
                      <NumberInput
                        step={0.5}
                        min={0.5}
                        max={15}
                        commitMin={0.1}
                        clampOnBlur
                        fallback={3}
                        value={conjMaxSep}
                        onValueChange={setConjMaxSep}
                        className="w-14 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-1.5 py-0.5 font-mono-num"
                      />
                      °
                    </label>
                    <label className="flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={conjIncludeMoon}
                        onChange={(e) => setConjIncludeMoon(e.target.checked)}
                      />
                      月を含む
                    </label>
                  </>
                )}

                {phenMode === "planet_cluster" && (
                  <>
                    <select
                      value={clusterMinCount}
                      onChange={(e) => setClusterMinCount(Number(e.target.value))}
                      className="rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 py-0.5"
                    >
                      <option value={3}>3惑星以上</option>
                      <option value={4}>4惑星以上</option>
                      <option value={5}>5惑星</option>
                    </select>
                    <label className="flex items-center gap-1">
                      範囲≦
                      <NumberInput
                        step={5}
                        min={10}
                        max={60}
                        commitMin={1}
                        clampOnBlur
                        fallback={25}
                        value={clusterMaxSpan}
                        onValueChange={setClusterMaxSpan}
                        className="w-14 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-1.5 py-0.5 font-mono-num"
                      />
                      °
                    </label>
                  </>
                )}

                {phenMode === "planet_star" && (
                  <>
                    <select
                      value={starHip ?? ""}
                      onChange={(e) =>
                        setStarHip(e.target.value === "" ? null : Number(e.target.value))
                      }
                      className="rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 py-0.5"
                    >
                      {BRIGHT_STAR_OPTIONS.map((st) => (
                        <option key={st.label} value={st.hip ?? ""}>
                          {st.label}
                        </option>
                      ))}
                    </select>
                    <label className="flex items-center gap-1">
                      離角≦
                      <NumberInput
                        step={0.5}
                        min={0.5}
                        max={10}
                        commitMin={0.1}
                        clampOnBlur
                        fallback={3}
                        value={conjMaxSep}
                        onValueChange={setConjMaxSep}
                        className="w-14 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-1.5 py-0.5 font-mono-num"
                      />
                      °
                    </label>
                  </>
                )}

                <Button
                  size="sm"
                  className="h-6 gap-1 px-2 text-[10.5px]"
                  onClick={runPhenomenaSearch}
                >
                  <RefreshCw className="h-3 w-3" /> 検索
                </Button>
              </div>
              <div className="text-[10px] text-[var(--text-muted)]">
                行をダブルクリック（または「再現」ボタン）で星図へ該当時刻・該当方位を即再現します
              </div>
            </div>

            {phenLoading ? (
              <div className="py-8 text-center text-xs text-[var(--text-muted)]">並列計算検索中...</div>
            ) : phenMode === "phenomena" ? (
              <div className="space-y-1">
                {phenRows.map((r, i) => (
                  <div
                    key={`${r.planet_id}-${r.kind}-${i}`}
                    onDoubleClick={() => jumpAndCenter(r.jd_ut, r.ra_deg, r.dec_deg, r.az_deg, r.alt_deg)}
                    className="flex cursor-pointer items-center justify-between gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)]/60 px-3 py-1.5 hover:border-[var(--accent-primary)]"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 font-semibold">
                        <span className="font-mono-num text-[10.5px] text-[var(--accent-primary)]">
                          {r.time_str}
                        </span>
                        <span>{r.planet_name_ja} {r.kind_ja}</span>
                      </div>
                      <div className="truncate text-[10px] text-[var(--text-muted)]">{r.detail_ja}</div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-6 shrink-0 px-2 text-[10px]"
                      onClick={() => jumpAndCenter(r.jd_ut, r.ra_deg, r.dec_deg, r.az_deg, r.alt_deg)}
                    >
                      再現
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="space-y-1">
                {conjRows.length === 0 ? (
                  <div className="py-8 text-center text-xs text-[var(--text-muted)]">
                    指定条件に該当する接近イベントはありません
                  </div>
                ) : (
                  conjRows.map((r, i) => (
                    <div
                      key={`${r.kind}-${i}`}
                      onDoubleClick={() => jumpAndCenter(r.jd_ut, r.ra_deg, r.dec_deg, r.az_deg, r.alt_deg)}
                      className="flex cursor-pointer items-center justify-between gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)]/60 px-3 py-1.5 hover:border-[var(--accent-primary)]"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 font-semibold">
                          <span className="font-mono-num text-[10.5px] text-[var(--accent-primary)]">
                            {r.time_str}
                          </span>
                          <span className="truncate">{r.title_ja}</span>
                        </div>
                        <div className="truncate text-[10px] text-[var(--text-muted)]">{r.detail_ja}</div>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 shrink-0 px-2 text-[10px]"
                        onClick={() => jumpAndCenter(r.jd_ut, r.ra_deg, r.dec_deg, r.az_deg, r.alt_deg)}
                      >
                        再現
                      </Button>
                    </div>
                  ))
                )}
              </div>
            )}
          </>
        )}

        {/* TAB 7: Galilean Moons & GRS */}
        {tab === "galilean" && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)]/65 px-3 py-2">
              <div className="flex items-center gap-1">
                {[3, 7, 14, 30].map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setGalSpanDays(d)}
                    className={`rounded border px-2 py-0.5 font-mono-num text-[10.5px] ${
                      galSpanDays === d
                        ? "border-[var(--accent-primary)] bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]"
                        : "border-[var(--border-subtle)] bg-[var(--bg-surface)]"
                    }`}
                  >
                    {d}日
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setGalInverted((v) => !v)}
                  className="ml-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 py-0.5 text-[10.5px]"
                >
                  {galInverted ? "倒立像 (S上)" : "正立 (N上)"}
                </button>
              </div>

              <div className="flex items-center gap-1.5 text-[10.5px]">
                <span>GRS経度(II):</span>
                <NumberInput
                  value={grsLon}
                  min={0}
                  max={359}
                  normalize={(v) => ((v % 360) + 360) % 360}
                  onValueChange={(v) => setGrsLon(((v % 360) + 360) % 360)}
                  className="w-14 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-1.5 py-0.5 font-mono-num"
                />
                <div className="flex gap-0.5">
                  <button
                    type="button"
                    onClick={() => stepTimeMinutes(-60)}
                    className="rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-1.5 py-0.5 font-mono-num"
                  >
                    -1h
                  </button>
                  <button
                    type="button"
                    onClick={() => stepTimeMinutes(60)}
                    className="rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-1.5 py-0.5 font-mono-num"
                  >
                    +1h
                  </button>
                </div>
              </div>
            </div>

            {galView && (
              <>
                {/* Instantaneous Orbital Arrangement (-28..+28 R_J) */}
                <div className="rounded-xl border border-[var(--border-subtle)] bg-[#040712] p-2.5">
                  <div className="mb-1 flex items-center justify-between text-[10.5px]">
                    <span className="font-mono-num">
                      CM I {galView.physical.cm_sys1_deg.toFixed(1)}° / CM II{" "}
                      {galView.physical.cm_sys2_deg.toFixed(1)}° / CM III{" "}
                      {galView.physical.cm_sys3_deg.toFixed(1)}°
                    </span>
                    <span
                      className={
                        galView.physical.grs_visible
                          ? "font-semibold text-amber-300"
                          : "text-[var(--text-muted)]"
                      }
                    >
                      {galView.physical.grs_visible
                        ? `★ 大赤斑 正面側 (${galView.physical.grs_offset_deg.toFixed(0)}°)`
                        : "大赤斑 裏側"}
                    </span>
                  </div>

                  <svg viewBox="0 0 460 72" className="w-full">
                    {(() => {
                      const sign = galInverted ? -1 : 1;
                      const mapX = (xRj: number) => 230 + sign * xRj * 7.5;
                      const moonCols: Record<string, string> = {
                        io: "#facc15",
                        europa: "#bae6fd",
                        ganymede: "#c4b5fd",
                        callisto: "#fca5a5",
                      };
                      return (
                        <>
                          <line x1="12" y1="36" x2="448" y2="36" stroke="rgba(148,163,184,0.22)" />
                          <text x="16" y="14" fontSize="9" fill="#94a3b8">
                            {galInverted ? "W (西)" : "E (東)"}
                          </text>
                          <text x="444" y="14" textAnchor="end" fontSize="9" fill="#94a3b8">
                            {galInverted ? "E (東)" : "W (西)"}
                          </text>

                          {/* Behind-Jupiter moons */}
                          {galView.moons
                            .filter((m) => m.z_rj < 0)
                            .map((m) => (
                              <circle
                                key={m.id}
                                cx={mapX(m.x_rj)}
                                cy={36 + sign * m.y_rj * 7.5}
                                r="3.4"
                                fill={m.in_eclipse ? "#475569" : moonCols[m.id] ?? "#fff"}
                                opacity={m.behind_disk ? 0.25 : 0.9}
                              />
                            ))}

                          {/* Jupiter central disc */}
                          <ellipse cx="230" cy="36" rx="7.5" ry="7.0" fill="#f4d8b3" />
                          {galView.physical.grs_visible && (
                            <circle
                              cx={230 + sign * Math.sin((galView.physical.grs_offset_deg * Math.PI) / 180) * 6.5}
                              cy={36 + sign * 2}
                              r="1.8"
                              fill="#ea580c"
                            />
                          )}

                          {/* Front moons + labels */}
                          {galView.moons.map((m, idx) => {
                            const mx = mapX(m.x_rj);
                            const my = 36 + sign * m.y_rj * 7.5;
                            const col = moonCols[m.id] ?? "#fff";
                            return (
                              <g key={m.id}>
                                {m.z_rj >= 0 && <circle cx={mx} cy={my} r="3.8" fill={col} />}
                                <text
                                  x={mx}
                                  y={idx % 2 === 0 ? 21 : 58}
                                  textAnchor="middle"
                                  fontSize="9"
                                  fill={col}
                                  fontFamily="monospace"
                                >
                                  {m.id === "io" ? "I" : m.id === "europa" ? "II" : m.id === "ganymede" ? "III" : "IV"}
                                </text>
                              </g>
                            );
                          })}
                        </>
                      );
                    })()}
                  </svg>

                  <div className="mt-1 grid grid-cols-4 gap-1 text-[10px]">
                    {galView.moons.map((m) => (
                      <div key={m.id} className="rounded bg-[var(--bg-surface)] px-1.5 py-1">
                        <div className="font-semibold">{m.name_ja}</div>
                        <div className="font-mono-num text-[9.5px] text-[var(--text-muted)]">
                          {m.x_rj.toFixed(1)}Rj ・{m.status_ja}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Galilean Sinusoidal Wave Chart */}
                <div className="rounded-xl border border-[var(--border-subtle)] bg-[#040712] p-2.5">
                  <div className="mb-1 flex items-center justify-between text-[10.5px]">
                    <span className="font-semibold">ガリレオ衛星 波動曲線 (クリックで時刻移動)</span>
                    <div className="flex gap-2 font-mono-num text-[9.5px]">
                      <span className="text-yellow-400">I イオ</span>
                      <span className="text-sky-200">II エウロパ</span>
                      <span className="text-violet-300">III ガニメデ</span>
                      <span className="text-rose-300">IV カリスト</span>
                    </div>
                  </div>
                  {(() => {
                    const samples = galView.wave_samples;
                    if (samples.length < 2) return null;
                    const W = 460;
                    const H = 200;
                    const L = 42;
                    const R = 445;
                    const sign = galInverted ? -1 : 1;
                    const cx = L + (R - L) * 0.5;
                    const xScale = (R - L) / 56;
                    const yOf = (i: number) => 10 + (i / (samples.length - 1)) * (H - 20);
                    const startJd = samples[0].jd_ut;
                    const endJd = samples[samples.length - 1].jd_ut;
                    const curRatio = (jdUt - startJd) / Math.max(1e-6, endJd - startJd);

                    const makePath = (pick: (s: (typeof samples)[number]) => number) =>
                      samples
                        .map((s, i) => `${(cx + sign * pick(s) * xScale).toFixed(1)},${yOf(i).toFixed(1)}`)
                        .join(" ");

                    return (
                      <svg
                        viewBox={`0 0 ${W} ${H}`}
                        className="w-full cursor-pointer"
                        onClick={(e) => {
                          const rect = e.currentTarget.getBoundingClientRect();
                          const sy = ((e.clientY - rect.top) / rect.height) * H;
                          const rel = Math.max(0, Math.min(1, (sy - 10) / (H - 20)));
                          jumpToJdUt(startJd + rel * (endJd - startJd));
                        }}
                      >
                        <rect
                          x={cx - xScale}
                          y="10"
                          width={xScale * 2}
                          height={H - 20}
                          fill="rgba(244, 216, 179, 0.2)"
                        />
                        <polyline fill="none" stroke="#fca5a5" strokeWidth="1.2" points={makePath((s) => s.callisto_x)} />
                        <polyline fill="none" stroke="#c4b5fd" strokeWidth="1.4" points={makePath((s) => s.ganymede_x)} />
                        <polyline fill="none" stroke="#bae6fd" strokeWidth="1.5" points={makePath((s) => s.europa_x)} />
                        <polyline fill="none" stroke="#facc15" strokeWidth="1.6" points={makePath((s) => s.io_x)} />

                        {curRatio >= 0 && curRatio <= 1 && (
                          <line
                            x1={L}
                            x2={R}
                            y1={10 + curRatio * (H - 20)}
                            y2={10 + curRatio * (H - 20)}
                            stroke="#38bdf8"
                            strokeWidth="1.2"
                            strokeDasharray="4 2"
                          />
                        )}

                        {[0, 0.25, 0.5, 0.75, 1].map((r) => {
                          const idx = Math.round(r * (samples.length - 1));
                          return (
                            <text
                              key={r}
                              x={L - 4}
                              y={yOf(idx) + 3}
                              textAnchor="end"
                              fontSize="8.5"
                              fill="#94a3b8"
                              fontFamily="monospace"
                            >
                              {samples[idx]?.time_label}
                            </text>
                          );
                        })}
                      </svg>
                    );
                  })()}
                </div>

                {/* GRS Transit Predictions */}
                <div className="space-y-1.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)]/65 p-2.5">
                  <div className="font-semibold text-[var(--text-secondary)]">
                    木星 大赤斑 (GRS {grsLon}°) 正中時刻予報（クリックでジャンプ）
                  </div>
                  <div className="grid grid-cols-2 gap-1">
                    {galView.grs_transits.slice(0, 8).map((tr) => (
                      <button
                        key={tr.jd_ut}
                        type="button"
                        onClick={() => jumpToJdUt(tr.jd_ut)}
                        className={`flex items-center justify-between rounded-lg border px-2 py-1 text-left font-mono-num text-[10px] transition ${
                          tr.observable
                            ? "border-emerald-500/35 bg-emerald-500/10 hover:border-emerald-400"
                            : "border-[var(--border-subtle)] bg-[var(--bg-surface)]/70 hover:border-[var(--accent-primary)]"
                        }`}
                      >
                        <span>{tr.time_str}</span>
                        <span className={tr.observable ? "font-semibold text-emerald-300" : "text-[var(--text-muted)]"}>
                          木星 {tr.jupiter_alt_deg.toFixed(0)}°
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
