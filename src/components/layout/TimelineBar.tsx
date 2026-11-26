import { memo } from "react";
import {
  FastForward,
  Pause,
  Play,
  Radio,
  Rewind,
  Route,
  StepBack,
  StepForward,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSkyStore } from "@/store/skyStore";
import { useTelemetryStore } from "@/store/telemetryStore";

const STEP_OPTIONS: { label: string; minutes: number }[] = [
  { label: "1分", minutes: 1 },
  { label: "10分", minutes: 10 },
  { label: "1時間", minutes: 60 },
  { label: "1日", minutes: 1440 },
  { label: "1恒星日", minutes: 1436.068 },
  { label: "7日", minutes: 10080 },
  { label: "30日", minutes: 43200 },
  { label: "1年", minutes: 525960 },
  { label: "100年", minutes: 52596000 },
  { label: "1000年", minutes: 525960000 },
];

function formatRaHms(raDeg: number): string {
  const totalSec = (((raDeg % 360) + 360) % 360) * 240;
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = (totalSec % 60).toFixed(0).padStart(2, "0");
  return `${String(h).padStart(2, "0")}h${String(m).padStart(2, "0")}m${s}s`;
}

export const TimelineBar = memo(function TimelineBar() {
  const hover = useTelemetryStore((s) => s.hover);
  const activePanel = useSkyStore((s) => s.activePanel);
  const simPlaying = useSkyStore((s) => s.simPlaying);
  const simDirection = useSkyStore((s) => s.simDirection);
  const simStepMinutes = useSkyStore((s) => s.simStepMinutes);
  const autoRunRealtime = useSkyStore((s) => s.autoRunRealtime);
  const trailEnabled = useSkyStore((s) => s.trailEnabled);
  const trails = useSkyStore((s) => s.trails);
  const error = useSkyStore((s) => s.error);

  const setSimPlaying = useSkyStore((s) => s.setSimPlaying);
  const setSimDirection = useSkyStore((s) => s.setSimDirection);
  const setSimStepMinutes = useSkyStore((s) => s.setSimStepMinutes);
  const setAutoRunRealtime = useSkyStore((s) => s.setAutoRunRealtime);
  const setTrailEnabled = useSkyStore((s) => s.setTrailEnabled);
  const clearTrails = useSkyStore((s) => s.clearTrails);
  const advanceSimulationTick = useSkyStore((s) => s.advanceSimulationTick);

  const trailCount = Object.values(trails).reduce((acc, t) => acc + t.points.length, 0);
  const hasHover =
    hover?.az_deg != null && hover?.alt_deg != null;

  return (
    <footer
      className={`pointer-events-none relative z-20 flex items-end justify-between gap-2 ${
        activePanel !== null ? "hidden sm:flex" : "flex"
      }`}
    >
      {/* Minimal Sky Coordinate Pill (visible on desktop hover or error only) */}
      <div className="hidden md:block">
        {(error || hasHover) && (
          <div className="liquid-glass-pill pointer-events-auto flex items-center gap-3 px-3.5 py-1.5 text-[11px]">
            {error ? (
              <span className="text-[var(--status-danger)]">{error}</span>
            ) : (
              <>
                <span className="font-mono-num">
                  方位 {hover?.az_deg?.toFixed(1)}° · 高度 {hover?.alt_deg?.toFixed(1)}°
                </span>
                {hover?.ra_deg != null && hover?.dec_deg != null && (
                  <span className="hidden font-mono-num text-[var(--text-secondary)] lg:inline">
                    {formatRaHms(hover.ra_deg)} / {hover.dec_deg >= 0 ? "+" : ""}
                    {hover.dec_deg.toFixed(1)}°
                  </span>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* Compact Liquid Glass Simulation Pill */}
      <div className="liquid-glass-pill pointer-events-auto ml-auto flex items-center gap-0.5 px-1.5 py-1">
        <Button
          type="button"
          size="icon"
          variant={simPlaying && simDirection === -1 ? "tonal" : "ghost"}
          className="h-8 w-8"
          title="逆再生"
          onClick={() => {
            setSimDirection(-1);
            setSimPlaying(true);
          }}
        >
          <Rewind className="h-3.5 w-3.5" />
        </Button>

        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="hidden h-8 w-8 sm:inline-flex"
          title="1ステップ戻る"
          onClick={() => {
            setSimDirection(-1);
            void advanceSimulationTick();
          }}
        >
          <StepBack className="h-3.5 w-3.5" />
        </Button>

        <Button
          type="button"
          size="icon"
          variant={simPlaying ? "default" : "tonal"}
          className="h-8 w-8"
          title="再生 / 一時停止"
          onClick={() => setSimPlaying(!simPlaying)}
        >
          {simPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
        </Button>

        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="hidden h-8 w-8 sm:inline-flex"
          title="1ステップ進む"
          onClick={() => {
            setSimDirection(1);
            void advanceSimulationTick();
          }}
        >
          <StepForward className="h-3.5 w-3.5" />
        </Button>

        <Button
          type="button"
          size="icon"
          variant={simPlaying && simDirection === 1 ? "tonal" : "ghost"}
          className="h-8 w-8"
          title="順再生"
          onClick={() => {
            setSimDirection(1);
            setSimPlaying(true);
          }}
        >
          <FastForward className="h-3.5 w-3.5" />
        </Button>

        <select
          aria-label="時間ステップ"
          value={simStepMinutes}
          onChange={(e) => setSimStepMinutes(Number(e.target.value))}
          className="mx-0.5 h-7 rounded-full bg-white/5 px-2 font-mono-num text-[11px] text-[var(--text-primary)] outline-none hover:bg-white/10"
        >
          {STEP_OPTIONS.map((opt) => (
            <option key={opt.label} value={opt.minutes} className="bg-[#0b1120] text-[#f1f5f9]">
              {opt.label}
            </option>
          ))}
        </select>

        <Button
          type="button"
          size="icon"
          variant={autoRunRealtime ? "tonal" : "ghost"}
          className="h-8 w-8"
          onClick={() => setAutoRunRealtime(!autoRunRealtime)}
          title="リアルタイム追従"
        >
          <Radio className={`h-3.5 w-3.5 ${autoRunRealtime ? "animate-pulse" : ""}`} />
        </Button>

        <Button
          type="button"
          size="icon"
          variant={trailEnabled ? "tonal" : "ghost"}
          className="h-8 w-8"
          onClick={() => setTrailEnabled(!trailEnabled)}
          title="軌跡重ね描き"
        >
          <Route className="h-3.5 w-3.5" />
        </Button>

        {trailCount > 0 && (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-8 w-8 text-[var(--status-warn)]"
            onClick={clearTrails}
            title="軌跡を消去"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    </footer>
  );
});
