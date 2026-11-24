import { useMemo, useState } from "react";
import { BookOpen, Compass, Search, Sparkles, Star, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { wrapDeg360 } from "@/lib/projection";
import { useSkyStore } from "@/store/skyStore";
import type { ConstellationEntry, ConstellationMyth, StarGuide } from "@/types/sky";

type EncTab = "constellations" | "stars";
type SeasonFilter = "all" | "春" | "夏" | "秋" | "冬" | "北天" | "南天";
type StarSortKey = "mag" | "dist" | "name";

function spectralColor(spectrum: string): string {
  const s = spectrum.trim().toUpperCase();
  if (s.startsWith("O") || s.startsWith("B")) return "#93c5fd";
  if (s.startsWith("A")) return "#e0f2fe";
  if (s.startsWith("F")) return "#fef9c3";
  if (s.startsWith("G")) return "#fde68a";
  if (s.startsWith("K")) return "#fdba74";
  if (s.startsWith("M")) return "#fca5a5";
  return "#bae6fd";
}

function j2000ToHor(
  raDeg: number,
  decDeg: number,
  mat: number[][],
  latDeg: number,
  lastDeg: number,
): { azDeg: number; altDeg: number; appRaDeg: number; appDecDeg: number } {
  const r = (raDeg * Math.PI) / 180;
  const d = (decDeg * Math.PI) / 180;
  const vx = Math.cos(d) * Math.cos(r);
  const vy = Math.cos(d) * Math.sin(r);
  const vz = Math.sin(d);
  const ax = mat[0][0] * vx + mat[0][1] * vy + mat[0][2] * vz;
  const ay = mat[1][0] * vx + mat[1][1] * vy + mat[1][2] * vz;
  const az = mat[2][0] * vx + mat[2][1] * vy + mat[2][2] * vz;
  const appRaDeg = wrapDeg360((Math.atan2(ay, ax) * 180) / Math.PI);
  const appDecDeg = (Math.asin(Math.max(-1, Math.min(1, az))) * 180) / Math.PI;
  const ha = ((wrapDeg360(lastDeg - appRaDeg + 180) - 180) * Math.PI) / 180;
  const lat = (latDeg * Math.PI) / 180;
  const decR = (appDecDeg * Math.PI) / 180;
  const sinAlt = Math.sin(lat) * Math.sin(decR) + Math.cos(lat) * Math.cos(decR) * Math.cos(ha);
  const altDeg = (Math.asin(Math.max(-1, Math.min(1, sinAlt))) * 180) / Math.PI;
  const y = -Math.sin(ha) * Math.cos(decR);
  const x = Math.cos(lat) * Math.sin(decR) - Math.sin(lat) * Math.cos(decR) * Math.cos(ha);
  const azDeg = wrapDeg360((Math.atan2(y, x) * 180) / Math.PI);
  return { azDeg, altDeg, appRaDeg, appDecDeg };
}

function ConstellationMiniSvg({ con }: { con?: ConstellationEntry | null }) {
  const { segments, nodes } = useMemo(() => {
    if (!con) return { segments: [] as [number, number][][], nodes: [] as [number, number][] };
    const lines =
      con.lines_standard.length > 0
        ? con.lines_standard
        : con.lines_simple.length > 0
          ? con.lines_simple
          : con.lines_detailed;
    if (lines.length === 0) return { segments: [] as [number, number][][], nodes: [] as [number, number][] };

    const a0 = (con.center_ra_deg * Math.PI) / 180;
    const d0 = (con.center_dec_deg * Math.PI) / 180;
    const cx = Math.cos(d0) * Math.cos(a0);
    const cy = Math.cos(d0) * Math.sin(a0);
    const cz = Math.sin(d0);
    // East unit vector in equatorial frame
    const ex = -Math.sin(a0);
    const ey = Math.cos(a0);
    const ez = 0;
    // North unit vector = center x east
    const nx = cy * ez - cz * ey;
    const ny = cz * ex - cx * ez;
    const nz = cx * ey - cy * ex;

    const proj = (raDeg: number, decDeg: number): [number, number] | null => {
      const a = (raDeg * Math.PI) / 180;
      const d = (decDeg * Math.PI) / 180;
      const vx = Math.cos(d) * Math.cos(a);
      const vy = Math.cos(d) * Math.sin(a);
      const vz = Math.sin(d);
      const dotC = Math.max(0.15, vx * cx + vy * cy + vz * cz);
      const px = -(vx * ex + vy * ey + vz * ez) / dotC;
      const py = -(vx * nx + vy * ny + vz * nz) / dotC;
      return [px, py];
    };

    const rawSegs: [number, number][][] = [];
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    for (const poly of lines) {
      const pts: [number, number][] = [];
      for (const [ra, dec] of poly) {
        const p = proj(ra, dec);
        if (!p) continue;
        pts.push(p);
        minX = Math.min(minX, p[0]);
        maxX = Math.max(maxX, p[0]);
        minY = Math.min(minY, p[1]);
        maxY = Math.max(maxY, p[1]);
      }
      if (pts.length >= 2) rawSegs.push(pts);
    }

    if (!Number.isFinite(minX)) return { segments: [], nodes: [] };
    const spanX = Math.max(0.05, maxX - minX);
    const spanY = Math.max(0.05, maxY - minY);
    const scale = Math.min(184 / spanX, 92 / spanY);
    const midX = (minX + maxX) * 0.5;
    const midY = (minY + maxY) * 0.5;

    const toSvg = ([x, y]: [number, number]): [number, number] => [
      110 + (x - midX) * scale,
      58 + (y - midY) * scale,
    ];

    const outSegs = rawSegs.map((poly) => poly.map(toSvg));
    const nodeMap = new Map<string, [number, number]>();
    for (const poly of outSegs) {
      for (const p of poly) {
        const key = `${Math.round(p[0])},${Math.round(p[1])}`;
        if (!nodeMap.has(key)) nodeMap.set(key, p);
      }
    }
    return { segments: outSegs, nodes: Array.from(nodeMap.values()) };
  }, [con]);

  return (
    <svg
      viewBox="0 0 220 116"
      className="h-28 w-full rounded-xl border border-[var(--border-subtle)] bg-[#030712]"
    >
      <defs>
        <radialGradient id="con-bg" cx="50%" cy="50%" r="70%">
          <stop offset="0%" stopColor="#0f172a" />
          <stop offset="100%" stopColor="#020617" />
        </radialGradient>
      </defs>
      <rect width="220" height="116" fill="url(#con-bg)" />
      {segments.map((poly, idx) => (
        <polyline
          key={idx}
          fill="none"
          stroke="#38bdf8"
          strokeWidth="1.4"
          strokeOpacity="0.82"
          points={poly.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ")}
        />
      ))}
      {nodes.map(([x, y], idx) => (
        <g key={idx}>
          <circle cx={x} cy={y} r="3.4" fill="#38bdf8" opacity="0.25" />
          <circle cx={x} cy={y} r="1.7" fill="#f8fafc" />
        </g>
      ))}
      {con && (
        <text
          x="10"
          y="15"
          fill="#94a3b8"
          fontSize="9"
          fontFamily="monospace"
        >
          {con.id} · {con.name_la}
        </text>
      )}
    </svg>
  );
}

export function Encyclopedia() {
  const staticAssets = useSkyStore((s) => s.staticAssets);
  const skyFrame = useSkyStore((s) => s.skyFrame);
  const location = useSkyStore((s) => s.location);
  const layers = useSkyStore((s) => s.layers);
  const setConstellationLineMode = useSkyStore((s) => s.setConstellationLineMode);
  const centerOnSkyCoords = useSkyStore((s) => s.centerOnSkyCoords);
  const selectObject = useSkyStore((s) => s.selectObject);
  const setActivePanel = useSkyStore((s) => s.setActivePanel);

  const [tab, setTab] = useState<EncTab>("constellations");
  const [conQuery, setConQuery] = useState("");
  const [seasonFilter, setSeasonFilter] = useState<SeasonFilter>("all");
  const [selectedConId, setSelectedConId] = useState<string>("Ori");

  const [starQuery, setStarQuery] = useState("");
  const [starSort, setStarSort] = useState<StarSortKey>("mag");
  const [selectedHip, setSelectedHip] = useState<number>(32349);

  const conById = useMemo(() => {
    const map = new Map<string, ConstellationEntry>();
    for (const c of staticAssets?.constellations ?? []) {
      map.set(c.id, c);
    }
    return map;
  }, [staticAssets?.constellations]);

  const namedStarByHip = useMemo(() => {
    const map = new Map<number, { ra_deg: number; dec_deg: number; mag: number }>();
    for (const s of staticAssets?.named_stars ?? []) {
      if (s.hip > 0) map.set(s.hip, { ra_deg: s.ra_deg, dec_deg: s.dec_deg, mag: s.mag });
    }
    return map;
  }, [staticAssets?.named_stars]);

  const mat = skyFrame?.j2000_to_apparent_matrix ?? [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  const lastDeg = skyFrame?.last_deg ?? 0;

  const filteredMyths = useMemo(() => {
    const list = staticAssets?.constellation_myths ?? [];
    const q = conQuery.trim().toLowerCase();
    return list.filter((m) => {
      if (seasonFilter !== "all" && !m.season.includes(seasonFilter)) return false;
      if (!q) return true;
      return (
        m.name_ja.toLowerCase().includes(q) ||
        m.name_la.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q) ||
        m.summary.toLowerCase().includes(q) ||
        m.notable_objects.some((o) => o.toLowerCase().includes(q))
      );
    });
  }, [staticAssets?.constellation_myths, conQuery, seasonFilter]);

  const activeMyth: ConstellationMyth | null =
    filteredMyths.find((m) => m.id === selectedConId) ??
    (staticAssets?.constellation_myths ?? []).find((m) => m.id === selectedConId) ??
    filteredMyths[0] ??
    null;

  const activeConEntry = activeMyth ? conById.get(activeMyth.id) ?? null : null;

  const activeConHor = useMemo(() => {
    if (!activeConEntry) return null;
    return j2000ToHor(
      activeConEntry.center_ra_deg,
      activeConEntry.center_dec_deg,
      mat,
      location.lat_deg,
      lastDeg,
    );
  }, [activeConEntry, mat, location.lat_deg, lastDeg]);

  const filteredStars = useMemo(() => {
    const list = [...(staticAssets?.star_guides ?? [])];
    const q = starQuery.trim().toLowerCase();
    const out = list.filter((s) => {
      if (!q) return true;
      const conJa = conById.get(s.constellation)?.name_ja ?? "";
      return (
        s.name_ja.toLowerCase().includes(q) ||
        s.name_en.toLowerCase().includes(q) ||
        s.constellation.toLowerCase().includes(q) ||
        conJa.toLowerCase().includes(q) ||
        `hip ${s.hip}`.includes(q)
      );
    });
    out.sort((a, b) => {
      if (starSort === "dist") return a.dist_ly - b.dist_ly;
      if (starSort === "name") return a.name_ja.localeCompare(b.name_ja, "ja");
      return a.mag - b.mag;
    });
    return out;
  }, [staticAssets?.star_guides, starQuery, starSort, conById]);

  const activeStar: StarGuide | null =
    filteredStars.find((s) => s.hip === selectedHip) ??
    (staticAssets?.star_guides ?? []).find((s) => s.hip === selectedHip) ??
    filteredStars[0] ??
    null;

  const handleShowConstellationInSky = () => {
    if (!activeConEntry || !activeConHor) return;
    if (layers.constellationLines === "off") {
      setConstellationLineMode("standard");
    }
    centerOnSkyCoords(
      activeConHor.appRaDeg,
      activeConHor.appDecDeg,
      activeConHor.azDeg,
      activeConHor.altDeg,
    );
  };

  const handleShowStarInSky = (star: StarGuide) => {
    const pos = namedStarByHip.get(star.hip);
    if (!pos) return;
    const hor = j2000ToHor(pos.ra_deg, pos.dec_deg, mat, location.lat_deg, lastDeg);
    selectObject(
      {
        kind: "star",
        id: `HIP ${star.hip}`,
        name_ja: star.name_ja,
        name_en: star.name_en,
        constellation: star.constellation,
        mag: star.mag,
        ra_deg: hor.appRaDeg,
        dec_deg: hor.appDecDeg,
        az_deg: hor.azDeg,
        alt_deg: hor.altDeg,
        dist_text: `${star.dist_ly.toFixed(1)} 光年`,
        angular_sep_deg: 0,
        extra_info: `${star.bayer} ${star.constellation} (${star.spectrum})`,
      },
      true,
    );
  };

  return (
    <aside className="flex h-full w-[29rem] max-w-[calc(100vw-5.5rem)] flex-col rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface-glass)] text-[var(--text-primary)] shadow-2xl backdrop-blur-md">
      {/* Header */}
      <div className="flex items-start justify-between gap-2 border-b border-[var(--border-subtle)] px-4 py-3">
        <div>
          <h2 className="flex items-center gap-1.5 text-sm font-semibold tracking-tight">
            <BookOpen className="h-4 w-4 text-amber-300" /> 星座の解説と神話・恒星図鑑
          </h2>
          <p className="text-[11px] text-[var(--text-muted)]">
            全 {(staticAssets?.constellation_myths ?? []).length} 星座の解説・見つけ方・神話 &amp; 主要{" "}
            {(staticAssets?.star_guides ?? []).length} 恒星ガイド
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

      {/* Tabs */}
      <div className="flex gap-1 border-b border-[var(--border-subtle)] px-4 py-2 text-xs">
        <button
          type="button"
          onClick={() => setTab("constellations")}
          className={`flex items-center gap-1 rounded-lg px-3 py-1 font-medium transition ${
            tab === "constellations"
              ? "bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]"
              : "bg-[var(--bg-surface)] text-[var(--text-secondary)]"
          }`}
        >
          <Sparkles className="h-3.5 w-3.5" />
          全88星座の解説・神話
        </button>
        <button
          type="button"
          onClick={() => setTab("stars")}
          className={`flex items-center gap-1 rounded-lg px-3 py-1 font-medium transition ${
            tab === "stars"
              ? "bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]"
              : "bg-[var(--bg-surface)] text-[var(--text-secondary)]"
          }`}
        >
          <Star className="h-3.5 w-3.5" />
          主要恒星の解説 ({(staticAssets?.star_guides ?? []).length})
        </button>
      </div>

      {tab === "constellations" ? (
        <div className="flex min-h-0 flex-1 flex-col">
          {/* Constellation Filter Controls */}
          <div className="space-y-2 border-b border-[var(--border-subtle)] px-4 py-2.5 text-xs">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]" />
              <input
                type="text"
                value={conQuery}
                onChange={(e) => setConQuery(e.target.value)}
                placeholder="星座名・学名・見どころ天体 (M42 / オリオン など)"
                className="h-8 w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] pr-3 pl-8 text-xs outline-none focus:border-[var(--accent-primary)]"
              />
            </div>
            <div className="flex flex-wrap gap-1">
              {(
                [
                  { id: "all", label: "すべて" },
                  { id: "春", label: "春" },
                  { id: "夏", label: "夏" },
                  { id: "秋", label: "秋" },
                  { id: "冬", label: "冬" },
                  { id: "北天", label: "北天周極" },
                  { id: "南天", label: "南天" },
                ] as const
              ).map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setSeasonFilter(s.id)}
                  className={`rounded-md border px-2 py-0.5 text-[10px] font-medium transition ${
                    seasonFilter === s.id
                      ? "border-[var(--accent-primary)] bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]"
                      : "border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)]"
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-3 text-xs">
            {/* Active Constellation Detail Card */}
            {activeMyth && (
              <div className="mb-3 space-y-2.5 rounded-xl border border-amber-400/35 bg-[var(--bg-surface-elevated)] p-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-medium text-amber-200">
                        {activeMyth.season}
                      </span>
                      <span className="font-mono-num text-[10px] text-[var(--text-muted)]">
                        {activeMyth.id} · {activeMyth.name_la}
                      </span>
                      {activeConHor && (
                        <span
                          className={`font-mono-num text-[10px] ${
                            activeConHor.altDeg >= 0 ? "text-emerald-300" : "text-[var(--text-muted)]"
                          }`}
                        >
                          高度 {activeConHor.altDeg.toFixed(0)}°
                        </span>
                      )}
                    </div>
                    <h3 className="mt-1 text-base font-bold">{activeMyth.name_ja}</h3>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    className="h-7 shrink-0 gap-1 px-2.5 text-[11px]"
                    disabled={!activeConEntry}
                    onClick={handleShowConstellationInSky}
                  >
                    <Compass className="h-3.5 w-3.5" />
                    プラネタリウムで表示
                  </Button>
                </div>

                <ConstellationMiniSvg con={activeConEntry} />

                <div className="space-y-1.5 text-[11px] leading-relaxed">
                  <div>
                    <span className="font-semibold text-sky-300">特徴: </span>
                    <span className="text-[var(--text-primary)]">{activeMyth.summary}</span>
                  </div>
                  <div>
                    <span className="font-semibold text-emerald-300">見つけ方: </span>
                    <span className="text-[var(--text-secondary)]">{activeMyth.how_to_find}</span>
                  </div>
                  <div>
                    <span className="font-semibold text-amber-300">神話・由来: </span>
                    <span className="text-[var(--text-secondary)]">{activeMyth.mythology}</span>
                  </div>
                  {activeMyth.notable_objects.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1 pt-1">
                      <span className="text-[10px] font-semibold text-[var(--text-muted)]">
                        主な見どころ:
                      </span>
                      {activeMyth.notable_objects.map((obj, idx) => (
                        <span
                          key={idx}
                          className="rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-1.5 py-0.5 text-[10px]"
                        >
                          {obj}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* 88 Constellation Chips / List */}
            <div className="grid grid-cols-2 gap-1.5">
              {filteredMyths.map((m) => {
                const sel = activeMyth?.id === m.id;
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => setSelectedConId(m.id)}
                    className={`rounded-lg border px-2.5 py-1.5 text-left transition ${
                      sel
                        ? "border-[var(--accent-primary)] bg-[var(--accent-primary)]/15"
                        : "border-[var(--border-subtle)] bg-[var(--bg-surface)] hover:bg-[var(--bg-surface-elevated)]"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1">
                      <span className="truncate font-semibold">{m.name_ja}</span>
                      <span className="font-mono-num text-[9px] text-[var(--text-muted)]">{m.id}</span>
                    </div>
                    <div className="truncate text-[10px] text-[var(--text-muted)]">
                      {m.season} · {m.name_la}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {/* Star Search & Sort */}
          <div className="flex items-center gap-2 border-b border-[var(--border-subtle)] px-4 py-2.5 text-xs">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]" />
              <input
                type="text"
                value={starQuery}
                onChange={(e) => setStarQuery(e.target.value)}
                placeholder="恒星名・星座名・HIP番号で絞り込み..."
                className="h-8 w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] pr-3 pl-8 text-xs outline-none focus:border-[var(--accent-primary)]"
              />
            </div>
            <select
              value={starSort}
              onChange={(e) => setStarSort(e.target.value as StarSortKey)}
              className="h-8 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 text-[11px]"
            >
              <option value="mag">明るさ順</option>
              <option value="dist">近い順</option>
              <option value="name">名前順</option>
            </select>
          </div>

          <div className="flex-1 space-y-2.5 overflow-y-auto px-4 py-3 text-xs">
            {activeStar && (
              <div className="space-y-2 rounded-xl border border-sky-400/35 bg-[var(--bg-surface-elevated)] p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-start gap-2.5">
                    <span
                      className="mt-1 h-4 w-4 shrink-0 rounded-full shadow"
                      style={{
                        backgroundColor: spectralColor(activeStar.spectrum),
                        boxShadow: `0 0 12px ${spectralColor(activeStar.spectrum)}`,
                      }}
                    />
                    <div>
                      <div className="flex flex-wrap items-center gap-1.5 font-mono-num text-[10px] text-[var(--text-muted)]">
                        <span>
                          {conById.get(activeStar.constellation)?.name_ja ?? activeStar.constellation} (
                          {activeStar.bayer || activeStar.constellation})
                        </span>
                        <span>· HIP {activeStar.hip}</span>
                        <span>· {activeStar.mag.toFixed(2)}等</span>
                        <span>· {activeStar.dist_ly.toFixed(1)}光年</span>
                      </div>
                      <h3 className="mt-0.5 text-base font-bold">{activeStar.name_ja}</h3>
                      <p className="text-[11px] text-[var(--text-muted)]">
                        {activeStar.name_en} · スペクトル {activeStar.spectrum}
                      </p>
                    </div>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    className="h-7 shrink-0 gap-1 px-2.5 text-[11px]"
                    onClick={() => handleShowStarInSky(activeStar)}
                  >
                    <Compass className="h-3.5 w-3.5" />
                    プラネタリウムで表示
                  </Button>
                </div>

                <p className="rounded-lg bg-[var(--bg-surface)] px-2.5 py-1.5 text-[11px] font-medium text-amber-200">
                  {activeStar.summary_ja}
                </p>
                <p className="text-[11px] leading-relaxed text-[var(--text-secondary)]">
                  {activeStar.commentary_ja}
                </p>
              </div>
            )}

            <div className="space-y-1.5">
              {filteredStars.map((s) => {
                const sel = activeStar?.hip === s.hip;
                const conJa = conById.get(s.constellation)?.name_ja ?? s.constellation;
                return (
                  <button
                    key={s.hip}
                    type="button"
                    onClick={() => setSelectedHip(s.hip)}
                    className={`flex w-full items-center justify-between gap-2 rounded-xl border px-3 py-2 text-left transition ${
                      sel
                        ? "border-[var(--accent-primary)] bg-[var(--accent-primary)]/15"
                        : "border-[var(--border-subtle)] bg-[var(--bg-surface)] hover:bg-[var(--bg-surface-elevated)]"
                    }`}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: spectralColor(s.spectrum) }}
                      />
                      <div className="min-w-0">
                        <div className="truncate font-semibold">{s.name_ja}</div>
                        <div className="truncate text-[10px] text-[var(--text-muted)]">
                          {conJa} {s.bayer} · {s.spectrum}
                        </div>
                      </div>
                    </div>
                    <div className="shrink-0 text-right font-mono-num text-[11px]">
                      <div className="text-amber-200">{s.mag.toFixed(2)}等</div>
                      <div className="text-[10px] text-[var(--text-muted)]">
                        {s.dist_ly.toFixed(1)}光年
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
