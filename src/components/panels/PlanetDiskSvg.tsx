import { LUNAR_FEATURES, projectLunarFeature } from "@/lib/lunarFeatures";
import type { GalileanMoonPosition, JupiterPhysicalEphemeris } from "@/types/sky";

interface PlanetDiskSvgProps {
  id: string;
  illuminatedFraction: number;
  brightLimbPaDeg?: number;
  polePaDeg?: number | null;
  parallacticAngleDeg?: number;
  orientation?: "equatorial" | "horizontal";
  ringTiltDeg?: number | null;
  jupiterPhys?: JupiterPhysicalEphemeris | null;
  galileanMoons?: GalileanMoonPosition[];
  showLunarLabels?: boolean;
  waxing?: boolean;
  size?: number;
  simple?: boolean;
}

function litTopPhasePath(cx: number, cy: number, r: number, k: number): string {
  if (k >= 0.992) {
    return `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx} ${cy + r} A ${r} ${r} 0 1 1 ${cx} ${cy - r} Z`;
  }
  if (k <= 0.008) {
    return "";
  }
  // Top semicircle lit: (cx - r, cy) -> (cx + r, cy) clockwise via top (0,0,1)
  // Terminator returns (cx + r, cy) -> (cx - r, cy):
  // If k < 0.5 (crescent), curve goes through upper half (sweep = 0)
  // If k >= 0.5 (gibbous), curve bulges into bottom half (sweep = 1)
  const ry = Math.max(0.01, Math.abs(2 * k - 1) * r);
  const sweep = k >= 0.5 ? 1 : 0;
  return `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy} A ${r} ${ry.toFixed(2)} 0 0 ${sweep} ${cx - r} ${cy} Z`;
}

/**
 * Shared SVG component rendering realistic planet & Moon disk geometry, illumination phase,
 * Saturn ring tilt, Jupiter cloud belts + GRS + Galilean moons, and Equatorial/Horizontal sky orientation.
 */
