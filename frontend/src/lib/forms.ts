import type { Form, FormField, Props } from "./types";

/** Client-side validation. The server validates again (it is the authority). */
export function validateProperties(form: Form, props: Props): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const f of form.fields) {
    const v = props[f.id];
    const empty = v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
    if (f.required && empty) { errors[f.id] = `${f.label} is required.`; continue; }
    if (empty) continue;
    if (f.type === "number" && Number.isNaN(Number(v))) errors[f.id] = `${f.label} must be a number.`;
    if (f.type === "choice" && f.choices && !f.choices.includes(String(v))) errors[f.id] = `Choose one of the listed options.`;
  }
  return errors;
}

export function slugifyFieldId(label: string, existing: FormField[]): string {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "field";
  let id = base;
  let n = 2;
  while (existing.some((f) => f.id === id)) id = `${base}_${n++}`;
  return id;
}

export const FIELD_TYPE_LABEL: Record<FormField["type"], string> = {
  text: "Text", number: "Number", choice: "Choice", multi_choice: "Multiple choice", date: "Date", photo: "Photo",
};

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
  const walk = (c: unknown): void => {
    if (Array.isArray(c) && typeof c[0] === "number") {
      any = true;
      w = Math.min(w, c[0] as number); e = Math.max(e, c[0] as number);
      s = Math.min(s, c[1] as number); n = Math.max(n, c[1] as number);
    } else if (Array.isArray(c)) c.forEach(walk);
  };
  geoms.forEach((g) => walk(g.coordinates));
  return any ? [w, s, e, n] : null;
}
