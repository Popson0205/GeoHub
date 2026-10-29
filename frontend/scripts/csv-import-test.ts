import {
  autoMap, buildUploadCsv, coerceCell, detectLocation, guessDateOrder, importableFields, parseCsv, parseDate, parseNumber, parseShape,
  prepare, problemsCsv, sniffDelimiter, templateCsv, toWkt, type ImportSetup,
} from "../src/lib/csvImport";
import type { Form, GeometryType } from "../src/lib/types";

const ok = (c: boolean, m: string) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const mkForm = (geometry_type: GeometryType): Form => ({ id: "f", project_id: "p", name: "Water point", geometry_type, version: 1, status: "published", fields: [
  { id: "name", label: "Name", type: "text", required: true },
  { id: "kind", label: "Type of source", type: "choice", choices: ["Well", "Borehole", "Tap"] },
  { id: "depth", label: "Depth (m)", type: "number", min: 0 },
  { id: "visited", label: "Date visited", type: "date" },
  { id: "working", label: "Working?", type: "boolean", true_label: "Working", false_label: "Broken" },
  { id: "tags", label: "Tags", type: "multi_choice", choices: ["Shaded", "Fenced", "Public"] },
  { id: "photo", label: "Photo", type: "photo" },
  { id: "notes", label: "Notes", type: "text" },
  { id: "area", label: "Section", type: "group", children: [{ id: "village", label: "Village", type: "text" }] },
  { id: "total", label: "Total", type: "calculation" },
] } as unknown as Form);
const point = mkForm("Point"), polygon = mkForm("Polygon");

// ---------- reading the file ----------
let p = parseCsv('\ufeffName,Notes\r\n"Ada, the well","line one\nline two ""quoted"""\r\nBo,\r\n\r\n,\r\n');
ok(same(p.headers, ["Name", "Notes"]) && p.rows.length === 2, "a byte-order mark, CRLF, blank lines and a blank last row are all ignored");
ok(p.rows[0][0] === "Ada, the well" && p.rows[0][1] === 'line one\nline two "quoted"', "quoted commas, line breaks and doubled quotes are kept in the cell");
ok(p.rows[1][1] === "", "a short row is padded");
p = parseCsv("Name;Depth\nA;1,5\nB;2");
ok(p.delimiter === ";" && same(p.headers, ["Name", "Depth"]) && p.rows[0][1] === "1,5", "a semicolon file (Excel in many countries) is read correctly");
p = parseCsv("Name\tDepth\nA\t1");
ok(p.delimiter === "\t" && p.rows[0][1] === "1", "a tab-separated file is read correctly");
ok(sniffDelimiter("Name\nA\nB") === "," && parseCsv("").headers.length === 0, "a single column and an empty file do not confuse it");
p = parseCsv("Name,,Name\nA,B,C");
ok(same(p.headers, ["Name", "Column 2", "Name (2)"]), "blank and repeated headers are made distinct");

