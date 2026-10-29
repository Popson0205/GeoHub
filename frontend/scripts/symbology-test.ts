// Map viewer symbology: a colour for a record, the legend, and what is kept when a saved style is read back.
import { PALETTE, cleanViewerStyle, colorOf, defaultLayer, graduatedClasses, legendOf, statusLayer, uniqueClasses, type LayerStyle } from "../src/lib/symbology";

const ok = (c: boolean, m: string) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };
const rec = (props: Record<string, unknown>, status = "approved") => ({ properties: props, status } as any);
const recs = [rec({ kind: "school", n: 10 }), rec({ kind: "school", n: 30 }), rec({ kind: "clinic", n: 50 }, "submitted"), rec({ kind: ["market", "school"], n: 90 }, "rejected"), rec({})];

// single symbol
const single = defaultLayer(1);
ok(colorOf(recs[0], single) === PALETTE[1], "single symbol: every record gets the layer colour");

// unique values: most common first, several choices count under each, blanks fall into Other
const uq = uniqueClasses(recs, "kind");
ok(uq.classes[0].value === "school" && uq.classes.length === 3, "unique: values listed most common first");
const uLayer: LayerStyle = { ...single, renderer: uq };
ok(colorOf(recs[0], uLayer) === uq.classes[0].color && colorOf(recs[4], uLayer) === uq.other, "unique: a value gets its colour, a blank record gets Other");
ok(colorOf(recs[3], uLayer) !== uq.other, "unique: a record with several choices takes the first class it matches");
const legend = legendOf(recs, uLayer);
ok(legend.find((r) => r.label === "school")?.count === 3 && legend.find((r) => r.label === "Other / blank")?.count === 1, "legend counts records per class, and the blanks");

// graduated: equal steps from lowest to highest, highest value stays in the last class
const gr = graduatedClasses(recs, "n", "green", 4);
ok(gr.classes.length === 4 && gr.classes[0].min === 10 && gr.classes[3].max === 90, "graduated: equal classes from the lowest to the highest value");
const gLayer: LayerStyle = { ...single, renderer: gr };
ok(colorOf(recs[3], gLayer) === gr.classes[3].color, "graduated: the highest value is in the last class");
ok(colorOf(recs[4], gLayer) === "#9aa3ad", "graduated: a record without the number gets the neutral colour");
ok(graduatedClasses([rec({})], "n").classes.length === 0, "graduated: no numbers yet means no classes, not a crash");

// the review status can be used like any field (dashboard maps start from it)
const st = statusLayer();
ok(colorOf(recs[2], st) === "#d98a0b" && colorOf(recs[3], st) === "#c0392b", "status layer: waiting is amber and rejected is red, as dashboard maps always were");
ok(legendOf(recs, st).some((r) => r.label === "Waiting for review"), "status legend uses readable names");

// a stored style is never trusted: bad values fall back instead of breaking the map
const bad = cleanViewerStyle({ basemap: "satellite", layers: { a: { symbol: { color: "red; background:url(x)", size: 9999, opacity: -3 }, renderer: { kind: "unique", field: "k", classes: [{ value: "x", color: "nope" }, null] } } } });
ok(bad.basemap === "streets", "bad basemap name: back to streets");
ok(/^#[0-9a-f]{6}$/i.test(bad.layers.a.symbol.color) && bad.layers.a.symbol.size === 20 && bad.layers.a.symbol.opacity === 0.1, "bad colour, size and opacity are replaced or clamped");
ok(bad.layers.a.renderer.kind === "unique" && (bad.layers.a.renderer as any).classes.length === 1 && /^#[0-9a-f]{6}$/i.test((bad.layers.a.renderer as any).classes[0].color), "bad classes are dropped or repaired");
ok(cleanViewerStyle(null).basemap === "streets" && Object.keys(cleanViewerStyle("x").layers).length === 0, "nothing stored: the default look");
