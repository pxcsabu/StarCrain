import {
  memo,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

interface FloatingPanelWindowProps {
  id: string;
  zIndex: number;
  defaultX: number;
  defaultY: number;
  isFocused?: boolean;
  openCount?: number;
  closing?: boolean;
  onFocusPanel: (id: string) => void;
  children: ReactNode;
}

type ResizeDir = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

const TOP_SAFE_Y = 60;
const EDGE_MARGIN_X = 8;
const BOTTOM_SAFE_GAP = 72;
const MIN_WIDTH = 280;
const MIN_HEIGHT = 220;

function clampFloatingPosition(
  x: number,
  y: number,
  el: HTMLElement | null,
  explicitSize: { width: number; height: number } | null,
): { x: number; y: number } {
  if (typeof window === "undefined") return { x, y };
  const width = explicitSize?.width ?? el?.offsetWidth ?? 352;
  const height = explicitSize?.height ?? el?.offsetHeight ?? 420;
  const maxX = Math.max(EDGE_MARGIN_X, window.innerWidth - width - EDGE_MARGIN_X);
  const maxY = Math.max(TOP_SAFE_Y, window.innerHeight - height - BOTTOM_SAFE_GAP);
  return {
    x: Math.min(maxX, Math.max(EDGE_MARGIN_X, x)),
    y: Math.min(maxY, Math.max(TOP_SAFE_Y, y)),
  };
}

const EDGE_HANDLES: { dir: ResizeDir; className: string }[] = [
  { dir: "n", className: "top-0 inset-x-3 h-1.5 cursor-ns-resize" },
  { dir: "s", className: "bottom-0 inset-x-3 h-1.5 cursor-ns-resize" },
  { dir: "w", className: "left-0 inset-y-3 w-1.5 cursor-ew-resize" },
  { dir: "e", className: "right-0 inset-y-3 w-1.5 cursor-ew-resize" },
  { dir: "nw", className: "top-0 left-0 h-3 w-3 cursor-nwse-resize" },
  { dir: "ne", className: "top-0 right-0 h-3 w-3 cursor-nesw-resize" },
  { dir: "sw", className: "bottom-0 left-0 h-3 w-3 cursor-nesw-resize" },
];

export const FloatingPanelWindow = memo(function FloatingPanelWindow({
  id,
  zIndex,
  defaultX,
  defaultY,
  isFocused = true,
  openCount = 1,
  closing = false,
  onFocusPanel,
  children,
}: FloatingPanelWindowProps) {
  const winRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number }>(() => ({ x: defaultX, y: defaultY }));
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [interacting, setInteracting] = useState(false);
  const sizeRef = useRef<{ width: number; height: number } | null>(null);
  sizeRef.current = size;

  const dragStateRef = useRef<{
    pointerId: number;
    startPointerX: number;
    startPointerY: number;
    startPosX: number;
    startPosY: number;
  } | null>(null);

  const resizeStateRef = useRef<{
    pointerId: number;
    dir: ResizeDir;
    startPointerX: number;
    startPointerY: number;
    startX: number;
    startY: number;
    startW: number;
    startH: number;
  } | null>(null);

  const clampInPlace = useCallback(() => {
    setSize((prevSize) => {
      if (!prevSize || typeof window === "undefined") return prevSize;
      const maxW = Math.max(MIN_WIDTH, window.innerWidth - EDGE_MARGIN_X * 2);
      const maxH = Math.max(MIN_HEIGHT, window.innerHeight - TOP_SAFE_Y - 12);
      const nextW = Math.min(prevSize.width, maxW);
      const nextH = Math.min(prevSize.height, maxH);
      return nextW === prevSize.width && nextH === prevSize.height
        ? prevSize
        : { width: nextW, height: nextH };
    });
    setPos((prev) => {
      const clamped = clampFloatingPosition(prev.x, prev.y, winRef.current, sizeRef.current);
      return clamped.x === prev.x && clamped.y === prev.y ? prev : clamped;
    });
  }, []);

  useEffect(() => {
    const raf = requestAnimationFrame(clampInPlace);
    window.addEventListener("resize", clampInPlace);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", clampInPlace);
    };
  }, [clampInPlace]);

  const handleFocus = useCallback(() => {
    if (!isFocused) {
      onFocusPanel(id);
    }
  }, [id, isFocused, onFocusPanel]);

  const handleDragStart = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    handleFocus();
    setInteracting(true);
    e.currentTarget.setPointerCapture(e.pointerId);
    dragStateRef.current = {
      pointerId: e.pointerId,
      startPointerX: e.clientX,
      startPointerY: e.clientY,
      startPosX: pos.x,
      startPosY: pos.y,
    };
  };

  const handleDragMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragStateRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const dx = e.clientX - drag.startPointerX;
    const dy = e.clientY - drag.startPointerY;
    setPos(
      clampFloatingPosition(
        drag.startPosX + dx,
        drag.startPosY + dy,
        winRef.current,
        sizeRef.current,
      ),
    );
  };

  const handleDragEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragStateRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    dragStateRef.current = null;
    setInteracting(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const handleResizeStart = (dir: ResizeDir) => (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    handleFocus();
    setInteracting(true);
    e.currentTarget.setPointerCapture(e.pointerId);

    const rect = winRef.current?.getBoundingClientRect();
    const startX = rect ? rect.left : pos.x;
    const startY = rect ? rect.top : pos.y;
    const startW = rect ? rect.width : size?.width ?? 360;
    const startH = rect ? rect.height : size?.height ?? 420;

    setSize((prev) => prev ?? { width: Math.round(startW), height: Math.round(startH) });
    resizeStateRef.current = {
      pointerId: e.pointerId,
      dir,
      startPointerX: e.clientX,
      startPointerY: e.clientY,
      startX,
      startY,
      startW,
      startH,
    };
  };

  const handleResizeMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const rs = resizeStateRef.current;
    if (!rs || rs.pointerId !== e.pointerId || typeof window === "undefined") return;
    const dx = e.clientX - rs.startPointerX;
    const dy = e.clientY - rs.startPointerY;
    const { dir, startX, startY, startW, startH } = rs;

    let nextX = startX;
    let nextY = startY;
    let nextW = startW;
    let nextH = startH;

    if (dir === "e" || dir === "ne" || dir === "se") {
      const maxW = Math.max(MIN_WIDTH, window.innerWidth - startX - EDGE_MARGIN_X);
      nextW = Math.min(maxW, Math.max(MIN_WIDTH, startW + dx));
    }
    if (dir === "s" || dir === "se" || dir === "sw") {
      const maxH = Math.max(MIN_HEIGHT, window.innerHeight - startY - 12);
      nextH = Math.min(maxH, Math.max(MIN_HEIGHT, startH + dy));
    }
    if (dir === "w" || dir === "nw" || dir === "sw") {
      const right = startX + startW;
      const maxX = right - MIN_WIDTH;
      nextX = Math.min(maxX, Math.max(EDGE_MARGIN_X, startX + dx));
      nextW = right - nextX;
    }
    if (dir === "n" || dir === "nw" || dir === "ne") {
      const bottom = startY + startH;
      const maxY = bottom - MIN_HEIGHT;
      nextY = Math.min(maxY, Math.max(TOP_SAFE_Y, startY + dy));
      nextH = bottom - nextY;
    }

    setPos({ x: Math.round(nextX), y: Math.round(nextY) });
    setSize({ width: Math.round(nextW), height: Math.round(nextH) });
  };

  const handleResizeEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    const rs = resizeStateRef.current;
    if (!rs || rs.pointerId !== e.pointerId) return;
    resizeStateRef.current = null;
    setInteracting(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  return (
    <div
      ref={winRef}
      data-floating-window={id}
      data-resized={size !== null ? "true" : undefined}
      data-focused={isFocused ? "true" : "false"}
      data-multi={openCount > 2 ? "true" : "false"}
      data-interacting={interacting ? "true" : undefined}
      onPointerDownCapture={handleFocus}
      onFocusCapture={handleFocus}
      style={{
        left: 0,
        top: 0,
        transform: `translate3d(${pos.x}px, ${pos.y}px, 0)`,
        width: size ? `${size.width}px` : undefined,
        height: size ? `${size.height}px` : undefined,
        zIndex,
      }}
      className={`fixed starcrane-floating-window flex flex-col ${
        closing ? "pointer-events-none" : "pointer-events-auto"
      }`}
    >
      <div
        className={`relative liquid-glass-sheet starcrane-floating-surface overflow-hidden ${
          closing ? "starcrane-win-exit" : "starcrane-win-enter"
        }`}
      >
        {/* Top Drag Bar */}
        <div
          role="presentation"
          title="ドラッグして移動"
          onPointerDown={handleDragStart}
          onPointerMove={handleDragMove}
          onPointerUp={handleDragEnd}
          onPointerCancel={handleDragEnd}
          style={{ touchAction: "none" }}
          className="h-5 pt-0.5 [@media(pointer:coarse)]:h-7 shrink-0 flex items-center justify-center cursor-grab active:cursor-grabbing select-none border-b border-white/[0.08] hover:bg-white/[0.05] transition-colors"
        >
          <span className="h-1 w-9 rounded-full bg-white/30" />
        </div>

        {/* Panel Body */}
        <div className="starcrane-panel-host min-h-0 flex-1 overflow-hidden">
          {children}
        </div>

        {/* Edge & Corner Resize Handles */}
        {EDGE_HANDLES.map((h) => (
          <div
            key={h.dir}
            role="presentation"
            onPointerDown={handleResizeStart(h.dir)}
            onPointerMove={handleResizeMove}
            onPointerUp={handleResizeEnd}
            onPointerCancel={handleResizeEnd}
            style={{ touchAction: "none" }}
            className={`absolute z-20 ${h.className}`}
          />
        ))}

        {/* Bottom-right visible resize grip */}
        <div
          role="presentation"
          title="ドラッグしてサイズ変更（ダブルクリックで初期サイズ）"
          onPointerDown={handleResizeStart("se")}
          onPointerMove={handleResizeMove}
          onPointerUp={handleResizeEnd}
          onPointerCancel={handleResizeEnd}
          onDoubleClick={(e) => {
            e.stopPropagation();
            setSize(null);
            requestAnimationFrame(clampInPlace);
          }}
          style={{ touchAction: "none" }}
          className="absolute right-0 bottom-0 z-20 flex h-4 w-4 [@media(pointer:coarse)]:h-7 [@media(pointer:coarse)]:w-7 cursor-nwse-resize items-end justify-end p-1 text-white/40 transition-colors hover:text-white/80"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
            <path d="M9 3.5L3.5 9M9 6.5L6.5 9" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
          </svg>
        </div>
      </div>
    </div>
  );
});
