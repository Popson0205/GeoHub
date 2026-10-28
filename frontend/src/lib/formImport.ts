// Building a form from a CSV file (like XLSForm / Survey123 Connect / KoboToolbox, but one sheet).
//
// One row = one field. Columns are found by header name, in any order, and unknown columns are reported and ignored:
//   type       required   What the field is. GeoHub names (text, number, choice ...) and XLSForm names
//                         (integer, decimal, select_one, select_multiple, begin group, end group, begin repeat ...) both work.
//   label      required   The question the collector sees. (If empty, the name is used.)
//   name       optional   The field id. If empty it is made from the label.
//   choices    optional   For choice, multi choice and ranking: options separated by ; or | (a comma works too when the cell is quoted).
//   hint, placeholder, required, default, readonly, appearance, min, max, min_length, max_length, pattern, unit, decimals
//
// Everything is plain functions, so it is easy to test. The result is checked with the same rules as the builder
// (checkFieldDefs), and rows with a problem are listed with their line number instead of being silently dropped.
import { csvEscape } from "./csv";
import { parseCsv } from "./csvImport";
import { TYPE_SPECS, allFields, hasChoices, isContainer, slugifyFieldId } from "./fieldSpec";
import { checkFieldDefs } from "./forms";
import type { FieldType, FormField } from "./types";

export const MAX_FORM_FIELDS = 500;
const MAX_DEPTH = 3;

export interface FormImportResult {
  fields: FormField[];
  /** Fields that were created, counted at every level. */
  count: number;
  /** Rows that could not become a field, or were changed. Always shown to the person. */
  problems: { line: number; message: string }[];
  /** Columns in the file that GeoHub does not use. */
  ignoredColumns: string[];
}

interface TypeMatch { type: FieldType; preset?: Partial<FormField> }
const norm = (s: string) => s.toLowerCase().trim().replace(/[\s\-]+/g, "_");

/** Type names people write, GeoHub's own and XLSForm's. */
const TYPE_ALIASES: Record<string, TypeMatch> = {
  text: { type: "text" }, string: { type: "text" },
  multiline: { type: "text", preset: { appearance: "multiline" } }, multiline_text: { type: "text", preset: { appearance: "multiline" } },
  number: { type: "number" },
  integer: { type: "number", preset: { integer: true } }, int: { type: "number", preset: { integer: true } },
  decimal: { type: "number", preset: { integer: false, decimals: 2 } }, float: { type: "number", preset: { integer: false, decimals: 2 } },
  date: { type: "date" }, time: { type: "time" }, datetime: { type: "datetime" }, date_time: { type: "datetime" },
  barcode: { type: "barcode" }, qr: { type: "barcode" }, qr_code: { type: "barcode" },
  choice: { type: "choice" }, single_choice: { type: "choice" }, select_one: { type: "choice" }, radio: { type: "choice", preset: { appearance: "radio" } },
  dropdown: { type: "choice", preset: { appearance: "dropdown" } },
  multi_choice: { type: "multi_choice" }, multiple_choice: { type: "multi_choice" }, select_multiple: { type: "multi_choice" },
  boolean: { type: "boolean" }, yes_no: { type: "boolean" }, toggle: { type: "boolean", preset: { appearance: "switch" } }, switch: { type: "boolean", preset: { appearance: "switch" } },
  acknowledge: { type: "boolean", preset: { appearance: "checkbox", must_be_true: true, required: true } },
  acknowledgement: { type: "boolean", preset: { appearance: "checkbox", must_be_true: true, required: true } },
  ranking: { type: "ranking" }, rank: { type: "ranking" },
  photo: { type: "photo" }, image: { type: "photo" }, audio: { type: "audio" }, video: { type: "video" }, file: { type: "file" }, signature: { type: "signature" },
  note: { type: "note" }, instructions: { type: "note" },
  calculation: { type: "calculation" }, calculate: { type: "calculation" },
  group: { type: "group" }, repeat: { type: "repeat" },
};
const BEGIN = /^(begin|start)[\s_]+(group|repeat)$/, END = /^end[\s_]+(group|repeat)$/;
const GEO_ONLY = new Set(["geopoint", "geotrace", "geoshape", "gps", "gps_point", "gps_line", "gps_area", "point", "line", "polygon", "area"]);
const SKIP = new Set(["start", "end", "today", "deviceid", "username", "phonenumber", "audit", "subscriberid", "simserial", "email"]); // XLSForm metadata