// ---------- numbers and dates ----------
ok(parseNumber("1,234.5") === 1234.5 && parseNumber("1.234,5") === 1234.5 && parseNumber("1 234,5") === 1234.5 && parseNumber("1,5") === 1.5 && parseNumber("1,234,567") === 1234567 && parseNumber("-.5") === -0.5 && parseNumber("1e3") === 1000, "numbers in English, European and spaced styles");
ok(parseNumber("abc") === null && parseNumber("12%") === null && parseNumber("Infinity") === null && parseNumber("") === null && parseNumber("1.2.3x") === null, "things that are not numbers are refused");
ok(parseDate("2026-03-04", "dmy") === "2026-03-04" && parseDate("4/3/2026", "dmy") === "2026-03-04" && parseDate("4/3/2026", "mdy") === "2026-04-03" && parseDate("2026/3/4", "dmy") === "2026-03-04" && parseDate("2026-03-04T10:00:00Z", "dmy") === "2026-03-04", "dates in ISO, day-first and month-first");
ok(parseDate("31/02/2026", "dmy") === null && parseDate("2026-13-01", "dmy") === null && parseDate("March 4", "dmy") === null, "impossible dates are refused");
ok(same(guessDateOrder(["2026-01-02", ""]), { iso: true, order: "dmy", decisive: false }) && guessDateOrder(["25/03/2026"]).order === "dmy" && guessDateOrder(["03/25/2026"]).order === "mdy" && !guessDateOrder(["03/04/2026"]).decisive, "the date order is guessed when a value gives it away");
const F = (id: string) => importableFields(point).find((f) => f.id === id)!;
ok(same(coerceCell(F("working"), "Working"), { value: true }) && same(coerceCell(F("working"), "broken"), { value: false }) && same(coerceCell(F("working"), "YES"), { value: true }) && !!coerceCell(F("working"), "maybe").error, "yes/no accepts the form's own labels");
ok(same(coerceCell(F("kind"), "borehole"), { value: "Borehole" }) && !!coerceCell(F("kind"), "Spring").error, "a choice is matched ignoring case, and an unknown one is explained");
ok(same(coerceCell(F("tags"), "shaded; Public|shaded"), { value: ["Shaded", "Public"] }) && !!coerceCell(F("tags"), "Shaded;Roof").error, "multiple choice splits on ; or |, drops repeats and checks each");
ok(coerceCell(F("depth"), "  ").value === undefined && coerceCell(F("depth"), "").error === undefined, "an empty cell is simply empty");
const time = { id: "t", label: "T", type: "time" } as never, dt = { id: "d", label: "D", type: "datetime" } as never;
ok(coerceCell(time, "9:05 PM").value === "21:05" && coerceCell(time, "14:30").value === "14:30" && !!coerceCell(time, "25:00").error, "times, including AM/PM");
ok(coerceCell(dt, "4/3/2026 9:05").value === "2026-03-04T09:05:00" && coerceCell(dt, "2026-03-04 10:00").value === "2026-03-04T10:00" && coerceCell(dt, "2026-03-04T10:00:00Z").value === "2026-03-04T10:00:00Z", "date and time in several styles");

// ---------- matching columns ----------
ok(same(importableFields(point).map((f) => f.id), ["name", "kind", "depth", "visited", "working", "tags", "notes", "village"]), "fields in groups can be filled; photos and calculations cannot");
let m = autoMap(["Name", "Type of Source", "depth_m", "DATE VISITED!", "working", "Mystery"], importableFields(point));
ok(m["Name"] === "name" && m["Type of Source"] === "kind" && m["DATE VISITED!"] === "visited" && m["working"] === "working" && m["Mystery"] === "" && m["depth_m"] === "depth", "columns match fields by id or label, ignoring case and punctuation");
m = autoMap(["name", "Name"], importableFields(point));
ok(m["name"] === "name" && m["Name"] === "", "a field is used by one column only");
ok(autoMap(["lon", "kind"], importableFields(point), new Set(["lon"]))["lon"] === "", "location columns are skipped");

// ---------- locations ----------
ok(same(detectLocation(["Name", "Longitude", "Latitude"], "Point"), { kind: "lonlat", lon: "Longitude", lat: "Latitude" }) && same(detectLocation(["x", "Y"], "Point"), { kind: "lonlat", lon: "x", lat: "Y" }), "longitude and latitude are found by their usual names");
ok(same(detectLocation(["id", "status", "longitude", "latitude", "geometry"], "Polygon"), { kind: "geometry", column: "geometry" }) && detectLocation(["a", "b"], "Point").kind === "none", "a polygon form looks for a geometry column, and no match says so");
ok(parseShape("POINT(3.5 6.2)").hasOwnProperty("shape") && toWkt((parseShape("POINT (3.5 6.2)") as any).shape) === "POINT(3.5 6.2)", "WKT points");
ok(toWkt((parseShape("SRID=4326;POINT Z (3.5 6.2 100)") as any).shape) === "POINT(3.5 6.2)", "an SRID prefix and a height are dropped");
const ring = "POLYGON((0 0, 0 1, 1 1, 0 0))";
ok(toWkt((parseShape(ring) as any).shape) === ring.replace("((", "((").replace(", ", ", ") && "error" in parseShape("POLYGON((0 0, 0 1, 1 1, 1 0))"), "a closed ring is accepted and an open one refused");
ok(toWkt((parseShape('{"type":"Polygon","coordinates":[[[0,0],[0,1],[1,1],[0,0]]]}') as any).shape) === ring && toWkt((parseShape('{"type":"Feature","geometry":{"type":"LineString","coordinates":[[0,0],[1,1]]}}') as any).shape) === "LINESTRING(0 0, 1 1)", "GeoJSON shapes (the app's own export) become WKT");
ok("error" in parseShape("MULTIPOINT((1 2),(3 4))") && "error" in parseShape('{"type":"MultiPolygon","coordinates":[]}') && "error" in parseShape("POINT EMPTY") && "error" in parseShape("POINT(200 10)") && "error" in parseShape("LINESTRING(0 0)") && "error" in parseShape("hello") && "error" in parseShape("{oops"), "multi-part, empty, out-of-range, too-short and unreadable shapes are explained");

