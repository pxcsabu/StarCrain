import { invoke, isTauri } from "@tauri-apps/api/core";
import { Maximize2, Minimize2, X, ZoomIn } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { resolveCelestialPhoto } from "@/lib/celestialPhotos";
import { useSkyStore } from "@/store/skyStore";
import { useThemeStore } from "@/store/themeStore";
import type { SolarSystemBodyRender } from "@/types/sky";

interface CelestialVisualSvgProps {
  kind: string;
  id: string;
  title: string;
  objType?: string;
  mag?: number | null;
  spectrum?: string | null;
  posAngDeg?: number | null;
  raDeg?: number;
  decDeg?: number;
  majAxArcmin?: number | null;
  body?: SolarSystemBodyRender | null;
  size?: "sm" | "lg";
}

function spectralHex(spectrum?: string | null, id?: string): string {
  const s = (spectrum ?? "").trim().toUpperCase();
  if (id === "mars") return "#f97352";
  if (id === "jupiter") return "#f6c28b";
  if (id === "saturn") return "#f5dc99";
  if (id === "venus") return "#fef3c7";
  if (id === "mercury") return "#cbd5e1";
  if (id === "uranus") return "#7dd3fc";
  if (id === "neptune") return "#60a5fa";
  if (s.startsWith("O") || s.startsWith("B")) return "#93c5fd";
  if (s.startsWith("A")) return "#e0f2fe";
  if (s.startsWith("F")) return "#fef9c3";
  if (s.startsWith("G")) return "#fde68a";
  if (s.startsWith("K")) return "#fdba74";
  if (s.startsWith("M")) return "#fca5a5";
  return "#bae6fd";
}

/**
 * Offline procedural astronomical visual card for DSOs, solar system bodies, and bright stars.
 * Avoids any external image URL dependency while maintaining distinct visual morphology per object type.
 */
