// The one table that describes every form element. It drives the "Add a field" palette, the property panel,
// the renderer and the validators. backend/app/services/forms.py carries the same table (TYPE_SPECS).
// If you change one, change the other: backend/tests/test_form_fields.py checks they agree.
import type { FieldType, FormField } from "./types";

export type Prop = Exclude<keyof FormField, "id" | "type" | "label">;
export type Category = "Input" | "Choice" | "Media" | "Display" | "Computed" | "Structure";

export interface TypeSpec {
  label: string;
  category: Category;
  /** How the value sits in feature.properties. "none" = nothing is stored for this element. */
  stores: "none" | "scalar" | "array" | "rows";
  /** True when the element collects an answer from the person filling the form. */
  answers: boolean;
  /** First entry is the default appearance. */
  appearances: readonly string[];
  /** Properties the builder offers for this type (beyond id, label and type). */
  props: readonly Prop[];
  children?: boolean;
  /** How the value is written to dataset exports. */
  exportAs: "column" | "joined" | "skip";
  /** Capture is done by the host (the mobile collector), so the editor only shows a note. */
  media?: boolean;
}

const BASE: Prop[] = ["hint", "visible", "required", "required_if", "readonly", "default"];

export const TYPE_SPECS: Record<FieldType, TypeSpec> = {
  text:         { label: "Text", category: "Input", stores: "scalar", answers: true, appearances: ["single_line", "multiline"], props: [...BASE, "placeholder", "min_length", "max_length", "pattern", "pattern_message"], exportAs: "column" },
  number:       { label: "Number", category: "Input", stores: "scalar", answers: true, appearances: ["input", "stepper", "slider"], props: [...BASE, "placeholder", "integer", "decimals", "unit", "min", "max"], exportAs: "column" },
  date:         { label: "Date", category: "Input", stores: "scalar", answers: true, appearances: ["picker"], props: [...BASE, "min", "max"], exportAs: "column" },
  time:         { label: "Time", category: "Input", stores: "scalar", answers: true, appearances: ["picker"], props: [...BASE, "min", "max"], exportAs: "column" },
  datetime:     { label: "Date and time", category: "Input", stores: "scalar", answers: true, appearances: ["picker"], props: [...BASE, "min", "max"], exportAs: "column" },
  barcode:      { label: "Barcode / QR code", category: "Input", stores: "scalar", answers: true, appearances: ["scan_or_type"], props: [...BASE, "placeholder", "pattern", "pattern_message"], exportAs: "column" },
  choice:       { label: "Single choice", category: "Choice", stores: "scalar", answers: true, appearances: ["auto", "buttons", "radio", "dropdown"], props: [...BASE, "choices"], exportAs: "column" },
  multi_choice: { label: "Multiple choice", category: "Choice", stores: "array", answers: true, appearances: ["checkbox", "chips", "dropdown"], props: [...BASE, "choices", "min_items", "max_items"], exportAs: "joined" },
  boolean:      { label: "Yes / No", category: "Choice", stores: "scalar", answers: true, appearances: ["switch", "checkbox", "yes_no_buttons"], props: [...BASE, "true_label", "false_label", "must_be_true"], exportAs: "column" },
  ranking:      { label: "Ranking", category: "Choice", stores: "array", answers: true, appearances: ["list"], props: [...BASE.filter((p) => p !== "default"), "choices"], exportAs: "joined" },
  photo:        { label: "Photo", category: "Media", stores: "array", answers: true, appearances: ["camera_or_gallery", "camera_only"], props: ["hint", "visible", "required", "required_if", "min_items", "max_items"], exportAs: "skip", media: true },
  audio:        { label: "Audio", category: "Media", stores: "array", answers: true, appearances: ["recorder"], props: ["hint", "visible", "required", "required_if", "max_items"], exportAs: "skip", media: true },
  video:        { label: "Video", category: "Media", stores: "array", answers: true, appearances: ["recorder"], props: ["hint", "visible", "required", "required_if", "max_items"], exportAs: "skip", media: true },
  file:         { label: "File", category: "Media", stores: "array", answers: true, appearances: ["picker"], props: ["hint", "visible", "required", "required_if", "max_items"], exportAs: "skip", media: true },
  signature:    { label: "Signature", category: "Media", stores: "array", answers: true, appearances: ["pad"], props: ["hint", "visible", "required", "required_if"], exportAs: "skip", media: true },
  note:         { label: "Note", category: "Display", stores: "none", answers: false, appearances: ["plain", "info", "warning", "heading"], props: ["visible", "text"], exportAs: "skip" },
  calculation:  { label: "Calculation", category: "Computed", stores: "scalar", answers: false, appearances: ["readonly_text", "hidden"], props: ["hint", "visible", "calc", "decimals", "unit", "store"], exportAs: "column" },
  group:        { label: "Group / Section", category: "Structure", stores: "none", answers: false, appearances: ["section", "collapsible", "page"], props: ["hint", "visible"], children: true, exportAs: "skip" },
  repeat:       { label: "Repeat section", category: "Structure", stores: "rows", answers: true, appearances: ["cards", "table"], props: ["hint", "visible", "required", "min_items", "max_items"], children: true, exportAs: "skip" },
};

