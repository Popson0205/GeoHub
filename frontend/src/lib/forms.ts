import { TYPE_SPECS, allFields, hasChoices, slugifyFieldId, topLevelFields, walk } from "./fieldSpec";
import { calcRefs, conditionRefs, isEmpty, resolve } from "./logic";
import type { FieldType, Form, FormField, Props } from "./types";

export { slugifyFieldId };

export const FIELD_TYPE_LABEL = Object.fromEntries(Object.entries(TYPE_SPECS).map(([k, v]) => [k, v.label])) as Record<FieldType, string>;

const TEXT_CAP = 5000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

/** Checks one answer against its field. Returns an error message, or "" when it is fine. `v` is never empty here. */
function checkValue(f: FormField, v: unknown): string {
  const L = f.label;
  switch (f.type) {
    case "text": case "barcode": {
      const cap = f.max_length ?? (f.type === "barcode" ? 500 : TEXT_CAP);
      if (typeof v !== "string") return `${L} must be text.`;
      if (v.length > cap) return `${L} can have at most ${cap} characters.`;
      if (f.min_length !== undefined && v.length < f.min_length) return `${L} needs at least ${f.min_length} characters.`;
      if (f.pattern) { try { if (!new RegExp(f.pattern).test(v)) return f.pattern_message || `${L} is not in the expected format.`; } catch { /* the builder reports a bad pattern */ } }
      return "";
    }
    case "number": {
      if (typeof v !== "number" || !Number.isFinite(v)) return `${L} must be a number.`;
      if (f.integer && !Number.isInteger(v)) return `${L} must be a whole number.`;
      if (typeof f.min === "number" && v < f.min) return `${L} must be at least ${f.min}.`;
      if (typeof f.max === "number" && v > f.max) return `${L} must be at most ${f.max}.`;
      return "";
    }
    case "date": case "time": case "datetime": {
      const ok = f.type === "date" ? typeof v === "string" && DATE_RE.test(v) && !Number.isNaN(Date.parse(v))
        : f.type === "time" ? typeof v === "string" && TIME_RE.test(v)
        : typeof v === "string" && !Number.isNaN(Date.parse(v));
      if (!ok) return `${L} must be a valid ${f.type === "date" ? "date" : f.type === "time" ? "time" : "date and time"}.`;
      if (typeof f.min === "string" && (v as string) < f.min) return `${L} cannot be before ${f.min}.`;
      if (typeof f.max === "string" && (v as string) > f.max) return `${L} cannot be after ${f.max}.`;
      return "";
    }
    case "choice": return f.choices?.includes(String(v)) ? "" : "Choose one of the listed options.";
    case "multi_choice": case "ranking": {
      if (!Array.isArray(v) || new Set(v).size !== v.length || v.some((x) => !f.choices?.includes(String(x)))) return "Choose only from the listed options.";
      if (f.type === "ranking" && v.length !== f.choices?.length) return `Rank every option in ${L}.`;
      if (f.min_items !== undefined && v.length < f.min_items) return `Choose at least ${f.min_items}.`;
      if (f.max_items !== undefined && v.length > f.max_items) return `Choose at most ${f.max_items}.`;
      return "";
    }
    case "boolean": {
      if (typeof v !== "boolean") return `${L} must be yes or no.`;
      return f.must_be_true && !v ? `${L} must be accepted to continue.` : "";
    }
    case "photo": case "audio": case "video": case "file": case "signature": {
      if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) return `${L} holds an unreadable attachment.`;
      const cap = f.max_items ?? (f.type === "photo" ? 20 : f.type === "signature" ? 1 : 10);
      if (v.length > cap) return `${L} can have at most ${cap}.`;
      if (f.min_items !== undefined && v.length < f.min_items) return `${L} needs at least ${f.min_items}.`;
      return "";
    }
    case "calculation": return typeof v === "number" || typeof v === "string" ? "" : `${L} could not be calculated.`;
    default: return "";
  }
}

/**
 * Client-side validation. The server validates again (it is the authority).
 * Only visible fields are checked. Errors are keyed by field id, or `${repeatId}.${row}.${fieldId}` inside a repeat.
 */
export function validateProperties(form: Pick<Form, "fields">, props: Props): Record<string, string> {
  const { values, hidden, required } = resolve(form.fields, props);
  const errors: Record<string, string> = {};
  const check = (fields: FormField[], vals: Props, prefix: string): void => {
    for (const f of fields) {
      const key = prefix + f.id;
      if (hidden.has(key)) continue;
      if (f.type === "group") { check(f.children ?? [], vals, prefix); continue; }
      if (f.type === "note") continue;
      const v = vals[f.id];
      if (f.type === "repeat") {
        const rows = Array.isArray(v) ? (v as Props[]) : [];
        if (required.has(key) && rows.length === 0) { errors[key] = `${f.label} needs at least one entry.`; continue; }
        if (f.min_items !== undefined && rows.length < f.min_items) errors[key] = `${f.label} needs at least ${f.min_items} entries.`;
        if (f.max_items !== undefined && rows.length > f.max_items) errors[key] = `${f.label} can have at most ${f.max_items} entries.`;
        rows.forEach((row, i) => check(f.children ?? [], row, `${f.id}.${i}.`));
        continue;
      }
      if (isEmpty(v)) { if (required.has(key) && f.type !== "calculation") errors[key] = `${f.label} is required.`; continue; }
      const msg = checkValue(f, v);
      if (msg) errors[key] = msg;
    }
  };
  check(form.fields, values, "");
  return errors;
}

