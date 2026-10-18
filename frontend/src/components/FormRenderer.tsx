import type { ReactNode } from "react";
import type { Form, FormField, Props } from "../lib/types";

interface Props_ {
  form: Form;
  value: Props;
  onChange: (next: Props) => void;
  errors?: Record<string, string>;
  /** Photo fields are rendered by the host (the collector captures; the editor only shows a note). */
  renderPhoto?: (field: FormField) => ReactNode;
}

export default function FormRenderer({ form, value, onChange, errors = {}, renderPhoto }: Props_) {
  const set = (id: string, v: unknown) => onChange({ ...value, [id]: v });
  return (
    <div className="stack">
      {form.fields.map((f) => {
        const err = errors[f.id];
        const id = `field-${form.id}-${f.id}`;
        const label = <>{f.label}{f.required && <span aria-hidden="true"> *</span>}</>;
        const msg = err && <span className="field-error" id={`${id}-err`} role="alert">{err}</span>;
        const aria = { "aria-invalid": err ? true : undefined, "aria-describedby": err ? `${id}-err` : undefined } as const;

        if (f.type === "text" || f.type === "number" || f.type === "date") {
          return (
            <div className="field" key={f.id}>
              <label htmlFor={id}>{label}</label>
              <input id={id} {...aria} type={f.type === "text" ? "text" : f.type} inputMode={f.type === "number" ? "decimal" : undefined}
                value={String(value[f.id] ?? "")} onChange={(e) => set(f.id, f.type === "number" && e.target.value !== "" ? Number(e.target.value) : e.target.value)} />
              {msg}
            </div>
          );
        }
        if (f.type === "choice") {
          const opts = f.choices ?? [];
          if (opts.length > 5) {
            return (
              <div className="field" key={f.id}>
                <label htmlFor={id}>{label}</label>
                <select id={id} {...aria} value={String(value[f.id] ?? "")} onChange={(e) => set(f.id, e.target.value)}>
                  <option value="">Choose…</option>
                  {opts.map((o) => <option key={o}>{o}</option>)}
                </select>
                {msg}
              </div>
            );
          }
          return (
            <fieldset className="field" key={f.id} style={{ border: 0, padding: 0, margin: 0 }}>
              <legend style={{ padding: 0, marginBottom: 4 }}>{label}</legend>
              <div className="choice-row">
                {opts.map((o) => (
                  <button type="button" key={o} className="choice" aria-pressed={value[f.id] === o} onClick={() => set(f.id, value[f.id] === o ? "" : o)}>{o}</button>
                ))}
              </div>
              {msg}
            </fieldset>
          );
        }
        if (f.type === "multi_choice") {
          const cur = Array.isArray(value[f.id]) ? (value[f.id] as string[]) : [];
          return (
            <fieldset className="field" key={f.id} style={{ border: 0, padding: 0, margin: 0 }}>
              <legend style={{ padding: 0, marginBottom: 4 }}>{label}</legend>
              {(f.choices ?? []).map((o) => (
                <label className="check" key={o}>
                  <input type="checkbox" checked={cur.includes(o)} onChange={(e) => set(f.id, e.target.checked ? [...cur, o] : cur.filter((x) => x !== o))} />
                  {o}
                </label>
              ))}
              {msg}
            </fieldset>
          );
        }
        return (
          <div className="field" key={f.id}>
            <span>{label}</span>
            {renderPhoto ? renderPhoto(f) : <span className="field-hint">Photos are added from the mobile collector.</span>}
            {msg}
          </div>
        );
      })}
    </div>
  );
}
