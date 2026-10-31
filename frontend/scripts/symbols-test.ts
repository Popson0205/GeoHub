// Symbols: the library, the SVG sanitizer (custom SVG is shown to other people, so it is attacked here), and drawing.
import { ICONS, MAX_SVG, MOTIONS, SHAPES, cleanSymbolSpec, composeSymbolSvg, iconById, sanitizeSvg, symbolUri } from "../src/lib/symbols";

const ok = (c: boolean, m: string) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };
const good = (s: string) => { const r = sanitizeSvg(s); return r.ok ? r : null; };
const text = (s: string) => { const r = sanitizeSvg(s); return r.ok ? r.inner + r.root : ""; };

// ---- a normal icon survives ----
const lucide = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L4 14h7l-1 8 9-12h-7z"/></svg>';
const r1 = good(lucide);
ok(!!r1 && r1.viewBox === "0 0 24 24" && r1.inner === '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>' && r1.root.includes('fill="none"') && r1.root.includes('stroke="currentColor"'), "a normal icon keeps its shapes and its fill and stroke");
const r2 = good('<?xml version="1.0"?><!-- c --><svg viewBox="0 0 100 50"><defs><linearGradient id="a" x1="0" x2="1"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="rgb(0,0,255)"/></linearGradient></defs><rect x="0" y="0" width="100" height="50" rx="8" fill="url(#a)"/><circle cx="50" cy="25" r="10" fill=\'white\'/></svg>');
ok(!!r2 && r2.viewBox === "0 0 100 50" && r2.inner.includes('<linearGradient id="a"') && r2.inner.includes('fill="url(#a)"') && r2.inner.includes("<stop"), "gradients, rects, circles, single quotes and an XML header work");
ok(good('<svg width="40px" height="20"><path d="M0 0h10"/></svg>')?.viewBox === "0 0 40 20", "a size with no viewBox becomes one");

// ---- attacks ----
const bad: [string, string][] = [
  ['<svg><script>alert(1)</script><circle r="5"/></svg>', "<script"],
  ['<svg onload="alert(1)"><circle r="5" onclick="alert(1)"/></svg>', "onload"],
  ['<svg><circle r="5" onmouseover="alert(1)"/></svg>', "onmouseover"],
  ['<svg><foreignObject><iframe src="https://evil"/></foreignObject><circle r="5"/></svg>', "foreignObject"],
  ['<svg><style>@import url(https://evil/x.css); circle{fill:red}</style><circle r="5"/></svg>', "style"],
  ['<svg><circle r="5" style="fill:url(https://evil/x)"/></svg>', "style="],
  ['<svg><image href="https://evil/x.png" width="10" height="10"/><circle r="5"/></svg>', "image"],
  ['<svg><a href="javascript:alert(1)"><circle r="5"/></a></svg>', "javascript"],
  ['<svg><use href="https://evil/x.svg#a"/><circle r="5"/></svg>', "<use"],
  ['<svg><circle r="5" fill="url(https://evil/x)"/></svg>', "evil"],
  ['<svg><circle r="5" fill="url(javascript:alert(1))"/></svg>', "javascript"],
  ['<svg><path d="M0 0 L10 10 <script>alert(1)</script>"/></svg>', "script"],
  ['<svg><circle r="5" xlink:href="javascript:alert(1)"/></svg>', "xlink"],
  ['<svg><animate attributeName="href" values="javascript:alert(1)"/><circle r="5"/></svg>', "animate"],
  ['<svg><set attributeName="onload" to="alert(1)"/><circle r="5"/></svg>', "<set"],
  ['<svg><text x="0" y="10">hello</text><circle r="5"/></svg>', "<text"],
  ['<svg><filter id="f"><feImage href="https://evil"/></filter><circle r="5" filter="url(#f)"/></svg>', "filter"],
  ['<svg><circle r="5" transform="translate(1) onload"/></svg>', "onload"],
  ['<svg><circle r="5" fill="red&quot; onload=&quot;alert(1)"/></svg>', "onload"],
  ['<svg><g><g><script>alert(1)</script></g></g><circle r="5"/></svg>', "script"],
  ['<svg><circle r="5" fill="red" "onload=alert(1)"/></svg>', ""],
];
for (const [code, needle] of bad) {
  const r = sanitizeSvg(code);
  const out = r.ok ? r.inner + r.root + r.viewBox : "";
  ok(!needle || !out.toLowerCase().includes(needle.toLowerCase()), `attack removed: ${code.slice(5, 60).replace(/\s+/g, " ")}`);
  ok(!/on[a-z]+\s*=|<script|javascript:|https?:|<style|<image|<use|<text|foreignObject|<a\b/i.test(out), "…and nothing dangerous is left in what remains");
}
ok(!sanitizeSvg('<svg><circle r="5" fill="red" "onload=alert(1)"/></svg>').ok, "an attribute written without a name is refused, not guessed at");
ok(text('<svg><circle r="5" id="x" fill="red"/></svg>') === '<circle r="5" fill="red"/>', "an id is only kept on gradients");