/**
 * What gets saved: calculations filled in, hidden answers dropped, empty answers dropped, and nothing for
 * notes, groups or calculations marked "do not save".
 */
export function pruneProperties(form: Pick<Form, "fields">, props: Props): Props {
  const { values, hidden } = resolve(form.fields, props);
  const build = (fields: FormField[], vals: Props, prefix: string): Props => {
    const out: Props = {};
    for (const f of topLevelFields(fields)) {
      const spec = TYPE_SPECS[f.type];
      if (spec.stores === "none" || hidden.has(prefix + f.id) || (f.type === "calculation" && f.store === false)) continue;
      const v = vals[f.id];
      if (isEmpty(v)) continue;
      if (f.type === "repeat") {
        const rows = (v as Props[]).map((row, i) => build(f.children ?? [], row, `${f.id}.${i}.`)).filter((r) => Object.keys(r).length > 0);
        if (rows.length) out[f.id] = rows;
      } else out[f.id] = v;
    }
    return out;
  };
  return build(form.fields, values, "");
}

/** Fills in default values for a new feature or a new repeat row. `$today` and `$now` become the current date or time. */
export function applyDefaults(fields: FormField[], props: Props = {}): Props {
  const out: Props = { ...props };
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const token = (v: unknown, t: FieldType): unknown => {
    if (v === "$today") return t === "datetime" ? d.toISOString() : `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    if (v === "$now") return t === "time" ? `${p(d.getHours())}:${p(d.getMinutes())}` : d.toISOString();
    return v;
  };
  for (const f of topLevelFields(fields)) {
    if (f.default !== undefined && isEmpty(out[f.id]) && f.type !== "repeat") out[f.id] = token(f.default, f.type);
  }
  return out;
}
/** A blank row for a repeat section. */
export const newRow = (repeat: FormField): Props => applyDefaults(repeat.children ?? []);

/** Problems with a form's design, found while building it. The server runs the same checks when the form is saved. */
export function checkFieldDefs(fields: FormField[]): Record<string, string[]> {
  const issues: Record<string, string[]> = {};
  const add = (id: string, m: string) => { (issues[id] ??= []).push(m); };
  const all = allFields(fields);
  const dataIds = new Set(all.filter((f) => TYPE_SPECS[f.type].stores !== "none").map((f) => f.id));
  const insideRepeat = new Set<string>();
  walk(fields, (f) => { if (f.type === "repeat") allFields(f.children ?? []).forEach((c) => { if (c.type === "repeat") insideRepeat.add(c.id); }); });

  const seen = new Set<string>();
  for (const f of all) {
    if (seen.has(f.id)) add(f.id, "Another field already uses this id.");
    seen.add(f.id);
    if (!f.label.trim()) add(f.id, "Give this field a label.");
    if (hasChoices(f.type)) {
      const ch = f.choices ?? [];
      if (ch.length === 0) add(f.id, "Add at least one choice.");
      if (new Set(ch).size !== ch.length || ch.some((c) => !c)) add(f.id, "Choices must be different and not empty.");
    }
    if (f.type === "calculation" && !f.calc) add(f.id, "Choose what to calculate.");
    if (f.type === "note" && !f.text?.trim()) add(f.id, "Write the note text.");
    if (insideRepeat.has(f.id)) add(f.id, "A repeat section cannot sit inside another repeat section.");
    if (f.min !== undefined && f.max !== undefined && typeof f.min === typeof f.max && f.min > f.max) add(f.id, "The minimum is larger than the maximum.");
    if (f.min_items !== undefined && f.max_items !== undefined && f.min_items > f.max_items) add(f.id, "The minimum is larger than the maximum.");
    if (f.pattern) { try { new RegExp(f.pattern); } catch { add(f.id, "The format pattern is not valid."); } }
    const refs = [...(f.visible ? conditionRefs(f.visible) : []), ...(f.required_if ? conditionRefs(f.required_if) : []), ...(f.calc ? calcRefs(f.calc) : [])];
    for (const r of refs) {
      if (r === f.id) add(f.id, "A field cannot depend on itself.");
      else if (!dataIds.has(r)) add(f.id, `It refers to a field that does not exist (${r}).`);
    }
  }

  // calculations that depend on each other in a circle
  const deps = new Map(all.filter((f) => f.type === "calculation" && f.calc).map((f) => [f.id, calcRefs(f.calc!)]));
  const state = new Map<string, 1 | 2>();
  const visit = (id: string): boolean => {
    if (state.get(id) === 2) return false;
    if (state.get(id) === 1) return true;
    state.set(id, 1);
    let cyc = false;
    for (const d of deps.get(id) ?? []) if (deps.has(d) && visit(d)) cyc = true;
    if (cyc) add(id, "Calculations refer to each other in a circle.");
    state.set(id, 2);
    return cyc;
  };
  deps.forEach((_, id) => visit(id));
  return issues;
}

export const uuid = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
      });

/** Bounding box [w, s, e, n] of a set of geometries, or null. */
export function bboxOf(geoms: { coordinates: unknown }[]): [number, number, number, number] | null {
  let w = 180, s = 90, e = -180, n = -90, any = false;
  const walkc = (c: unknown): void => {
    if (Array.isArray(c) && typeof c[0] === "number") {
      any = true;
      w = Math.min(w, c[0] as number); e = Math.max(e, c[0] as number);
      s = Math.min(s, c[1] as number); n = Math.max(n, c[1] as number);
    } else if (Array.isArray(c)) c.forEach(walkc);
  };
  geoms.forEach((g) => walkc(g.coordinates));
  return any ? [w, s, e, n] : null;
}