// ---------- checking rows ----------
const csv = [
  "Name,Type of source,Depth (m),Date visited,Working?,Tags,Mystery,Longitude,Latitude",
  "Ada well,well,12.5,04/03/2026,Working,Shaded; Fenced,x,3.39,6.52",       // 2: good
  ",Borehole,40,2026-03-05,Broken,,x,3.40,6.53",                             // 3: no name
  "Cy,Spring,5,2026-03-05,Working,,x,3.41,6.54",                             // 4: unknown type
  "Di,Tap,abc,2026-03-05,Working,,x,3.42,6.55",                              // 5: depth not a number
  "Ed,Tap,-3,2026-03-05,Working,,x,3.43,6.56",                               // 6: below the minimum
  "Fay,Tap,1,31/02/2026,Working,,x,3.44,6.57",                               // 7: impossible date
  "Gus,Tap,1,2026-03-05,Working,,x,,",                                       // 8: no location
  "Hal,Tap,1,2026-03-05,Working,,x,200,95",                                  // 9: out of range
  "Ivy,Tap,1,2026-03-05,Working,,x,3,91",                                    // 10: latitude 91 (swapped)
  "Jo,Tap,1,2026-03-05,Working,,x,3.5,6.6",                                  // 11: good
].join("\n");
const parsed = parseCsv(csv);
const setup = (over: Partial<ImportSetup> = {}): ImportSetup => ({
  form: point, mapping: autoMap(parsed.headers, importableFields(point), new Set(["Longitude", "Latitude"])),
  location: detectLocation(parsed.headers, "Point"), dateOrder: "dmy", status: "submitted", ...over });