export const FIELD_TYPES = Object.keys(TYPE_SPECS) as FieldType[];
export const MEDIA_TYPES = FIELD_TYPES.filter((t) => TYPE_SPECS[t].media);
export const isMedia = (t: FieldType): boolean => !!TYPE_SPECS[t].media;
export const isContainer = (t: FieldType): boolean => !!TYPE_SPECS[t].children;
export const hasChoices = (t: FieldType): boolean => t === "choice" || t === "multi_choice" || t === "ranking";
export const allows = (t: FieldType, p: Prop): boolean => TYPE_SPECS[t].props.includes(p);
export const defaultAppearance = (t: FieldType): string => TYPE_SPECS[t].appearances[0];

/** What the "Add a field" palette offers. Dropdown, Multiline, Integer... are presets of one type, not separate types. */
export interface PaletteItem { key: string; label: string; type: FieldType; category: Category; preset?: Partial<FormField> }
export const PALETTE: PaletteItem[] = [
  { key: "text", label: "Text", type: "text", category: "Input" },
  { key: "multiline", label: "Multiline text", type: "text", category: "Input", preset: { appearance: "multiline" } },
  { key: "integer", label: "Integer", type: "number", category: "Input", preset: { integer: true } },
  { key: "decimal", label: "Decimal", type: "number", category: "Input", preset: { integer: false, decimals: 2 } },
  { key: "date", label: "Date", type: "date", category: "Input" },
  { key: "time", label: "Time", type: "time", category: "Input" },
  { key: "datetime", label: "Date and time", type: "datetime", category: "Input" },
  { key: "barcode", label: "Barcode / QR code", type: "barcode", category: "Input" },
  { key: "choice", label: "Single choice", type: "choice", category: "Choice" },
  { key: "dropdown", label: "Dropdown", type: "choice", category: "Choice", preset: { appearance: "dropdown" } },
  { key: "multi_choice", label: "Multiple choice", type: "multi_choice", category: "Choice" },
  { key: "switch", label: "Switch / Toggle", type: "boolean", category: "Choice", preset: { appearance: "switch" } },
  { key: "ack", label: "Acknowledgement", type: "boolean", category: "Choice", preset: { appearance: "checkbox", must_be_true: true, required: true } },
  { key: "ranking", label: "Ranking", type: "ranking", category: "Choice" },
  { key: "photo", label: "Image / Photo", type: "photo", category: "Media" },
  { key: "audio", label: "Audio", type: "audio", category: "Media" },
  { key: "video", label: "Video", type: "video", category: "Media" },
  { key: "file", label: "File attachment", type: "file", category: "Media" },
  { key: "signature", label: "Signature", type: "signature", category: "Media" },
  { key: "note", label: "Note / Instructions", type: "note", category: "Display" },
  { key: "calculation", label: "Calculation", type: "calculation", category: "Computed" },
  { key: "group", label: "Group / Section", type: "group", category: "Structure" },
  { key: "repeat", label: "Repeat section", type: "repeat", category: "Structure" },
];
export const PALETTE_CATEGORIES: Category[] = ["Input", "Choice", "Media", "Display", "Computed", "Structure"];