/** Reads the first word(s) of a type cell: `select_one yes_no` -> select_one + list name. */
function readType(raw: string): { key: string; list?: string } {
  const t = raw.trim().replace(/\s+/g, " ");
  const m = /^(select_one|select_multiple|select one|select multiple|rank)\s+(?:from\s+)?(\S+)(?:\s+or_other)?$/i.exec(t);
  if (m) return { key: norm(m[1]), list: m[2] };
  return { key: norm(t) };
}

const YES = new Set(["yes", "y", "true", "1", "x", "required"]);
const isYes = (s: string) => YES.has(s.trim().toLowerCase());
const num = (s: string): number | undefined => { const n = Number(s.trim().replace(",", ".")); return s.trim() !== "" && Number.isFinite(n) ? n : undefined; };
const splitChoices = (s: string): string[] => {
  const sep = /[;|\n]/.test(s) ? /[;|\n]/ : /,/;
  const seen = new Set<string>();
  return s.split(sep).map((c) => c.trim()).filter((c) => c && !seen.has(c) && !!seen.add(c));
};

const KNOWN = ["type", "name", "id", "label", "choices", "options", "hint", "placeholder", "required", "default", "readonly", "read_only", "appearance",
  "min", "max", "min_length", "max_length", "min_items", "max_items", "pattern", "pattern_message", "unit", "decimals", "list_name", "list"];