// ---- not SVG, or unusable ----
ok(!sanitizeSvg("hello").ok && !sanitizeSvg("").ok && !sanitizeSvg(undefined).ok && !sanitizeSvg("<div><circle r='5'/></div>").ok, "text, nothing, and non-SVG are refused");
ok(!sanitizeSvg('<svg><circle r="5"></svg>').ok && !sanitizeSvg('<svg><circle r="5"/>').ok && !sanitizeSvg('<svg><circle r="5"').ok, "unclosed or broken markup is refused");
ok(!sanitizeSvg('<svg><text>hi</text></svg>').ok && !sanitizeSvg('<svg></svg>').ok, "an SVG with nothing to draw says so");
ok(!sanitizeSvg(`<svg><path d="${"M0 0".repeat(MAX_SVG)}"/></svg>`).ok && !sanitizeSvg(lucide, 50).ok, "too long is refused");
ok(!sanitizeSvg('<!DOCTYPE svg [<!ENTITY x "y">]><svg><circle r="5"/></svg>').ok, "entity tricks are refused");
const many = `<svg>${'<circle r="1"/>'.repeat(200)}</svg>`;
ok((good(many)?.inner.match(/<circle/g) ?? []).length === 150, "a huge number of shapes is cut at 150");
const dd = good('<svg><circle r="5" onclick="x" data-x="1" class="a"/></svg>');
ok(!!dd && dd.notes.includes("onclick") && dd.notes.includes("class"), "what was removed is reported");

// ---- the library ----
ok(ICONS.length >= 30 && new Set(ICONS.map((i) => i.id)).size === ICONS.length && ICONS.every((i) => /^[a-z0-9-]+$/.test(i.id)), "the library has unique, simple ids");
ok(ICONS.every((i) => sanitizeSvg(`<svg viewBox="0 0 24 24">${i.body}</svg>`).ok), "every built-in icon passes the same checks as custom code");
ok(iconById("bolt")?.label === "Power" && iconById("nope") === undefined, "icons are found by id");

// ---- drawing ----
const svg = composeSymbolSvg({ icon: "bolt", color: "#2f6fb0", shape: "ring" })!;
ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"') && svg.includes('stroke="#2f6fb0"') && svg.includes('color="#2f6fb0"') && svg.includes('<path d="M13 2L4 14'), "a ring symbol: coloured ring, glyph in the same colour");
ok(composeSymbolSvg({ icon: "bolt", color: "#2f6fb0", shape: "circle" })!.includes('color="#ffffff"') && composeSymbolSvg({ icon: "bolt", shape: "square" }, { color: "#c0392b" })!.includes('fill="#c0392b"'), "filled shapes use a white glyph and take the colour handed in when the symbol has none");
ok(composeSymbolSvg({ icon: "bolt" }, { forMap: true })!.includes('stroke="#ffffff" stroke-width="3"') && !composeSymbolSvg({ icon: "bolt" })!.includes("<circle"), "on a map the shape gets a white edge; elsewhere the default is the symbol alone");
ok(composeSymbolSvg({ icon: "nope" }) === null && composeSymbolSvg({}) === null && composeSymbolSvg(undefined) === null && composeSymbolSvg({ svg: "<svg><script/></svg>" }) === null, "nothing to draw gives null, never a broken picture");
const custom = composeSymbolSvg({ svg: '<svg viewBox="0 0 10 10" onload="x"><path d="M0 0h10v10z"/></svg>', color: "#123456" })!;
ok(custom.includes('viewBox="0 0 10 10"') && custom.includes('fill="currentColor"') && !custom.includes("onload"), "custom SVG without its own fill takes the symbol's colour and is rebuilt clean");
ok(!/<script|onload|onclick|javascript:/i.test(composeSymbolSvg({ svg: '<svg onload="a()"><circle r="3" onclick="b()" fill="red"/><script>c()</script></svg>' })!), "the finished picture has nothing executable");
ok(composeSymbolSvg({ icon: "bolt", color: "red" })!.includes("#1f6b52") && composeSymbolSvg({ icon: "bolt", color: "#fff\" onload=\"x" })!.includes("#1f6b52"), "a colour that is not #rrggbb is ignored");
ok(symbolUri({ icon: "bolt" }).startsWith("data:image/svg+xml;charset=utf-8,%3Csvg") && symbolUri({}) === "", "the picture is available as a data address for <img> and maps");

