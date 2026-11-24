interface MoonPhaseSvgProps {
  illuminatedFraction: number;
  waxing: boolean;
  size?: number;
  title?: string;
}

/**
 * Shared SVG lunar phase disc with accurate crescent/gibbous terminator geometry.
 */
export function MoonPhaseSvg({
  illuminatedFraction,
  waxing,
  size = 28,
  title,
}: MoonPhaseSvgProps) {
  const k = Math.max(0, Math.min(1, illuminatedFraction));
  const cx = 16;
  const cy = 16;
  const r = 13;
  const rx = Math.max(0.01, Math.abs(2 * k - 1) * r);

  let litPath = "";
  if (k >= 0.985) {
    litPath = `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx} ${cy + r} A ${r} ${r} 0 1 1 ${cx} ${cy - r} Z`;
  } else if (k > 0.015) {
    if (waxing) {
      const sweepInner = k >= 0.5 ? 1 : 0;
      litPath = `M ${cx} ${cy - r} A ${r} ${r} 0 0 1 ${cx} ${cy + r} A ${rx.toFixed(2)} ${r} 0 0 ${sweepInner} ${cx} ${cy - r} Z`;
    } else {
      const sweepInner = k >= 0.5 ? 0 : 1;
      litPath = `M ${cx} ${cy - r} A ${r} ${r} 0 0 0 ${cx} ${cy + r} A ${rx.toFixed(2)} ${r} 0 0 ${sweepInner} ${cx} ${cy - r} Z`;
    }
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className="shrink-0"
      role="img"
      aria-label={title ?? `輝面比 ${(k * 100).toFixed(0)}%`}
    >
      <circle cx={cx} cy={cy} r={r} fill="#161f33" stroke="rgba(148, 163, 184, 0.38)" strokeWidth="0.9" />
      {litPath && <path d={litPath} fill="#fef3c7" />}
      <circle cx="12" cy="12" r="2.2" fill="rgba(148, 163, 184, 0.14)" />
      <circle cx="20" cy="15" r="2.8" fill="rgba(148, 163, 184, 0.12)" />
      <circle cx="15" cy="21" r="1.8" fill="rgba(148, 163, 184, 0.12)" />
    </svg>
  );
}