export function importFormCsv(text: string, existing: FormField[] = []): FormImportResult {
  const parsed = parseCsv(text);
  const problems: FormImportResult["problems"] = [];
  const out: FormImportResult = { fields: [], count: 0, problems, ignoredColumns: [] };
  if (!parsed.headers.length) { problems.push({ line: 1, message: "The file is empty." }); return out; }

  const col = new Map<string, number>();
  parsed.headers.forEach((h, i) => { const k = norm(h); if (!col.has(k)) col.set(k, i); });
  out.ignoredColumns = parsed.headers.filter((h) => !KNOWN.includes(norm(h)));
  if (!col.has("type")) { problems.push({ line: 1, message: "There is no “type” column. The first row must name the columns, for example: type,label,choices,required." }); return out; }
  if (!col.has("label") && !col.has("name") && !col.has("id")) { problems.push({ line: 1, message: "There is no “label” column." }); return out; }

  const cell = (row: string[], ...keys: string[]): string => { for (const k of keys) { const i = col.get(k); if (i !== undefined && (row[i] ?? "").trim() !== "") return row[i].trim(); } return ""; };

  // XLSForm keeps choices on a second sheet. In one CSV, rows like `list_name,name,label` can also define them: type = "choices <list>".
  const lists = new Map<string, string[]>();
  const rowsData = parsed.rows.map((r, i) => ({ r, line: i + 2 }));
  for (const { r } of rowsData) {
    const lt = norm(cell(r, "type"));
    const m = /^(choices?|list)_(.+)$/.exec(lt);
    if (m) { const arr = lists.get(m[2]) ?? []; const v = cell(r, "label", "name", "id"); if (v) arr.push(v); lists.set(m[2], arr); }
  }

  const root: FormField[] = [];
  const stack: { field: FormField; line: number }[] = [];
  const known = [...existing];            // for unique ids: what is already in the form, plus what this file adds
  const list = () => (stack.length ? stack[stack.length - 1].field.children! : root);
  let total = existing.length;

  for (const { r, line } of rowsData) {
    const rawType = cell(r, "type");
    if (!rawType) { if (r.some((c) => c.trim())) problems.push({ line, message: "No type, so the row was skipped." }); continue; }
    const { key, list: listName } = readType(rawType);

    if (/^(choices?|list)_/.test(key)) continue;                       // choice rows, read above
    if (END.test(key)) {
      if (!stack.length) problems.push({ line, message: "“end” without a matching “begin”." }); else stack.pop();
      continue;
    }
    if (GEO_ONLY.has(key)) { problems.push({ line, message: "The point, line or area is drawn on the map, so this row was skipped. Choose the shape when you create the form." }); continue; }
    if (SKIP.has(key)) continue;

    const begin = BEGIN.exec(key.replace(/_/g, " "));
    const match: TypeMatch | undefined = begin ? { type: begin[2] as FieldType } : TYPE_ALIASES[key];
    if (!match) { problems.push({ line, message: `Unknown type “${rawType}”. Use one of: ${Object.keys(TYPE_ALIASES).filter((k) => !k.includes("_")).slice(0, 14).join(", ")} …` }); continue; }

    if (total >= MAX_FORM_FIELDS) { problems.push({ line, message: `A form can have ${MAX_FORM_FIELDS} fields. The rest of the file was not imported.` }); break; }
    const t = match.type;
    const spec = TYPE_SPECS[t];
    const label = cell(r, "label") || cell(r, "name", "id");
    const f: FormField = { id: "", label, type: t, ...match.preset };
    if (!label) { problems.push({ line, message: "No label, so the row was skipped." }); continue; }
    f.id = slugifyFieldId(cell(r, "name", "id") || label, known);

    const ok = (p: Parameters<typeof allows0>[1]) => allows0(t, p);
    const hint = cell(r, "hint"); if (hint && ok("hint")) f.hint = hint;
    const ph = cell(r, "placeholder"); if (ph && ok("placeholder")) f.placeholder = ph;
    const req = cell(r, "required"); if (req && isYes(req) && ok("required")) f.required = true;
    const ro = cell(r, "readonly", "read_only"); if (ro && isYes(ro) && ok("readonly")) f.readonly = true;
    const app = norm(cell(r, "appearance")); if (app && spec.appearances.includes(app)) f.appearance = app === spec.appearances[0] ? undefined : app;
    if (f.appearance === undefined) delete f.appearance;
    const unit = cell(r, "unit"); if (unit && t === "number") f.unit = unit;
    const dec = num(cell(r, "decimals")); if (dec !== undefined && t === "number" && !f.integer) f.decimals = Math.max(0, Math.min(10, Math.trunc(dec)));
    const pat = cell(r, "pattern"); if (pat && ok("pattern")) f.pattern = pat;
    const pm = cell(r, "pattern_message"); if (pm && f.pattern) f.pattern_message = pm;
    for (const k of ["min_length", "max_length", "min_items", "max_items"] as const) { const v = num(cell(r, k)); if (v !== undefined && ok(k)) f[k] = Math.trunc(v); }
    for (const k of ["min", "max"] as const) {
      const raw = cell(r, k); if (!raw || !ok(k)) continue;
      if (t === "number") { const v = num(raw); if (v !== undefined) f[k] = v; } else f[k] = raw;
    }
    const def = cell(r, "default");
    if (def && ok("default")) {
      const lower = def.toLowerCase();
      if (t === "number") { const v = num(def); if (v !== undefined) f.default = v; }
      else if (t === "boolean") { if (["yes", "true", "1"].includes(lower)) f.default = true; else if (["no", "false", "0"].includes(lower)) f.default = false; }
      else if (t === "date" || t === "datetime") f.default = lower === "today" || lower === "$today" ? "$today" : def;
      else if (t === "time") f.default = lower === "now" || lower === "$now" ? "$now" : def;
      else if (t === "multi_choice") f.default = splitChoices(def);
      else f.default = def;
    }

    if (hasChoices(t)) {
      const inline = cell(r, "choices", "options");
      const fromList = listName ? lists.get(norm(listName)) ?? lists.get(listName) : undefined;
      const ch = inline ? splitChoices(inline) : fromList ?? [];
      if (!ch.length) problems.push({ line, message: `“${label}” has no choices. Put them in the choices column, separated by ; or |.` });
      f.choices = ch;
      if (t === "choice" && typeof f.default === "string" && !ch.includes(f.default)) delete f.default;
    }
    if (t === "note") f.text = cell(r, "hint") || label;
    if (t === "calculation") problems.push({ line, message: `“${label}” is a calculation. Choose what to calculate in the builder; it cannot be written in a CSV.` });
    if (t === "photo") f.max_items = f.max_items ?? 3;
    if (isContainer(t)) f.children = [];

    if (begin) {
      if (stack.length >= MAX_DEPTH) { problems.push({ line, message: `Groups can go ${MAX_DEPTH} levels deep. “${label}” was skipped.` }); stack.push({ field: { ...f, children: [] }, line }); continue; }
      if (t === "repeat" && stack.some((s) => s.field.type === "repeat")) { problems.push({ line, message: "A repeat section cannot sit inside another repeat section." }); }
      list().push(f); known.push(f); total++; stack.push({ field: f, line });
    } else { list().push(f); known.push(f); total++; }
  }
  for (const s of stack) problems.push({ line: s.line, message: `“${s.field.label}” was never closed with an “end”. It was closed at the end of the file.` });

  out.fields = root;
  out.count = allFields(root).length;
  // Same checks as the builder, on the new fields only (references to existing fields are not looked up here: none are written in a CSV).
  const issues = checkFieldDefs([...existing, ...root]);
  const lineOf = new Map<string, number>();
  allFields(root).forEach((f) => { lineOf.set(f.id, 0); });
  for (const [id, msgs] of Object.entries(issues)) if (lineOf.has(id)) for (const m of msgs) if (!problems.some((p) => p.message.includes(m))) problems.push({ line: 0, message: `“${allFields(root).find((x) => x.id === id)?.label}”: ${m}` });
  return out;
}

