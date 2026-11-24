import {
  ArrowDown,
  ArrowUp,
  Globe,
  GripVertical,
  LocateFixed,
  MapPin,
  Minus,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import { type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { JAPAN_PREFECTURES, WORLD_LAND_RINGS } from "@/lib/geoMapData";
import { useSkyStore } from "@/store/skyStore";
import type { LocationPreset } from "@/types/sky";

const JP_W = 320;
const JP_H = 300;
const JP_LON_MIN = 121.2;
const JP_LON_MAX = 149.2;
const JP_LAT_MIN = 23.2;
const JP_LAT_MAX = 46.0;

const WORLD_W = 320;
const WORLD_H = 165;
const WORLD_LON_MIN = -180;
const WORLD_LON_MAX = 180;
const WORLD_LAT_MIN = -62;
const WORLD_LAT_MAX = 84;

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

function mercY(latDeg: number): number {
  const rad = Math.max(-85, Math.min(85, latDeg)) * DEG2RAD;
  return Math.log(Math.tan(Math.PI / 4 + rad / 2));
}

const JP_MY_MIN = mercY(JP_LAT_MIN);
const JP_MY_MAX = mercY(JP_LAT_MAX);

function projectJapanXY(lon: number, lat: number): [number, number] {
  const x = ((lon - JP_LON_MIN) / (JP_LON_MAX - JP_LON_MIN)) * JP_W;
  const y = ((JP_MY_MAX - mercY(lat)) / (JP_MY_MAX - JP_MY_MIN)) * JP_H;
  return [x, y];
}

function unprojectJapanXY(x: number, y: number): [number, number] {
  const lon = JP_LON_MIN + (x / JP_W) * (JP_LON_MAX - JP_LON_MIN);
  const my = JP_MY_MAX - (y / JP_H) * (JP_MY_MAX - JP_MY_MIN);
  const lat = (2 * Math.atan(Math.exp(my)) - Math.PI / 2) * RAD2DEG;
  return [lon, lat];
}

function projectWorldXY(lon: number, lat: number): [number, number] {
  const x = ((lon - WORLD_LON_MIN) / (WORLD_LON_MAX - WORLD_LON_MIN)) * WORLD_W;
  const y = ((WORLD_LAT_MAX - lat) / (WORLD_LAT_MAX - WORLD_LAT_MIN)) * WORLD_H;
  return [x, y];
}

function unprojectWorldXY(x: number, y: number): [number, number] {
  const lon = WORLD_LON_MIN + (x / WORLD_W) * (WORLD_LON_MAX - WORLD_LON_MIN);
  const lat = WORLD_LAT_MAX - (y / WORLD_H) * (WORLD_LAT_MAX - WORLD_LAT_MIN);
  return [lon, lat];
}

function ringsToSvgPath(rings: number[][], proj: (lon: number, lat: number) => [number, number]): string {
  let d = "";
  for (const r of rings) {
    if (r.length < 6) continue;
    const [x0, y0] = proj(r[0], r[1]);
    d += `M${x0.toFixed(2)},${y0.toFixed(2)}`;
    for (let i = 2; i < r.length; i += 2) {
      const [x, y] = proj(r[i], r[i + 1]);
      d += `L${x.toFixed(2)},${y.toFixed(2)}`;
    }
    d += "Z";
  }
  return d;
}

function clampMapPan(x: number, y: number, zoom: number, baseW: number, baseH: number): { x: number; y: number } {
  const vbW = baseW / zoom;
  const vbH = baseH / zoom;
  return {
    x: Math.max(0, Math.min(Math.max(0, baseW - vbW), x)),
    y: Math.max(0, Math.min(Math.max(0, baseH - vbH), y)),
  };
}

export function LocationManager() {
  const location = useSkyStore((s) => s.location);
  const locationsList = useSkyStore((s) => s.locationsList);
  const setLocation = useSkyStore((s) => s.setLocation);
  const addLocation = useSkyStore((s) => s.addLocation);
  const updateLocation = useSkyStore((s) => s.updateLocation);
  const deleteLocation = useSkyStore((s) => s.deleteLocation);
  const reorderLocations = useSkyStore((s) => s.reorderLocations);
  const resetLocationsToPresets = useSkyStore((s) => s.resetLocationsToPresets);
  const acquireGpsLocation = useSkyStore((s) => s.acquireGpsLocation);
  const gpsLoading = useSkyStore((s) => s.gpsLoading);
  const gpsStatus = useSkyStore((s) => s.gpsStatus);
  const setActivePanel = useSkyStore((s) => s.setActivePanel);

  const [query, setQuery] = useState("");
  const [catFilter, setCatFilter] = useState<"all" | "japan" | "overseas" | "custom">("all");
  const [mapMode, setMapMode] = useState<"off" | "japan" | "world">("japan");
  const [mapZoom, setMapZoom] = useState<number>(1);
  const [mapPan, setMapPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [hoveredPref, setHoveredPref] = useState<string | null>(null);
  const [hoveredCity, setHoveredCity] = useState<string | null>(null);
  const [hoverCoords, setHoverCoords] = useState<{ lat: number; lon: number } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [dragIdx, setDragIdx] = useState<number | null>(null);

  const mapSvgRef = useRef<SVGSVGElement | null>(null);
  const mapViewRef = useRef({ zoom: 1, panX: 0, panY: 0, mode: "japan" as "off" | "japan" | "world" });
  const mapGestureRef = useRef<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    startPanX: number;
    startPanY: number;
    moved: boolean;
  } | null>(null);

  const [form, setForm] = useState({
    name_ja: "新しい観測地",
    name_en: "Custom Site",
    country_ja: "日本",
    region: "カスタム",
    lat_deg: location.lat_deg,
    lon_deg: location.lon_deg,
    alt_m: location.alt_m,
    tz_offset_min: location.tz_offset_min,
    tz_name: location.tz_name,
  });

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return locationsList
      .map((loc, idx) => ({ loc, idx }))
      .filter(({ loc }) => {
        if (catFilter === "japan" && loc.category !== "japan") return false;
        if (catFilter === "overseas" && loc.category === "japan") return false;
        if (catFilter === "custom" && !loc.id.startsWith("custom_") && loc.id !== "gps_current") return false;
        if (!q) return true;
        return (
          loc.name_ja.toLowerCase().includes(q) ||
          loc.name_en.toLowerCase().includes(q) ||
          loc.region.toLowerCase().includes(q) ||
          loc.country_ja.toLowerCase().includes(q)
        );
      });
  }, [locationsList, query, catFilter]);

  const startCreate = () => {
    setEditingId(null);
    setForm({
      name_ja: "マイ観測地",
      name_en: "My Observatory",
      country_ja: "日本",
      region: "カスタム",
      lat_deg: Number(location.lat_deg.toFixed(4)),
      lon_deg: Number(location.lon_deg.toFixed(4)),
      alt_m: Math.round(location.alt_m),
      tz_offset_min: location.tz_offset_min,
      tz_name: location.tz_name,
    });
    setShowForm(true);
  };

  const startEdit = (loc: LocationPreset) => {
    setEditingId(loc.id);
    setForm({
      name_ja: loc.name_ja,
      name_en: loc.name_en,
      country_ja: loc.country_ja,
      region: loc.region,
      lat_deg: loc.lat_deg,
      lon_deg: loc.lon_deg,
      alt_m: loc.alt_m,
      tz_offset_min: loc.tz_offset_min,
      tz_name: loc.tz_name,
    });
    setShowForm(true);
  };

  const japanPaths = useMemo(
    () =>
      JAPAN_PREFECTURES.map((p) => ({
        id: p.id,
        nameJa: p.nameJa,
        d: ringsToSvgPath(p.rings, projectJapanXY),
      })),
    [],
  );

  const worldPathD = useMemo(() => ringsToSvgPath(WORLD_LAND_RINGS, projectWorldXY), []);

  const baseW = mapMode === "japan" ? JP_W : WORLD_W;
  const baseH = mapMode === "japan" ? JP_H : WORLD_H;
  const vbW = baseW / mapZoom;
  const vbH = baseH / mapZoom;
  const clampedPan = clampMapPan(mapPan.x, mapPan.y, mapZoom, baseW, baseH);
  mapViewRef.current = { zoom: mapZoom, panX: clampedPan.x, panY: clampedPan.y, mode: mapMode };

  const switchMapMode = (nextMode: "off" | "japan" | "world") => {
    setMapMode(nextMode);
    setMapZoom(1);
    setMapPan({ x: 0, y: 0 });
    setHoveredPref(null);
    setHoveredCity(null);
    setHoverCoords(null);
  };

  const applyMapZoom = (nextZoomRaw: number, anchorU = 0.5, anchorV = 0.5) => {
    const nextZoom = Math.max(1, Math.min(8, nextZoomRaw));
    const cur = mapViewRef.current;
    const bW = cur.mode === "japan" ? JP_W : WORLD_W;
    const bH = cur.mode === "japan" ? JP_H : WORLD_H;
    const curW = bW / cur.zoom;
    const curH = bH / cur.zoom;
    const anchorSvgX = cur.panX + anchorU * curW;
    const anchorSvgY = cur.panY + anchorV * curH;
    const nextW = bW / nextZoom;
    const nextH = bH / nextZoom;
    const nextPan = clampMapPan(
      anchorSvgX - anchorU * nextW,
      anchorSvgY - anchorV * nextH,
      nextZoom,
      bW,
      bH,
    );
    setMapZoom(nextZoom);
    setMapPan(nextPan);
  };

  useEffect(() => {
    const svg = mapSvgRef.current;
    if (!svg || mapMode === "off") return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const u = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const v = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
      const factor = e.deltaY < 0 ? 1.3 : 1 / 1.3;
      applyMapZoom(mapViewRef.current.zoom * factor, u, v);
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [mapMode]);

  const clientToSvgXY = (clientX: number, clientY: number, svg: SVGSVGElement): [number, number] => {
    const rect = svg.getBoundingClientRect();
    const u = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
    const v = Math.max(0, Math.min(1, (clientY - rect.top) / Math.max(1, rect.height)));
    const cur = mapViewRef.current;
    const bW = cur.mode === "japan" ? JP_W : WORLD_W;
    const bH = cur.mode === "japan" ? JP_H : WORLD_H;
    return [cur.panX + u * (bW / cur.zoom), cur.panY + v * (bH / cur.zoom)];
  };

  const toMapXY = (lon: number, lat: number): [number, number] =>
    mapMode === "japan" ? projectJapanXY(lon, lat) : projectWorldXY(lon, lat);

  const fromMapXY = (sx: number, sy: number): [number, number] =>
    mapMode === "japan" ? unprojectJapanXY(sx, sy) : unprojectWorldXY(sx, sy);

  const handleMapPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    mapGestureRef.current = {
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startPanX: clampedPan.x,
      startPanY: clampedPan.y,
      moved: false,
    };
  };

  const handleMapPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const svg = e.currentTarget;
    const [sx, sy] = clientToSvgXY(e.clientX, e.clientY, svg);
    const [lon, lat] = fromMapXY(sx, sy);
    setHoverCoords({
      lat: Math.max(-85, Math.min(85, lat)),
      lon: Math.max(-180, Math.min(180, lon)),
    });

    const g = mapGestureRef.current;
    if (!g || g.pointerId !== e.pointerId) return;
    const dxPx = e.clientX - g.startClientX;
    const dyPx = e.clientY - g.startClientY;
    if (Math.hypot(dxPx, dyPx) >= 5) {
      g.moved = true;
    }
    if (g.moved && mapZoom > 1) {
      const rect = svg.getBoundingClientRect();
      const svgDx = (dxPx / Math.max(1, rect.width)) * vbW;
      const svgDy = (dyPx / Math.max(1, rect.height)) * vbH;
      setMapPan(clampMapPan(g.startPanX - svgDx, g.startPanY - svgDy, mapZoom, baseW, baseH));
    }
  };

  const handleMapPointerUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    const g = mapGestureRef.current;
    if (!g || g.pointerId !== e.pointerId) return;
    const wasMoved = g.moved;
    mapGestureRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // Ignore capture release failures
      }
    }
    if (wasMoved) return;

    const [sx, sy] = clientToSvgXY(e.clientX, e.clientY, e.currentTarget);
    if (!showForm) {
      const hitLimit = 6.5 / mapZoom;
      let nearestLoc: LocationPreset | null = null;
      let nearestDist = hitLimit;
      for (const loc of locationsList) {
        const [px, py] = toMapXY(loc.lon_deg, loc.lat_deg);
        if (px < 0 || px > baseW || py < 0 || py > baseH) continue;
        const d = Math.hypot(px - sx, py - sy);
        if (d < nearestDist) {
          nearestDist = d;
          nearestLoc = loc;
        }
      }
      if (nearestLoc) {
        setLocation(nearestLoc);
        return;
      }
    }

    const [rawLon, rawLat] = fromMapXY(sx, sy);
    const clampedLat = Number(Math.max(-85, Math.min(85, rawLat)).toFixed(4));
    const clampedLon = Number(Math.max(-180, Math.min(180, rawLon)).toFixed(4));
    if (showForm) {
      setForm((f) => ({ ...f, lat_deg: clampedLat, lon_deg: clampedLon }));
    } else {
      updateLocation({ ...location, lat_deg: clampedLat, lon_deg: clampedLon });
    }
  };

  const activeLat = showForm ? form.lat_deg : location.lat_deg;
  const activeLon = showForm ? form.lon_deg : location.lon_deg;
  const [pinX, pinY] = toMapXY(activeLon, activeLat);
  const displayCoords = hoverCoords ?? { lat: activeLat, lon: activeLon };

  return (
    <aside className="pointer-events-auto flex max-h-full w-[24rem] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface-glass)] shadow-2xl backdrop-blur-md">
      <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-3.5 py-2.5">
        <div className="flex items-center gap-2 text-xs font-semibold">
          <MapPin className="h-4 w-4 text-[var(--accent-secondary)]" />
          <span>観測地マネージャー ({locationsList.length}件)</span>
        </div>
        <Button type="button" size="icon" variant="ghost" className="h-6 w-6" onClick={() => setActivePanel(null)}>
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto p-3 text-xs">
        {/* GPS Location Action */}
        <div className="space-y-1.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)]/75 p-2">
          <Button
            type="button"
            size="sm"
            variant="tonal"
            className="h-8 w-full justify-center gap-1.5 rounded-xl text-xs font-semibold"
            onClick={() => void acquireGpsLocation()}
            disabled={gpsLoading}
          >
            <LocateFixed className={`h-3.5 w-3.5 ${gpsLoading ? "animate-pulse" : ""}`} />
            {gpsLoading ? "GPS測位中..." : "GPSで現在地を取得して設定"}
          </Button>
          {gpsStatus && (
            <div className="text-[10.5px] leading-snug text-[var(--text-secondary)]">
              {gpsStatus}
            </div>
          )}
        </div>

        {/* Interactive Map Picker Toggle */}
        <div className="flex items-center justify-between gap-1">
          <div className="flex gap-1">
            {(["japan", "world", "off"] as const).map((m) => (
              <Button
                key={m}
                type="button"
                size="sm"
                variant={mapMode === m ? "default" : "outline"}
                className="h-6 px-2 text-[10px]"
                onClick={() => switchMapMode(m)}
              >
                <Globe className="h-3 w-3" />
                {m === "japan" ? "日本地図" : m === "world" ? "世界地図" : "地図非表示"}
              </Button>
            ))}
          </div>
          <Button type="button" size="sm" variant="outline" className="h-6 px-2 text-[10px]" onClick={startCreate}>
            <Plus className="h-3 w-3" />
            追加
          </Button>
        </div>

        {/* High-Precision Offline Interactive SVG Map Picker */}
        {mapMode !== "off" && (
          <div className="space-y-1.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-1.5">
            <div className="relative overflow-hidden rounded-lg border border-sky-400/15 bg-[#040d1d]">
              <svg
                ref={mapSvgRef}
                viewBox={`${clampedPan.x.toFixed(2)} ${clampedPan.y.toFixed(2)} ${vbW.toFixed(2)} ${vbH.toFixed(2)}`}
                onPointerDown={handleMapPointerDown}
                onPointerMove={handleMapPointerMove}
                onPointerUp={handleMapPointerUp}
                onPointerCancel={handleMapPointerUp}
                onPointerLeave={() => {
                  setHoveredPref(null);
                  setHoveredCity(null);
                  setHoverCoords(null);
                }}
                style={{ touchAction: mapZoom > 1 ? "none" : "pan-y" }}
                className={`block w-full select-none ${
                  mapMode === "japan" ? "aspect-[320/300]" : "aspect-[320/165]"
                } ${mapZoom > 1 ? "cursor-grab active:cursor-grabbing" : "cursor-crosshair"}`}
              >
                <defs>
                  <linearGradient id="starcrane-sea-grad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#07152c" />
                    <stop offset="60%" stopColor="#051024" />
                    <stop offset="100%" stopColor="#030a18" />
                  </linearGradient>
                  <radialGradient id="starcrane-pin-halo" cx="50%" cy="50%" r="50%">
                    <stop offset="0%" stopColor="#fbbf24" stopOpacity="0.65" />
                    <stop offset="100%" stopColor="#fbbf24" stopOpacity="0" />
                  </radialGradient>
                </defs>

                <rect x={0} y={0} width={baseW} height={baseH} fill="url(#starcrane-sea-grad)" />

                {/* Graticule Lines */}
                <g stroke="rgba(148, 163, 184, 0.14)" strokeWidth={0.6} vectorEffect="non-scaling-stroke">
                  {mapMode === "japan"
                    ? [125, 130, 135, 140, 145].map((lon) => {
                        const [gx] = projectJapanXY(lon, 35);
                        return <line key={`lon-${lon}`} x1={gx} y1={0} x2={gx} y2={JP_H} />;
                      })
                    : [-150, -120, -90, -60, -30, 0, 30, 60, 90, 120, 150].map((lon) => {
                        const [gx] = projectWorldXY(lon, 0);
                        return (
                          <line
                            key={`lon-${lon}`}
                            x1={gx}
                            y1={0}
                            x2={gx}
                            y2={WORLD_H}
                            strokeDasharray={lon === 0 ? "3 2" : undefined}
                          />
                        );
                      })}
                  {mapMode === "japan"
                    ? [25, 30, 35, 40, 45].map((lat) => {
                        const [, gy] = projectJapanXY(135, lat);
                        return <line key={`lat-${lat}`} x1={0} y1={gy} x2={JP_W} y2={gy} />;
                      })
                    : [-30, 0, 30, 60].map((lat) => {
                        const [, gy] = projectWorldXY(0, lat);
                        return (
                          <line
                            key={`lat-${lat}`}
                            x1={0}
                            y1={gy}
                            x2={WORLD_W}
                            stroke={lat === 0 ? "rgba(56, 189, 248, 0.28)" : undefined}
                          />
                        );
                      })}
                </g>

                {/* Subtle Graticule Coordinate Labels */}
                {mapMode === "japan" && (
                  <g
                    fill="rgba(148, 163, 184, 0.48)"
                    fontSize={7 / Math.sqrt(mapZoom)}
                    fontFamily="monospace"
                    className="pointer-events-none"
                  >
                    {[125, 130, 135, 140, 145].map((lon) => {
                      const [gx] = projectJapanXY(lon, 35);
                      return (
                        <text key={`tlon-${lon}`} x={gx + 2 / mapZoom} y={clampedPan.y + vbH - 3 / mapZoom}>
                          {lon}°E
                        </text>
                      );
                    })}
                    {[25, 30, 35, 40, 45].map((lat) => {
                      const [, gy] = projectJapanXY(135, lat);
                      return (
                        <text key={`tlat-${lat}`} x={clampedPan.x + 3 / mapZoom} y={gy - 2 / mapZoom}>
                          {lat}°N
                        </text>
                      );
                    })}
                  </g>
                )}

                {/* Landmass / Prefectures Polygons */}
                {mapMode === "japan" ? (
                  <g strokeLinejoin="round">
                    {japanPaths.map((p) => {
                      const isHover = hoveredPref === p.nameJa;
                      return (
                        <path
                          key={p.id}
                          d={p.d}
                          fill={isHover ? "rgba(56, 189, 248, 0.34)" : "rgba(26, 78, 128, 0.42)"}
                          stroke={isHover ? "rgba(186, 230, 253, 0.9)" : "rgba(103, 211, 252, 0.46)"}
                          strokeWidth={isHover ? 1.15 : 0.72}
                          vectorEffect="non-scaling-stroke"
                          onPointerEnter={() => setHoveredPref(p.nameJa)}
                          onPointerLeave={() => setHoveredPref((cur) => (cur === p.nameJa ? null : cur))}
                        />
                      );
                    })}
                  </g>
                ) : (
                  <path
                    d={worldPathD}
                    fill="rgba(26, 78, 128, 0.44)"
                    stroke="rgba(103, 211, 252, 0.52)"
                    strokeWidth={0.8}
                    strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke"
                  />
                )}

                {/* Observatory / City Preset Markers */}
                {locationsList.map((loc) => {
                  const [px, py] = toMapXY(loc.lon_deg, loc.lat_deg);
                  if (px < -4 || px > baseW + 4 || py < -4 || py > baseH + 4) return null;
                  const isActive = loc.id === location.id;
                  const r = (isActive ? 3.2 : 2.1) / Math.sqrt(mapZoom);
                  return (
                    <circle
                      key={loc.id}
                      cx={px}
                      cy={py}
                      r={r}
                      fill={isActive ? "#fbbf24" : "rgba(226, 232, 240, 0.72)"}
                      stroke={isActive ? "#0f172a" : "rgba(4, 13, 29, 0.75)"}
                      strokeWidth={0.6}
                      vectorEffect="non-scaling-stroke"
                      onPointerEnter={() => setHoveredCity(loc.name_ja)}
                      onPointerLeave={() => setHoveredCity((cur) => (cur === loc.name_ja ? null : cur))}
                    />
                  );
                })}

                {/* Active Pin Target Reticle */}
                <g className="pointer-events-none">
                  <circle cx={pinX} cy={pinY} r={10 / Math.sqrt(mapZoom)} fill="url(#starcrane-pin-halo)" />
                  <circle
                    cx={pinX}
                    cy={pinY}
                    r={5.2 / Math.sqrt(mapZoom)}
                    fill="none"
                    stroke="#fbbf24"
                    strokeWidth={1.3}
                    vectorEffect="non-scaling-stroke"
                  />
                  <line
                    x1={pinX - 8 / Math.sqrt(mapZoom)}
                    y1={pinY}
                    x2={pinX - 5.2 / Math.sqrt(mapZoom)}
                    y2={pinY}
                    stroke="#fbbf24"
                    strokeWidth={1}
                    vectorEffect="non-scaling-stroke"
                  />
                  <line
                    x1={pinX + 5.2 / Math.sqrt(mapZoom)}
                    y1={pinY}
                    x2={pinX + 8 / Math.sqrt(mapZoom)}
                    y2={pinY}
                    stroke="#fbbf24"
                    strokeWidth={1}
                    vectorEffect="non-scaling-stroke"
                  />
                  <line
                    x1={pinX}
                    y1={pinY - 8 / Math.sqrt(mapZoom)}
                    x2={pinX}
                    y2={pinY - 5.2 / Math.sqrt(mapZoom)}
                    stroke="#fbbf24"
                    strokeWidth={1}
                    vectorEffect="non-scaling-stroke"
                  />
                  <line
                    x1={pinX}
                    y1={pinY + 5.2 / Math.sqrt(mapZoom)}
                    x2={pinX}
                    y2={pinY + 8 / Math.sqrt(mapZoom)}
                    stroke="#fbbf24"
                    strokeWidth={1}
                    vectorEffect="non-scaling-stroke"
                  />
                </g>
              </svg>

              {/* Floating Zoom Controls */}
              <div className="pointer-events-auto absolute top-1.5 right-1.5 flex items-center gap-0.5 rounded-full border border-white/15 bg-slate-950/75 px-1 py-0.5 backdrop-blur-sm">
                <button
                  type="button"
                  onClick={() => applyMapZoom(mapZoom * 1.4)}
                  className="flex h-5 w-5 items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-white/10 hover:text-[var(--text-primary)]"
                  title="拡大"
                >
                  <Plus className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  onClick={() => applyMapZoom(mapZoom / 1.4)}
                  disabled={mapZoom <= 1.01}
                  className="flex h-5 w-5 items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-white/10 hover:text-[var(--text-primary)] disabled:opacity-35"
                  title="縮小"
                >
                  <Minus className="h-3 w-3" />
                </button>
                {mapZoom > 1.05 && (
                  <button
                    type="button"
                    onClick={() => {
                      setMapZoom(1);
                      setMapPan({ x: 0, y: 0 });
                    }}
                    className="rounded-full px-1.5 font-mono-num text-[9.5px] text-[var(--accent-primary)] hover:bg-white/10"
                    title="全体表示に戻す"
                  >
                    1×
                  </button>
                )}
              </div>
            </div>

            <div className="flex items-center justify-between gap-2 px-0.5 text-[10px] text-[var(--text-secondary)]">
              <span className="truncate font-medium text-[var(--text-primary)]">
                {hoveredCity ?? hoveredPref ?? "クリック指定 / ホイール拡大"}
              </span>
              <span className="shrink-0 font-mono-num">
                {displayCoords.lat >= 0
                  ? `${displayCoords.lat.toFixed(2)}°N`
                  : `${Math.abs(displayCoords.lat).toFixed(2)}°S`}
                ,{" "}
                {displayCoords.lon >= 0
                  ? `${displayCoords.lon.toFixed(2)}°E`
                  : `${Math.abs(displayCoords.lon).toFixed(2)}°W`}
              </span>
            </div>
          </div>
        )}

        {/* Add / Edit Form */}
        {showForm && (
          <form
            className="space-y-2 rounded-lg border border-[var(--accent-primary)]/40 bg-[var(--bg-surface)] p-2.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (editingId) {
                const existing = locationsList.find((l) => l.id === editingId);
                if (existing) {
                  updateLocation({ ...existing, ...form });
                }
              } else {
                addLocation({ ...form, category: "japan" });
              }
              setShowForm(false);
            }}
          >
            <div className="font-semibold text-[var(--accent-primary)]">
              {editingId ? "観測地を編集" : "新しい観測地を登録"}
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <input
                required
                value={form.name_ja}
                onChange={(e) => setForm({ ...form, name_ja: e.target.value })}
                placeholder="名称 (日本語)"
                className="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 text-xs outline-none"
              />
              <input
                value={form.region}
                onChange={(e) => setForm({ ...form, region: e.target.value })}
                placeholder="地域 (例: 近畿)"
                className="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 text-xs outline-none"
              />
              <label className="text-[10px] text-[var(--text-secondary)]">
                緯度 (°)
                <input
                  type="number"
                  step="0.0001"
                  min={-89.9}
                  max={89.9}
                  value={form.lat_deg}
                  onChange={(e) => setForm({ ...form, lat_deg: Number(e.target.value) })}
                  className="mt-0.5 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-1.5 py-1 font-mono-num text-xs outline-none"
                />
              </label>
              <label className="text-[10px] text-[var(--text-secondary)]">
                経度 (°)
                <input
                  type="number"
                  step="0.0001"
                  min={-180}
                  max={180}
                  value={form.lon_deg}
                  onChange={(e) => setForm({ ...form, lon_deg: Number(e.target.value) })}
                  className="mt-0.5 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-1.5 py-1 font-mono-num text-xs outline-none"
                />
              </label>
              <label className="text-[10px] text-[var(--text-secondary)]">
                標高 (m)
                <input
                  type="number"
                  value={form.alt_m}
                  onChange={(e) => setForm({ ...form, alt_m: Number(e.target.value) })}
                  className="mt-0.5 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-1.5 py-1 font-mono-num text-xs outline-none"
                />
              </label>
              <label className="text-[10px] text-[var(--text-secondary)]">
                時差 (分) / TZ
                <div className="mt-0.5 flex gap-1">
                  <input
                    type="number"
                    value={form.tz_offset_min}
                    onChange={(e) => setForm({ ...form, tz_offset_min: Number(e.target.value) })}
                    className="w-1/2 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-1 py-1 font-mono-num text-xs outline-none"
                  />
                  <input
                    value={form.tz_name}
                    onChange={(e) => setForm({ ...form, tz_name: e.target.value })}
                    className="w-1/2 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-1 py-1 text-xs outline-none"
                  />
                </div>
              </label>
            </div>
            <div className="flex justify-end gap-1">
              <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setShowForm(false)}>
                キャンセル
              </Button>
              <Button type="submit" size="sm" className="h-7 px-3 text-xs">
                保存
              </Button>
            </div>
          </form>
        )}

        {/* Search & Filter */}
        <div className="space-y-1.5">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="都市名・地域で検索 (例: 東京, Hawai)..."
            className="w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2.5 py-1.5 text-xs outline-none"
          />
          <div className="flex items-center justify-between gap-1">
            <div className="flex gap-1">
              {[
                { id: "all", label: "全て" },
                { id: "japan", label: "日本" },
                { id: "overseas", label: "海外" },
                { id: "custom", label: "カスタム" },
              ].map((t) => (
                <Button
                  key={t.id}
                  type="button"
                  size="sm"
                  variant={catFilter === t.id ? "default" : "ghost"}
                  className="h-6 px-2 text-[10px]"
                  onClick={() => setCatFilter(t.id as typeof catFilter)}
                >
                  {t.label}
                </Button>
              ))}
            </div>
            <Button type="button" size="sm" variant="ghost" className="h-6 px-1.5 text-[10px]" onClick={resetLocationsToPresets} title="既定リストに戻す">
              <RotateCcw className="h-3 w-3" />
            </Button>
          </div>
        </div>

        {/* Draggable Reorderable Locations List */}
        <div className="space-y-1">
          {filtered.map(({ loc, idx }) => {
            const active = loc.id === location.id;
            return (
              <div
                key={loc.id}
                draggable
                onDragStart={() => setDragIdx(idx)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => {
                  if (dragIdx !== null && dragIdx !== idx) {
                    reorderLocations(dragIdx, idx);
                  }
                  setDragIdx(null);
                }}
                className={`flex items-center justify-between gap-1.5 rounded-lg border px-2 py-1.5 transition-colors ${
                  active
                    ? "border-[var(--accent-primary)] bg-[var(--accent-primary)]/12"
                    : "border-[var(--border-subtle)] bg-[var(--bg-surface)] hover:bg-[var(--bg-surface-elevated)]"
                }`}
              >
                <GripVertical className="h-3.5 w-3.5 shrink-0 cursor-grab text-[var(--text-muted)]" />
                <button
                  type="button"
                  onClick={() => setLocation(loc)}
                  className="flex-1 text-left"
                >
                  <div className="flex items-center gap-1.5 font-semibold">
                    <span>{loc.name_ja}</span>
                    <span className="text-[10px] font-normal text-[var(--text-secondary)]">
                      {loc.region}
                    </span>
                  </div>
                  <div className="font-mono-num text-[10px] text-[var(--text-secondary)]">
                    {loc.lat_deg.toFixed(2)}°N, {loc.lon_deg.toFixed(2)}°E · {loc.tz_name}
                  </div>
                </button>
                <div className="flex items-center gap-0.5">
                  <Button type="button" size="icon" variant="ghost" className="h-6 w-6" onClick={() => reorderLocations(idx, Math.max(0, idx - 1))} title="上へ">
                    <ArrowUp className="h-3 w-3" />
                  </Button>
                  <Button type="button" size="icon" variant="ghost" className="h-6 w-6" onClick={() => reorderLocations(idx, Math.min(locationsList.length - 1, idx + 1))} title="下へ">
                    <ArrowDown className="h-3 w-3" />
                  </Button>
                  <Button type="button" size="icon" variant="ghost" className="h-6 w-6" onClick={() => startEdit(loc)} title="編集">
                    <Pencil className="h-3 w-3" />
                  </Button>
                  <Button type="button" size="icon" variant="ghost" className="h-6 w-6 text-[var(--status-danger)]" onClick={() => deleteLocation(loc.id)} title="削除">
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </aside>
  );
}
