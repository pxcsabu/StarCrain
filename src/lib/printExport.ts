import { createStarSpriteAtlas, renderSkyCanvas } from "@/components/canvas/skyRenderer";
import { computeFovDimensions } from "@/lib/fovMath";
import {
  buildJ2000ToEnuMatrix,
  compileProjectionContext,
  flattenMat3,
  projectAppEqVectorForStarChart,
  projectEqToScreen,
  projectHorToScreen,
  wrapDeg360,
} from "@/lib/projection";
import {
  PROJECTION_META,
  type CustomColorPalette,
  type FovPreset,
  type LocationPreset,
  type PrintColorMode,
  type PrintOrientation,
  type PrintPaperSize,
  type ProjectionParams,
  type SatellitePass,
  type SatelliteSkyPos,
  type SkyFrame,
  type SkyLayerVisibility,
  type SkyStaticAssets,
} from "@/types/sky";

export interface PrintExportArgs {
  paperSize: PrintPaperSize;
  orientation: PrintOrientation;
  colorMode: PrintColorMode;
  title: string;
  includeFov: boolean;
  includeLegend: boolean;
  params: ProjectionParams;
  frame: SkyFrame;
  location: LocationPreset;
  staticAssets: SkyStaticAssets | null;
  starBuffer: Float32Array | null;
  starCount: number;
  dsoBuffer?: Float32Array | null;
  dsoCount?: number;
  limitingMag: number;
  refractionEnabled: boolean;
  layers: SkyLayerVisibility;
  customColors: CustomColorPalette;
  fovPresets: FovPreset[];
  satellites: SatelliteSkyPos[];
  showSatellites: boolean;
  highlightedSatPass: SatellitePass | null;
}

export function paperDimensionsPx(
  size: PrintPaperSize,
  orientation: PrintOrientation,
  scale = 1,
): { width: number; height: number; widthPt: number; heightPt: number } {
  // Points (72 pt/in): A4 = 595.28 x 841.89, B5(JIS) = 515.91 x 728.50
  const basePt = size === "A4" ? [595.28, 841.89] : [515.91, 728.5];
  const [wPt, hPt] = orientation === "landscape" ? [basePt[1], basePt[0]] : basePt;
  const pxScale = size === "A4" ? 2.945 * scale : 2.85 * scale;
  return {
    width: Math.round(wPt * pxScale),
    height: Math.round(hPt * pxScale),
    widthPt: wPt,
    heightPt: hPt,
  };
}