export function PlanetDiskSvg({
  id,
  illuminatedFraction,
  brightLimbPaDeg = 270,
  polePaDeg = 0,
  parallacticAngleDeg = 0,
  orientation = "equatorial",
  ringTiltDeg = null,
  jupiterPhys = null,
  galileanMoons = [],
  showLunarLabels = false,
  waxing = true,
  size = 210,
  simple = false,
}: PlanetDiskSvgProps) {
  const normId = id.toLowerCase();
  const k = Math.max(0, Math.min(1, illuminatedFraction));

  if (simple) {
    const cx = 16;
    const cy = 16;
    const r = 13;
    const rx = Math.max(0.01, Math.abs(2 * k - 1) * r);
    const fill = normId === "mercury" ? "#cbd5e1" : normId === "mars" ? "#fb7154" : "#fef08a";
    let d = "";
    if (k >= 0.985) {
      d = `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx} ${cy + r} A ${r} ${r} 0 1 1 ${cx} ${cy - r} Z`;
    } else if (k > 0.015) {
      if (waxing) {
        d = `M ${cx} ${cy - r} A ${r} ${r} 0 0 1 ${cx} ${cy + r} A ${rx.toFixed(2)} ${r} 0 0 ${k >= 0.5 ? 1 : 0} ${cx} ${cy - r} Z`;
      } else {
        d = `M ${cx} ${cy - r} A ${r} ${r} 0 0 0 ${cx} ${cy + r} A ${rx.toFixed(2)} ${r} 0 0 ${k >= 0.5 ? 0 : 1} ${cx} ${cy - r} Z`;
      }
    }
    return (
      <svg width={size} height={size} viewBox="0 0 32 32" className="shrink-0">
        <circle cx={cx} cy={cy} r={r} fill="#182235" stroke="rgba(148,163,184,0.4)" strokeWidth="0.8" />
        {d && <path d={d} fill={fill} />}
      </svg>
    );
  }

  const cx = 120;
  const cy = 120;
  const r = normId === "saturn" ? 30 : 48;
  const skyTilt = orientation === "horizontal" ? parallacticAngleDeg : 0;
  const limbRot = -brightLimbPaDeg + skyTilt;
  const poleRot = -(polePaDeg ?? 0) + skyTilt;
  const northArrowRot = skyTilt;
  const clipId = `disk-clip-${normId}`;

  const phaseFill =
    normId === "mercury"
      ? "#cbd5e1"
      : normId === "venus"
        ? "#fef3c7"
        : normId === "mars"
          ? "#fb7154"
          : "#e2e8f0";

  const pathTopLit = litTopPhasePath(cx, cy, r, k);

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 240 240"
      className="mx-auto block rounded-2xl border border-[var(--border-subtle)] bg-[#040712]"
      role="img"
      aria-label={`${id} 見え方図`}
    >
      <defs>
        <clipPath id={clipId}>
          {normId === "jupiter" ? (
            <ellipse cx={cx} cy={cy} rx={r} ry={r * 0.935} />
          ) : (
            <circle cx={cx} cy={cy} r={r} />
          )}
        </clipPath>
      </defs>

      {/* Faint reference ring */}
      <circle
        cx={cx}
        cy={cy}
        r={98}
        fill="none"
        stroke="rgba(148, 163, 184, 0.14)"
        strokeDasharray="3 4"
      />
      <line x1="22" y1={cy} x2="218" y2={cy} stroke="rgba(148, 163, 184, 0.1)" />
      <line x1={cx} y1="22" x2={cx} y2="218" stroke="rgba(148, 163, 184, 0.1)" />

      {/* Frame orientation labels */}
      {orientation === "equatorial" ? (
        <g fill="#94a3b8" fontSize="10" fontFamily="monospace" textAnchor="middle">
          <text x={cx} y="15">N (北)</text>
          <text x={cx} y="232">S (南)</text>
          <text x="16" y={cy + 3}>E</text>
          <text x="224" y={cy + 3}>W</text>
        </g>
      ) : (
        <g fontSize="10" fontFamily="monospace" textAnchor="middle">
          <text x={cx} y="15" fill="#38bdf8">天頂 (Zenith)</text>
          <text x={cx} y="232" fill="#94a3b8">地平方向</text>
          <g transform={`rotate(${northArrowRot.toFixed(1)} ${cx} ${cy})`}>
            <line x1={cx} y1="30" x2={cx} y2="42" stroke="#fbbf24" strokeWidth="1.5" />
            <text x={cx} y="27" fill="#fbbf24" fontSize="9.5">N</text>
          </g>
        </g>
      )}

      {/* SATURN with back/front tilted ring halves */}
      {normId === "saturn" && (
        <g transform={`rotate(${poleRot.toFixed(1)} ${cx} ${cy})`}>
          {(() => {
            const bDeg = ringTiltDeg ?? 12;
            const sinB = Math.sin((Math.abs(bDeg) * Math.PI) / 180);
            const outerRx = 68;
            const outerRy = Math.max(2.5, outerRx * sinB);
            const innerRx = 43;
            const innerRy = Math.max(1.5, innerRx * sinB);
            const midRx = 56;
            const midRy = Math.max(2.0, midRx * sinB);
            const northVisible = bDeg >= 0;
            // Back ring arc path: top or bottom half depending on B sign
            const backSweepOuter = northVisible ? 1 : 0;
            const frontSweepOuter = northVisible ? 0 : 1;
            return (
              <>
                {/* Back half of rings (behind globe) */}
                <path
                  d={`M ${cx - outerRx} ${cy} A ${outerRx} ${outerRy} 0 0 ${backSweepOuter} ${cx + outerRx} ${cy}`}
                  fill="none"
                  stroke="#d9bd7b"
                  strokeWidth="8.5"
                  opacity="0.82"
                />
                <path
                  d={`M ${cx - midRx} ${cy} A ${midRx} ${midRy} 0 0 ${backSweepOuter} ${cx + midRx} ${cy}`}
                  fill="none"
                  stroke="#040712"
                  strokeWidth="1.6"
                />
                <path
                  d={`M ${cx - innerRx} ${cy} A ${innerRx} ${innerRy} 0 0 ${backSweepOuter} ${cx + innerRx} ${cy}`}
                  fill="none"
                  stroke="#bfa165"
                  strokeWidth="5.5"
                  opacity="0.72"
                />

                {/* Saturn oblate globe */}
                <ellipse cx={cx} cy={cy} rx={r} ry={r * 0.905} fill="#edd08e" />
                <ellipse cx={cx} cy={cy - 9} rx={r - 2} ry={3.5} fill="#c89e56" opacity="0.45" />
                <ellipse cx={cx} cy={cy + 7} rx={r - 2} ry={3.2} fill="#d6ae65" opacity="0.38" />

                {/* Front half of rings (in front of globe) */}
                <path
                  d={`M ${cx - outerRx} ${cy} A ${outerRx} ${outerRy} 0 0 ${frontSweepOuter} ${cx + outerRx} ${cy}`}
                  fill="none"
                  stroke="#f3db9d"
                  strokeWidth="8.5"
                  opacity="0.92"
                />
                <path
                  d={`M ${cx - midRx} ${cy} A ${midRx} ${midRy} 0 0 ${frontSweepOuter} ${cx + midRx} ${cy}`}
                  fill="none"
                  stroke="#040712"
                  strokeWidth="1.6"
                />
                <path
                  d={`M ${cx - innerRx} ${cy} A ${innerRx} ${innerRy} 0 0 ${frontSweepOuter} ${cx + innerRx} ${cy}`}
                  fill="none"
                  stroke="#d9be7f"
                  strokeWidth="5.5"
                  opacity="0.82"
                />
              </>
            );
          })()}
        </g>
      )}

      {/* JUPITER with bands, live GRS, and close Galilean moons */}
      {normId === "jupiter" && (
        <g transform={`rotate(${poleRot.toFixed(1)} ${cx} ${cy})`}>
          {/* Nearby Galilean moons behind Jupiter */}
          {galileanMoons
            .filter((m) => m.z_rj < 0 && Math.abs(m.x_rj) > 1.05 && Math.abs(m.x_rj) <= 2.3)
            .map((m) => (
              <circle
                key={m.id}
                cx={cx + m.x_rj * r}
                cy={cy + m.y_rj * r}
                r="2.4"
                fill="#fde68a"
                opacity="0.7"
              />
            ))}

          {/* Oblate disc + Equatorial bands */}
          <g clipPath={`url(#${clipId})`}>
            <ellipse cx={cx} cy={cy} rx={r} ry={r * 0.935} fill="#f4d8b3" />
            <rect x={cx - r} y={cy - r * 0.935} width={r * 2} height={10} fill="#9c8978" opacity="0.48" />
            <rect x={cx - r} y={cy - 18} width={r * 2} height={8.5} fill="#b8653c" opacity="0.8" />
            <rect x={cx - r} y={cy + 8} width={r * 2} height={9.5} fill="#a85532" opacity="0.85" />
            <rect x={cx - r} y={cy - 3} width={r * 2} height={7} fill="#faebd7" opacity="0.65" />
            <rect x={cx - r} y={cy + r * 0.72} width={r * 2} height={14} fill="#948374" opacity="0.45" />

            {/* Great Red Spot when visible on Earthward hemisphere (+X = West/Receding) */}
            {jupiterPhys && jupiterPhys.grs_visible && (
              (() => {
                const rad = (jupiterPhys.grs_offset_deg * Math.PI) / 180;
                const xGrs = cx + Math.sin(rad) * (r * 0.88);
                const foreshorten = Math.max(0.25, Math.cos(rad));
                return (
                  <ellipse
                    cx={xGrs}
                    cy={cy + 14}
                    rx={8.5 * foreshorten}
                    ry={4.8}
                    fill="#ea580c"
                    stroke="#fed7aa"
                    strokeWidth="0.9"
                  />
                );
              })()
            )}

            {/* Galilean moon shadows on Jupiter */}
            {galileanMoons
              .filter((m) => m.shadow_on_disk)
              .map((m) => (
                <circle
                  key={`${m.id}-sh`}
                  cx={cx + m.x_shadow_rj * r}
                  cy={cy + m.y_shadow_rj * r}
                  r="2.6"
                  fill="#0f172a"
                />
              ))}
          </g>

          {/* Nearby Galilean moons in front / flanking */}
          {galileanMoons
            .filter((m) => (m.z_rj >= 0 || Math.abs(m.x_rj) > 1.0) && Math.abs(m.x_rj) <= 3.8)
            .map((m) => (
              <g key={m.id}>
                <circle
                  cx={cx + m.x_rj * r}
                  cy={cy + m.y_rj * r}
                  r="2.8"
                  fill={m.in_eclipse ? "#475569" : "#fef08a"}
                  stroke="#040712"
                  strokeWidth="0.7"
                />
              </g>
            ))}
        </g>
      )}

      {/* PHASE PLANETS & MOON (Mercury, Venus, Mars, Moon) */}
      {normId !== "saturn" && normId !== "jupiter" && (
        <g>
          {/* Base unlit dark side */}
          <circle cx={cx} cy={cy} r={r} fill="#141c2f" stroke="rgba(148,163,184,0.35)" strokeWidth="1" />

          {/* Mars polar cap & dark Syrtis Major style feature */}
          {normId === "mars" && (
            <g transform={`rotate(${poleRot.toFixed(1)} ${cx} ${cy})`} clipPath={`url(#${clipId})`}>
              <circle cx={cx} cy={cy} r={r} fill="#c25236" opacity="0.4" />
              <ellipse cx={cx} cy={cy - r + 7} rx={15} ry={5} fill="#f8fafc" opacity="0.65" />
              <path
                d={`M ${cx - 18} ${cy - 4} Q ${cx} ${cy + 16} ${cx + 22} ${cy - 8} Q ${cx + 10} ${cy + 26} ${cx - 20} ${cy + 22} Z`}
                fill="#7c2d12"
                opacity="0.45"
              />
            </g>
          )}

          {/* Illuminated phase wedge oriented toward bright_limb_pa_deg */}
          {pathTopLit && (
            <g transform={`rotate(${limbRot.toFixed(1)} ${cx} ${cy})`}>
              <path d={pathTopLit} fill={phaseFill} opacity={normId === "mars" ? 0.85 : 0.96} />
            </g>
          )}

          {/* Subtle lunar maria shading & optional selenographic labels */}
          {normId === "moon" && (
            <>
              <g clipPath={`url(#${clipId})`} opacity="0.24" fill="#475569">
                <circle cx={cx - 18} cy={cy - 10} r="13" />
                <circle cx={cx + 12} cy={cy - 12} r="11" />
                <circle cx={cx + 22} cy={cy + 6} r="9" />
                <circle cx={cx - 8} cy={cy + 16} r="8" />
                <ellipse cx={cx + 34} cy={cy - 11} rx="5" ry="4" />
              </g>
              {showLunarLabels &&
                LUNAR_FEATURES.filter((f) => f.rank === 1).map((feat, idx) => {
                  const p = projectLunarFeature(
                    feat,
                    cx,
                    cy,
                    r,
                    (northArrowRot * Math.PI) / 180,
                  );
                  if (!p.isVisibleLimb) return null;
                  const col =
                    feat.kind === "mare"
                      ? "#cbd5e1"
                      : feat.kind === "mountain"
                        ? "#7dd3fc"
                        : "#fde047";
                  const dyLabel = idx % 2 === 0 ? -5.5 : 7.5;
                  return (
                    <g key={feat.id} className="pointer-events-none">
                      {feat.kind !== "mare" && (
                        <circle
                          cx={p.x}
                          cy={p.y}
                          r="1.7"
                          fill={col}
                          stroke="#040712"
                          strokeWidth="0.6"
                        />
                      )}
                      <text
                        x={p.x}
                        y={feat.kind === "mare" ? p.y : p.y + dyLabel}
                        textAnchor="middle"
                        fontSize="6.4"
                        fontWeight="600"
                        fill={col}
                        stroke="#02040a"
                        strokeWidth="2.1"
                        paintOrder="stroke"
                      >
                        {feat.nameJa}
                      </text>
                    </g>
                  );
                })}
            </>
          )}
        </g>
      )}
    </svg>
  );
}
