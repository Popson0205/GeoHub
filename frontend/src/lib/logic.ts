// Conditions, calculations and "what is visible right now". Pure functions, no React.
// backend/app/services/forms.py implements the same rules; keep the two in step.
import { levelIds } from "./fieldSpec";
import type { Calc, Condition, FormField, Operand, Props } from "./types";

type Get = (id: string) => unknown;
export const isEmpty = (v: unknown): boolean => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

/** Compares two answers. Numbers compare as numbers, ISO dates and times as text. Returns null when they cannot be compared. */
function compare(a: unknown, b: unknown): number | null {
  if (isEmpty(a) || isEmpty(b)) return null;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") {
    const na = Number(a), nb = Number(b);
    if (a.trim() !== "" && b.trim() !== "" && Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  const na = Number(a), nb = Number(b);
  return Number.isFinite(na) && Number.isFinite(nb) ? na - nb : null;
}
const same = (a: unknown, b: unknown): boolean => {
  if (isEmpty(a)) return false;
  if (typeof a === "boolean" || typeof b === "boolean") return a === b;
  return String(a) === String(b);
};

export function evalCondition(c: Condition, get: Get): boolean {
  if ("all" in c) return c.all.every((x) => evalCondition(x, get));
  if ("any" in c) return c.any.some((x) => evalCondition(x, get));
  if ("not" in c) return !evalCondition(c.not, get);
  const v = get(c.field);
  switch (c.op) {
    case "filled": return !isEmpty(v);
    case "empty": return isEmpty(v);
    case "eq": return same(v, c.value);
    case "ne": return !same(v, c.value);
    case "gt": { const r = compare(v, c.value); return r !== null && r > 0; }
    case "gte": { const r = compare(v, c.value); return r !== null && r >= 0; }
    case "lt": { const r = compare(v, c.value); return r !== null && r < 0; }
    case "lte": { const r = compare(v, c.value); return r !== null && r <= 0; }
    case "in": case "not_in": {
      const list = Array.isArray(c.value) ? c.value : [c.value];
      const hit = Array.isArray(v) ? v.some((x) => list.some((y) => same(x, y))) : list.some((y) => same(v, y));
      return c.op === "in" ? hit : !hit;
    }
    case "contains": {
      const list = Array.isArray(c.value) ? c.value : [c.value];
      return Array.isArray(v) ? list.every((y) => v.some((x) => same(x, y))) : typeof v === "string" && list.every((y) => v.includes(String(y)));
    }
  }
}

const round = (n: number): number => Math.round(n * 1e10) / 1e10;
const operand = (o: Operand, get: Get): unknown => ("const" in o ? o.const : get(o.field));
const nums = (args: Operand[], get: Get): number[] =>
  args.map((a) => operand(a, get)).filter((v) => !isEmpty(v) && typeof v !== "boolean").map(Number).filter(Number.isFinite);
const two = (args: Operand[], get: Get): [number, number] | null => {
  const [a, b] = args.map((x) => operand(x, get));
  if (isEmpty(a) || isEmpty(b)) return null;
  const x = Number(a), y = Number(b);
  return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
};
const pad = (n: number) => String(n).padStart(2, "0");

// ---- generated ids ----
const ID_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";   // no 0 O 1 I L, so an id can be read out loud or copied by hand
function randomBytes(n: number): number[] {
  const out = new Uint8Array(n);
  if (typeof crypto !== "undefined" && "getRandomValues" in crypto) crypto.getRandomValues(out);
  else for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  return Array.from(out);
}
const newUuid = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === "x" ? r : (r & 0x3) | 0x8).toString(16); });
/** True for calculations that make a new value instead of working one out from answers. They run once and are then kept. */
export const isGenerated = (c: Calc | undefined): boolean => !!c && (c.fn === "uuid" || c.fn === "short_id");
/** A new id for a `uuid` or `short_id` calculation. */
export function generateId(c: Calc): string {
  if (c.fn === "uuid") return newUuid();
  const prefix = c.fn === "short_id" ? c.prefix ?? "" : "";
  return prefix + randomBytes(8).map((b) => ID_ALPHABET[b % ID_ALPHABET.length]).join("");
}

