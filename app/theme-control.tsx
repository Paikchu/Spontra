"use client";

import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";

const key = "max-investment-record:theme";
type Mode = "system" | "light" | "dark";
const valid = (value: unknown): value is Mode => value === "system" || value === "light" || value === "dark";


function apply(mode: Mode) {
  const dark = mode === "dark" || (mode === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
  document.querySelectorAll('meta[name="theme-color"]').forEach((node) => node.setAttribute("content", dark ? "#0d1718" : "#f6f7f4"));
  window.dispatchEvent(new Event("max-theme-change"));
}

export function useResolvedTheme() {
  const [theme, setTheme] = useState<"light" | "dark">("dark");
  useEffect(() => {
    const sync = () => setTheme(document.documentElement.classList.contains("dark") ? "dark" : "light");
    sync();
    window.addEventListener("max-theme-change", sync);
    return () => window.removeEventListener("max-theme-change", sync);
  }, []);
  return theme;
}

const ThemeContext = createContext<{ mode: Mode; choose: (value: string) => void } | null>(null);

function savedMode(): Mode {
  try { const saved = localStorage.getItem(key); return valid(saved) ? saved : "dark"; } catch { return "dark"; }
}
function subscribeMode(notify: () => void) {
  const onStorage = (event: StorageEvent) => { if (event.key === key || event.key === null) { selectedMode = null; notify(); } };
  window.addEventListener("storage", onStorage);
  window.addEventListener("max-theme-choice", notify);
  return () => { window.removeEventListener("storage", onStorage); window.removeEventListener("max-theme-choice", notify); };
}
let selectedMode: Mode | null = null;
function currentMode() { return selectedMode ?? savedMode(); }

export function ThemeProvider({ children }: { children: ReactNode }) {
  const mode = useSyncExternalStore(subscribeMode, currentMode, () => "dark" as Mode);
  useEffect(() => {
    apply(mode);
    const media = matchMedia("(prefers-color-scheme: dark)");
    const systemChanged = () => apply(mode);
    media.addEventListener("change", systemChanged);
    return () => media.removeEventListener("change", systemChanged);
  }, [mode]);
  const choose = (value: string) => {
    if (!valid(value)) return;
    selectedMode = value;
    try { localStorage.setItem(key, value); } catch {}
    window.dispatchEvent(new Event("max-theme-choice"));
  };
  return <ThemeContext.Provider value={{ mode, choose }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme requires ThemeProvider");
  return context;
}
