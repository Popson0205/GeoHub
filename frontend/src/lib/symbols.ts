// Symbols: a small library of pictures, the author's own SVG code, and the one function that turns either into a picture to draw.
// Custom SVG comes from people and is shown to other people (shared dashboards), so it is never used as given: sanitizeSvg reads it
// and builds new markup from an allow-list of shapes and attributes. Anything else (scripts, styles, event handlers, links, images,
// text, filters) is left out. The result is drawn as an <img>, where scripts cannot run, as a second line of defence.
import type { SymbolMotion, SymbolShape, SymbolSpec } from "./types";

export const SHAPES: { id: SymbolShape; label: string }[] = [
  { id: "plain", label: "Symbol only" }, { id: "circle", label: "Filled circle" }, { id: "ring", label: "Ring" }, { id: "square", label: "Rounded square" },
];
export const MOTIONS: { id: SymbolMotion; label: string }[] = [
  { id: "none", label: "None" }, { id: "pulse", label: "Pulse" }, { id: "spin", label: "Spin" }, { id: "bounce", label: "Bounce" }, { id: "float", label: "Float" },
  { id: "glow", label: "Glow" }, { id: "shake", label: "Shake" }, { id: "ripple", label: "Ripple" }, { id: "blink", label: "Blink" },
];
export const MAX_SVG = 6000, MAX_SVG_MAP = 3000;

