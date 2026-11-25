export interface ResolvedCelestialPhoto {
  primarySrc: string;
  fallbackSrc: string;
  credit: string;
  isSurveyRemote: boolean;
  cacheKey: string | null;
}

const BUNDLED_PHOTOS: Record<string, { file: string; credit: string }> = {
  sun: { file: "sun.jpg", credit: "NASA / SDO 実写" },
  moon: { file: "moon.jpg", credit: "月面望遠鏡 実写" },
  mercury: { file: "mercury.jpg", credit: "NASA MESSENGER 実写" },
  venus: { file: "venus.jpg", credit: "NASA Mariner 10 実写" },
  earth: { file: "earth.jpg", credit: "NASA DSCOVR EPIC 実写" },
  mars: { file: "mars.jpg", credit: "ESA Mars Express / Viking 実写" },
  jupiter: { file: "jupiter.jpg", credit: "NASA / ESA Hubble 実写" },
  saturn: { file: "saturn.jpg", credit: "NASA Cassini 実写" },
  uranus: { file: "uranus.jpg", credit: "NASA Voyager 2 実写" },
  neptune: { file: "neptune.jpg", credit: "NASA Voyager 2 実写" },
  pluto: { file: "pluto.jpg", credit: "NASA New Horizons 実写" },
  eris: { file: "pluto.jpg", credit: "準惑星 実写参考像" },
  comet: { file: "comet.jpg", credit: "彗星 NEOWISE 実写" },
  m1: { file: "m1.jpg", credit: "Hubble かに星雲 (M1)" },
  m8: { file: "m8.jpg", credit: "干潟星雲 (M8) 実写" },
  m13: { file: "m13.jpg", credit: "M13 球状星団 実写" },
  m16: { file: "m16.jpg", credit: "JWST / Hubble わし星雲 (M16)" },
  m17: { file: "m17.jpg", credit: "オメガ星雲 (M17) 実写" },
  m20: { file: "m20.jpg", credit: "三裂星雲 (M20) 実写" },
  m27: { file: "m27.jpg", credit: "ESO 亜鈴状星雲 (M27)" },
  m31: { file: "m31.jpg", credit: "アンドロメダ銀河 (M31) 実写" },
  m33: { file: "m33.jpg", credit: "さんかく座銀河 (M33) 実写" },
  m42: { file: "m42.jpg", credit: "NASA / ESA Hubble オリオン大星雲 (M42)" },
  m43: { file: "m42.jpg", credit: "オリオン大星雲領域 (M43) 実写" },
  m44: { file: "m44.jpg", credit: "プレセペ星団 (M44) 実写" },
  m45: { file: "m45.jpg", credit: "NASA すばる / プレアデス星団 (M45)" },
  m51: { file: "m51.jpg", credit: "Hubble 子持ち銀河 (M51)" },
  m57: { file: "m57.jpg", credit: "Hubble 環状星雲 (M57)" },
  m63: { file: "m63.jpg", credit: "Hubble ひまわり銀河 (M63)" },
  m64: { file: "m64.jpg", credit: "Hubble 黒目銀河 (M64)" },
  m78: { file: "m78.jpg", credit: "ESO M78 反射星雲 実写" },
  m81: { file: "m81.jpg", credit: "Hubble ボーデの銀河 (M81)" },
  m82: { file: "m82.jpg", credit: "Hubble 葉巻銀河 (M82)" },
  m83: { file: "m83.jpg", credit: "Hubble 南の回転花火銀河 (M83)" },
  m97: { file: "m97.jpg", credit: "ふくろう星雲 (M97) 実写" },
  m101: { file: "m101.jpg", credit: "Hubble 回転花火銀河 (M101)" },
  m104: { file: "m104.jpg", credit: "Hubble ソンブレロ銀河 (M104)" },
  ngc253: { file: "ngc253.jpg", credit: "ちょうこくしつ座銀河 (NGC 253) 実写" },
  ngc869: { file: "ngc869.jpg", credit: "二重星団 (NGC 869/884) 実写" },
  ngc884: { file: "ngc869.jpg", credit: "二重星団 (NGC 869/884) 実写" },
  ngc2237: { file: "ngc2237.jpg", credit: "ばら星雲 (NGC 2237) 実写" },
  ngc3372: { file: "ngc3372.jpg", credit: "JWST / Hubble イータ・カリーナ星雲" },
  ngc5139: { file: "ngc5139.jpg", credit: "オメガ星団 (NGC 5139) 実写" },
  ngc7000: { file: "ngc7000.jpg", credit: "北アメリカ星雲 (NGC 7000) 実写" },
  ngc7293: { file: "ngc7293.jpg", credit: "Hubble / Spitzer らせん星雲 (NGC 7293)" },
  sirius: { file: "sirius.jpg", credit: "NASA Hubble / Spitzer 恒星・星雲実写" },
  betelgeuse: { file: "betelgeuse.jpg", credit: "NASA 恒星フィールド実写" },
  albireo: { file: "albireo.jpg", credit: "NASA 重星・恒星フィールド実写" },
  etacar: { file: "eta_carinae.jpg", credit: "Hubble イータ・カリーナ (ホムンクルス星雲)" },
  star_field: { file: "star_field.jpg", credit: "散開星団・恒星フィールド実写" },
};

