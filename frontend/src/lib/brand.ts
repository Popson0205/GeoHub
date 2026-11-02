/** An organization's colour applied to the app: the brand green's shades are swapped for ones made from it, in light
 * and dark themes. Success colours (e.g. "Verified" badges) keep their own green. */
import type { OrgBrand } from "./types";

const STYLE_ID = "org-brand";
type Rgb = [number, number, number];

export function parseHex(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const toHex = (c: Rgb) => "#" + c.map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, "0")).join("");
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const lin = (c: number) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
export const luminance = (c: Rgb) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
export const contrast = (a: Rgb, b: Rgb) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

/** The colour, darkened until white text on it reads at 4.5:1 (the server does the same when saving). */
export function readable(hex: string): string {
  let c = parseHex(hex);
  if (!c) return hex;
  while (contrast(c, [255, 255, 255]) < 4.5) c = c.map((x) => Math.floor(x * 0.92)) as Rgb;
  return toHex(c);
}

const WHITE: Rgb = [255, 255, 255], INK: Rgb = [18, 22, 20];
/** The shades that stand in for the brand green, for light and for dark backgrounds. */
export function palette(hex: string): { light: Record<string, string>; dark: Record<string, string> } | null {
  const c = parseHex(readable(hex));
  if (!c) return null;
  const light = { "--green-50": toHex(mix(c, WHITE, 0.92)), "--green-500": toHex(mix(c, WHITE, 0.15)), "--green-600": toHex(c),
    "--green-700": toHex(mix(c, [0, 0, 0], 0.2)), "--green-hover": toHex(mix(c, [0, 0, 0], 0.2)), "--green-soft": toHex(mix(c, WHITE, 0.92)) };
  // on dark backgrounds text and highlights need a light version; buttons keep the colour itself (white text on it)
  let text = mix(c, WHITE, 0.45);
  for (let t = 0.5; contrast(text, INK) < 4.5 && t <= 1; t += 0.05) text = mix(c, WHITE, t);
  const dark = { "--green-50": toHex(mix(c, INK, 0.82)), "--green-500": toHex(mix(c, WHITE, 0.3)), "--green-600": toHex(c),
    "--green-700": toHex(text), "--green-hover": toHex(mix(c, WHITE, 0.12)), "--green-soft": toHex(mix(c, INK, 0.82)) };
  return { light, dark };
}

const decl = (vars: Record<string, string>) => Object.entries(vars).map(([k, v]) => `${k}:${v}`).join(";");

/** Apply (or remove, with null) an organization's colour. Rules mirror tokens.css so light/dark switching still works. */
export function applyBrand(brand: OrgBrand | null | undefined): void {
  if (typeof document === "undefined") return;
  document.getElementById(STYLE_ID)?.remove();
  const p = brand?.color ? palette(brand.color) : null;
  if (!p) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = `:root{${decl(p.light)}}` +
    `@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){${decl(p.dark)}}}` +
    `:root[data-theme="dark"]{${decl(p.dark)}}`;
  document.head.appendChild(el);
}
