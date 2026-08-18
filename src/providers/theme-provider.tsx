"use client";

import * as React from "react";
import { useServerInsertedHTML } from "next/navigation";
import type { ResolvedTheme, ThemeMode } from "@/types/theme";

const STORAGE_KEY = "theme";

type ThemeContextValue = {
  theme: ThemeMode;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: ThemeMode) => void;
  systemTheme: ResolvedTheme;
};

const ThemeContext = React.createContext<ThemeContextValue | null>(null);

function buildThemeInitScript(defaultTheme: ThemeMode) {
  return `(function(){try{var k=${JSON.stringify(STORAGE_KEY)};var d=${JSON.stringify(defaultTheme)};var t=localStorage.getItem(k)||d;var m=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';var r=t==='dark'||t==='light'?t:t==='system'?m:'light';var e=document.documentElement;e.classList.remove('light','dark');e.classList.add(r);e.style.colorScheme=r;}catch(e){}})();`;
}

function getSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function applyTheme(resolved: ResolvedTheme, disableTransition: boolean) {
  const root = document.documentElement;
  if (disableTransition) {
    const style = document.createElement("style");
    style.appendChild(
      document.createTextNode(
        "*,*::before,*::after{-webkit-transition:none!important;transition:none!important}",
      ),
    );
    document.head.appendChild(style);
    root.classList.remove("light", "dark");
    root.classList.add(resolved);
    root.style.colorScheme = resolved;
    void window.getComputedStyle(style).opacity;
    style.remove();
    return;
  }
  root.classList.remove("light", "dark");
  root.classList.add(resolved);
  root.style.colorScheme = resolved;
}

export function ThemeProvider({
  children,
  defaultTheme = "light",
  enableSystem = true,
  disableTransitionOnChange = false,
}: {
  children: React.ReactNode;
  defaultTheme?: ThemeMode;
  enableSystem?: boolean;
  disableTransitionOnChange?: boolean;
}) {
  const [theme, setThemeState] = React.useState<ThemeMode>(defaultTheme);
  const [systemTheme, setSystemTheme] = React.useState<ResolvedTheme>("light");
  const [mounted, setMounted] = React.useState(false);
  const scriptInserted = React.useRef(false);

  useServerInsertedHTML(() => {
    if (scriptInserted.current) return null;
    scriptInserted.current = true;
    return (
      <script
        dangerouslySetInnerHTML={{
          __html: buildThemeInitScript(defaultTheme),
        }}
      />
    );
  });

  React.useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY) as ThemeMode | null;
    const initial =
      stored === "light" || stored === "dark" || stored === "system"
        ? stored
        : defaultTheme;
    setThemeState(initial);
    setSystemTheme(getSystemTheme());
    setMounted(true);

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setSystemTheme(getSystemTheme());
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [defaultTheme]);

  const resolvedTheme: ResolvedTheme =
    theme === "system" && enableSystem
      ? systemTheme
      : theme === "dark"
        ? "dark"
        : "light";

  React.useEffect(() => {
    if (!mounted) return;
    applyTheme(resolvedTheme, disableTransitionOnChange);
  }, [mounted, resolvedTheme, disableTransitionOnChange]);

  const setTheme = React.useCallback((next: ThemeMode) => {
    setThemeState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore quota / private mode
    }
  }, []);

  const value = React.useMemo<ThemeContextValue>(
    () => ({
      theme,
      resolvedTheme,
      setTheme,
      systemTheme,
    }),
    [theme, resolvedTheme, setTheme, systemTheme],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = React.useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useTheme must be used within ThemeProvider");
  }
  return ctx;
}
