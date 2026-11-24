import { create } from "zustand";
import type { InversePoint } from "@/types/sky";

interface TelemetryStoreState {
  fps: number;
  hover: InversePoint | null;
  setFps: (fps: number) => void;
  setHover: (hover: InversePoint | null) => void;
  setTelemetry: (fps: number, hover: InversePoint | null) => void;
}

export const useTelemetryStore = create<TelemetryStoreState>((set) => ({
  fps: 60,
  hover: null,
  setFps: (fps) => set((s) => (s.fps === fps ? s : { fps })),
  setHover: (hover) => set((s) => (s.hover === null && hover === null ? s : { hover })),
  setTelemetry: (fps, hover) => set({ fps, hover }),
}));
