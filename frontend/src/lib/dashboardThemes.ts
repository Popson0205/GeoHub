// Dashboard looks. A theme is a handful of colours; the builder turns them into CSS variables on the dashboard canvas
// only, so nothing outside the dashboard changes. Presets are fixed; a person can change any single colour on top of one.
import type { CSSProperties } from "react";
import type { DashTheme, ThemeColorKey } from "./types";

export const THEME_KEYS: ThemeColorKey[] = ["background", "foreground", "accent", "cardBackground", "cardForeground", "headerBackground", "headerForeground"];
export type ThemeColors = Record<ThemeColorKey, string>;
export interface ThemePreset { label: string; colors: ThemeColors }

export const DASHBOARD_THEMES: Record<string, ThemePreset> = {
  light: { label: "Light", colors: { background: "#f1f3f2", foreground: "#10241f", accent: "#17634c", cardBackground: "#ffffff", cardForeground: "#10241f", headerBackground: "#ffffff", headerForeground: "#10241f" } },
  dark: { label: "Dark", colors: { background: "#12161c", foreground: "#e6ebe8", accent: "#4fc08d", cardBackground: "#1c222b", cardForeground: "#e6ebe8", headerBackground: "#1c222b", headerForeground: "#e6ebe8" } },
  ocean: { label: "Ocean", colors: { background: "#eaf1f7", foreground: "#0f2a43", accent: "#1f6fb2", cardBackground: "#ffffff", cardForeground: "#0f2a43", headerBackground: "#12395c", headerForeground: "#ffffff" } },
  earth: { label: "Earth", colors: { background: "#f6efe6", foreground: "#3a2a1c", accent: "#b8431a", cardBackground: "#fffaf3", cardForeground: "#3a2a1c", headerBackground: "#6b3a1e", headerForeground: "#ffffff" } },
  violet: { label: "Violet", colors: { background: "#f4eff7", foreground: "#2b1733", accent: "#7a2e8e", cardBackground: "#ffffff", cardForeground: "#2b1733", headerBackground: "#4a1a57", headerForeground: "#ffffff" } },
};
export const DEFAULT_THEME_PRESET = "light";

export const THEME_COLOR_FIELDS: { group: string; fields: { key: ThemeColorKey; label: string }[] }[] = [
  { group: "Canvas", fields: [{ key: "background", label: "Background" }, { key: "foreground", label: "Text" }, { key: "accent", label: "Accent (charts, numbers)" }] },
  { group: "Elements", fields: [{ key: "cardBackground", label: "Element background" }, { key: "cardForeground", label: "Element text" }] },
  { group: "Header", fields: [{ key: "headerBackground", label: "Header background" }, { key: "headerForeground", label: "Header text" }] },
];

export const isHexColor = (v: unknown): v is string => typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v);

/** The theme's colours: its preset, with the author's own colours on top. Unknown presets and bad colours are ignored, never trusted. */
export function resolveThemeColors(theme?: DashTheme | null): ThemeColors {
  const base = (theme && DASHBOARD_THEMES[theme.preset]) || DASHBOARD_THEMES[DEFAULT_THEME_PRESET];
  const out: ThemeColors = { ...base.colors };
  for (const k of THEME_KEYS) { const v = theme?.overrides?.[k]; if (isHexColor(v)) out[k] = v; }
  return out;
}

/** Only the known keys with real colours, so a saved theme never carries anything else. */
export function cleanTheme(raw: unknown): DashTheme | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const t = raw as { preset?: unknown; overrides?: Record<string, unknown> };
  const preset = typeof t.preset === "string" && DASHBOARD_THEMES[t.preset] ? t.preset : DEFAULT_THEME_PRESET;
  const overrides: DashTheme["overrides"] = {};
  for (const k of THEME_KEYS) { const v = t.overrides?.[k]; if (isHexColor(v)) overrides[k] = v; }
  return Object.keys(overrides).length ? { preset, overrides } : { preset };
}

const mix = (a: string, pct: number, b: string) => `color-mix(in srgb, ${a} ${pct}%, ${b})`;
/** CSS variables for the canvas. The dashboard's tiles, charts and filters already read these tokens, so they follow the theme. */
export function themeToCssVars(c: ThemeColors): CSSProperties {
  const vars: Record<string, string> = {
    "--dash-bg": c.background, "--dash-fg": c.foreground, "--dash-accent": c.accent,
    "--dash-card": c.cardBackground, "--dash-card-fg": c.cardForeground,
    "--dash-head-bg": c.headerBackground, "--dash-head-fg": c.headerForeground,
    "--paper": c.background, "--card": c.cardBackground, "--ink": c.cardForeground, "--ink-900": c.cardForeground,
    "--n-800": c.cardForeground, "--n-700": mix(c.cardForeground, 88, c.cardBackground), "--n-600": mix(c.cardForeground, 72, c.cardBackground),
    "--muted": mix(c.cardForeground, 72, c.cardBackground), "--n-500": mix(c.cardForeground, 58, c.cardBackground), "--n-400": mix(c.cardForeground, 42, c.cardBackground),
    "--line": mix(c.cardForeground, 14, c.cardBackground), "--line-strong": mix(c.cardForeground, 24, c.cardBackground),
    "--n-300": mix(c.cardForeground, 22, c.cardBackground), "--n-200": mix(c.cardForeground, 12, c.cardBackground),
    "--n-100": mix(c.cardForeground, 8, c.cardBackground), "--n-50": mix(c.cardForeground, 4, c.cardBackground),
    "--green-50": mix(c.accent, 12, c.cardBackground), "--green-300": mix(c.accent, 55, c.cardBackground), "--green-500": c.accent, "--green-600": c.accent, "--green-800": mix(c.accent, 80, c.cardForeground),
    "--chart-1": c.accent,
  };
  return vars as CSSProperties;
}