export interface SymbolIconDef { id: string; label: string; tags: string; body: string }
const I = (id: string, label: string, tags: string, body: string): SymbolIconDef => ({ id, label, tags, body });
/** Line icons on a 24 x 24 grid. They draw with `currentColor`, which becomes the symbol's colour. */
export const ICONS: SymbolIconDef[] = [
  I("bolt", "Power", "electric energy lightning", '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>'),
  I("plug", "Plug", "electric socket connector", '<path d="M9 2v6M15 2v6M7 8h10v4a5 5 0 01-10 0zM12 17v5"/>'),
  I("transformer", "Transformer", "electric coil substation", '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9.5" cy="12" r="3.5"/><circle cx="14.5" cy="12" r="3.5"/>'),
  I("pole", "Pole", "electric pole line utility", '<path d="M12 2v20M5 6h14M7 10h10M9 22h6"/>'),
  I("tower", "Tower", "pylon transmission mast", '<path d="M12 2L6 22M12 2l6 20M8 9h8M7 15h10"/>'),
  I("panel", "Panel", "distribution board switch", '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 7h8M8 11h3M13 11h3M8 15h3M13 15h3"/>'),
  I("battery", "Battery", "storage charge power", '<rect x="2" y="7" width="18" height="10" rx="2"/><path d="M22 11v2M6 10v4M10 10v4"/>'),
  I("sun", "Solar", "sun energy panel light", '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  I("cog", "Generator", "gear machine engine settings", '<circle cx="12" cy="12" r="3.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9L7 7M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"/>'),
  I("gauge", "Meter", "gauge dial measure", '<path d="M4 18a9 9 0 1116 0"/><path d="M12 18l4-6"/>'),
  I("building", "Building", "office facility block", '<path d="M4 21V4a1 1 0 011-1h9a1 1 0 011 1v17M15 9h4a1 1 0 011 1v11M2 21h20M8 7h3M8 11h3M8 15h3"/>'),
  I("home", "Home", "house residence", '<path d="M3 11l9-8 9 8M5 10v10h14V10M10 20v-6h4v6"/>'),
  I("pin", "Place", "map location marker", '<path d="M12 22s7-6.5 7-12a7 7 0 10-14 0c0 5.5 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/>'),
  I("flag", "Flag", "mark milestone", '<path d="M5 22V3M5 4h12l-2 4 2 4H5"/>'),
  I("tool", "Maintenance", "wrench repair fix", '<path d="M15 4a5 5 0 00-4 7L3 19l2 2 8-8a5 5 0 007-4l-3 3-3-1-1-3z"/>'),
  I("users", "People", "population users team", '<circle cx="9" cy="8" r="3.5"/><path d="M2 21a7 7 0 0114 0M16 4.5a3.5 3.5 0 010 7M19 21a7 7 0 00-3-5.7"/>'),
  I("shield", "Security", "safe protect", '<path d="M12 2l8 3v6c0 5-3.5 9-8 11-4.5-2-8-6-8-11V5z"/>'),
  I("fire", "Fire", "heat hazard", '<path d="M12 22c4 0 7-3 7-7 0-3-2-5-3-7-1 2-2 3-3 3 0-4-1-7-4-9 0 4-4 6-4 12a7 7 0 007 8z"/>'),
  I("drop", "Water", "drop liquid", '<path d="M12 2.5s7 7 7 12a7 7 0 01-14 0c0-5 7-12 7-12z"/>'),
  I("chart", "Trend", "chart graph growth", '<path d="M3 3v18h18M7 15l4-5 3 3 5-7"/>'),
  I("check", "Done", "ok approved complete", '<circle cx="12" cy="12" r="9.5"/><path d="M7.5 12.5l3 3 6-6.5"/>'),
  I("alert", "Warning", "alert danger problem", '<path d="M12 3L2 21h20zM12 10v5M12 18v.5"/>'),
  I("clock", "Time", "clock schedule date", '<circle cx="12" cy="12" r="9.5"/><path d="M12 6.5V12l3.5 2"/>'),
  I("camera", "Photo", "camera picture", '<path d="M3 8h4l2-3h6l2 3h4v12H3z"/><circle cx="12" cy="13" r="3.5"/>'),
  I("tree", "Tree", "plant nature green", '<circle cx="12" cy="9" r="6"/><path d="M12 15v7"/>'),
  I("road", "Road", "street route", '<path d="M8 2L4 22M16 2l4 20M12 3v3M12 10v4M12 18v3"/>'),
  I("truck", "Vehicle", "truck transport car", '<path d="M2 6h11v10H2zM13 9h5l4 4v3h-9zM6 19a2 2 0 100-4 2 2 0 000 4zM17 19a2 2 0 100-4 2 2 0 000 4z"/>'),
  I("hospital", "Health", "clinic medical cross", '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M12 8v8M8 12h8"/>'),
  I("signal", "Signal", "wifi network coverage", '<path d="M2 9a15 15 0 0120 0M5 12.5a10 10 0 0114 0M8.5 16a5 5 0 017 0M12 20v.1"/>'),
  I("star", "Star", "favourite important", '<path d="M12 2.5l3 6.2 6.8 1-5 4.7 1.2 6.8L12 18l-6 3.2 1.2-6.8-5-4.7 6.8-1z"/>'),
  I("heart", "Heart", "care like", '<path d="M12 21s-9-5.5-9-12a5 5 0 019-3 5 5 0 019 3c0 6.5-9 12-9 12z"/>'),
  I("database", "Records", "data layers total count", '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>'),
  I("dot", "Dot", "point simple", '<circle cx="12" cy="12" r="6" fill="currentColor"/>'),
  I("square", "Square", "block simple", '<rect x="5" y="5" width="14" height="14" rx="1.5" fill="currentColor"/>'),
  I("triangle", "Triangle", "simple", '<path d="M12 4l9 16H3z" fill="currentColor"/>'),
  I("diamond", "Diamond", "simple", '<path d="M12 3l9 9-9 9-9-9z" fill="currentColor"/>'),
];
export const iconById = (id?: string) => ICONS.find((i) => i.id === id);

// ---------- reading SVG code from a person ----------
export type SvgResult =
  | { ok: true; viewBox: string; /** presentation attributes of the outer <svg> (fill, stroke ...), already checked */ root: string; inner: string; notes: string[] }
  | { ok: false; error: string };

const SHAPE_TAGS = new Set(["g", "path", "circle", "ellipse", "rect", "line", "polyline", "polygon", "defs", "linearGradient", "radialGradient", "stop"]);
const NUM = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?(?:%|px)?$/;
const COLOR = /^(?:none|currentColor|transparent|#[0-9a-fA-F]{3,8}|(?:rgb|hsl)a?\([0-9\s.,%/-]{1,40}\)|[a-zA-Z]{3,20})$/;
const URL_REF = /^url\(#[A-Za-z][A-Za-z0-9_-]{0,30}\)$/;
const TRANSFORM = /^(?:\s*(?:matrix|translate|scale|rotate|skewX|skewY)\s*\([-\d\s.,eE+]*\)\s*)+$/;
const color = (v: string) => COLOR.test(v) || URL_REF.test(v);
const oneOf = (...xs: string[]) => (v: string) => xs.includes(v);
const NUMERIC = ["x", "y", "cx", "cy", "r", "rx", "ry", "x1", "y1", "x2", "y2", "width", "height", "fx", "fy", "offset", "stroke-width", "opacity", "fill-opacity", "stroke-opacity", "stop-opacity", "stroke-miterlimit"];
const ATTR: Record<string, (v: string) => boolean> = {
  ...Object.fromEntries(NUMERIC.map((n) => [n, (v: string) => NUM.test(v)])),
  d: (v) => v.length <= 3000 && /^[MmLlHhVvCcSsQqTtAaZz0-9eE+\-.,\s]+$/.test(v),
  points: (v) => v.length <= 2000 && /^[0-9eE+\-.,\s]+$/.test(v),
  transform: (v) => TRANSFORM.test(v), gradientTransform: (v) => TRANSFORM.test(v),
  fill: color, stroke: color, "stop-color": color,
  "fill-rule": oneOf("nonzero", "evenodd"), "clip-rule": oneOf("nonzero", "evenodd"),
  "stroke-linecap": oneOf("butt", "round", "square"), "stroke-linejoin": oneOf("miter", "round", "bevel"),
  "stroke-dasharray": (v) => /^[0-9.,\s%-]{1,60}$/.test(v), gradientUnits: oneOf("userSpaceOnUse", "objectBoundingBox"),
  id: (v) => /^[A-Za-z][A-Za-z0-9_-]{0,30}$/.test(v),
};
const ROOT_ATTRS = new Set(["fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin"]);
const ID_TAGS = new Set(["linearGradient", "radialGradient"]);
const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const TAG_START = /<([A-Za-z][A-Za-z0-9:_-]*)/y, ATTR_RE = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;

export function sanitizeSvg(code: unknown, maxLen = MAX_SVG): SvgResult {
  if (typeof code !== "string" || !code.trim()) return { ok: false, error: "Paste the SVG code, starting with <svg." };
  if (code.length > maxLen) return { ok: false, error: `This SVG is too long (${code.length} characters; the limit is ${maxLen}). Simplify it or remove metadata.` };
  if (/<!ENTITY/i.test(code)) return { ok: false, error: "SVG that defines entities is not allowed." };
  const s = code.replace(/<!--[\s\S]*?-->/g, "").replace(/<\?[\s\S]*?\?>/g, "").replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "").replace(/<!DOCTYPE[^>]*>/gi, "");
  const dropped = new Set<string>();
  const out: string[] = [];
  const stack: { name: string; kept: boolean }[] = [];
  let skip = 0, kept = 0, i = 0, viewBox = "", w = "", h = "", root = "", sawRoot = false;
  const bad = (msg: string): SvgResult => ({ ok: false, error: msg });

  while (i < s.length) {
    const lt = s.indexOf("<", i);
    if (lt < 0) break;
    if (s.startsWith("</", lt)) {
      const gt = s.indexOf(">", lt);
      if (gt < 0) return bad("A closing tag is not finished (missing >).");
      const name = s.slice(lt + 2, gt).trim();
      const top = stack.pop();
      if (!top || top.name !== name) return bad(`The SVG is not well formed: unexpected </${name}>.`);
      if (skip > 0) skip--; else if (top.kept && name !== "svg") out.push(`</${name}>`);
      i = gt + 1; continue;
    }
    TAG_START.lastIndex = lt;
    const m = TAG_START.exec(s);
    if (!m) { i = lt + 1; continue; }
    const name = m[1];
    let p = lt + m[0].length, self = false;
    const attrs: [string, string][] = [];
    for (;;) {
      while (p < s.length && /\s/.test(s[p])) p++;
      if (p >= s.length) return bad(`The <${name}> tag is not finished (missing >).`);
      if (s[p] === ">") { p++; break; }
      if (s[p] === "/" && s[p + 1] === ">") { self = true; p += 2; break; }
      ATTR_RE.lastIndex = p;
      const a = ATTR_RE.exec(s);
      if (!a || a.index !== p) return bad(`Could not read an attribute in <${name}>. Attribute values need quotes.`);
      attrs.push([a[1], a[2] ?? a[3] ?? ""]); p += a[0].length;
    }
    i = p;
    const parentKept = stack.length === 0 || (skip === 0);
    if (!sawRoot) {
      if (name !== "svg") return bad("The code has to start with an <svg> element.");
      sawRoot = true;
      for (const [k, v] of attrs) {
        if (k === "viewBox") viewBox = v.trim(); else if (k === "width") w = v.trim(); else if (k === "height") h = v.trim();
        else if (ROOT_ATTRS.has(k) && ATTR[k]?.(v.trim())) root += ` ${k}="${esc(v.trim())}"`;
      }
      if (!self) stack.push({ name, kept: true });
      continue;
    }
    if (skip > 0 || !parentKept) { if (!self) { stack.push({ name, kept: false }); skip++; } continue; }
    if (!SHAPE_TAGS.has(name) || ++kept > 150) {
      dropped.add(`<${name}>`);
      if (!self) { stack.push({ name, kept: false }); skip++; }
      continue;
    }
    let tag = `<${name}`;
    for (const [k, raw] of attrs) {
      const v = raw.trim(), ok = ATTR[k];
      if (!ok || !ok(v) || (k === "id" && !ID_TAGS.has(name))) { dropped.add(k); continue; }
      tag += ` ${k}="${esc(v)}"`;
    }
    out.push(self ? `${tag}/>` : `${tag}>`);
    if (!self) stack.push({ name, kept: true });
  }
  if (!sawRoot) return bad("The code has to start with an <svg> element.");
  if (stack.length) return bad(`The SVG is not well formed: <${stack[stack.length - 1].name}> is never closed.`);
  const inner = out.join("");
  if (!/<(path|circle|ellipse|rect|line|polyline|polygon)\b/.test(inner)) return bad("Nothing to draw: use path, circle, rect, line, polygon or similar shapes (text, images and filters are not supported).");
  const vb = /^-?\d+(?:\.\d+)?[\s,]+-?\d+(?:\.\d+)?[\s,]+\d+(?:\.\d+)?[\s,]+\d+(?:\.\d+)?$/.test(viewBox) ? viewBox.replace(/,/g, " ").split(/\s+/) : null;
  const num = (v: string) => (NUM.test(v) ? parseFloat(v) : NaN);
  const box = vb && parseFloat(vb[2]) > 0 && parseFloat(vb[3]) > 0 ? vb.join(" ") : num(w) > 0 && num(h) > 0 ? `0 0 ${num(w)} ${num(h)}` : "0 0 24 24";
  return { ok: true, viewBox: box, root, inner, notes: [...dropped].slice(0, 8) };
}

// ---------- drawing a symbol ----------
const HEX = /^#[0-9a-fA-F]{6}$/;
export const isHex = (v: unknown): v is string => typeof v === "string" && HEX.test(v);
const cache = new Map<string, string | null>();

/**
 * The finished picture as standalone SVG text (48 x 48), or null when there is nothing to draw (no icon, unknown icon, or SVG that
 * cannot be read). `color` is used when the symbol has none of its own: a map point passes its colour here.
 */
export function composeSymbolSvg(spec: SymbolSpec | undefined, opts: { color?: string; forMap?: boolean } = {}): string | null {
  if (!spec || (!spec.icon && !spec.svg)) return null;
  const key = JSON.stringify([spec.icon, spec.svg, spec.color, spec.shape, opts.color, opts.forMap]);
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const c = isHex(spec.color) ? spec.color : isHex(opts.color) ? opts.color : "#1f6b52";
  const shape: SymbolShape = spec.shape ?? (opts.forMap ? "circle" : "plain");
  let vb = "0 0 24 24", inner = "", rootAttrs = ' fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
  let res: string | null = null;
  if (spec.svg) {
    const r = sanitizeSvg(spec.svg, opts.forMap ? MAX_SVG_MAP : MAX_SVG);
    if (r.ok) { vb = r.viewBox; inner = r.inner; rootAttrs = r.root.includes("fill=") ? r.root : ` fill="currentColor"${r.root}`; }
    else inner = "";
  } else { const ic = iconById(spec.icon); if (ic) inner = ic.body; }
  if (inner) {
    const edge = opts.forMap ? ` stroke="#ffffff" stroke-width="3"` : "";
    const bg = shape === "circle" ? `<circle cx="24" cy="24" r="22" fill="${c}"${edge}/>`
      : shape === "ring" ? `<circle cx="24" cy="24" r="21.5" fill="${c}" fill-opacity="0.14" stroke="${c}" stroke-width="3"/>`
      : shape === "square" ? `<rect x="2" y="2" width="44" height="44" rx="11" fill="${c}"${edge}/>` : "";
    const fg = shape === "circle" || shape === "square" ? "#ffffff" : c;
    const [x, size] = shape === "plain" ? [6, 36] : [11, 26];
    res = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">${bg}<svg x="${x}" y="${x}" width="${size}" height="${size}" viewBox="${vb}" color="${fg}"${rootAttrs}>${inner}</svg></svg>`;
  }
  if (cache.size > 400) cache.clear();
  cache.set(key, res);
  return res;
}
/** The same picture as a data address, for an <img> or a map image. Empty text when there is nothing to draw. */
export function symbolUri(spec: SymbolSpec | undefined, opts: { color?: string; forMap?: boolean } = {}): string {
  const svg = composeSymbolSvg(spec, opts);
  return svg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` : "";
}

/** A symbol read back from storage or the server: unknown values are dropped, never trusted. */
export function cleanSymbolSpec(raw: unknown): SymbolSpec | undefined {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== "object") return undefined;
  const icon = typeof r.icon === "string" && /^[a-z0-9-]{1,40}$/.test(r.icon) ? r.icon : undefined;
  const svg = typeof r.svg === "string" && r.svg.trim() && r.svg.length <= MAX_SVG ? r.svg : undefined;
  if (!icon && !svg) return undefined;
  return {
    ...(icon ? { icon } : {}), ...(svg ? { svg } : {}),
    ...(isHex(r.color) ? { color: r.color } : {}),
    ...(SHAPES.some((s) => s.id === r.shape) ? { shape: r.shape as SymbolShape } : {}),
    ...(MOTIONS.some((m) => m.id === r.motion) && r.motion !== "none" ? { motion: r.motion as SymbolMotion } : {}),
  };
}
