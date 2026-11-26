import { invoke, isTauri } from "@tauri-apps/api/core";
import { Compass, Crosshair, Eye, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { nowUtcJd, useSkyStore } from "@/store/skyStore";
import type { PolarAlignmentInfo } from "@/types/sky";

function wrapDeg180(deg: number): number {
  let d = ((deg + 180) % 360 + 360) % 360 - 180;
  if (d <= -180) d += 360;
  return d;
}

function wrapDeg360(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

function formatClockJa(h12: number): string {
  const w = ((h12 % 12) + 12) % 12;
  const mins = Math.round(w * 60) % 720;
  const hh = Math.floor(mins / 60);
  const mm = mins % 60;
  return `${hh === 0 ? 12 : hh}時${String(mm).padStart(2, "0")}分`;
}

function computeFallbackPolarAlignment(
  jdUt: number,
  latDeg: number,
  lonDeg: number,
  tzOffsetMin: number,
): PolarAlignmentInfo {
  const isNorth = latDeg >= 0;
  // Approximate precessed Polaris / Sigma Octantis RA/Dec for 2026 epoch
  const yrs = (jdUt - 2451545.0) / 365.25;
  const raDeg = isNorth ? 37.95 + yrs * 0.68 : 317.2 - yrs * 0.52;
  const decDeg = isNorth ? 89.264 + yrs * 0.0046 : -88.957 + yrs * 0.004;
  const gmst = wrapDeg360(280.46061837 + 360.98564736629 * (jdUt - 2451545.0));
  const last = wrapDeg360(gmst + lonDeg);
  const haDeg = wrapDeg180(last - raDeg);
  const haHours = haDeg / 15;
  const rawErect = isNorth ? -haHours / 2 : haHours / 2;
  const clockErect = ((rawErect % 12) + 12) % 12;
  const clockInv = (clockErect + 6) % 12;
  const haAhead = wrapDeg360(raDeg - last);
  const transitMs = (jdUt + (haAhead / 360) * 0.99726957 - 2440587.5) * 86400000 + tzOffsetMin * 60000;
  const d = new Date(transitMs);
  return {
    jd_ut: jdUt,
    hemisphere: isNorth ? "north" : "south",
    pole_star_name_ja: isNorth ? "ポラリス (北極星 · α UMi)" : "はちぶんぎ座 σ星 (南極星)",
    ra_app_deg: raDeg,
    dec_app_deg: decDeg,
    last_deg: last,
    ha_deg: haDeg,
    ha_hours: haHours,
    polar_dist_arcmin: (90 - Math.abs(decDeg)) * 60,
    clock_hour_erect: clockErect,
    clock_hour_inverted: clockInv,
    clock_str_erect: formatClockJa(clockErect),
    clock_str_inverted: formatClockJa(clockInv),
    next_transit_str: `${String(d.getUTCHours()).padStart(2, "0")}:${String(
      d.getUTCMinutes(),
    ).padStart(2, "0")}`,
  };
}

export function PolarAlignment() {
  const closePanel = useSkyStore((s) => s.closePanel);
  const location = useSkyStore((s) => s.location);
  const appJdUt = useSkyStore((s) => s.jdUt);
  const centerOnSkyCoords = useSkyStore((s) => s.centerOnSkyCoords);

  const [useLiveTime, setUseLiveTime] = useState(true);
  const [invertedView, setInvertedView] = useState(true); // Most polar scopes invert 180 deg
  const [redBacklight, setRedBacklight] = useState(true);
  const [info, setInfo] = useState<PolarAlignmentInfo>(() =>
    computeFallbackPolarAlignment(nowUtcJd(), location.lat_deg, location.lon_deg, location.tz_offset_min),
  );

  const refreshPolar = useCallback(
    async (targetJd: number) => {
      if (!isTauri()) {
        setInfo(
          computeFallbackPolarAlignment(
            targetJd,
            location.lat_deg,
            location.lon_deg,
            location.tz_offset_min,
          ),
        );
        return;
      }
      try {
        const res = await invoke<PolarAlignmentInfo>("get_polar_alignment_cmd", {
          req: {
            jd_ut: targetJd,
            lat_deg: location.lat_deg,
            lon_deg: location.lon_deg,
            tz_offset_min: location.tz_offset_min,
          },
        });
        setInfo(res);
      } catch {
        setInfo(
          computeFallbackPolarAlignment(
            targetJd,
            location.lat_deg,
            location.lon_deg,
            location.tz_offset_min,
          ),
        );
      }
    },
    [location.lat_deg, location.lon_deg, location.tz_offset_min],
  );

  useEffect(() => {
    void refreshPolar(useLiveTime ? nowUtcJd() : appJdUt);
    if (!useLiveTime) return;
    const timer = window.setInterval(() => {
      void refreshPolar(nowUtcJd());
    }, 1000);
    return () => window.clearInterval(timer);
  }, [useLiveTime, appJdUt, refreshPolar]);

  const clockHours = invertedView ? info.clock_hour_inverted : info.clock_hour_erect;
  const clockText = invertedView ? info.clock_str_inverted : info.clock_str_erect;

  // Clock angle: 12 o'clock (0h) is Top (-Y in SVG), clockwise (+Az around ring)
  const angleRad = (clockHours / 12) * Math.PI * 2;
  // Scale polar distance (~38') cleanly onto reticle epoch ring (40' ≈ R=76 on 200x200 SVG)
  const ringR = Math.min(82, Math.max(46, (info.polar_dist_arcmin / 40) * 74));
  const dotX = 110 + ringR * Math.sin(angleRad);
  const dotY = 110 - ringR * Math.cos(angleRad);
  const glowColor = redBacklight ? "#ef4444" : "#38bdf8";
  const ringStroke = redBacklight ? "rgba(239,68,68,0.65)" : "rgba(148,163,184,0.65)";

  return (
    <aside className="flex h-[34rem] max-h-[calc(100dvh-10.5rem)] w-[26rem] max-w-[calc(100vw-4rem)] flex-col text-[var(--text-primary)] max-sm:h-[82dvh] max-sm:max-h-none max-sm:w-full max-sm:max-w-none">
      {/* Header */}
      <div className="flex items-start justify-between gap-2 border-b border-[var(--border-subtle)] px-4 py-2.5">
        <div>
          <h2 className="flex items-center gap-1.5 text-sm font-semibold tracking-tight">
            <Crosshair className="h-4 w-4 text-rose-400" />
            <span>極軸合わせ支援 (極軸望遠鏡レチクル)</span>
          </h2>
          <p className="text-[11px] text-[var(--text-muted)]">
            {location.name_ja} ({location.lat_deg.toFixed(2)}° / {location.lon_deg.toFixed(2)}°) ·{" "}
            {info.pole_star_name_ja}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => closePanel("polar_align")}
          title="閉じる"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center justify-between gap-1.5 border-b border-[var(--border-subtle)] px-4 py-2 text-xs">
        <div className="flex gap-1">
          <Button
            type="button"
            size="sm"
            variant={invertedView ? "default" : "outline"}
            className="h-7 px-2 text-[10.5px]"
            onClick={() => setInvertedView(true)}
            title="一般的な極軸望遠鏡の光学反転像"
          >
            倒立像 (通常極望)
          </Button>
          <Button
            type="button"
            size="sm"
            variant={!invertedView ? "default" : "outline"}
            className="h-7 px-2 text-[10.5px]"
            onClick={() => setInvertedView(false)}
            title="電子極軸カメラ・直視正立視野"
          >
            正立像 (カメラ)
          </Button>
        </div>

        <div className="flex gap-1">
          <Button
            type="button"
            size="sm"
            variant={useLiveTime ? "default" : "outline"}
            className="h-7 gap-1 px-2 text-[10.5px]"
            onClick={() => setUseLiveTime((v) => !v)}
          >
            <RefreshCw className={`h-3 w-3 ${useLiveTime ? "animate-spin" : ""}`} />
            {useLiveTime ? "LIVE" : "星図時刻"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant={redBacklight ? "tonal" : "outline"}
            className="h-7 gap-1 px-2 text-[10.5px]"
            onClick={() => setRedBacklight((v) => !v)}
            title="暗順応レッド照明切替"
          >
            <Eye className="h-3 w-3 text-rose-400" />
            赤照明
          </Button>
        </div>
      </div>

      {/* Interactive Polar Scope Reticle SVG */}
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3 text-xs">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-[var(--border-subtle)] bg-[#030104] py-3">
          <svg viewBox="0 0 220 220" className="h-56 w-56 select-none">
            <defs>
              <radialGradient id="polar-glow" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor={glowColor} stopOpacity="0.12" />
                <stop offset="100%" stopColor="#000000" stopOpacity="0" />
              </radialGradient>
            </defs>
            <circle cx="110" cy="110" r="102" fill="url(#polar-glow)" stroke={ringStroke} strokeWidth="1.2" />
            {/* 60' outer ring & 40' inner ring */}
            <circle cx="110" cy="110" r="90" fill="none" stroke={ringStroke} strokeWidth="0.7" strokeDasharray="3 3" />
            <circle cx="110" cy="110" r={ringR} fill="none" stroke={glowColor} strokeWidth="1.35" opacity="0.85" />
            <circle cx="110" cy="110" r={ringR * 0.72} fill="none" stroke={ringStroke} strokeWidth="0.65" opacity="0.55" />

            {/* Crosshairs & 12-hour dial ticks */}
            <line x1="110" y1="14" x2="110" y2="206" stroke={ringStroke} strokeWidth="0.7" opacity="0.7" />
            <line x1="14" y1="110" x2="206" y2="110" stroke={ringStroke} strokeWidth="0.7" opacity="0.7" />
            {Array.from({ length: 12 }).map((_, i) => {
              const a = (i / 12) * Math.PI * 2;
              const r0 = i % 3 === 0 ? 84 : 86;
              const r1 = 92;
              return (
                <line
                  key={i}
                  x1={110 + r0 * Math.sin(a)}
                  y1={110 - r0 * Math.cos(a)}
                  x2={110 + r1 * Math.sin(a)}
                  y2={110 - r1 * Math.cos(a)}
                  stroke={ringStroke}
                  strokeWidth={i % 3 === 0 ? 1.5 : 0.8}
                />
              );
            })}

            {/* Clock Labels: 0/12 (Top), 3 (Right), 6 (Bottom), 9 (Left) */}
            <g fill={glowColor} fontSize="11" fontWeight="700" fontFamily="monospace" textAnchor="middle">
              <text x="110" y="13">0 (12)</text>
              <text x="206" y="114">3</text>
              <text x="110" y="216">6</text>
              <text x="14" y="114">9</text>
            </g>

            {/* True Celestial Pole Center Cross */}
            <circle cx="110" cy="110" r="2.2" fill={glowColor} />

            {/* Live Polaris / Sigma Octantis Position Marker */}
            <line
              x1="110"
              y1="110"
              x2={dotX}
              y2={dotY}
              stroke={glowColor}
              strokeWidth="0.9"
              strokeDasharray="2 2"
              opacity="0.7"
            />
            <circle cx={dotX} cy={dotY} r="9" fill="none" stroke="#ffffff" strokeWidth="1.1" opacity="0.65" />
            <circle cx={dotX} cy={dotY} r="4.5" fill="#fffbeb" stroke={glowColor} strokeWidth="1.6" />
          </svg>

          <div className="mt-1 text-center">
            <div className="text-[10.5px] text-[var(--text-muted)]">
              極軸望遠鏡 ({invertedView ? "倒立像" : "正立像"}) の{info.hemisphere === "north" ? "北極星" : "南極星"}位置
            </div>
            <div className="font-mono-num text-xl font-bold tracking-wide text-rose-300">
              {clockText}
            </div>
          </div>
        </div>

        {/* Telemetry Readout */}
        <div className="grid grid-cols-2 gap-1.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)]/75 p-2.5">
          <div>
            <div className="text-[10px] text-[var(--text-muted)]">時角 (HA)</div>
            <div className="font-mono-num text-xs font-semibold">
              {info.ha_hours >= 0 ? "+" : ""}
              {info.ha_hours.toFixed(2)}h ({info.ha_deg.toFixed(1)}°)
            </div>
          </div>
          <div>
            <div className="text-[10px] text-[var(--text-muted)]">地方視恒星時 (LAST)</div>
            <div className="font-mono-num text-xs font-semibold">
              {(info.last_deg / 15).toFixed(2)}h ({info.last_deg.toFixed(1)}°)
            </div>
          </div>
          <div>
            <div className="text-[10px] text-[var(--text-muted)]">真の天の極からの離角</div>
            <div className="font-mono-num text-xs font-semibold">
              {info.polar_dist_arcmin.toFixed(1)}′
            </div>
          </div>
          <div>
            <div className="text-[10px] text-[var(--text-muted)]">次回の上方通過 (南中/0時位置)</div>
            <div className="font-mono-num text-xs font-semibold text-amber-300">
              {info.next_transit_str}
            </div>
          </div>
        </div>

        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 w-full gap-1.5 text-xs"
          onClick={() =>
            centerOnSkyCoords(info.hemisphere === "north" ? 37.95 : 317.2, info.hemisphere === "north" ? 89.26 : -88.96)
          }
        >
          <Compass className="h-3.5 w-3.5 text-rose-400" />
          星図で天の{info.hemisphere === "north" ? "北" : "南"}極を表示
        </Button>
      </div>
    </aside>
  );
}