let r = prepare(parsed, setup());
ok(r.total === 10 && r.valid.length === 2 && r.problems.length === 8, "two rows are good and eight are held back with reasons");
ok(same(r.valid.map((v) => v.rowNo), [2, 11]), "row numbers count the header as row 1, like a spreadsheet");
ok(r.valid[0].props.depth === 12.5 && r.valid[0].props.visited === "2026-03-04" && r.valid[0].props.working === true && same(r.valid[0].props.tags, ["Shaded", "Fenced"]) && r.valid[0].props.kind === "Well", "good rows are converted to the field types (day-first dates, yes/no, choices)");
const why = (n: number) => r.problems.find((x) => x.rowNo === n)!.messages.join(" ");
ok(/Name is required/.test(why(3)) && /“Spring” is not one of the options/.test(why(4)) && /“abc” is not a number/.test(why(5)) && /at least 0/.test(why(6)) && /not a date/.test(why(7)), "each problem names the field and what is wrong");
ok(/location is missing/i.test(why(8)) && /out of range/i.test(why(9)) && /swapped/.test(why(10)), "missing, out-of-range and swapped locations are explained");
ok(r.ignoredColumns.join() === "Mystery" && r.missingRequired.length === 0 && !r.locationMissing, "unmatched columns are listed as ignored");
r = prepare(parsed, setup({ dateOrder: "mdy" }));
ok(r.valid.length === 2 && r.valid[0].props.visited === "2026-04-03", "month-first dates give a different reading");
r = prepare(parsed, setup({ status: "draft" }));
ok(r.valid.some((v) => v.rowNo === 3) && !r.problems.some((x) => x.rowNo === 3), "a draft import does not insist on required fields");
r = prepare(parsed, setup({ mapping: { ...setup().mapping, Name: "" } }));
ok(r.missingRequired.map((f) => f.id).join() === "name" && r.valid.length === 3 && !r.problems.some((x) => /Name is required/.test(x.messages.join(" "))), "a required question with no column is mentioned but skipped: the rows that were held back only for it now pass");
{
  const left = Object.fromEntries(Object.entries(setup().mapping).map(([h, id]) => [h, id === "name" || id === "kind" ? "" : id]));
  r = prepare(parsed, setup({ mapping: left }));
  ok(r.valid.length >= 3 && r.valid.every((v) => v.props.name === undefined && v.props.kind === undefined) && r.valid.some((v) => v.props.depth !== undefined), "several questions can be left out of the file at once; the others are still imported");
}
{
  // a column that IS in the file but blank in a row is still a missing answer
  const small = prepare(parseCsv("Name,Longitude,Latitude\nA,6.5,6.2\n,3.5,6.2"), setup({ mapping: { Name: "name", Longitude: "", Latitude: "" }, location: { kind: "lonlat", lon: "Longitude", lat: "Latitude" } }));
  ok(small.valid.length === 1 && small.problems.length === 1 && /Name is required/.test(small.problems[0].messages.join(" ")), "a blank cell in a column that exists still counts as missing");
  const onlyWhere = prepare(parseCsv("Longitude,Latitude\n6.5,6.2\n3.5,6.2"), { ...setup(), mapping: { Longitude: "", Latitude: "" }, location: { kind: "lonlat", lon: "Longitude", lat: "Latitude" } });
  ok(onlyWhere.valid.length === 2 && onlyWhere.missingRequired.map((f) => f.id).join() === "name", "a file with only coordinates imports, leaving every question empty");
}
r = prepare(parsed, setup({ location: { kind: "none" } }));
ok(r.locationMissing && r.valid.length === 0, "no location column means nothing is importable");
r = prepare(parseCsv("Name,Longitude,Latitude\nA,6.5,200\nB,3.5,6.2"), setup({ mapping: { Name: "name", Longitude: "", Latitude: "" }, location: { kind: "lonlat", lon: "Longitude", lat: "Latitude" } }));
ok(r.valid.length === 1 && /out of range/.test(r.problems[0].messages.join(" ")), "an out-of-range latitude is caught");
r = prepare(parseCsv("Name,Longitude,Latitude\nA,6.5,120"), setup({ mapping: { Name: "name", Longitude: "", Latitude: "" }, location: { kind: "lonlat", lon: "Longitude", lat: "Latitude" } }));
ok(/swapped/.test(r.problems[0].messages.join(" ")), "longitude and latitude that look swapped say so");

