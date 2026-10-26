// Importing a CSV into a form.
//
// Everything here is plain functions, so it is easy to test. The page reads a file, then:
//   parseCsv      -> headers and rows (any of , ; tab |, quotes, line breaks inside a cell, a byte-order mark)
//   autoMap       -> which column feeds which form field, matched by field id or label
//   detectLocation-> which columns hold the coordinates or the shape
//   prepare       -> each row converted to the field's own type and checked with the SAME rules as the data entry form
//   buildUploadCsv-> only the good rows, with plain headers, for the server's import job
// Rows with problems are never sent. They are listed (with the reason) and can be downloaded, fixed and imported again.
// The server checks every row again, so this is a preview of what it will accept, not a replacement for it.
import { csvEscape } from "./csv";
import { topLevelFields } from "./fieldSpec";
import { validateProperties } from "./forms";
import { GEOMETRY_LABEL, type Form, type FormField, type GeometryType, type Props } from "./types";

export const MAX_IMPORT_MB = 50;               // the server's limit for an import file
export const MAX_IMPORT_ROWS = 100_000;        // keeps the preview quick in the browser; split bigger files
export type ImportStatus = "draft" | "submitted" | "approved";
export type DateOrder = "dmy" | "mdy";

// ------------------------------------------------------------------------------------------------ reading the file
export interface Parsed { delimiter: string; headers: string[]; rows: string[][] }

const DELIMITERS = [",", ";", "\t", "|"];

/** Split text into records, honouring quotes ("" is a quote inside a quoted cell) and line breaks inside quotes. */
function records(text: string, delimiter: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [], cell = "", quoted = false, i = 0;
  const endCell = () => { row.push(cell); cell = ""; };
  const endRow = () => { endCell(); out.push(row); row = []; };
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i += 2; continue; } quoted = false; i++; continue; }
      cell += ch; i++; continue;
    }
    if (ch === '"' && cell === "") { quoted = true; i++; continue; }
    if (ch === delimiter) { endCell(); i++; continue; }
    if (ch === "\r") { endRow(); i += text[i + 1] === "\n" ? 2 : 1; continue; }
    if (ch === "\n") { endRow(); i++; continue; }
    cell += ch; i++;
  }
  if (cell !== "" || row.length) endRow();
  return out;
}

/** Excel in many countries saves "CSV" with semicolons. Pick the separator that splits the first line into the most columns. */
export function sniffDelimiter(text: string): string {
  const head = text.slice(0, 20000);
  let best = ",", bestCount = 0;
  for (const d of DELIMITERS) {
    const first = records(head, d).find((r) => r.some((c) => c.trim() !== ""));
    const n = first ? first.length : 0;
    if (n > bestCount) { best = d; bestCount = n; }
  }
  return best;
}