// ---- tree helpers ----
export function walk(fields: FormField[], fn: (f: FormField, parent: FormField | null, depth: number) => void, parent: FormField | null = null, depth = 0): void {
  for (const f of fields) { fn(f, parent, depth); if (f.children) walk(f.children, fn, f, depth + 1); }
}
export const allFields = (fields: FormField[]): FormField[] => { const out: FormField[] = []; walk(fields, (f) => out.push(f)); return out; };
export const findField = (fields: FormField[], id: string): FormField | null => allFields(fields).find((f) => f.id === id) ?? null;

/** The fields whose values sit directly in feature.properties: groups are looked through, repeats stay one unit. */
export function topLevelFields(fields: FormField[]): FormField[] {
  const out: FormField[] = [];
  for (const f of fields) {
    if (f.type === "group") out.push(...topLevelFields(f.children ?? []));
    else out.push(f);
  }
  return out;
}
/** Everything that is stored as its own column in exports: answers and stored calculations, not media, notes or repeats. */
export const columnFields = (fields: FormField[]): FormField[] =>
  topLevelFields(fields).filter((f) => TYPE_SPECS[f.type].exportAs !== "skip" && !(f.type === "calculation" && f.store === false));
/** The ids used by a level of the form (a group's children belong to the level of the group). Repeat children are separate. */
export function levelIds(fields: FormField[]): Set<string> {
  const ids = new Set<string>();
  for (const f of fields) { ids.add(f.id); if (f.type === "group") levelIds(f.children ?? []).forEach((i) => ids.add(i)); }
  return ids;
}

/** Returns a copy of the tree with `fn` applied to the field with this id. Return null from fn to remove it. */
export function mapField(fields: FormField[], id: string, fn: (f: FormField) => FormField | null): FormField[] {
  const out: FormField[] = [];
  for (const f of fields) {
    if (f.id === id) { const r = fn(f); if (r) out.push(r); continue; }
    out.push(f.children ? { ...f, children: mapField(f.children, id, fn) } : f);
  }
  return out;
}
/** Where a field sits: the list that holds it and its index. */
export function locate(fields: FormField[], id: string): { list: FormField[]; index: number; parent: FormField | null } | null {
  const look = (list: FormField[], parent: FormField | null): ReturnType<typeof locate> => {
    for (let i = 0; i < list.length; i++) {
      if (list[i].id === id) return { list, index: i, parent };
      const kids = list[i].children;
      if (kids) { const r = look(kids, list[i]); if (r) return r; }
    }
    return null;
  };
  return look(fields, null);
}
/** Moves a field up or down inside its own list. Returns the same tree when it cannot move. */
export function moveField(fields: FormField[], id: string, dir: -1 | 1): FormField[] {
  const loc = locate(fields, id);
  if (!loc) return fields;
  const j = loc.index + dir;
  if (j < 0 || j >= loc.list.length) return fields;
  const swap = (list: FormField[]): FormField[] => { const n = [...list]; [n[loc.index], n[j]] = [n[j], n[loc.index]]; return n; };
  if (!loc.parent) return swap(fields);
  return mapField(fields, loc.parent.id, (p) => ({ ...p, children: swap(p.children ?? []) }));
}
/** Moves a field into a group or repeat (at the end), or out of it to the top level when `intoId` is null. */
export function moveInto(fields: FormField[], id: string, intoId: string | null): FormField[] {
  const f = findField(fields, id);
  if (!f) return fields;
  if (intoId === id || (intoId && findField(f.children ?? [], intoId))) return fields; // never into itself
  if (intoId) { const target = findField(fields, intoId); if (!target || !isContainer(target.type)) return fields; if (f.type === "repeat" && target.type === "repeat") return fields; }
  if (f.type === "repeat" && intoId && inRepeat(fields, intoId)) return fields;
  const without = mapField(fields, id, () => null);
  if (!intoId) return [...without, f];
  return mapField(without, intoId, (t) => ({ ...t, children: [...(t.children ?? []), f] }));
}
/** True when this field is a repeat or contains one anywhere inside it. */
export const holdsRepeat = (f: FormField): boolean => f.type === "repeat" || (f.children ?? []).some(holdsRepeat);