// ---------- a polygon form, and the file that is sent ----------
const poly = parseCsv(`Name,Shape\nPlot 1,"POLYGON((0 0,0 1,1 1,0 0))"\nPlot 2,"{""type"":""Polygon"",""coordinates"":[[[2,2],[2,3],[3,3],[2,2]]]}"\nPlot 3,POINT(1 1)\nPlot 4,"POLYGON((0 0,0 1,1 1))"`);
const ps: ImportSetup = { form: polygon, mapping: { Name: "name", Shape: "" }, location: { kind: "geometry", column: "Shape" }, dateOrder: "dmy", status: "submitted" };
r = prepare(poly, ps);
ok(r.valid.length === 2 && r.problems.length === 2 && /collects polygons, not points/.test(r.problems[0].messages.join(" ")) && /closed rings/.test(r.problems[1].messages.join(" ")), "a polygon form takes WKT or GeoJSON areas and refuses points and open rings");
let up = buildUploadCsv(r.valid, ["name"], "Polygon");
ok(up.location.wkt === "__wkt" && up.text.split("\n")[0] === "name,__wkt" && up.text.includes('"POLYGON((2 2, 2 3, 3 3, 2 2))"'), "areas are sent as WKT in one column");
r = prepare(parsed, setup());
up = buildUploadCsv(r.valid, ["name", "kind", "depth", "visited", "working", "tags"], "Point");
const back = parseCsv(up.text);
ok(up.location.lon === "__lon" && up.location.lat === "__lat" && same(back.headers, ["name", "kind", "depth", "visited", "working", "tags", "__lon", "__lat"]), "points are sent with plain longitude and latitude columns");
ok(same(back.rows[0], ["Ada well", "Well", "12.5", "2026-03-04", "true", "Shaded;Fenced", "3.39", "6.52"]), "the file that is sent holds clean, canonical values (ISO dates, true/false, ;-joined choices)");
const tricky = prepare(parseCsv('Name,Notes,Longitude,Latitude\n"Ada, ""the"" well","one\ntwo",3,6'), { ...setup(), mapping: { Name: "name", Notes: "notes", Longitude: "", Latitude: "" }, location: { kind: "lonlat", lon: "Longitude", lat: "Latitude" } });
const trickyBack = parseCsv(buildUploadCsv(tricky.valid, ["name", "notes"], "Point").text);
ok(trickyBack.rows[0][0] === 'Ada, "the" well' && trickyBack.rows[0][1] === "one\ntwo", "commas, quotes and line breaks inside a cell survive the trip");
r = prepare(parsed, setup());
const rep = parseCsv(problemsCsv(parsed, r.problems));
ok(same(rep.headers.slice(0, 3), ["Row", "Problem", "Name"]) && rep.rows.length === 8 && rep.rows[0][0] === "3" && /Name is required/.test(rep.rows[0][1]) && rep.rows[0][3] === "Borehole", "the report of held-back rows has the row, the reason, then the original cells");

// ---------- templates and the app's own export ----------
const tpl = parseCsv(templateCsv(point));
ok(same(tpl.headers, ["Name", "Type of source", "Depth (m)", "Date visited", "Working?", "Tags", "Notes", "Village", "Longitude", "Latitude"]) && templateCsv(polygon).includes("Shape (WKT)"), "the template has a column for each fillable field and the location");
const tm = autoMap(tpl.headers, importableFields(point), new Set(["Longitude", "Latitude"]));
ok(Object.entries(tm).filter(([h]) => !["Longitude", "Latitude"].includes(h)).every(([, id]) => id) && detectLocation(tpl.headers, "Point").kind === "lonlat" && detectLocation(templateCsv(polygon).replace("\ufeff", "").trim().split(","), "Polygon").kind === "geometry", "a downloaded template is understood perfectly when it comes back");
const exported = parseCsv('id,status,longitude,latitude,geometry,name,kind\nabc,approved,3.1,6.2,,Ada,Well\n');
ok(detectLocation(exported.headers, "Point").kind === "lonlat" && autoMap(exported.headers, importableFields(point), new Set(["longitude", "latitude", "geometry"]))["name"] === "name", "a CSV downloaded from Collected data can be imported again");
const exportedPoly = parseCsv('id,status,longitude,latitude,geometry,name\nabc,approved,,,"{""type"":""Polygon"",""coordinates"":[[[0,0],[0,1],[1,1],[0,0]]]}",Plot\n');
ok(same(detectLocation(exportedPoly.headers, "Polygon"), { kind: "geometry", column: "geometry" }) && prepare(exportedPoly, { form: polygon, mapping: { name: "name" }, location: { kind: "geometry", column: "geometry" }, dateOrder: "dmy", status: "submitted" }).valid.length === 1, "…and so can an exported polygon, whose shape is GeoJSON");

// ---------- speed ----------
{
  const lines = ["Name,Type of source,Depth (m),Date visited,Working?,Longitude,Latitude"];
  for (let i = 0; i < 50000; i++) lines.push(`Point ${i},Well,${i % 90},0${1 + (i % 9)}/03/2026,Yes,${3 + (i % 100) / 100},${6 + (i % 100) / 100}`);
  const t0 = Date.now(), big = parseCsv(lines.join("\n"));
  const res = prepare(big, { form: point, mapping: autoMap(big.headers, importableFields(point), new Set(["Longitude", "Latitude"])), location: detectLocation(big.headers, "Point"), dateOrder: "dmy", status: "submitted" });
  const ms = Date.now() - t0;
  ok(res.valid.length === 50000 && ms < 8000, `50,000 rows are read and checked in ${ms} ms`);
}
