import { create } from "zustand";

export type ThemeMode = "dark" | "night-vision";

const STORAGE_KEY = "starcrane-theme";

function getInitialTheme(): ThemeMode {
  if (typeof window === "undefined") {
    return "dark";
  }
  const saved = window.localStorage.getItem(STORAGE_KEY);
  if (saved === "night-vision") {
    return "night-vision";
  }
  if (saved === "light") {
    window.localStorage.setItem(STORAGE_KEY, "dark");
  }
  return "dark";
}

function applyThemeToDom(theme: ThemeMode): void {
  if (typeof document !== "undefined") {
    document.documentElement.dataset.theme = theme;
  }
}

interface ThemeState {
  theme: ThemeMode;
  setTheme: (theme: ThemeMode) => void;
  cycleTheme: () => void;
}

const initialTheme = getInitialTheme();
applyThemeToDom(initialTheme);

export const useThemeStore = create<ThemeState>((set, get) => ({
  theme: initialTheme,
  setTheme: (theme) => {
    applyThemeToDom(theme);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, theme);
    }
    set({ theme });
  },
  cycleTheme: () => {
    const next: ThemeMode = get().theme === "night-vision" ? "dark" : "night-vision";
    get().setTheme(next);
  },
}));