export function CelestialVisualSvg({
  kind,
  id,
  title,
  objType = "",
  mag,
  spectrum,
  posAngDeg,
  raDeg,
  decDeg,
  majAxArcmin,
  body,
  size = "lg",
}: CelestialVisualSvgProps) {
  const offlineMode = useSkyStore((s) => s.offlineMode);
  const nightVision = useThemeStore((s) => s.theme) === "night-vision";

  const photo = useMemo(
    () =>
      resolveCelestialPhoto({
        kind,
        id,
        title,
        objType,
        raDeg,
        decDeg,
        majAxArcmin,
      }),
    [kind, id, title, objType, raDeg, decDeg, majAxArcmin],
  );

  const [stage, setStage] = useState<"primary" | "fallback" | "svg">(
    photo.isSurveyRemote && offlineMode && !isTauri() ? "fallback" : "primary",
  );
  const [cachedRemoteUrl, setCachedRemoteUrl] = useState<string | null>(null);
  const [fitMode, setFitMode] = useState<"contain" | "cover">("contain");
  const [lightboxOpen, setLightboxOpen] = useState(false);

  useEffect(() => {
    setFitMode("contain");
    setLightboxOpen(false);
    setCachedRemoteUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });

    if (!photo.isSurveyRemote) {
      setStage("primary");
      return;
    }

    if (!isTauri()) {
      setStage(offlineMode ? "fallback" : "primary");
      return;
    }

    // In Tauri: check disk cache even when offlineMode is true
    let cancelled = false;
    setStage("primary");
    if (photo.cacheKey) {
      void invoke<ArrayBuffer>("fetch_cached_object_photo_cmd", {
        cacheKey: photo.cacheKey,
        url: photo.primarySrc,
        offlineMode,
      })
        .then((buf) => {
          if (cancelled) return;
          const url = URL.createObjectURL(new Blob([buf], { type: "image/jpeg" }));
          setCachedRemoteUrl((prev) => {
            if (prev) URL.revokeObjectURL(prev);
            return url;
          });
          setStage("primary");
        })
        .catch(() => {
          if (cancelled) return;
          setStage((s) => (s === "primary" ? "fallback" : s));
        });
    } else {
      setStage(offlineMode ? "fallback" : "primary");
    }

    return () => {
      cancelled = true;
    };
  }, [photo.primarySrc, photo.isSurveyRemote, photo.cacheKey, offlineMode]);

  useEffect(() => {
    return () => {
      if (cachedRemoteUrl) {
        URL.revokeObjectURL(cachedRemoteUrl);
      }
    };
  }, [cachedRemoteUrl]);

  const activePhotoSrc =
    stage === "primary"
      ? photo.isSurveyRemote && isTauri()
        ? cachedRemoteUrl
        : photo.primarySrc
      : stage === "fallback"
        ? photo.fallbackSrc
        : null;

  const uid = `${kind}-${id}`.replace(/[^a-zA-Z0-9_-]/g, "_");
  const lowerType = objType.toLowerCase();
  const normId = id.toLowerCase();
  const isGalaxy =
    lowerType === "gx" ||
    lowerType === "g" ||
    lowerType.includes("galax") ||
    normId === "m31" ||
    normId === "m33" ||
    normId === "m51" ||
    normId === "m81" ||
    normId === "m82" ||
    normId === "m101" ||
    normId === "m104";
  const isGlobular =
    lowerType === "gc" ||
    lowerType.includes("globular") ||
    normId === "m13" ||
    normId === "m3" ||
    normId === "m5" ||
    normId === "m22" ||
    normId === "ngc5139";
  const isOpenCluster =
    lowerType === "oc" ||
    lowerType.includes("open") ||
    normId === "m45" ||
    normId === "m44" ||
    normId === "ngc869" ||
    normId === "ngc884";
  const isPlanetary =
    lowerType === "pn" ||
    lowerType.includes("planetary") ||
    normId === "m57" ||
    normId === "m27";
  const isNebula =
    lowerType === "nb" ||
    lowerType === "en" ||
    lowerType === "rn" ||
    lowerType === "snr" ||
    lowerType.includes("neb") ||
    normId === "m42" ||
    normId === "m1" ||
    normId === "m8" ||
    normId === "m20" ||
    normId === "ngc7000";

  const starHex = spectralHex(spectrum, normId);
  const tiltDeg = ((posAngDeg ?? 35) % 180) - 90;

  return (
    <>
      <div
        className={`relative overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[#02040a] ${
          size === "lg" ? "h-52 w-full" : "h-28 w-full"
        }`}
      >
        {activePhotoSrc ? (
          <img
            src={activePhotoSrc}
            alt={`${title} 実写写真`}
            loading="lazy"
            onClick={() => {
              if (size === "lg") setLightboxOpen(true);
            }}
            onError={() => {
              if (stage === "primary" && photo.fallbackSrc !== photo.primarySrc) {
                setStage("fallback");
              } else {
                setStage("svg");
              }
            }}
            className={`h-full w-full transition-opacity duration-200 ${
              size === "lg" ? "cursor-zoom-in" : ""
            } ${
              fitMode === "cover" ? "object-cover" : "bg-[#02040a] object-contain"
            } ${
              nightVision
                ? "brightness-75 contrast-125 grayscale sepia hue-rotate-[-50deg] saturate-[5]"
                : ""
            }`}
          />
        ) : (
        <svg
          viewBox="0 0 240 120"
          className="h-full w-full"
          role="img"
          aria-label={`${title} 天文イメージ`}
        >
        <defs>
          <radialGradient id={`bg-${uid}`} cx="50%" cy="50%" r="70%">
            <stop offset="0%" stopColor="#131f3d" />
            <stop offset="65%" stopColor="#070c1c" />
            <stop offset="100%" stopColor="#02040b" />
          </radialGradient>
          <radialGradient id={`core-${uid}`} cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#fff7ed" stopOpacity="0.98" />
            <stop offset="30%" stopColor="#fed7aa" stopOpacity="0.72" />
            <stop offset="70%" stopColor="#93c5fd" stopOpacity="0.22" />
            <stop offset="100%" stopColor="#000000" stopOpacity="0" />
          </radialGradient>
          <radialGradient id={`neb-${uid}`} cx="48%" cy="50%" r="52%">
            <stop offset="0%" stopColor="#f472b6" stopOpacity="0.88" />
            <stop offset="38%" stopColor="#a855f7" stopOpacity="0.48" />
            <stop offset="75%" stopColor="#38bdf8" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#000000" stopOpacity="0" />
          </radialGradient>
          <radialGradient id={`pn-${uid}`} cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#67e8f9" stopOpacity="0.22" />
            <stop offset="48%" stopColor="#22d3ee" stopOpacity="0.78" />
            <stop offset="72%" stopColor="#fb7185" stopOpacity="0.65" />
            <stop offset="100%" stopColor="#000000" stopOpacity="0" />
          </radialGradient>
          <radialGradient id={`star-${uid}`} cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="1" />
            <stop offset="28%" stopColor={starHex} stopOpacity="0.9" />
            <stop offset="70%" stopColor={starHex} stopOpacity="0.22" />
            <stop offset="100%" stopColor="#000000" stopOpacity="0" />
          </radialGradient>
        </defs>

        <rect width="240" height="120" fill={`url(#bg-${uid})`} />

        {/* Background field stars */}
        {[
          [22, 18, 0.9],
          [48, 92, 0.7],
          [76, 26, 0.8],
          [194, 24, 1.0],
          [212, 82, 0.8],
          [165, 98, 0.7],
          [34, 62, 0.6],
          [202, 48, 0.6],
          [94, 102, 0.7],
          [148, 16, 0.75],
        ].map(([cx, cy, r], idx) => (
          <circle
            key={idx}
            cx={cx}
            cy={cy}
            r={r}
            fill="#e2e8f0"
            opacity={0.45 + (idx % 3) * 0.18}
          />
        ))}

        {/* Solar system: Sun */}
        {kind === "sun" && (
          <g>
            <circle cx="120" cy="60" r="46" fill="#f59e0b" opacity="0.22" />
            <circle cx="120" cy="60" r="32" fill="#fbbf24" />
            <circle cx="120" cy="60" r="29" fill="#fef08a" opacity="0.75" />
            <path
              d="M88 58 Q74 46 89 40"
              fill="none"
              stroke="#fb7185"
              strokeWidth="2.2"
              opacity="0.75"
            />
            <path
              d="M151 64 Q165 73 149 79"
              fill="none"
              stroke="#f97316"
              strokeWidth="2"
              opacity="0.7"
            />
          </g>
        )}

        {/* Solar system: Moon with phase approximation */}
        {kind === "moon" && (
          <g>
            <circle cx="120" cy="60" r="35" fill="#1e293b" />
            <circle cx="120" cy="60" r="32" fill="#e2e8f0" />
            {(body?.illuminated_fraction ?? 0.6) < 0.96 && (
              <ellipse
                cx={120 - (1 - (body?.illuminated_fraction ?? 0.6)) * 22}
                cy="60"
                rx={Math.max(4, (1 - (body?.illuminated_fraction ?? 0.6)) * 31)}
                ry="32"
                fill="#0f172a"
                opacity="0.88"
              />
            )}
            <circle cx="110" cy="49" r="7" fill="#94a3b8" opacity="0.35" />
            <circle cx="128" cy="54" r="9" fill="#94a3b8" opacity="0.28" />
            <circle cx="119" cy="73" r="5" fill="#94a3b8" opacity="0.32" />
            <circle cx="131" cy="72" r="3" fill="#64748b" opacity="0.45" />
          </g>
        )}

        {/* Solar system: Comets */}
        {kind === "comet" && (
          <g>
            <polygon
              points="116,58 214,22 214,48 122,68"
              fill="#34d399"
              opacity="0.24"
            />
            <polygon
              points="118,59 208,34 208,46 121,64"
              fill="#6ee7b7"
              opacity="0.35"
            />
            <circle cx="116" cy="62" r="24" fill="#34d399" opacity="0.22" />
            <circle cx="116" cy="62" r="13" fill="#6ee7b7" opacity="0.52" />
            <circle cx="116" cy="62" r="5.5" fill="#ecfdf5" />
          </g>
        )}

        {/* Solar system: Planets / Dwarf planets */}
        {(kind === "planet" || kind === "dwarf_planet") && (
          <g>
            {normId === "saturn" ? (
              <g transform="rotate(-18 120 60)">
                <ellipse
                  cx="120"
                  cy="60"
                  rx="58"
                  ry="14"
                  fill="none"
                  stroke="#e7d39a"
                  strokeWidth="6.5"
                  opacity="0.68"
                />
                <ellipse
                  cx="120"
                  cy="60"
                  rx="48"
                  ry="10.5"
                  fill="none"
                  stroke="#fde68a"
                  strokeWidth="2.5"
                  opacity="0.85"
                />
                <circle cx="120" cy="60" r="22" fill="#f3d488" />
                <ellipse cx="120" cy="57" rx="21.5" ry="4" fill="#d9a85c" opacity="0.45" />
              </g>
            ) : normId === "jupiter" ? (
              <g>
                <circle cx="120" cy="60" r="30" fill="#f3d2a8" />
                <rect x="92" y="45" width="56" height="4.5" rx="2" fill="#c26d43" opacity="0.72" />
                <rect x="90" y="57" width="60" height="5" rx="2" fill="#b45c38" opacity="0.78" />
                <rect x="93" y="69" width="54" height="4" rx="2" fill="#d18456" opacity="0.65" />
                <ellipse cx="130" cy="68" rx="6.5" ry="3.8" fill="#ea580c" opacity="0.85" />
                {/* Galilean moons */}
                <circle cx="62" cy="62" r="2.2" fill="#fef08a" />
                <circle cx="77" cy="61" r="1.8" fill="#e2e8f0" />
                <circle cx="166" cy="59" r="2.4" fill="#fde68a" />
                <circle cx="184" cy="58" r="1.7" fill="#cbd5e1" />
              </g>
            ) : (
              <g>
                <circle cx="120" cy="60" r="34" fill={starHex} opacity="0.16" />
                <circle cx="120" cy="60" r="24" fill={starHex} />
                {normId === "mars" && (
                  <>
                    <ellipse cx="120" cy="39" rx="9" ry="3" fill="#f8fafc" opacity="0.82" />
                    <path
                      d="M104 59 Q120 69 135 55 Q128 71 112 72 Z"
                      fill="#9a3412"
                      opacity="0.45"
                    />
                  </>
                )}
              </g>
            )}
          </g>
        )}

        {/* DSO: Galaxy */}
        {kind === "dso" && isGalaxy && (
          <g transform={`rotate(${tiltDeg} 120 60)`}>
            <ellipse cx="120" cy="60" rx="68" ry="24" fill={`url(#core-${uid})`} />
            <ellipse
              cx="120"
              cy="60"
              rx="52"
              ry="14"
              fill="none"
              stroke="#bfdbfe"
              strokeWidth="1.6"
              opacity="0.42"
              strokeDasharray="18 6"
            />
            <ellipse
              cx="120"
              cy="60"
              rx="34"
              ry="9"
              fill="none"
              stroke="#fed7aa"
              strokeWidth="2"
              opacity="0.65"
            />
            <ellipse cx="120" cy="60" rx="14" ry="7" fill="#fff7ed" opacity="0.92" />
          </g>
        )}

        {/* DSO: Globular Cluster */}
        {kind === "dso" && isGlobular && (
          <g>
            <circle cx="120" cy="60" r="42" fill={`url(#core-${uid})`} />
            {[
              [120, 60, 2.2], [114, 55, 1.5], [126, 56, 1.4], [116, 66, 1.5], [125, 65, 1.3],
              [105, 51, 1.1], [134, 52, 1.2], [108, 70, 1.2], [133, 69, 1.1], [120, 44, 1.2],
              [120, 76, 1.1], [98, 60, 1.0], [142, 60, 1.0], [111, 40, 0.9], [131, 41, 0.9],
              [110, 79, 0.9], [131, 79, 0.9], [95, 48, 0.8], [146, 72, 0.8], [94, 71, 0.8],
            ].map(([cx, cy, r], idx) => (
              <circle key={idx} cx={cx} cy={cy} r={r} fill="#fff7ed" opacity="0.9" />
            ))}
          </g>
        )}

        {/* DSO: Open Cluster */}
        {kind === "dso" && isOpenCluster && (
          <g>
            {[
              [102, 48, 3.0, "#bae6fd"],
              [118, 56, 3.4, "#e0f2fe"],
              [133, 45, 2.8, "#93c5fd"],
              [127, 68, 2.6, "#bae6fd"],
              [109, 71, 2.3, "#e0f2fe"],
              [143, 60, 2.2, "#93c5fd"],
              [92, 61, 2.0, "#cbd5e1"],
              [122, 39, 1.9, "#fef08a"],
            ].map(([cx, cy, r, fill], idx) => (
              <g key={idx}>
                <circle cx={cx as number} cy={cy as number} r={(r as number) * 3.5} fill={fill as string} opacity="0.16" />
                <circle cx={cx as number} cy={cy as number} r={r as number} fill="#ffffff" />
              </g>
            ))}
          </g>
        )}

        {/* DSO: Planetary Nebula */}
        {kind === "dso" && isPlanetary && (
          <g>
            <ellipse cx="120" cy="60" rx="34" ry="26" fill={`url(#pn-${uid})`} />
            <ellipse cx="120" cy="60" rx="18" ry="13" fill="#070c1c" opacity="0.72" />
            <circle cx="120" cy="60" r="2.2" fill="#e0f2fe" />
          </g>
        )}

        {/* DSO: Diffuse Nebula or fallback DSO */}
        {kind === "dso" && !isGalaxy && !isGlobular && !isOpenCluster && !isPlanetary && (
          <g>
            <ellipse cx="116" cy="58" rx="54" ry="34" fill={`url(#neb-${uid})`} />
            <ellipse
              cx="132"
              cy="64"
              rx="38"
              ry="24"
              fill={isNebula ? "#38bdf8" : "#c084fc"}
              opacity="0.18"
            />
            <circle cx="117" cy="58" r="2.2" fill="#fff" />
            <circle cx="122" cy="55" r="1.7" fill="#e0f2fe" />
            <circle cx="124" cy="61" r="1.5" fill="#e0f2fe" />
            <circle cx="116" cy="63" r="1.5" fill="#e0f2fe" />
          </g>
        )}

        {/* Star / Constellation / Variable star */}
        {(kind === "star" || kind === "constellation") && (
          <g>
            <circle cx="120" cy="60" r="34" fill={`url(#star-${uid})`} />
            <line x1="72" y1="60" x2="168" y2="60" stroke={starHex} strokeWidth="1" opacity="0.6" />
            <line x1="120" y1="18" x2="120" y2="102" stroke={starHex} strokeWidth="1" opacity="0.6" />
            <circle cx="120" cy="60" r="4.5" fill="#ffffff" />
          </g>
        )}
      </svg>
      )}

      {/* Top-right image fit / full-preview controls */}
      {activePhotoSrc && size === "lg" && (
        <div className="absolute right-2 top-2 flex items-center gap-1">
          <button
            type="button"
            title={fitMode === "contain" ? "枠いっぱいに拡大表示" : "全体を表示 (見切れなし)"}
            onClick={() => setFitMode((m) => (m === "contain" ? "cover" : "contain"))}
            className="flex items-center gap-1 rounded-md border border-white/15 bg-black/65 px-1.5 py-0.5 text-[9.5px] text-slate-200 backdrop-blur-sm hover:border-white/35"
          >
            {fitMode === "contain" ? (
              <>
                <Maximize2 className="h-2.5 w-2.5" />
                <span>拡大</span>
              </>
            ) : (
              <>
                <Minimize2 className="h-2.5 w-2.5" />
                <span>全体</span>
              </>
            )}
          </button>
          <button
            type="button"
            title="原寸プレビューを開く"
            onClick={() => setLightboxOpen(true)}
            className="flex items-center justify-center rounded-md border border-white/15 bg-black/65 p-1 text-slate-200 backdrop-blur-sm hover:border-white/35"
          >
            <ZoomIn className="h-3 w-3" />
          </button>
        </div>
      )}

      {/* Bottom vignette & corner telemetry */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-black/75 via-black/35 to-transparent" />
      <div className="pointer-events-none absolute inset-x-2 bottom-1.5 flex items-center justify-between gap-1 text-[10px] text-slate-200/95">
        <span className="truncate rounded bg-black/55 px-1.5 py-0.5 font-mono-num backdrop-blur-sm">
          {size === "lg" && activePhotoSrc
            ? photo.credit
            : spectrum
              ? `Sp: ${spectrum}`
              : objType || kind.toUpperCase()}
        </span>
        {mag !== null && mag !== undefined && (
          <span className="shrink-0 rounded bg-black/55 px-1.5 py-0.5 font-mono-num backdrop-blur-sm">
            {mag.toFixed(2)}等
          </span>
        )}
      </div>
    </div>

    {lightboxOpen && activePhotoSrc && (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4 backdrop-blur-sm"
        onClick={() => setLightboxOpen(false)}
      >
        <div
          className="relative flex max-h-[90vh] max-w-[92vw] flex-col items-center gap-2 rounded-2xl border border-white/15 bg-[#050814] p-3 shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex w-full items-center justify-between gap-4 px-1 text-xs text-slate-200">
            <span className="truncate font-semibold">{title}</span>
            <button
              type="button"
              onClick={() => setLightboxOpen(false)}
              className="rounded-lg p-1 text-slate-400 hover:bg-white/10 hover:text-white"
              aria-label="プレビューを閉じる"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <img
            src={activePhotoSrc}
            alt={`${title} 実写拡大`}
            className={`max-h-[78vh] max-w-[86vw] rounded-lg bg-[#02040a] object-contain ${
              nightVision
                ? "brightness-75 contrast-125 grayscale sepia hue-rotate-[-50deg] saturate-[5]"
                : ""
            }`}
          />
          <div className="text-[11px] text-slate-400">{photo.credit}</div>
        </div>
      </div>
    )}
    </>
  );
}
