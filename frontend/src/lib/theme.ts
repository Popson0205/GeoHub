/** Light, dark, or whatever the device uses. The choice is kept in this browser and set as data-theme on <html>. */
export type ThemePref = "system" | "light" | "dark";
const KEY = "geohub.theme";

export function getTheme(): ThemePref {
  try { const v = localStorage.getItem(KEY); return v === "light" || v === "dark" ? v : "system"; } catch { return "system"; }
}
export function applyTheme(t: ThemePref): void {
  const el = document.documentElement;
  if (t === "system") el.removeAttribute("data-theme"); else el.setAttribute("data-theme", t);
}
export function setTheme(t: ThemePref): void {
  try { if (t === "system") localStorage.removeItem(KEY); else localStorage.setItem(KEY, t); } catch { /* private mode: still applies for this visit */ }
  applyTheme(t);
}