// ---- stored symbols are cleaned ----
ok(cleanSymbolSpec(null) === undefined && cleanSymbolSpec({}) === undefined && cleanSymbolSpec({ icon: "Bad Id!" }) === undefined && cleanSymbolSpec({ svg: "   " }) === undefined, "empty or odd symbols are dropped");
ok(JSON.stringify(cleanSymbolSpec({ icon: "bolt", color: "#112233", shape: "ring", motion: "pulse", evil: 1 })) === JSON.stringify({ icon: "bolt", color: "#112233", shape: "ring", motion: "pulse" }), "a good symbol keeps its settings and loses extras");
ok(!("motion" in cleanSymbolSpec({ icon: "bolt", motion: "none" })!) && !("motion" in cleanSymbolSpec({ icon: "bolt", motion: "explode" })!) && !("color" in cleanSymbolSpec({ icon: "bolt", color: "blue" })!) && !("shape" in cleanSymbolSpec({ icon: "bolt", shape: "star" })!), "unknown motions, colours and shapes are dropped");
ok(cleanSymbolSpec({ svg: "x".repeat(MAX_SVG + 1) }) === undefined && SHAPES.length === 4 && MOTIONS[0].id === "none" && MOTIONS.length === 9, "oversized SVG is dropped; shapes and motions are as listed");

// ---- symbols on map layers, widgets and selectors ----
import { cleanLayer, defaultLayer, iconOf, legendOf, type LayerStyle } from "../src/lib/symbology";
import { cleanControls, normalizeConfig } from "../src/lib/dashboard";
import { templateWidgets } from "../src/lib/dashboardTemplates";
import type { Feature, Form } from "../src/lib/types";
const form = { id: "f", project_id: "p", name: "Assets", geometry_type: "Point", version: 1, status: "published", fields: [{ id: "cat", label: "Category", type: "choice", choices: ["Pole", "Meter"] }, { id: "kva", label: "kVA", type: "number" }] } as unknown as Form;
let n = 0;
const rec = (cat: string): Feature => ({ id: `r${n++}`, project_id: "p", form_id: "f", form_version: 1, geometry: { type: "Point", coordinates: [0, 0] }, properties: { cat }, status: "approved", version: 1, updated_at: "2026-10-01T00:00:00Z" });
const recs = [rec("Pole"), rec("Pole"), rec("Meter")];
const base = defaultLayer(0);
const withLayer: LayerStyle = { ...base, icon: { icon: "bolt" } };
ok(iconOf(recs[0], base) === undefined && iconOf(recs[0], withLayer)?.icon === "bolt", "a layer symbol draws every point; with none, points stay dots");
const uniq: LayerStyle = { ...withLayer, renderer: { kind: "unique", field: "cat", other: "#999999", classes: [{ value: "Pole", color: "#112233", icon: { icon: "pole" } }, { value: "Meter", color: "#445566" }] } };
ok(iconOf(recs[0], uniq)?.icon === "pole" && iconOf(recs[2], uniq)?.icon === "bolt", "a value's own symbol wins; the others use the layer's");
const lg = legendOf(recs, uniq);
ok(lg.find((r) => r.label === "Pole")?.icon?.icon === "pole" && lg.find((r) => r.label === "Meter")?.icon?.icon === "bolt" && legendOf(recs, base).every((r) => !r.icon), "the legend shows each row's symbol");
const lyr = cleanLayer({ ...uniq, icon: { icon: "bolt", motion: "spin", color: "red" } }, 0);
ok(lyr.icon?.icon === "bolt" && lyr.icon?.motion === "spin" && !("color" in (lyr.icon ?? {})), "a saved map style is cleaned on load (bad colour dropped)");
const badLayer = cleanLayer({ ...uniq, icon: { icon: "Not valid!" } }, 0);
ok(badLayer.icon === undefined, "a symbol that is not valid is dropped from a layer");

const cfg = normalizeConfig({ pages: [{ id: "p", title: "P", widgets: [{ id: "k1", type: "kpi", title: "", metric: "count", bucket: "month", limit: 5, columns: [], symbol: { icon: "bolt", shape: "ring", motion: "glow" } }, { id: "k2", type: "kpi", title: "", metric: "count", bucket: "month", limit: 5, columns: [], symbol: { icon: "<x>" } }],
  controls: [{ id: "c1", kind: "category", field: "cat", label: "", symbol: { svg: '<svg viewBox="0 0 24 24"><path d="M1 1h2"/></svg>', shape: "square" } }] }] });
ok(cfg.pages[0].widgets[0].symbol?.motion === "glow" && cfg.pages[0].widgets[1].symbol === undefined, "an indicator's symbol is kept; an invalid one is dropped");
ok(cfg.pages[0].controls?.[0].symbol?.shape === "square" && !!cfg.pages[0].controls?.[0].symbol?.svg && cleanControls([{ id: "c2", kind: "date", label: "", symbol: { icon: "clock" } }])[0].symbol?.icon === "clock", "a selector keeps its symbol (library or custom)");
let k = 0;
const mon = templateWidgets("monitor", form, () => `t${k++}`);
ok(mon.filter((w) => w.type === "kpi").every((w) => w.symbol?.shape === "ring" && !!w.symbol.icon), "the Monitoring board's key numbers come with ring symbols");
