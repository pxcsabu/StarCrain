import { useEffect, useRef, useState } from "react";
import { Download, FileCode2, FileImage, FileText, Printer, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  buildPdfFromCanvas,
  buildVectorSkySvg,
  type PrintExportArgs,
  renderPrintSheetCanvas,
  triggerBlobDownload,
} from "@/lib/printExport";
import { useSkyStore } from "@/store/skyStore";
import type { PrintColorMode, PrintOrientation, PrintPaperSize } from "@/types/sky";

export function PrintExport() {
  const skyFrame = useSkyStore((s) => s.skyFrame);
  const location = useSkyStore((s) => s.location);
  const staticAssets = useSkyStore((s) => s.staticAssets);
  const starBuffer = useSkyStore((s) => s.starBuffer);
  const starCount = useSkyStore((s) => s.starCount);
  const dsoBuffer = useSkyStore((s) => s.dsoBuffer);
  const dsoCount = useSkyStore((s) => s.dsoCount);
  const limitingMag = useSkyStore((s) => s.limitingMag);
  const refractionEnabled = useSkyStore((s) => s.refractionEnabled);
  const layers = useSkyStore((s) => s.layers);
  const customColors = useSkyStore((s) => s.customColors);
  const fovPresets = useSkyStore((s) => s.fovPresets);
  const satellites = useSkyStore((s) => s.satellites);
  const showSatellites = useSkyStore((s) => s.showSatellites);
  const highlightedSatPass = useSkyStore((s) => s.highlightedSatPass);
  const buildProjectionParams = useSkyStore((s) => s.buildProjectionParams);
  const setActivePanel = useSkyStore((s) => s.setActivePanel);

  const [paperSize, setPaperSize] = useState<PrintPaperSize>("A4");
  const [orientation, setOrientation] = useState<PrintOrientation>("landscape");
  const [colorMode, setColorMode] = useState<PrintColorMode>("inverted");
  const [title, setTitle] = useState("StarCrane 観望用星図");
  const [includeFov, setIncludeFov] = useState(true);
  const [includeLegend, setIncludeLegend] = useState(true);
  const [busyMsg, setBusyMsg] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const previewRef = useRef<HTMLCanvasElement | null>(null);

  const buildArgs = (): PrintExportArgs | null => {
    if (!skyFrame) return null;
    return {
      paperSize,
      orientation,
      colorMode,
      title,
      includeFov,
      includeLegend,
      params: buildProjectionParams(1280, 800),
      frame: skyFrame,
      location,
      staticAssets,
      starBuffer,
      starCount,
      dsoBuffer,
      dsoCount,
      limitingMag,
      refractionEnabled,
      layers,
      customColors,
      fovPresets,
      satellites,
      showSatellites,
      highlightedSatPass,
    };
  };

  useEffect(() => {
    const args = buildArgs();
    const target = previewRef.current;
    if (!args || !target) return;
    const sheet = renderPrintSheetCanvas(args, 0.34);
    target.width = sheet.width;
    target.height = sheet.height;
    const ctx = target.getContext("2d");
    ctx?.drawImage(sheet, 0, 0);
  }, [
    paperSize,
    orientation,
    colorMode,
    title,
    includeFov,
    includeLegend,
    skyFrame,
    location,
    dsoBuffer,
    limitingMag,
    layers,
    fovPresets,
  ]);

  const handleExportPng = () => {
    const args = buildArgs();
    if (!args) return;
    setBusyMsg("高解像度 PNG 生成中...");
    setTimeout(() => {
      try {
        const sheet = renderPrintSheetCanvas(args, 1);
        sheet.toBlob((blob) => {
          if (blob) {
            triggerBlobDownload(blob, `starcrane-${paperSize}-${colorMode}.png`);
            setStatusMsg(`${paperSize} 高解像度 PNG (${sheet.width}×${sheet.height}px) を保存しました。`);
          }
          setBusyMsg(null);
        }, "image/png");
      } catch {
        setBusyMsg(null);
      }
    }, 20);
  };

  const handleExportSvg = () => {
    const args = buildArgs();
    if (!args) return;
    const svgText = buildVectorSkySvg(args);
    const blob = new Blob([svgText], { type: "image/svg+xml;charset=utf-8" });
    triggerBlobDownload(blob, `starcrane-${paperSize}-${colorMode}.svg`);
    setStatusMsg(`${paperSize} ベクター SVG を保存しました。`);
  };

  const handleExportPdf = async () => {
    const args = buildArgs();
    if (!args) return;
    setBusyMsg("PDF 生成中...");
    try {
      const sheet = renderPrintSheetCanvas(args, 0.9);
      const pdfBytes = await buildPdfFromCanvas(sheet, paperSize, orientation);
      const blob = new Blob([pdfBytes.slice().buffer], { type: "application/pdf" });
      triggerBlobDownload(blob, `starcrane-${paperSize}-${colorMode}.pdf`);
      setStatusMsg(`${paperSize} (${orientation === "landscape" ? "横" : "縦"}) PDF を保存しました。`);
    } finally {
      setBusyMsg(null);
    }
  };

  const handleNativePrint = () => {
    const args = buildArgs();
    if (!args) return;
    const sheet = renderPrintSheetCanvas(args, 0.85);
    const dataUrl = sheet.toDataURL("image/png");
    const win = window.open("", "_blank");
    if (!win) {
      setStatusMsg("印刷プレビューウィンドウを開けませんでした。PDF出力をご利用ください。");
      return;
    }
    win.document.write(
      `<!DOCTYPE html><html><head><title>${title}</title><style>@page{size:${paperSize} ${orientation};margin:6mm;}body{margin:0;display:flex;justify-content:center;align-items:center;background:#fff;}img{max-width:100%;max-height:100vh;object-fit:contain;}</style></head><body><img src="${dataUrl}" onload="window.print()" /></body></html>`,
    );
    win.document.close();
  };

  return (
    <aside className="flex h-full w-[30rem] max-w-[calc(100vw-5.5rem)] flex-col rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface-glass)] text-[var(--text-primary)] shadow-2xl backdrop-blur-md">
      {/* Header */}
      <div className="flex items-start justify-between gap-2 border-b border-[var(--border-subtle)] px-4 py-3">
        <div>
          <h2 className="flex items-center gap-1.5 text-sm font-semibold tracking-tight">
            <Printer className="h-4 w-4 text-sky-400" /> 拡張印刷 &amp; エクスポート (PNG / SVG / PDF)
          </h2>
          <p className="text-[11px] text-[var(--text-muted)]">
            A4 / B5 用紙レイアウト・日時/観測地/図法ヘッダー自動印字・白地黒星インク節約モード
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

      {/* Controls */}
      <div className="space-y-2.5 border-b border-[var(--border-subtle)] px-4 py-3 text-xs">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="mb-1 text-[10px] text-[var(--text-muted)]">用紙サイズ・向き</div>
            <div className="flex gap-1">
              {(["A4", "B5"] as PrintPaperSize[]).map((sz) => (
                <button
                  key={sz}
                  type="button"
                  onClick={() => setPaperSize(sz)}
                  className={`rounded border px-2 py-0.5 text-[11px] font-medium ${
                    paperSize === sz
                      ? "border-[var(--accent-primary)] bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]"
                      : "border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)]"
                  }`}
                >
                  {sz}
                </button>
              ))}
              {(
                [
                  { id: "landscape", label: "横" },
                  { id: "portrait", label: "縦" },
                ] as const
              ).map((o) => (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => setOrientation(o.id)}
                  className={`rounded border px-2 py-0.5 text-[11px] font-medium ${
                    orientation === o.id
                      ? "border-[var(--accent-primary)] bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]"
                      : "border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)]"
                  }`}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="mb-1 text-[10px] text-[var(--text-muted)]">色彩モード</div>
            <div className="flex gap-1">
              {(
                [
                  { id: "inverted", label: "白地黒星" },
                  { id: "grayscale", label: "白黒" },
                  { id: "normal", label: "カラー" },
                ] as const
              ).map((cm) => (
                <button
                  key={cm.id}
                  type="button"
                  onClick={() => setColorMode(cm.id)}
                  className={`rounded border px-2 py-0.5 text-[10px] font-medium ${
                    colorMode === cm.id
                      ? "border-[var(--accent-primary)] bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]"
                      : "border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)]"
                  }`}
                >
                  {cm.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="星図タイトル"
            className="h-7 flex-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 text-xs"
          />
          <label className="flex shrink-0 items-center gap-1 text-[11px]">
            <input
              type="checkbox"
              checked={includeFov}
              onChange={(e) => setIncludeFov(e.target.checked)}
            />
            FOV枠
          </label>
          <label className="flex shrink-0 items-center gap-1 text-[11px]">
            <input
              type="checkbox"
              checked={includeLegend}
              onChange={(e) => setIncludeLegend(e.target.checked)}
            />
            凡例
          </label>
        </div>

        {statusMsg && (
          <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/15 px-2.5 py-1.5 text-[11px] text-emerald-200">
            {statusMsg}
          </div>
        )}
      </div>

      {/* Paper Preview */}
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-auto bg-black/25 p-3">
        <canvas
          ref={previewRef}
          className="max-h-full max-w-full rounded border border-white/15 shadow-xl"
        />
        {busyMsg && (
          <div className="mt-2 text-[11px] text-sky-300">{busyMsg}</div>
        )}
      </div>

      {/* Export Buttons */}
      <div className="grid grid-cols-4 gap-1.5 border-t border-[var(--border-subtle)] px-4 py-3">
        <Button
          type="button"
          size="sm"
          className="h-8 gap-1 px-2 text-[11px]"
          disabled={!!busyMsg}
          onClick={() => void handleExportPdf()}
        >
          <FileText className="h-3.5 w-3.5" />
          PDF
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 gap-1 px-2 text-[11px]"
          disabled={!!busyMsg}
          onClick={handleExportPng}
        >
          <FileImage className="h-3.5 w-3.5" />
          PNG
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 gap-1 px-2 text-[11px]"
          disabled={!!busyMsg}
          onClick={handleExportSvg}
        >
          <FileCode2 className="h-3.5 w-3.5" />
          SVG
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 gap-1 px-2 text-[11px]"
          disabled={!!busyMsg}
          onClick={handleNativePrint}
        >
          <Download className="h-3.5 w-3.5" />
          印刷
        </Button>
      </div>
    </aside>
  );
}