/** The value of a calculation, or null when its inputs are not there yet. */
export function evalCalc(c: Calc, get: Get): number | string | null {
  switch (c.fn) {
    case "sum": { const n = nums(c.args, get); return n.length ? round(n.reduce((a, b) => a + b, 0)) : null; }
    case "product": { const n = nums(c.args, get); return n.length ? round(n.reduce((a, b) => a * b, 1)) : null; }
    case "min": { const n = nums(c.args, get); return n.length ? Math.min(...n) : null; }
    case "max": { const n = nums(c.args, get); return n.length ? Math.max(...n) : null; }
    case "avg": { const n = nums(c.args, get); return n.length ? round(n.reduce((a, b) => a + b, 0) / n.length) : null; }
    case "diff": { const p = two(c.args, get); return p ? round(p[0] - p[1]) : null; }
    case "ratio": { const p = two(c.args, get); return p && p[1] !== 0 ? round(p[0] / p[1]) : null; }
    case "count_selected": { const v = operand(c.args[0], get); return Array.isArray(v) ? v.length : 0; }
    case "concat": {
      const parts = c.args.map((a) => operand(a, get)).filter((v) => !isEmpty(v)).map((v) => (Array.isArray(v) ? v.join(", ") : String(v)));
      return parts.length ? parts.join(c.sep ?? " ") : null;
    }
    case "today": { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
    case "now": return new Date().toISOString();
    case "uuid": case "short_id": return generateId(c);
  }
}

/** Field ids a condition or calculation reads. */
export function conditionRefs(c: Condition): string[] {
  if ("all" in c) return c.all.flatMap(conditionRefs);
  if ("any" in c) return c.any.flatMap(conditionRefs);
  if ("not" in c) return conditionRefs(c.not);
  return [c.field];
}
export const calcRefs = (c: Calc): string[] => ("args" in c ? (c.args as Operand[]).flatMap((a) => ("field" in a ? [a.field] : [])) : []);

// ---- resolving a whole form ----
export interface Resolved {
  /** The answers with calculations filled in. */
  values: Props;
  /** Hidden fields. Top level: the field id. Inside a repeat row: `${repeatId}.${row}.${fieldId}` (see rowKey). */
  hidden: Set<string>;
  /** Visible fields that must be answered right now. Same keys as `hidden`. */
  required: Set<string>;
}
export const rowKey = (repeatId: string, row: number, id: string): string => `${repeatId}.${row}.${id}`;

interface State { prev: Set<string>; hidden: Set<string>; required: Set<string> }

function scan(fields: FormField[], next: Props, root: Props, ids: Set<string>, parentVisible: boolean, prefix: string, st: State): void {
  const get: Get = (id) => {
    const inLevel = ids.has(id);
    if (st.prev.has(inLevel ? prefix + id : id)) return undefined; // a hidden answer counts as no answer
    return inLevel ? next[id] : root[id];
  };
  for (const f of fields) {
    const key = prefix + f.id;
    const visible = parentVisible && (!f.visible || evalCondition(f.visible, get));
    if (!visible) st.hidden.add(key);
    else if (f.required || f.must_be_true || (f.required_if && evalCondition(f.required_if, get))) st.required.add(key);
    if (f.type === "calculation" && f.calc && isGenerated(f.calc)) {
      if (visible && isEmpty(next[f.id])) next[f.id] = generateId(f.calc);       // made once; an existing id is never replaced
    } else if (f.type === "calculation" && f.calc) {
      let v = evalCalc(f.calc, get);
      if (typeof v === "number" && f.decimals !== undefined) v = Number(v.toFixed(f.decimals));
      if (v === null) delete next[f.id]; else next[f.id] = v;
    } else if (f.type === "group") {
      scan(f.children ?? [], next, root, ids, visible, prefix, st);
    } else if (f.type === "repeat" && Array.isArray(next[f.id])) {
      const kids = f.children ?? [];
      const kidIds = levelIds(kids);
      next[f.id] = (next[f.id] as Props[]).map((row, i) => {
        const r: Props = { ...row };
        scan(kids, r, root, kidIds, visible, `${f.id}.${i}.`, st);
        return r;
      });
    }
  }
}

/** Works out what is visible, what is required and what the calculations say. Cheap enough to run on every keystroke. */
export function resolve(fields: FormField[], input: Props): Resolved {
  let values: Props = { ...input };
  let hidden = new Set<string>();
  let required = new Set<string>();
  const ids = levelIds(fields);
  for (let pass = 0; pass < 3; pass++) {            // a calculation can decide visibility, and hidden answers feed calculations
    const st: State = { prev: hidden, hidden: new Set(), required: new Set() };
    const next: Props = { ...values };
    scan(fields, next, values, ids, true, "", st);
    values = next; hidden = st.hidden; required = st.required;
  }
  return { values, hidden, required };
}