export function parseCsv(input: string, delimiter?: string): Parsed {
  const text = input.replace(/^\uFEFF/, "");
  const d = delimiter ?? sniffDelimiter(text);
  const all = records(text, d).filter((r) => r.some((c) => c.trim() !== ""));
  if (!all.length) return { delimiter: d, headers: [], rows: [] };
  const seen = new Map<string, number>();
  const headers = all[0].map((h, i) => {
    const base = h.trim() || `Column ${i + 1}`, n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base} (${n})`;
  });
  const rows = all.slice(1).map((r) => headers.map((_, i) => r[i] ?? ""));
  return { delimiter: d, headers, rows };
}
export const delimiterName = (d: string) => (d === ";" ? "semicolons" : d === "\t" ? "tabs" : d === "|" ? "bars" : "commas");

// ------------------------------------------------------------------------------------------------ matching columns
const NOT_IMPORTABLE = new Set(["note", "group", "repeat", "calculation", "photo", "audio", "video", "file", "signature"]);
/** The form's fields a CSV column can fill: not notes, calculations, photos or other attachments. */
export const importableFields = (form: Pick<Form, "fields">): FormField[] => topLevelFields(form.fields).filter((f) => !NOT_IMPORTABLE.has(f.type));
const squash = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "");

/** column header -> field id ("" = not imported). Matches the id, then the label, ignoring case, spaces and punctuation. Each field is used once. */
export function autoMap(headers: string[], fields: FormField[], skip: ReadonlySet<string> = new Set()): Record<string, string> {
  const out: Record<string, string> = Object.fromEntries(headers.map((h) => [h, ""]));
  const taken = new Set<string>();
  const passes: ((f: FormField) => string)[] = [(f) => f.id.toLowerCase(), (f) => squash(f.label || ""), (f) => squash(f.id)];
  for (const key of passes) for (const h of headers) {
    if (out[h] || skip.has(h)) continue;
    const want = key === passes[0] ? h.trim().toLowerCase() : squash(h);
    if (!want) continue;
    const f = fields.find((x) => !taken.has(x.id) && key(x) === want);
    if (f) { out[h] = f.id; taken.add(f.id); }
  }
  return out;
}

export type Location =
  | { kind: "lonlat"; lon: string; lat: string }
  | { kind: "geometry"; column: string }
  | { kind: "none" };
const LON = new Set(["lon", "lng", "long", "longitude", "x", "xcoord", "xcoordinate", "lon_dd"].map(squash));
const LAT = new Set(["lat", "latitude", "y", "ycoord", "ycoordinate", "lat_dd"].map(squash));
const GEOM = new Set(["wkt", "geom", "geometry", "thegeom", "shape", "wktgeom", "wktgeometry", "shapewkt", "geometrywkt", "wktshape"].map(squash));

/** Find the coordinate columns (points) or the shape column (WKT or GeoJSON), by the usual names. */
export function detectLocation(headers: string[], geometry: GeometryType): Location {
  const find = (names: Set<string>) => headers.find((h) => names.has(squash(h)));
  const lon = find(LON), lat = find(LAT), geom = find(GEOM);
  if (geometry === "Point" && lon && lat) return { kind: "lonlat", lon, lat };
  if (geom) return { kind: "geometry", column: geom };
  return { kind: "none" };
}

// ------------------------------------------------------------------------------------------------ values
type Cell = { value?: unknown; error?: string };
const pad = (n: number | string, w = 2) => String(n).padStart(w, "0");

/** "1,234.5", "1.234,5", "1 234,5" and "1,5" (a lone comma is a decimal, as on the server) all become numbers. */
export function parseNumber(raw: string): number | null {
  let s = raw.trim().replace(/[\s\u00a0\u202f']/g, "");
  if (!s) return null;
  const commas = (s.match(/,/g) ?? []).length, dots = (s.match(/\./g) ?? []).length;
  if (commas && dots) { const dec = s.lastIndexOf(",") > s.lastIndexOf(".") ? "," : "."; s = s.split(dec === "," ? "." : ",").join("").replace(dec, "."); }
  else if (commas > 1) s = s.split(",").join("");
  else if (dots > 1) s = s.split(".").join("");
  else if (commas === 1) s = s.replace(",", ".");
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const realDate = (y: number, m: number, d: number) => { const t = new Date(Date.UTC(y, m - 1, d)); return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d; };
/** 2026-03-04, 2026/3/4, 4/3/2026 (day first) or 3/4/2026 (month first, depending on `order`) -> 2026-03-04. A time on the end is ignored. */
export function parseDate(raw: string, order: DateOrder): string | null {
  const s = raw.trim();
  let y: number, m: number, d: number;
  let r = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/.exec(s);
  if (r) { y = +r[1]; m = +r[2]; d = +r[3]; }
  else if ((r = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?:[T\s].*)?$/.exec(s))) { y = +r[3]; if (order === "dmy") { d = +r[1]; m = +r[2]; } else { m = +r[1]; d = +r[2]; } }
  else return null;
  return realDate(y, m, d) ? `${y}-${pad(m)}-${pad(d)}` : null;
}
/** Is a column's text written the way dates are on a form (2026-03-04)? If not, and a value like 25/03/2026 gives it away, which order is it? */
export function guessDateOrder(values: string[]): { iso: boolean; order: DateOrder; decisive: boolean } {
  let iso = true, dm = false, md = false;
  for (const v of values) {
    const s = v.trim(); if (!s) continue;
    const r = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/.exec(s);
    if (!r) continue;
    iso = false;
    if (+r[1] > 12) dm = true;
    if (+r[2] > 12) md = true;
  }
  return { iso, order: md && !dm ? "mdy" : "dmy", decisive: dm !== md };
}

function parseTime(raw: string): string | null {
  const r = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(raw.trim());
  if (!r) return null;
  let h = +r[1]; const min = +r[2], sec = r[3] === undefined ? undefined : +r[3];
  if (r[4]) { if (h < 1 || h > 12) return null; h = (h % 12) + (r[4].toLowerCase() === "pm" ? 12 : 0); }
  if (h > 23 || min > 59 || (sec !== undefined && sec > 59)) return null;
  return `${pad(h)}:${pad(min)}${sec === undefined ? "" : ":" + pad(sec)}`;
}
function parseDateTime(raw: string, order: DateOrder): string | null {
  const s = raw.trim();
  const iso = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:?\d{2})?$/.exec(s);
  if (iso && parseDate(iso[1], order)) return `${iso[1]}T${iso[2]}${iso[3] ?? ""}`;
  const parts = /^(\S+)(?:[T\s]+(.+))?$/.exec(s);
  if (!parts) return null;
  const d = parseDate(parts[1], order);
  if (!d) return null;
  if (parts[2] === undefined) return `${d}T00:00:00`;
  const t = parseTime(parts[2]);
  return t ? `${d}T${t.length === 5 ? t + ":00" : t}` : null;
}

const canon = (choices: string[] | undefined, v: string) => (choices ?? []).find((c) => c === v) ?? (choices ?? []).find((c) => c.trim().toLowerCase() === v.trim().toLowerCase());
const YES = new Set(["true", "yes", "y", "1"]), NO = new Set(["false", "no", "n", "0"]);

/** One cell, converted to what the field stores. An empty cell is not an error here (a required field is caught by the form's own rules). */
export function coerceCell(f: FormField, raw: string, order: DateOrder = "dmy"): Cell {
  const text = raw.trim();
  if (text === "") return {};
  const L = f.label || f.id;
  switch (f.type) {
    case "number": { const n = parseNumber(text); return n === null ? { error: `${L}: “${text}” is not a number.` } : { value: n }; }
    case "boolean": {
      const v = text.toLowerCase();
      if (YES.has(v) || (f.true_label && v === f.true_label.trim().toLowerCase())) return { value: true };
      if (NO.has(v) || (f.false_label && v === f.false_label.trim().toLowerCase())) return { value: false };
      return { error: `${L}: “${text}” is not yes or no.` };
    }
    case "choice": { const c = canon(f.choices, text); return c === undefined ? { error: `${L}: “${text}” is not one of the options.` } : { value: c }; }
    case "multi_choice": case "ranking": {
      const parts = text.split(/[;|]/).map((p) => p.trim()).filter(Boolean), out: string[] = [];
      for (const p of parts) {
        const c = canon(f.choices, p);
        if (c === undefined) return { error: `${L}: “${p}” is not one of the options.` };
        if (!out.includes(c)) out.push(c);
      }
      return { value: out };
    }
    case "date": { const d = parseDate(text, order); return d === null ? { error: `${L}: “${text}” is not a date I can read. Use 2026-03-31, or day/month/year.` } : { value: d }; }
    case "time": { const t = parseTime(text); return t === null ? { error: `${L}: “${text}” is not a time. Use 14:30.` } : { value: t }; }
    case "datetime": { const t = parseDateTime(text, order); return t === null ? { error: `${L}: “${text}” is not a date and time I can read.` } : { value: t }; }
    default: return { value: text };
  }
}
const cellText = (v: unknown): string => (Array.isArray(v) ? v.join(";") : typeof v === "boolean" ? String(v) : v == null ? "" : String(v));

// ------------------------------------------------------------------------------------------------ locations
type Position = [number, number];
type Shape = { type: "Point"; coordinates: Position } | { type: "LineString"; coordinates: Position[] } | { type: "Polygon"; coordinates: Position[][] };
const NAME: Record<string, GeometryType> = { POINT: "Point", LINESTRING: "LineString", POLYGON: "Polygon" };

/** Read the body of a WKT shape, e.g. "(1 2, 3 4)". Only the first two numbers of a position are kept (no height). */
function wktBody(s: string): unknown[] | null {
  let i = 0;
  const num = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  const position = (): number[] | null => {
    const nums: number[] = [];
    for (;;) { ws(); num.lastIndex = i; const m = num.exec(s); if (!m) break; nums.push(Number(m[0])); i = num.lastIndex; }
    return nums.length >= 2 ? nums.slice(0, 2) : null;
  };
  const group = (): unknown[] | null => {
    ws(); if (s[i] !== "(") return null; i++;
    const items: unknown[] = [];
    for (;;) {
      ws();
      const item = s[i] === "(" ? group() : position();
      if (!item) return null;
      items.push(item); ws();
      if (s[i] === ",") { i++; continue; }
      if (s[i] === ")") { i++; return items; }
      return null;
    }
  };
  const g = group(); ws();
  return g && i === s.length ? g : null;
}

const inRange = (p: number[]) => p[0] >= -180 && p[0] <= 180 && p[1] >= -90 && p[1] <= 90;
const ringOk = (r: unknown): r is Position[] => Array.isArray(r) && r.length >= 4 && r.every(isPos) && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1];
const isPos = (p: unknown): p is Position => Array.isArray(p) && p.length >= 2 && typeof p[0] === "number" && typeof p[1] === "number";

/** A WKT or GeoJSON shape from one cell, checked and tidied. Only single-part Point, LineString and Polygon are accepted. */
export function parseShape(raw: string): { shape: Shape } | { error: string } {
  const text = raw.trim();
  let type: string | undefined, coords: unknown;
  if (text.startsWith("{")) {
    try {
      let g = JSON.parse(text);
      if (g?.type === "Feature") g = g.geometry;
      type = g?.type; coords = g?.coordinates;
      if (typeof type === "string" && type.startsWith("Multi")) return { error: "multi-part shapes are not supported. Put each part on its own row." };
    } catch { return { error: "the shape is not valid GeoJSON." }; }
  } else {
    const m = /^(?:SRID=\d+;)?\s*(MULTI)?(POINT|LINESTRING|POLYGON)\s*(?:ZM|Z|M)?\s*(\(.*\))\s*$/is.exec(text);
    if (!m) return { error: /EMPTY/i.test(text) ? "the shape is empty." : "not a shape I can read. Use WKT, like POINT(3.1 6.5), or GeoJSON." };
    if (m[1]) return { error: "multi-part shapes are not supported. Put each part on its own row." };
    type = NAME[m[2].toUpperCase()];
    const body = wktBody(m[3]);
    if (!body) return { error: "the shape’s coordinates could not be read." };
    coords = type === "Point" ? body[0] : body;
  }
  const bad = "the coordinates are invalid. Use longitude then latitude, in degrees.";
  if (type === "Point") { if (!isPos(coords)) return { error: bad }; const p: Position = [coords[0], coords[1]]; return inRange(p) ? { shape: { type, coordinates: p } } : { error: "the point is outside the range of longitude (−180 to 180) and latitude (−90 to 90)." }; }
  if (type === "LineString") {
    if (!Array.isArray(coords) || coords.length < 2 || !coords.every(isPos)) return { error: "a line needs at least two points." };
    const c = (coords as number[][]).map((p): Position => [p[0], p[1]]);
    return c.every(inRange) ? { shape: { type, coordinates: c } } : { error: "a point of the line is outside the range of longitude and latitude." };
  }
  if (type === "Polygon") {
    if (!Array.isArray(coords) || !coords.length || !coords.every(ringOk)) return { error: "an area needs closed rings of at least four points (the last point repeats the first)." };
    const c = (coords as number[][][]).map((r) => r.map((p): Position => [p[0], p[1]]));
    return c.every((r) => r.every(inRange)) ? { shape: { type, coordinates: c } } : { error: "a point of the area is outside the range of longitude and latitude." };
  }
  return { error: "the shape must be a point, line or area." };
}
export function toWkt(s: Shape): string {
  const p = (q: Position) => `${q[0]} ${q[1]}`;
  if (s.type === "Point") return `POINT(${p(s.coordinates)})`;
  if (s.type === "LineString") return `LINESTRING(${s.coordinates.map(p).join(", ")})`;
  return `POLYGON(${s.coordinates.map((r) => `(${r.map(p).join(", ")})`).join(", ")})`;
}

// ------------------------------------------------------------------------------------------------ checking rows
export interface ImportSetup {
  form: Pick<Form, "fields" | "geometry_type">;
  mapping: Record<string, string>;      // column header -> field id ("" = not imported)
  location: Location;
  dateOrder: DateOrder;
  status: ImportStatus;
}
export interface PreparedRow { rowNo: number; props: Props; shape: Shape }
export interface RowProblem { rowNo: number; messages: string[] }
export interface Prepared {
  total: number;
  valid: PreparedRow[];
  problems: RowProblem[];
  missingRequired: FormField[];         // required fields with no column
  ignoredColumns: string[];             // columns that go nowhere
  locationMissing: boolean;             // there is nothing to say where the records are
}

/** Row numbers count the header as row 1, like a spreadsheet and like the server's own report. */
export function prepare(parsed: Parsed, setup: ImportSetup): Prepared {
  const { form, mapping, location, dateOrder, status } = setup;
  const fields = importableFields(form), byId = new Map(fields.map((f) => [f.id, f]));
  const cols = parsed.headers.map((h, i) => ({ h, i, field: byId.get(mapping[h] ?? "") }));
  const used = cols.filter((c) => c.field);
  const idx = (h: string) => parsed.headers.indexOf(h);
  const locCols = new Set(location.kind === "lonlat" ? [location.lon, location.lat] : location.kind === "geometry" ? [location.column] : []);
  const mappedIds = new Set(used.map((c) => c.field!.id));
  const walkRequired = fields.filter((f) => f.required === true && !mappedIds.has(f.id));
  const out: Prepared = {
    total: parsed.rows.length, valid: [], problems: [],
    missingRequired: status === "draft" ? [] : walkRequired,
    ignoredColumns: parsed.headers.filter((h) => !mappedIds.has(mapping[h] ?? "") && !locCols.has(h)),
    locationMissing: location.kind === "none"
      || (location.kind === "lonlat" && (idx(location.lon) < 0 || idx(location.lat) < 0 || location.lon === location.lat))
      || (location.kind === "geometry" && idx(location.column) < 0),
  };
  const gtype = setup.form.geometry_type;
  parsed.rows.forEach((row, n) => {
    const rowNo = n + 2, msgs: string[] = [], props: Props = {};
    for (const c of used) {
      const r = coerceCell(c.field!, row[c.i], dateOrder);
      if (r.error) msgs.push(r.error); else if (r.value !== undefined) props[c.field!.id] = r.value as Props[string];
    }
    let shape: Shape | undefined;
    if (out.locationMissing) msgs.push("There is no location column chosen.");
    else if (location.kind === "lonlat") {
      const lo = row[idx(location.lon)].trim(), la = row[idx(location.lat)].trim();
      const x = parseNumber(lo), y = parseNumber(la);
      if (lo === "" || la === "") msgs.push("The location is missing (longitude and latitude are both needed).");
      else if (x === null || y === null) msgs.push(`The location is not numbers: “${lo}”, “${la}”.`);
      else if (!inRange([x, y])) msgs.push(Math.abs(x) <= 90 && Math.abs(y) > 90 && Math.abs(y) <= 180
        ? "Longitude and latitude look swapped."
        : `The location is out of range: longitude ${x}, latitude ${y} (longitude −180 to 180, latitude −90 to 90).`);
      else shape = { type: "Point", coordinates: [x, y] };
    } else if (location.kind === "geometry") {
      const v = row[idx(location.column)];
      if (v.trim() === "") msgs.push("The location is missing.");
      else { const s = parseShape(v); if ("error" in s) msgs.push(`Location: ${s.error}`); else shape = s.shape; }
    }
    if (shape && gtype && shape.type !== gtype) { msgs.push(`This form collects ${GEOMETRY_LABEL[gtype]}s, not ${GEOMETRY_LABEL[shape.type]}s.`); shape = undefined; }
    if (!msgs.length) {
      const errs = validateProperties(form as Pick<Form, "fields">, props);
      for (const m of Object.values(errs)) if (!(status === "draft" && /(is required|needs at least one entry)\.$/.test(m))) msgs.push(m);
    }
    if (msgs.length || !shape) out.problems.push({ rowNo, messages: msgs.length ? msgs : ["The row could not be read."] });
    else out.valid.push({ rowNo, props, shape });
  });
  return out;
}

// ------------------------------------------------------------------------------------------------ what gets sent / saved
export const LON_COLUMN = "__lon", LAT_COLUMN = "__lat", WKT_COLUMN = "__wkt";

/** The CSV the server's import job reads: plain field-id headers, only the rows that passed, one location style for the whole file. */
export function buildUploadCsv(rows: PreparedRow[], fieldIds: string[], geometry: GeometryType): { text: string; location: { lon?: string; lat?: string; wkt?: string } } {
  const point = geometry === "Point";
  const head = [...fieldIds, ...(point ? [LON_COLUMN, LAT_COLUMN] : [WKT_COLUMN])];
  const lines = [head.map(csvEscape).join(",")];
  for (const r of rows) {
    const where = point ? ((r.shape as { coordinates: Position }).coordinates.map(String)) : [toWkt(r.shape)];
    lines.push([...fieldIds.map((id) => cellText(r.props[id])), ...where].map(csvEscape).join(","));
  }
  return { text: lines.join("\n") + "\n", location: point ? { lon: LON_COLUMN, lat: LAT_COLUMN } : { wkt: WKT_COLUMN } };
}

/** The rows that were left out, with the reason first, so the person can fix them in a spreadsheet and import them again. */
export function problemsCsv(parsed: Parsed, problems: RowProblem[]): string {
  const lines = [["Row", "Problem", ...parsed.headers].map(csvEscape).join(",")];
  for (const p of problems) lines.push([p.rowNo, p.messages.join(" "), ...(parsed.rows[p.rowNo - 2] ?? [])].map(csvEscape).join(","));
  return "\ufeff" + lines.join("\n") + "\n";
}

/** A blank file with the right headers: one column per field (by its label) and the location columns. */
export function templateCsv(form: Pick<Form, "fields" | "geometry_type">): string {
  const seen = new Map<string, number>();
  const labels = importableFields(form).map((f) => { const b = f.label || f.id, n = (seen.get(b) ?? 0) + 1; seen.set(b, n); return n === 1 ? b : `${b} (${n})`; });
  const where = form.geometry_type === "Point" ? ["Longitude", "Latitude"] : ["Shape (WKT)"];
  return "\ufeff" + [...labels, ...where].map(csvEscape).join(",") + "\n";
}
