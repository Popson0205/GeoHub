import type { GeoFeature, Geometry } from "../src/lib/types";
import { addNew, commit, current, effective, mergeInto, newHistory, redo, removeFeature, replaceWithPieces, setGeometry, setProperties, summarize, undo } from "../src/lib/staging";
import { draftFeatures, fmtArea, fmtLength, measure, pathLength, polygonArea } from "../src/lib/sketch";
import { cutByLine, mergeGeometries, splitLineAtPoint, translate } from "../src/lib/geoops";

const ok = (c: boolean, m: string) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };
const server: GeoFeature[] = [
  { id: "a", version: 1, properties: { highway: "road" }, geometry: { type: "LineString", coordinates: [[0, 0], [1, 0], [2, 0]] } },
  { id: "b", version: 3, properties: { building: "yes" }, geometry: { type: "Polygon", coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]] } },
];
let n = 0; const nid = () => `n${++n}`;

(async () => {
  // ---- staging ----
  let h = newHistory();
  h = commit(h, addNew(h.present, "x", { type: "Point", coordinates: [1, 1] }, { name: "A" }));
  h = commit(h, addNew(h.present, "y", { type: "Point", coordinates: [2, 2] }));
  ok(effective(server, h.present).length === 4 && summarize(h.present).created === 2, "several features can be drawn before saving");
  h = commit(h, setProperties(h.present, server, "x", { name: "B" }), "tags:x");
  h = commit(h, setProperties(h.present, server, "x", { name: "BC" }), "tags:x");
  ok(h.past.length === 3, "typing in a tag is one history step");
  h = undo(h);
  ok((current(server, h.present, "x")!.properties as any).name === "A", "undo reverts the whole tag edit");
  h = redo(h);
  ok((current(server, h.present, "x")!.properties as any).name === "BC", "redo re-applies it");

  let e = setProperties({}, server, "a", { highway: "path" });
  ok(summarize(e).modified === 1, "editing a saved feature stages a modification");
  e = setProperties(e, server, "a", { highway: "road" });
  ok(summarize(e).total === 0, "putting it back leaves nothing to save");
  e = removeFeature(addNew({}, "z", { type: "Point", coordinates: [0, 0] }), server, "z");
  ok(summarize(e).total === 0, "deleting a never-saved feature leaves no trace");
  e = removeFeature({}, server, "a");
  ok(summarize(e).deleted === 1 && !effective(server, e).some((f) => f.id === "a"), "deleting a saved feature hides it and stages a delete");

  // ---- geometry ----
  const t = translate(server[0].geometry, 1, 1) as any;
  ok(t.coordinates[0][0] === 1 && t.coordinates[2][1] === 1, "translate moves every vertex");

  const line = server[0].geometry as any;
  let parts = splitLineAtPoint(line, [0.5, 0.01])!;
  ok(parts.length === 2 && parts[0].coordinates.length === 2 && parts[1].coordinates.length === 3 && parts[1].coordinates[0][0] === 0.5, "split a line in the middle of a segment");
  parts = splitLineAtPoint(line, [1, 0.001])!;
  ok(parts.length === 2 && parts[0].coordinates.length === 2 && parts[1].coordinates.length === 2, "split a line at an existing vertex (no duplicate vertex)");
  ok(splitLineAtPoint(line, [0, 0]) === null && splitLineAtPoint(line, [2, 0]) === null, "clicking an end of a line splits nothing");

  const cutLine = { type: "LineString", coordinates: [[0.5, -1], [0.5, 1]] } as any;
  let pieces = (await cutByLine(line, cutLine))!;
  ok(pieces?.length === 2, "cut a line with a crossing line");
  pieces = (await cutByLine(server[1].geometry, { type: "LineString", coordinates: [[1, -1], [1, 3]] }))!;
  ok(pieces?.length === 2 && pieces.every((p) => p.type === "Polygon"), "cut an area edge to edge into two areas");
  const area = (g: any) => { const r = g.coordinates[0]; let s = 0; for (let i = 0; i < r.length - 1; i++) s += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1]; return Math.abs(s / 2); };
  ok(Math.abs(area(pieces[0]) + area(pieces[1]) - 4) < 1e-6, "the two pieces add up to the original area");
  ok((await cutByLine(server[1].geometry, { type: "LineString", coordinates: [[1, 1], [1, 3]] })) === null, "a cut that stops inside the area is refused");

  // ---- sketch while drawing ----
  const kinds = (fs: any[]) => fs.map((f) => f.properties.kind).sort().join(",");
  ok(kinds(draftFeatures(false, [[0, 0]], null)) === "last", "a line with one point shows just that point");
  ok(kinds(draftFeatures(false, [[0, 0], [1, 0]], [2, 0])) === "last,line,rubber,v,v", "a line shows its points, the solid line and a dashed segment to the pointer");
  const polyDraft = draftFeatures(true, [[0, 0], [1, 0], [1, 1]], [0, 1]);
  ok(kinds(polyDraft) === "fill,first,last,line,rubber,rubber,v,v", "a polygon also shows a fill, the green first point and the closing segment");
  ok((polyDraft.find((f) => f.properties.kind === "first")!.geometry as any).coordinates[0] === 0, "the first point of a polygon is marked");
  ok(kinds(draftFeatures(true, [[0, 0], [1, 0], [1, 1]], null)).includes("rubber"), "with no pointer (touch) the closing edge is still shown");
  ok(draftFeatures(true, [], [1, 1]).length === 0, "nothing is shown before the first point");
  ok(Math.abs(pathLength([[0, 0], [0, 1]]) - 111195) < 100, "one degree of latitude is about 111.2 km");
  const sq = [[0, 0], [0.001, 0], [0.001, 0.001], [0, 0.001]] as any;
  ok(Math.abs(polygonArea(sq) - 12364) / 12364 < 0.01, "a 0.001 degree square near the equator is about 12,400 m²");
  ok(fmtLength(4.2) === "4.2 m" && fmtLength(1500) === "1.50 km" && fmtArea(250) === "250 m²" && fmtArea(25000) === "2.50 ha", "lengths and areas read naturally");
  ok(measure(false, [[0, 0], [0, 0.001]]) === "111 m" && measure(true, sq).startsWith("1.24 ha ·"), "line and polygon readouts");

  // split staged
  const s = replaceWithPieces({}, server, "b", pieces, nid);
  ok(s.ids.length === 2 && summarize(s.edits).modified === 1 && summarize(s.edits).created === 1, "split keeps the original and adds the other piece");
  ok((current(server, s.edits, s.ids[1])!.properties as any).building === "yes", "the new piece copies the tags");

  // merge
  const l1: Geometry = { type: "LineString", coordinates: [[0, 0], [1, 0]] };
  const l2: Geometry = { type: "LineString", coordinates: [[2, 0], [1, 0]] };
  let m: any = await mergeGeometries([l1, l2]);
  ok(m.geometry?.coordinates.length === 3 && m.geometry.coordinates[2][0] === 2, "lines that meet end to end are joined (and reversed when needed)");
  m = await mergeGeometries([l1, { type: "LineString", coordinates: [[5, 5], [6, 6]] }]);
  ok(!!m.error, "unconnected lines are refused");
  const p1: Geometry = { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] };
  const p2: Geometry = { type: "Polygon", coordinates: [[[1, 0], [2, 0], [2, 1], [1, 1], [1, 0]]] };
  m = await mergeGeometries([p1, p2]);
  ok(m.geometry?.type === "Polygon" && Math.abs(area(m.geometry) - 2) < 1e-9, "touching areas are merged into one");
  m = await mergeGeometries([p1, { type: "Polygon", coordinates: [[[5, 5], [6, 5], [6, 6], [5, 6], [5, 5]]] }]);
  ok(!!m.error, "separate areas are refused");
  m = await mergeGeometries([p1, l1]);
  ok(!!m.error, "mixed kinds are refused");

  const staged = mergeInto(addNew({}, "p", p1, { name: "one" }), server, ["p", "b"], p2);
  ok(summarize(staged).deleted === 1 && (current(server, staged, "p")!.properties as any).building === "yes" && (current(server, staged, "p")!.properties as any).name === "one", "merge keeps the first feature, removes the others, combines tags");
  ok(setGeometry({}, server, "b", server[1].geometry) && summarize(setGeometry({}, server, "b", server[1].geometry)).total === 0, "setting the same shape stages nothing");
})();