const allows0 = (t: FieldType, p: string): boolean => (TYPE_SPECS[t].props as readonly string[]).includes(p);

/** A starter file to download, with one example of everything that matters. */
export function formTemplateCsv(): string {
  const head = ["type", "name", "label", "hint", "required", "choices", "default", "min", "max", "appearance"];
  const rows: string[][] = [
    ["text", "site_name", "Site name", "As written on the signboard", "yes", "", "", "", "", ""],
    ["integer", "households", "Number of households", "", "", "", "", "0", "10000", ""],
    ["decimal", "depth_m", "Depth (m)", "", "", "", "", "0", "", ""],
    ["select_one", "condition", "Condition", "", "yes", "Working; Needs repair; Broken", "", "", "", "radio"],
    ["select_multiple", "uses", "What is it used for?", "", "", "Drinking; Washing; Farming", "", "", "", ""],
    ["boolean", "has_fence", "Is it fenced?", "", "", "", "no", "", "", "switch"],
    ["date", "visit_date", "Date of visit", "", "yes", "", "today", "", "", ""],
    ["photo", "site_photo", "Photo of the site", "", "", "", "", "", "", ""],
    ["note", "tip", "Take the photo from the road", "", "", "", "", "", "", ""],
    ["begin group", "contact", "Contact person", "", "", "", "", "", "", ""],
    ["text", "contact_name", "Name", "", "", "", "", "", "", ""],
    ["text", "contact_phone", "Phone", "", "", "", "", "", "", ""],
    ["end group", "", "", "", "", "", "", "", "", ""],
  ];
  return [head, ...rows].map((r) => r.map(csvEscape).join(",")).join("\r\n") + "\r\n";
}