/** May a field of this type sit directly inside `parentId` (null = the top level)? `movingId` is set when an existing field is being moved. */
export function canPlace(fields: FormField[], type: FieldType, parentId: string | null, movingId?: string): boolean {
  if (parentId === null) return true;
  const parent = findField(fields, parentId);
  if (!parent || !isContainer(parent.type)) return false;
  const moving = movingId ? findField(fields, movingId) : null;
  if (moving && (parentId === moving.id || findField(moving.children ?? [], parentId))) return false;   // never into itself or its own contents
  const insideRepeat = parent.type === "repeat" || inRepeat(fields, parentId);
  if (insideRepeat && (type === "repeat" || (moving && holdsRepeat(moving)))) return false;           // a repeat cannot hold another repeat
  return true;
}

/** Inserts a field at `index` (clamped) in a container's children, or at the top level when `parentId` is null. */
export function insertAt(fields: FormField[], field: FormField, parentId: string | null, index: number): FormField[] {
  const put = (list: FormField[]): FormField[] => { const i = Math.max(0, Math.min(list.length, index)); return [...list.slice(0, i), field, ...list.slice(i)]; };
  return parentId === null ? put(fields) : mapField(fields, parentId, (p) => ({ ...p, children: put(p.children ?? []) }));
}

/** Moves a field to a position: `index` counts the slots of the target list as they look before the move (so dropping just below
 * a field's own position is a no-op). Returns the same tree when the move is not allowed or changes nothing. */
export function moveTo(fields: FormField[], id: string, parentId: string | null, index: number): FormField[] {
  const loc = locate(fields, id);
  const f = findField(fields, id);
  if (!loc || !f || !canPlace(fields, f.type, parentId, id)) return fields;
  const sameList = (loc.parent?.id ?? null) === parentId;
  if (sameList && (index === loc.index || index === loc.index + 1)) return fields;
  const at = sameList && index > loc.index ? index - 1 : index;      // taking the field out shifts later slots up by one
  return insertAt(mapField(fields, id, () => null), f, parentId, at);
}
export function inRepeat(fields: FormField[], id: string): boolean {
  let found = false;
  walk(fields, (f) => { if (f.type === "repeat" && f.children && findField(f.children, id)) found = true; });
  return found;
}

export function slugifyFieldId(label: string, existing: FormField[]): string {
  const taken = new Set(allFields(existing).map((f) => f.id));
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^[0-9_]+/, "").slice(0, 36) || "field";
  let id = base, n = 2;
  while (taken.has(id)) id = `${base}_${n++}`;
  return id;
}

/** A new field with sensible starting values for its type. */
export function newField(item: PaletteItem, existing: FormField[]): FormField {
  const t = item.type;
  const label = item.label === TYPE_SPECS[t].label ? `New ${item.label.toLowerCase()}` : item.label;
  const f: FormField = { id: slugifyFieldId(label, existing), label, type: t, ...item.preset };
  if (hasChoices(t)) f.choices = ["Option 1", "Option 2"];
  if (t === "photo") f.max_items = 3;
  if (t === "note") f.text = "Write the instructions here.";
  if (t === "calculation") { f.calc = { fn: "sum", args: [] }; f.store = true; }
  if (isContainer(t)) f.children = [];
  return f;
}