export function renderPrintSheetCanvas(args: PrintExportArgs, previewScale = 1): HTMLCanvasElement {
  const { width, height } = paperDimensionsPx(args.paperSize, args.orientation, previewScale);
  const sheet = document.createElement("canvas");
  sheet.width = width;
  sheet.height = height;
  const ctx = sheet.getContext("2d");
  if (!ctx) return sheet;

  const isInverted = args.colorMode === "inverted";
  const isGray = args.colorMode === "grayscale";
  const paperBg = isInverted ? "#ffffff" : isGray ? "#0f172a" : "#070c18";
  const headerFg = isInverted ? "#0f172a" : "#f8fafc";
  const subFg = isInverted ? "#475569" : "#94a3b8";
  const borderCol = isInverted ? "#cbd5e1" : "#334155";

  ctx.fillStyle = paperBg;
  ctx.fillRect(0, 0, width, height);

  const pad = Math.round(Math.min(width, height) * 0.032);
  const headerH = Math.round(height * 0.075);
  const footerH = Math.round(height * 0.038);
  const chartX = pad;
  const chartY = pad + headerH;
  const chartW = Math.max(200, width - pad * 2);
  const chartH = Math.max(200, height - pad * 2 - headerH - footerH);

  // Header metadata
  const projLabel =
    PROJECTION_META.find((m) => m.mode === args.params.mode)?.labelJa ?? args.params.mode;
  const dt = args.frame.local_dt;
  const dtText = `${dt.year}-${String(dt.month).padStart(2, "0")}-${String(dt.day).padStart(2, "0")} ${String(dt.hour).padStart(2, "0")}:${String(dt.minute).padStart(2, "0")} ${args.location.tz_name}`;
  const locText = `${args.location.name_ja} (${args.location.lat_deg.toFixed(2)}°N, ${args.location.lon_deg.toFixed(2)}°E)`;

  ctx.fillStyle = headerFg;
  ctx.font = `700 ${Math.max(14, Math.round(headerH * 0.36))}px "Noto Sans JP", system-ui, sans-serif`;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText(args.title || "StarCrane 天体星図", pad, pad);

  ctx.fillStyle = subFg;
  ctx.font = `500 ${Math.max(10, Math.round(headerH * 0.23))}px "Noto Sans JP", system-ui, sans-serif`;
  ctx.fillText(`日時: ${dtText}   観測地: ${locText}   図法: ${projLabel}   極限等級: ${args.limitingMag.toFixed(1)}等`, pad, pad + Math.round(headerH * 0.48));

  ctx.textAlign = "right";
  ctx.fillText(
    `${args.paperSize} ${args.orientation === "landscape" ? "横" : "縦"} · ${
      isInverted ? "白地黒星(インク節約)" : isGray ? "グレースケール" : "フルカラー"
    }`,
    width - pad,
    pad,
  );

  // Render star chart offscreen canvas cleanly into framed area
  const chartCanvas = document.createElement("canvas");
  chartCanvas.width = chartW;
  chartCanvas.height = chartH;
  const chartCtx = chartCanvas.getContext("2d", { alpha: false });
  if (chartCtx) {
    const atlas = createStarSpriteAtlas();
    renderSkyCanvas({
      ctx: chartCtx,
      width: chartW,
      height: chartH,
      params: { ...args.params, width: chartW, height: chartH },
      frame: args.frame,
      location: args.location,
      staticAssets: args.staticAssets,
      starBuffer: args.starBuffer,
      starCount: args.starCount,
      dsoBuffer: args.dsoBuffer ?? null,
      dsoCount: args.dsoCount ?? 0,
      limitingMag: args.limitingMag,
      refractionEnabled: args.refractionEnabled,
      layers: args.layers,
      customColors: args.customColors,
      trails: {},
      simLockMode: "none",
      simStepMinutes: 60,
      nightVision: false,
      selectedObject: null,
      atlas,
      fovPresets: args.includeFov ? args.fovPresets : [],
      satellites: args.satellites,
      showSatellites: args.showSatellites,
      highlightedSatPass: args.highlightedSatPass,
      printColorMode: args.colorMode,
    });
    ctx.drawImage(chartCanvas, chartX, chartY, chartW, chartH);
  }

  ctx.strokeStyle = borderCol;
  ctx.lineWidth = Math.max(1.5, Math.round(width * 0.001));
  ctx.strokeRect(chartX, chartY, chartW, chartH);

  // Footer & Magnitude Legend
  const fy = chartY + chartH + Math.round(footerH * 0.35);
  ctx.fillStyle = subFg;
  ctx.font = `500 ${Math.max(9, Math.round(footerH * 0.36))}px "Noto Sans JP", system-ui, sans-serif`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";

  let cursorX = pad;
  if (args.includeLegend) {
    ctx.fillText("等級凡例:", cursorX, fy);
    cursorX += Math.round(footerH * 2.2);
    for (const [m, label] of [
      [-1, "-1等"],
      [1, "1等"],
      [3, "3等"],
      [5, "5等"],
    ] as [number, string][]) {
      const r = Math.max(1.1, Math.min(4.8, 3.6 - m * 0.48)) * (width / 1200);
      ctx.fillStyle = headerFg;
      ctx.beginPath();
      ctx.arc(cursorX, fy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = subFg;
      cursorX += Math.round(r * 2 + 4);
      ctx.fillText(label, cursorX, fy);
      cursorX += Math.round(footerH * 1.35);
    }
  }

  ctx.textAlign = "right";
  ctx.fillText("Generated by StarCrane (HYG / OpenNGC / d3-celestial / VSOP87 / SGP4)", width - pad, fy);

  return sheet;
}

function escapeXml(str: string): string {
  return str
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Generate clean vector SVG star chart matching current viewport, projection, and color mode. */
export function buildVectorSkySvg(args: PrintExportArgs): string {
  const { width, height } = paperDimensionsPx(args.paperSize, args.orientation, 0.5);
  const pad = 28;
  const headerH = 54;
  const footerH = 30;
  const cw = width - pad * 2;
  const ch = height - pad * 2 - headerH - footerH;

  const isInverted = args.colorMode === "inverted";
  const isGray = args.colorMode === "grayscale";
  const bg = isInverted ? "#ffffff" : isGray ? "#111827" : "#050914";
  const fg = isInverted ? "#0f172a" : "#f8fafc";
  const sub = isInverted ? "#475569" : "#94a3b8";
  const lineCol = isInverted ? "#334155" : isGray ? "#64748b" : "#38bdf8";

  const params: ProjectionParams = { ...args.params, width: cw, height: ch };
  const pCtx = compileProjectionContext(params);
  const mJ2000ToApp = flattenMat3(args.frame.j2000_to_apparent_matrix);
  const mJ2000ToEnu = args.frame.j2000_to_enu_override
    ? flattenMat3(args.frame.j2000_to_enu_override)
    : buildJ2000ToEnuMatrix(
        args.frame.j2000_to_apparent_matrix,
        args.frame.last_deg,
        args.location.lat_deg,
      );

  const scratch = new Float64Array(3);
  const projectJ2000 = (raDeg: number, decDeg: number): [number, number] | null => {
    const r = (raDeg * Math.PI) / 180;
    const d = (decDeg * Math.PI) / 180;
    const vx = Math.cos(d) * Math.cos(r);
    const vy = Math.cos(d) * Math.sin(r);
    const vz = Math.sin(d);
    const ex = mJ2000ToEnu[0] * vx + mJ2000ToEnu[1] * vy + mJ2000ToEnu[2] * vz;
    const ny = mJ2000ToEnu[3] * vx + mJ2000ToEnu[4] * vy + mJ2000ToEnu[5] * vz;
    const uz = mJ2000ToEnu[6] * vx + mJ2000ToEnu[7] * vy + mJ2000ToEnu[8] * vz;
    if (params.mode === "star_chart") {
      const ax = mJ2000ToApp[0] * vx + mJ2000ToApp[1] * vy + mJ2000ToApp[2] * vz;
      const ay = mJ2000ToApp[3] * vx + mJ2000ToApp[4] * vy + mJ2000ToApp[5] * vz;
      const az = mJ2000ToApp[6] * vx + mJ2000ToApp[7] * vy + mJ2000ToApp[8] * vz;
      if (!projectAppEqVectorForStarChart(ax, ay, az, uz, pCtx, scratch)) return null;
      return scratch[2] > 0.5 ? [scratch[0], scratch[1]] : null;
    }
    const azDeg = wrapDeg360((Math.atan2(ex, ny) * 180) / Math.PI);
    const altDeg = (Math.asin(Math.max(-1, Math.min(1, uz))) * 180) / Math.PI;
    const out = projectHorToScreen(azDeg, altDeg, pCtx, 0);
    return out && out.visible ? [out.x, out.y] : null;
  };

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
  );
  parts.push(`<rect width="${width}" height="${height}" fill="${bg}"/>`);

  const dt = args.frame.local_dt;
  const dtText = `${dt.year}-${String(dt.month).padStart(2, "0")}-${String(dt.day).padStart(2, "0")} ${String(dt.hour).padStart(2, "0")}:${String(dt.minute).padStart(2, "0")} ${args.location.tz_name}`;
  const projLabel =
    PROJECTION_META.find((m) => m.mode === args.params.mode)?.labelJa ?? args.params.mode;

  parts.push(
    `<text x="${pad}" y="${pad + 18}" fill="${fg}" font-size="18" font-weight="700" font-family="Noto Sans JP, sans-serif">${escapeXml(args.title || "StarCrane 天体星図")}</text>`,
  );
  parts.push(
    `<text x="${pad}" y="${pad + 38}" fill="${sub}" font-size="11" font-family="Noto Sans JP, sans-serif">${escapeXml(`日時: ${dtText}  観測地: ${args.location.name_ja} (${args.location.lat_deg.toFixed(2)}°N, ${args.location.lon_deg.toFixed(2)}°E)  図法: ${projLabel}`)}</text>`,
  );

  parts.push(`<defs><clipPath id="chart-clip"><rect x="0" y="0" width="${cw}" height="${ch}"/></clipPath></defs>`);
  parts.push(`<g transform="translate(${pad} ${pad + headerH})" clip-path="url(#chart-clip)">`);
  parts.push(`<rect width="${cw}" height="${ch}" fill="${bg}"/>`);

  // Constellation lines vector paths
  if (args.layers.constellationLines !== "off" && args.staticAssets) {
    const pathBuf: string[] = [];
    const jumpSq = (cw * 0.42) ** 2;
    for (const con of args.staticAssets.constellations) {
      for (const seg of con.lines_standard) {
        let pen = false;
        let prevX = 0;
        let prevY = 0;
        for (const [ra, dec] of seg) {
          const p = projectJ2000(ra, dec);
          if (!p) {
            pen = false;
            continue;
          }
          if (!pen || (p[0] - prevX) ** 2 + (p[1] - prevY) ** 2 > jumpSq) {
            pathBuf.push(`M${p[0].toFixed(1)},${p[1].toFixed(1)}`);
            pen = true;
          } else {
            pathBuf.push(`L${p[0].toFixed(1)},${p[1].toFixed(1)}`);
          }
          prevX = p[0];
          prevY = p[1];
        }
      }
    }
    if (pathBuf.length > 0) {
      parts.push(`<path d="${pathBuf.join(" ")}" fill="none" stroke="${lineCol}" stroke-width="0.9" stroke-opacity="0.6"/>`);
    }
  }

  // Bright named stars vector circles + labels
  if (args.staticAssets) {
    for (const s of args.staticAssets.named_stars) {
      if (s.mag > args.limitingMag) break;
      const p = projectJ2000(s.ra_deg, s.dec_deg);
      if (!p) continue;
      const r = Math.max(0.7, Math.min(4.2, 3.2 - s.mag * 0.45));
      parts.push(`<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${r.toFixed(2)}" fill="${fg}"/>`);
      if (args.layers.starNames && s.mag <= Math.min(args.limitingMag - 0.5, 2.5) && (s.name_ja || s.proper_name)) {
        parts.push(
          `<text x="${(p[0] + r + 3).toFixed(1)}" y="${(p[1] + 3).toFixed(1)}" fill="${fg}" font-size="10" font-family="Noto Sans JP, sans-serif">${escapeXml(s.name_ja || s.proper_name)}</text>`,
        );
      }
    }
  }

  // Solar System bodies & Comets
  for (const b of args.frame.bodies) {
    if (!params.show_below_horizon && b.alt_deg < -0.5) continue;
    const p =
      params.mode === "star_chart"
        ? projectEqToScreen(b.ra_deg, b.dec_deg, args.location.lat_deg, args.frame.last_deg, pCtx, 0)
        : projectHorToScreen(b.az_deg, b.alt_deg, pCtx, 0);
    if (!p || !p.visible) continue;
    const bCol = isInverted ? "#0f172a" : isGray ? "#e2e8f0" : b.kind === "comet" ? "#34d399" : "#fbbf24";
    parts.push(`<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4.5" fill="none" stroke="${bCol}" stroke-width="1.3"/>`);
    parts.push(
      `<text x="${(p.x + 7).toFixed(1)}" y="${(p.y + 3).toFixed(1)}" fill="${bCol}" font-size="11" font-weight="600" font-family="Noto Sans JP, sans-serif">${escapeXml(b.name_ja)}</text>`,
    );
  }

  // Active FOV boxes
  if (args.includeFov) {
    for (const f of args.fovPresets) {
      if (!f.enabled) continue;
      const dims = computeFovDimensions(f);
      const pxPerDeg = Math.min(cw, ch) / Math.max(0.25, params.fov_deg / params.zoom);
      const fCol = isInverted ? "#0f172a" : f.color;
      if (f.kind === "camera") {
        const rw = dims.widthDeg * pxPerDeg;
        const rh = dims.heightDeg * pxPerDeg;
        parts.push(
          `<rect x="${(-rw * 0.5).toFixed(1)}" y="${(-rh * 0.5).toFixed(1)}" width="${rw.toFixed(1)}" height="${rh.toFixed(1)}" transform="translate(${(cw * 0.5).toFixed(1)} ${(ch * 0.5).toFixed(1)}) rotate(${f.rotationDeg})" fill="none" stroke="${fCol}" stroke-width="1.2"/>`,
        );
      } else {
        const rad = dims.widthDeg * 0.5 * pxPerDeg;
        parts.push(
          `<circle cx="${(cw * 0.5).toFixed(1)}" cy="${(ch * 0.5).toFixed(1)}" r="${rad.toFixed(1)}" fill="none" stroke="${fCol}" stroke-width="1.2" stroke-dasharray="4 3"/>`,
        );
      }
    }
  }

  parts.push("</g>");
  parts.push(`<rect x="${pad}" y="${pad + headerH}" width="${cw}" height="${ch}" fill="none" stroke="${sub}" stroke-width="1.2"/>`);
  parts.push(
    `<text x="${width - pad}" y="${height - 14}" text-anchor="end" fill="${sub}" font-size="10" font-family="Noto Sans JP, sans-serif">StarCrane Vector Star Chart</text>`,
  );
  parts.push("</svg>");
  return parts.join("\n");
}

/**
 * Package a canvas into a standalone binary PDF 1.4 document with exact A4/B5 MediaBox and JPEG DCTDecode stream.
 */
export async function buildPdfFromCanvas(
  canvas: HTMLCanvasElement,
  paperSize: PrintPaperSize,
  orientation: PrintOrientation,
): Promise<Uint8Array> {
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("Canvas toBlob failed"))),
      "image/jpeg",
      0.93,
    );
  });
  const jpgBytes = new Uint8Array(await blob.arrayBuffer());
  const { widthPt, heightPt } = paperDimensionsPx(paperSize, orientation, 1);
  const wPt = widthPt.toFixed(2);
  const hPt = heightPt.toFixed(2);
  const enc = new TextEncoder();

  const chunks: Uint8Array[] = [];
  const offsets: number[] = [0];
  let bytePos = 0;

  const pushBytes = (u8: Uint8Array) => {
    chunks.push(u8);
    bytePos += u8.length;
  };
  const pushStr = (s: string) => pushBytes(enc.encode(s));

  pushStr("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");

  offsets.push(bytePos);
  pushStr("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");

  offsets.push(bytePos);
  pushStr("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");

  offsets.push(bytePos);
  pushStr(
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${wPt} ${hPt}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`,
  );

  offsets.push(bytePos);
  pushStr(
    `4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${canvas.width} /Height ${canvas.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpgBytes.length} >>\nstream\n`,
  );
  pushBytes(jpgBytes);
  pushStr("\nendstream\nendobj\n");

  const contentStream = `q\n${wPt} 0 0 ${hPt} 0 0 cm\n/Im0 Do\nQ\n`;
  offsets.push(bytePos);
  pushStr(
    `5 0 obj\n<< /Length ${contentStream.length} >>\nstream\n${contentStream}endstream\nendobj\n`,
  );

  const xrefStart = bytePos;
  pushStr(`xref\n0 ${offsets.length}\n0000000000 65535 f \n`);
  for (let i = 1; i < offsets.length; i++) {
    pushStr(`${String(offsets[i]).padStart(10, "0")} 00000 n \n`);
  }
  pushStr(`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`);

  const out = new Uint8Array(bytePos);
  let pos = 0;
  for (const ch of chunks) {
    out.set(ch, pos);
    pos += ch.length;
  }
  return out;
}

export function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