const ALIAS_BY_NAME: Record<string, string> = {
  sirius: "sirius",
  betelgeuse: "betelgeuse",
  albireo: "albireo",
  pleiades: "m45",
  orion: "m42",
  andromeda: "m31",
};

function selectClassFallbackKey(kind: string, objType = ""): string {
  if (kind === "comet") return "comet";
  if (kind === "sun") return "sun";
  if (kind === "moon") return "moon";
  if (kind === "planet") return "jupiter";
  if (kind === "dwarf_planet") return "pluto";
  if (kind === "star") return "star_field";
  const t = objType.toLowerCase();
  if (t === "gc" || t === "gcl" || t.includes("globular")) return "m13";
  if (t === "oc" || t === "ocl" || t.includes("open")) return "m45";
  if (t === "pn" || t.includes("planetary")) return "m57";
  if (t === "snr") return "m1";
  if (t.includes("g")) return "m31";
  if (t.includes("nb") || t.includes("neb") || t.includes("en") || t.includes("rn")) return "m42";
  return "star_field";
}

export function normalizeCelestialPhotoKey(id: string, title = ""): string {
  const cleanId = id.trim().toLowerCase().replace(/\s+/g, "");
  if (BUNDLED_PHOTOS[cleanId]) return cleanId;
  const messierMatch = /^m0*(\d+)$/.exec(cleanId);
  if (messierMatch && BUNDLED_PHOTOS[`m${messierMatch[1]}`]) {
    return `m${messierMatch[1]}`;
  }
  const lowTitle = title.toLowerCase();
  for (const [needle, key] of Object.entries(ALIAS_BY_NAME)) {
    if (lowTitle.includes(needle)) return key;
  }
  return cleanId;
}

export function getBundledPhotoMeta(key: string): { src: string; credit: string } | null {
  const rec = BUNDLED_PHOTOS[key];
  if (!rec) return null;
  return { src: `/photos/${rec.file}`, credit: rec.credit };
}

export function resolveCelestialPhoto(opts: {
  kind: string;
  id: string;
  title?: string;
  objType?: string;
  raDeg?: number;
  decDeg?: number;
  majAxArcmin?: number | null;
}): ResolvedCelestialPhoto {
  const key = normalizeCelestialPhotoKey(opts.id, opts.title ?? "");
  const exact = BUNDLED_PHOTOS[key];
  const fallbackKey = selectClassFallbackKey(opts.kind, opts.objType ?? "");
  const fallbackRec = BUNDLED_PHOTOS[fallbackKey] ?? BUNDLED_PHOTOS.star_field;
  const fallbackSrc = `/photos/${fallbackRec.file}`;

  if (exact) {
    return {
      primarySrc: `/photos/${exact.file}`,
      fallbackSrc,
      credit: exact.credit,
      isSurveyRemote: false,
      cacheKey: null,
    };
  }

  if (opts.kind === "comet") {
    return {
      primarySrc: `/photos/comet.jpg`,
      fallbackSrc,
      credit: BUNDLED_PHOTOS.comet.credit,
      isSurveyRemote: false,
      cacheKey: null,
    };
  }

  if (
    typeof opts.raDeg === "number" &&
    typeof opts.decDeg === "number" &&
    Number.isFinite(opts.raDeg) &&
    Number.isFinite(opts.decDeg)
  ) {
    const fovDeg = opts.majAxArcmin
      ? Math.max(0.18, Math.min(2.5, (opts.majAxArcmin / 60) * 2.1))
      : opts.kind === "star"
        ? 0.35
        : 0.55;
    const surveyUrl = `https://skyview.gsfc.nasa.gov/current/cgi/runquery.pl?Position=${opts.raDeg.toFixed(4)},${opts.decDeg.toFixed(4)}&Survey=DSS2+Red&Pixels=360&Size=${fovDeg.toFixed(3)}&Return=JPEG`;
    const cleanKindId = `${opts.kind}_${opts.id}`
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .slice(0, 44);
    const cacheKey = `sv_${cleanKindId}_${opts.raDeg.toFixed(2)}_${opts.decDeg.toFixed(2)}_${fovDeg.toFixed(2)}`.replace(
      /[^a-zA-Z0-9_-]/g,
      "_",
    );
    return {
      primarySrc: surveyUrl,
      fallbackSrc,
      credit: "NASA SkyView DSS2 実写 / 参考天体写真",
      isSurveyRemote: true,
      cacheKey,
    };
  }

  return {
    primarySrc: fallbackSrc,
    fallbackSrc,
    credit: fallbackRec.credit,
    isSurveyRemote: false,
    cacheKey: null,
  };
}
