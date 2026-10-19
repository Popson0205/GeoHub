import { useEffect, useMemo, useState, type ReactNode } from "react";
import { TYPE_SPECS, defaultAppearance } from "../lib/fieldSpec";
import { newRow } from "../lib/forms";
import { resolve } from "../lib/logic";
import type { Form, FormField, Props } from "../lib/types";
import { Button } from "./ui";

/** What the host gets for a media field. The host captures the file; `set` writes the ids back into the form. */
export interface MediaCtx { value: string[]; set: (ids: string[]) => void; key: string }

interface Props_ {
  form: Pick<Form, "id" | "fields">;
  value: Props;
  onChange: (next: Props) => void;
  /** Keyed by field id, or `${repeatId}.${row}.${fieldId}` inside a repeat (see validateProperties). */
  errors?: Record<string, string>;
  /** Photo, audio, video, file and signature fields are captured by the host (the collector). Without it the editor shows a note. */
  renderMedia?: (field: FormField, ctx: MediaCtx) => ReactNode;
}

const OPEN_FIELDSET = { border: 0, padding: 0, margin: 0, minWidth: 0 } as const;
const toLocalInput = (iso: unknown): string => {
  if (typeof iso !== "string" || !iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const fromLocalInput = (s: string): string => (s ? new Date(s).toISOString() : "");
const stepOf = (f: FormField): number | "any" => (f.integer ? 1 : f.decimals !== undefined ? Number((10 ** -f.decimals).toFixed(f.decimals)) : "any");

export default function FormRenderer({ form, value, onChange, errors = {}, renderMedia }: Props_) {
  const { values, hidden, required } = useMemo(() => resolve(form.fields, value), [form.fields, value]);
  const emit = (next: Props) => onChange(resolve(form.fields, next).values);

  // Groups drawn as pages: one page at a time, with a jump to the first page that has a problem.
  const paged = form.fields.some((f) => f.type === "group" && f.appearance === "page");
  const pages = useMemo(() => {
    const out: { title: string; items: FormField[] }[] = [];
    let loose: FormField[] = [];
    for (const f of form.fields) {
      if (f.type === "group" && f.appearance === "page") {
        if (loose.length) { out.push({ title: "", items: loose }); loose = []; }
        if (!hidden.has(f.id)) out.push({ title: f.label, items: [{ ...f, appearance: "section" }] });
      } else loose.push(f);
    }
    if (loose.length) out.push({ title: "", items: loose });
    return out;
  }, [form.fields, hidden]);
  const [page, setPage] = useState(0);
  const pageIndex = Math.min(page, Math.max(0, pages.length - 1));
  const errorKeys = Object.keys(errors).join("|");
  useEffect(() => {
    if (!paged || !errorKeys) return;
    const ids = errorKeys.split("|").map((k) => k.split(".")[0]);
    const holds = (items: FormField[], id: string): boolean => items.some((f) => f.id === id || (f.children ? holds(f.children, id) : false));
    const has = (i: number) => ids.some((id) => holds(pages[i]?.items ?? [], id));
    if (!has(pageIndex)) { const j = pages.findIndex((_, i) => has(i)); if (j >= 0) setPage(j); }
  }, [errorKeys, paged, pages, pageIndex]);

  // ---- one level of fields: the form itself, or one row of a repeat ----
  function level(fields: FormField[], vals: Props, setVals: (n: Props) => void, prefix: string): ReactNode[] {
    const set = (id: string, v: unknown) => setVals({ ...vals, [id]: v });
    return fields.map((f) => {
      const key = prefix + f.id;
      if (hidden.has(key)) return null;
      const spec = TYPE_SPECS[f.type];
      const app = f.appearance && spec.appearances.includes(f.appearance) ? f.appearance : defaultAppearance(f.type);
      const err = errors[key];
      const id = `field-${form.id}-${key.replace(/\./g, "-")}`;
      const isReq = required.has(key);
      const label = <>{f.label}{isReq && <span aria-hidden="true"> *</span>}</>;
      const hint = f.hint ? <span className="field-hint" id={`${id}-hint`}>{f.hint}</span> : null;
      const msg = err ? <span className="field-error" id={`${id}-err`} role="alert">{err}</span> : null;
      const describedBy = [f.hint ? `${id}-hint` : "", err ? `${id}-err` : ""].filter(Boolean).join(" ") || undefined;
      const aria = { "aria-invalid": err ? true : undefined, "aria-required": isReq || undefined, "aria-describedby": describedBy } as const;
      const v = vals[f.id];
      const ro = !!f.readonly;
      const fieldset = (body: ReactNode) => (
        <fieldset className="field" key={key} style={OPEN_FIELDSET} aria-describedby={describedBy} aria-invalid={err ? true : undefined}>
          <legend style={{ padding: 0, marginBottom: 4 }}>{label}</legend>{hint}{body}{msg}
        </fieldset>
      );
      const simple = (control: ReactNode) => (
        <div className="field" key={key}><label htmlFor={id}>{label}</label>{hint}{control}{msg}</div>
      );

      switch (f.type) {
        case "text":
          return simple(app === "multiline"
            ? <textarea id={id} {...aria} readOnly={ro} placeholder={f.placeholder} maxLength={f.max_length} value={String(v ?? "")} onChange={(e) => set(f.id, e.target.value)} />
            : <input id={id} {...aria} type="text" readOnly={ro} placeholder={f.placeholder} maxLength={f.max_length} value={String(v ?? "")} onChange={(e) => set(f.id, e.target.value)} />);

        case "number": {
          const min = typeof f.min === "number" ? f.min : undefined, max = typeof f.max === "number" ? f.max : undefined;
          const step = stepOf(f);
          const num = typeof v === "number" ? v : "";
          const bump = (d: number) => {
            const n = (typeof v === "number" ? v : min ?? 0) + d * (step === "any" ? 1 : step);
            set(f.id, Math.min(max ?? n, Math.max(min ?? n, Number(n.toFixed(f.decimals ?? 10)))));
          };
          return simple(
            <div className="num-row">
              {app === "stepper" && <Button small disabled={ro} aria-label={`Decrease ${f.label}`} onClick={() => bump(-1)}>−</Button>}
              <input id={id} {...aria} type={app === "slider" && min !== undefined && max !== undefined ? "range" : "number"} readOnly={ro}
                inputMode={f.integer ? "numeric" : "decimal"} placeholder={f.placeholder} min={min} max={max} step={step} value={num}
                onChange={(e) => set(f.id, e.target.value === "" ? "" : Number(e.target.value))} />
              {app === "stepper" && <Button small disabled={ro} aria-label={`Increase ${f.label}`} onClick={() => bump(1)}>+</Button>}
              {app === "slider" && <output className="num-out">{num === "" ? "–" : num}</output>}
              {f.unit && <span className="unit">{f.unit}</span>}
            </div>,
          );
        }

        case "date": case "time":
          return simple(<input id={id} {...aria} type={f.type} readOnly={ro} min={typeof f.min === "string" ? f.min : undefined} max={typeof f.max === "string" ? f.max : undefined}
            value={String(v ?? "")} onChange={(e) => set(f.id, e.target.value)} />);
        case "datetime":
          return simple(<input id={id} {...aria} type="datetime-local" readOnly={ro} min={typeof f.min === "string" ? toLocalInput(f.min) : undefined} max={typeof f.max === "string" ? toLocalInput(f.max) : undefined}
            value={toLocalInput(v)} onChange={(e) => set(f.id, fromLocalInput(e.target.value))} />);

        case "barcode":
          return simple(
            <div className="num-row">
              <input id={id} {...aria} type="text" readOnly={ro} placeholder={f.placeholder ?? "Scan or type the code"} value={String(v ?? "")} onChange={(e) => set(f.id, e.target.value)} />
              <ScanButton disabled={ro} label={f.label} onCode={(c) => set(f.id, c)} />
            </div>,
          );

        case "choice": {
          const opts = f.choices ?? [];
          const kind = app === "auto" ? (opts.length > 5 ? "dropdown" : "buttons") : app;
          if (kind === "dropdown") {
            return simple(
              <select id={id} {...aria} disabled={ro} value={String(v ?? "")} onChange={(e) => set(f.id, e.target.value)}>
                <option value="">Choose…</option>
                {opts.map((o) => <option key={o}>{o}</option>)}
              </select>,
            );
          }
          if (kind === "radio") {
            return fieldset(opts.map((o) => (
              <label className="check" key={o}><input type="radio" name={id} disabled={ro} checked={v === o} onChange={() => set(f.id, o)} />{o}</label>
            )));
          }
          return fieldset(
            <div className="choice-row">
              {opts.map((o) => <button type="button" key={o} className="choice" disabled={ro} aria-pressed={v === o} onClick={() => set(f.id, v === o ? "" : o)}>{o}</button>)}
            </div>,
          );
        }

        case "multi_choice": {
          const cur = Array.isArray(v) ? (v as string[]) : [];
          const opts = f.choices ?? [];
          const toggle = (o: string) => set(f.id, cur.includes(o) ? cur.filter((x) => x !== o) : [...cur, o]);
          if (app === "dropdown") {
            return simple(
              <select id={id} {...aria} multiple size={Math.min(6, Math.max(3, opts.length))} disabled={ro} value={cur}
                onChange={(e) => set(f.id, Array.from(e.target.selectedOptions).map((o) => o.value))}>
                {opts.map((o) => <option key={o}>{o}</option>)}
              </select>,
            );
          }
          if (app === "chips") {
            return fieldset(<div className="choice-row">{opts.map((o) => <button type="button" key={o} className="choice" disabled={ro} aria-pressed={cur.includes(o)} onClick={() => toggle(o)}>{o}</button>)}</div>);
          }
          return fieldset(opts.map((o) => (
            <label className="check" key={o}><input type="checkbox" disabled={ro} checked={cur.includes(o)} onChange={() => toggle(o)} />{o}</label>
          )));
        }

        case "boolean": {
          const yes = f.true_label || "Yes", no = f.false_label || "No";
          if (app === "checkbox") {
            return (
              <div className="field" key={key}>
                <label className="check"><input id={id} {...aria} type="checkbox" disabled={ro} checked={v === true} onChange={(e) => set(f.id, e.target.checked)} />{label}</label>
                {hint}{msg}
              </div>
            );
          }
          if (app === "yes_no_buttons") {
            return fieldset(
              <div className="choice-row">
                <button type="button" className="choice" disabled={ro} aria-pressed={v === true} onClick={() => set(f.id, v === true ? "" : true)}>{yes}</button>
                <button type="button" className="choice" disabled={ro} aria-pressed={v === false} onClick={() => set(f.id, v === false ? "" : false)}>{no}</button>
              </div>,
            );
          }
          return (
            <div className="field" key={key}>
              <div className="switch-row">
                <span id={`${id}-lbl`}>{label}</span>
                <button id={id} type="button" role="switch" className="switch" aria-checked={v === true} aria-labelledby={`${id}-lbl`} aria-describedby={describedBy} disabled={ro}
                  onClick={() => set(f.id, v !== true)}><span className="switch-knob" /></button>
                <span className="switch-state" aria-hidden="true">{v === true ? yes : no}</span>
              </div>
              {hint}{msg}
            </div>
          );
        }

        case "ranking": {
          const opts = f.choices ?? [];
          const ranked = Array.isArray(v) && v.length === opts.length ? (v as string[]) : null;
          const list = ranked ?? opts;
          const shift = (i: number, d: -1 | 1) => { const n = [...list]; const j = i + d; if (j < 0 || j >= n.length) return; [n[i], n[j]] = [n[j], n[i]]; set(f.id, n); };
          return fieldset(
            <>
              <ol className="ranking">
                {list.map((o, i) => (
                  <li key={o}>
                    <span className="rank-n">{i + 1}</span><span className="grow">{o}</span>
                    <Button small disabled={ro || i === 0} aria-label={`Move ${o} up`} onClick={() => shift(i, -1)}>↑</Button>
                    <Button small disabled={ro || i === list.length - 1} aria-label={`Move ${o} down`} onClick={() => shift(i, 1)}>↓</Button>
                  </li>
                ))}
              </ol>
              {!ranked && !ro && <Button small onClick={() => set(f.id, [...opts])}>Keep this order</Button>}
            </>,
          );
        }

        case "photo": case "audio": case "video": case "file": case "signature": {
          const ids = Array.isArray(v) ? (v as string[]) : [];
          const ctx: MediaCtx = { value: ids, set: (n) => set(f.id, n), key };
          return (
            <div className="field" key={key} role="group" aria-labelledby={`${id}-lbl`}>
              <span id={`${id}-lbl`}>{label}</span>{hint}
              {renderMedia ? renderMedia(f, ctx) : <span className="field-hint">{spec.label} is added from the mobile collector.</span>}
              {msg}
            </div>
          );
        }

        case "note": {
          if (!f.text) return null;
          const cls = `note note-${app}`;
          return app === "heading"
            ? <h3 className={cls} key={key}>{f.text}</h3>
            : <p className={cls} key={key} style={{ whiteSpace: "pre-wrap" }}>{f.text}</p>;
        }

        case "calculation": {
          if (app === "hidden") return null;
          return (
            <div className="field" key={key}>
              <span id={`${id}-lbl`}>{f.label}</span>{hint}
              <output className="calc" aria-labelledby={`${id}-lbl`}>{v === undefined || v === "" ? "–" : String(v)}{f.unit ? ` ${f.unit}` : ""}</output>
            </div>
          );
        }

        case "group": {
          const inner = <div className="stack">{level(f.children ?? [], vals, setVals, prefix)}</div>;
          if (app === "collapsible") {
            return <details className="group" key={key} open><summary>{f.label}</summary>{f.hint && <span className="field-hint">{f.hint}</span>}{inner}</details>;
          }
          return <section className="group" key={key} aria-label={f.label}><h3>{f.label}</h3>{f.hint && <span className="field-hint">{f.hint}</span>}{inner}</section>;
        }

        case "repeat": {
          const rows = Array.isArray(v) ? (v as Props[]) : [];
          const setRows = (n: Props[]) => set(f.id, n);
          const full = f.max_items !== undefined && rows.length >= f.max_items;
          return (
            <section className={`repeat${app === "table" ? " repeat-compact" : ""}`} key={key} aria-label={f.label}>
              <h3>{label}</h3>{hint}
              {rows.map((row, i) => (
                <fieldset className="repeat-row" key={i} style={OPEN_FIELDSET}>
                  <legend>{f.label} {i + 1}</legend>
                  <div className={app === "table" ? "repeat-cells" : "stack"}>
                    {level(f.children ?? [], row, (n) => setRows(rows.map((r, j) => (j === i ? n : r))), `${f.id}.${i}.`)}
                  </div>
                  <Button small variant="danger" disabled={ro} onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove {f.label.toLowerCase()} {i + 1}</Button>
                </fieldset>
              ))}
              {rows.length === 0 && <span className="field-hint">None added yet.</span>}
              <Button small disabled={ro || full} onClick={() => setRows([...rows, newRow(f)])}>Add {f.label.toLowerCase()}</Button>
              {msg}
            </section>
          );
        }
      }
    });
  }

  if (!paged) return <div className="stack">{level(form.fields, values, emit, "")}</div>;
  const cur = pages[pageIndex];
  return (
    <div className="stack">
      <p className="page-step" aria-live="polite">Page {pageIndex + 1} of {pages.length}{cur?.title ? ` · ${cur.title}` : ""}</p>
      {cur && level(cur.items, values, emit, "")}
      <div className="row">
        <Button disabled={pageIndex === 0} onClick={() => setPage(pageIndex - 1)}>Back</Button>
        <span className="grow" />
        <Button variant="primary" disabled={pageIndex >= pages.length - 1} onClick={() => setPage(pageIndex + 1)}>Next</Button>
      </div>
    </div>
  );
}

/** Reads a barcode or QR code from a photo, where the browser supports BarcodeDetector. Typing always works. */
function ScanButton({ onCode, disabled, label }: { onCode: (code: string) => void; disabled?: boolean; label: string }) {
  const [note, setNote] = useState("");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Detector = typeof window !== "undefined" ? (window as any).BarcodeDetector : undefined;
  if (!Detector) return null;
  async function read(file: File | undefined) {
    if (!file) return;
    try {
      const found = await new Detector().detect(await createImageBitmap(file));
      if (found[0]?.rawValue) { onCode(String(found[0].rawValue)); setNote(""); } else setNote("No code found. Try again or type it.");
    } catch { setNote("Could not read the code. Type it instead."); }
  }
  return (
    <>
      <label className="btn btn-sm" aria-disabled={disabled}>Scan
        <input className="sr-only" type="file" accept="image/*" capture="environment" disabled={disabled} aria-label={`Scan a code for ${label}`}
          onChange={(e) => { void read(e.target.files?.[0]); e.target.value = ""; }} />
      </label>
      {note && <span className="field-hint" role="status">{note}</span>}
    </>
  );
}
