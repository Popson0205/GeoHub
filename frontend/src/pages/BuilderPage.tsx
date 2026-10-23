import { useEffect, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import CalcEditor from "../components/CalcEditor";
import ConditionEditor from "../components/ConditionEditor";
import FormRenderer from "../components/FormRenderer";
import { Icon } from "../components/icons";
import { useFieldDnd } from "../components/useFieldDnd";
import { Button, ErrorState, Loading, useConfirm, useToast } from "../components/ui";
import { loadApi } from "../lib/api";
import {
  PALETTE, PALETTE_CATEGORIES, TYPE_SPECS, allFields, allows, findField, hasChoices, inRepeat, isContainer, mapField, moveInto, newField, topLevelFields,
  type PaletteItem, type Prop,
} from "../lib/fieldSpec";
import { checkFieldDefs } from "../lib/forms";
import { useAsync } from "../lib/hooks";
import { calcRefs, conditionRefs } from "../lib/logic";
import { GEOMETRY_LABEL, type Form, type FormField } from "../lib/types";

const toLocalInput = (iso: unknown): string => {
  if (typeof iso !== "string" || !iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const optNum = (s: string): number | undefined => (s === "" ? undefined : Number(s));

export default function BuilderPage() {
  const { projectId = "", formId = "" } = useParams();
  const toast = useToast();
  const confirm = useConfirm();
  const { data, error, loading, reload } = useAsync((api) => api.getForm(formId), [formId]);
  const [form, setForm] = useState<Form | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "publish" | null>(null);
  const [preview, setPreview] = useState(false);
  const [previewVal, setPreviewVal] = useState({});

  useEffect(() => { if (data) setForm(data); }, [data]);
  const dnd = useFieldDnd({ fields: form?.fields ?? [], enabled: !preview, onChange: (fields) => setForm((f) => (f ? { ...f, fields } : f)), onSelect: setSel });
  if (loading) return <Loading label="Loading form…" />;
  if (error != null || !form) return <div className="container"><ErrorState error={error ?? "Form not found."} onRetry={reload} /></div>;

  const field = sel ? findField(form.fields, sel) : null;
  const issues = checkFieldDefs(form.fields);
  const issueCount = Object.keys(issues).length;
  const update = (patch: Partial<Form>) => setForm({ ...form, ...patch });
  const setFields = (fields: FormField[]) => update({ fields });
  const patchField = (id: string, patch: Partial<FormField>) =>
    setFields(mapField(form.fields, id, (f) => {
      const n = { ...f, ...patch } as Record<string, unknown>;
      for (const k of Object.keys(patch)) if ((patch as Record<string, unknown>)[k] === undefined) delete n[k];
      return n as unknown as FormField;
    }));

  function add(item: PaletteItem) {
    const f = newField(item, form!.fields);
    const into = field && isContainer(field.type) && !(f.type === "repeat" && (field.type === "repeat" || inRepeat(form!.fields, field.id))) ? field : null;
    setFields(into ? mapField(form!.fields, into.id, (p) => ({ ...p, children: [...(p.children ?? []), f] })) : [...form!.fields, f]);
    setSel(f.id);
  }
  async function remove(id: string) {
    const target = findField(form!.fields, id);
    const ids = new Set(allFields(target?.children ?? []).map((c) => c.id).concat(id));
    const uses = (f: FormField) => [...(f.visible ? conditionRefs(f.visible) : []), ...(f.required_if ? conditionRefs(f.required_if) : []), ...(f.calc ? calcRefs(f.calc) : [])].some((r) => ids.has(r));
    const users = allFields(form!.fields).filter((f) => !ids.has(f.id) && uses(f));
    if (users.length && !(await confirm({ title: "Remove this field?", message: `${users.map((u) => u.label).join(", ")} use${users.length === 1 ? "s" : ""} this field in a rule. Removing it breaks that rule.`, confirmLabel: "Remove anyway", danger: true }))) return;
    setFields(mapField(form!.fields, id, () => null));
    setSel(null);
  }

  async function persist(publish: boolean) {
    if (issueCount) { toast("Fix the marked fields first.", "error"); return; }
    setBusy(publish ? "publish" : "save");
    try {
      const api = await loadApi();
      let saved = await api.saveForm(form!);
      if (publish) saved = await api.publishForm(saved.id);
      setForm(saved);
      toast(publish ? `Published version ${saved.version}. Open “Share and collect” to get the link.` : "Draft saved.", "success");
    } catch (e) { toast(e instanceof Error ? e.message : "Could not save the form.", "error"); }
    finally { setBusy(null); }
  }

  // ---- the field list ----
  const tree = (fields: FormField[], depth: number): ReactNode =>
    fields.map((f) => {
      const spec = TYPE_SPECS[f.type];
      const bad = issues[f.id];
      return (
        <div key={f.id} ref={dnd.blockRef(f.id)} style={{ marginLeft: depth ? 16 : 0 }} className={`${depth ? "tree-child" : ""}${dnd.moving === f.id ? " is-moving" : ""}`.trim() || undefined}>
          <div className="field-row">
            <button type="button" className="drag-handle" aria-label={`Reorder ${f.label || "field"}`} aria-describedby="dnd-help" title="Drag to reorder" {...dnd.handleProps(f)}><Icon name="grip" size={18} /></button>
            <button ref={dnd.cardRef(f.id)} className="field-card" aria-pressed={sel === f.id} onClick={() => setSel(f.id)} aria-describedby={bad ? `bad-${f.id}` : undefined} {...dnd.cardProps(f)}>
              <strong>{f.label || "(no label)"}</strong>
              <small>
                {spec.label}
                {f.appearance && f.appearance !== spec.appearances[0] ? ` · ${f.appearance.replace(/_/g, " ")}` : ""}
                {f.required || f.must_be_true ? " · required" : f.required_if ? " · sometimes required" : ""}
                {f.visible ? " · conditional" : ""}
                {f.type === "calculation" ? " · calculated" : ""}
                {f.readonly ? " · read-only" : ""}
              </small>
              {bad && <small id={`bad-${f.id}`} className="field-error">{bad[0]}</small>}
            </button>
          </div>
          {f.children && (f.children.length > 0
            ? <div className="tree-kids" ref={dnd.kidsRef(f.id)}>{tree(f.children, depth + 1)}</div>
            : <div className="tree-kids field-hint" ref={dnd.kidsRef(f.id)} style={{ marginLeft: 16 }}>Empty. Drag a field in here, or select this {spec.label.toLowerCase()} and add one.</div>)}
        </div>
      );
    });

  return (
    <div className="builder" style={{ flex: 1 }}>
      <h1 className="sr-only">Form builder</h1>
      <aside className="side left" aria-label="Add a field">
        <Link to={`/collect/${projectId}/forms`}>All forms</Link>
        <h2>Add a field</h2>
        {field && isContainer(field.type) && <span className="field-hint">New fields go inside “{field.label}”.</span>}
        {PALETTE_CATEGORIES.map((cat) => (
          <div key={cat} className="palette-group" role="group" aria-label={cat}>
            <h3 className="palette-h">{cat}</h3>
            {PALETTE.filter((p) => p.category === cat).map((p) => (
              <Button key={p.key} small onClick={() => add(p)} className="palette-item" style={{ justifyContent: "flex-start" }} {...dnd.paletteProps(p)}>{p.label}</Button>
            ))}
          </div>
        ))}
        <span className="field-hint">Click a field type to add it, or drag it onto the form.</span>
        <span className="field-hint">The point, line or area is drawn on the map, so the form only asks for the details.</span>
      </aside>

      <section className="canvas" aria-label="Form preview">
        <div className="stack dnd-wrap" ref={dnd.wrapRef}>
          <p id="dnd-help" className="sr-only">Press Space to pick this field up, use the up and down arrow keys to move it, press Space to drop it, or Escape to cancel.</p>
          <div className="row">
            <div className="field grow"><label htmlFor="form-name">Form name</label><input id="form-name" value={form.name} onChange={(e) => update({ name: e.target.value })} /></div>
            <span className="badge badge-ok">{GEOMETRY_LABEL[form.geometry_type]}</span>
          </div>
          <div className="row">
            <span className={`badge ${form.status === "published" ? "badge-ok" : "badge-warn"}`}>{form.status === "published" ? `Published v${form.version}` : "Draft"}</span>
            {issueCount > 0 && <span className="badge badge-bad">{issueCount} field{issueCount === 1 ? "" : "s"} to fix</span>}
            <span className="grow" />
            <Button small onClick={() => setPreview((v) => !v)}>{preview ? "Edit fields" : "Preview"}</Button>
          </div>
          {preview ? (
            <div className="card"><FormRenderer form={form} value={previewVal} onChange={setPreviewVal} renderMedia={(f) => <span className="field-hint">{TYPE_SPECS[f.type].label} capture opens here on the phone.</span>} /></div>
          ) : form.fields.length === 0 ? (
            <div className={`state${dnd.overEmpty ? " drop-ready" : ""}`}><strong>No fields yet</strong>Click a field type on the left, or drag one here.</div>
          ) : tree(form.fields, 0)}
          {!preview && form.fields.length > 1 && <span className="field-hint">Drag a field by its grip to reorder it, or into a group. With the keyboard: Tab to the grip, Space to pick up, arrow keys to move, Space to drop.</span>}
          {dnd.overlay}
        </div>
      </section>

      <aside className="side right" aria-label="Field settings">
        <h2>Field settings</h2>
        {field ? (
          <Settings key={field.id} form={form} field={field} issues={issues[field.id]} patch={(p) => patchField(field.id, p)}
            moveTo={(into) => setFields(moveInto(form.fields, field.id, into))} remove={() => remove(field.id)} />
        ) : <span className="field-hint">Select a field to change its label, choices or rules.</span>}
        <div className="row" style={{ marginTop: "auto" }}>
          <Button className="grow" busy={busy === "save"} disabled={!!busy} onClick={() => persist(false)}>Save draft</Button>
          <Button className="grow" variant="primary" busy={busy === "publish"} disabled={!!busy} onClick={() => persist(true)}>Publish</Button>
        </div>
        {form.status === "published" && <Link className="btn" to={`/collect/${form.project_id}/forms/${form.id}/share`}>Share and collect</Link>}
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
function Section({ title, children }: { title: string; children: ReactNode }) {
  return <fieldset className="settings-group" style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}><legend>{title}</legend><div className="stack">{children}</div></fieldset>;
}
function Text({ id, label, value, onChange, area, hint }: { id: string; label: string; value: string | undefined; onChange: (v: string | undefined) => void; area?: boolean; hint?: string }) {
  return (
    <div className="field"><label htmlFor={id}>{label}</label>
      {area ? <textarea id={id} value={value ?? ""} onChange={(e) => onChange(e.target.value || undefined)} /> : <input id={id} value={value ?? ""} onChange={(e) => onChange(e.target.value || undefined)} />}
      {hint && <span className="field-hint">{hint}</span>}
    </div>
  );
}
function Num({ id, label, value, onChange, min, max }: { id: string; label: string; value: number | undefined; onChange: (v: number | undefined) => void; min?: number; max?: number }) {
  return <div className="field"><label htmlFor={id}>{label}</label><input id={id} type="number" min={min} max={max} value={value ?? ""} onChange={(e) => onChange(optNum(e.target.value))} /></div>;
}
function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return <label className="check"><input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />{label}</label>;
}

/** One input per option. Blank rows stay on screen while typing but are not saved, so Enter / "Add option" always gives a new row. */
function ChoicesEditor({ choices, onChange }: { choices: string[]; onChange: (c: string[]) => void }) {
  const [rows, setRows] = useState<string[]>(choices.length ? choices : [""]);
  const [focus, setFocus] = useState<number | null>(null);
  const commit = (next: string[]) => { setRows(next); onChange(next.map((r) => r.trim()).filter(Boolean)); };
  useEffect(() => {
    if (focus === null) return;
    document.getElementById(`s-ch-${focus}`)?.focus();
    setFocus(null);
  }, [focus]);
  const addAfter = (i: number) => { const n = [...rows]; n.splice(i + 1, 0, ""); setRows(n); setFocus(i + 1); };
  return (
    <div className="field">
      <span id="s-ch-label">Options</span>
      <div className="stack" role="group" aria-labelledby="s-ch-label" style={{ gap: 6 }}>
        {rows.map((r, i) => (
          <div key={i} style={{ display: "flex", gap: 6 }}>
            <input id={`s-ch-${i}`} value={r} aria-label={`Option ${i + 1}`} placeholder={`Option ${i + 1}`}
              onChange={(e) => commit(rows.map((x, j) => (j === i ? e.target.value : x)))}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addAfter(i); } }} />
            <Button small type="button" aria-label={`Remove option ${i + 1}`} disabled={rows.length === 1 && !r}
              onClick={() => { const n = rows.filter((_, j) => j !== i); commit(n.length ? n : [""]); }}><Icon name="close" size={16} /></Button>
          </div>
        ))}
      </div>
      <div><Button small type="button" onClick={() => addAfter(rows.length - 1)}>+ Add option</Button></div>
      <span className="field-hint">Changing an option's wording after publishing does not change answers already collected.</span>
    </div>
  );
}

interface SettingsProps {
  form: Form; field: FormField; issues?: string[];
  patch: (p: Partial<FormField>) => void; moveTo: (into: string | null) => void; remove: () => void;
}
function Settings({ form, field, issues, patch, moveTo, remove }: SettingsProps) {
  const t = field.type;
  const spec = TYPE_SPECS[t];
  const has = (p: Prop) => allows(t, p);
  const outer = form.fields;
  // Rules can look at answers on the same level, plus the form's top-level answers. Notes and groups hold no answer.
  const inside = outer.find((r) => r.type === "repeat" && allFields(r.children ?? []).some((c) => c.id === field.id));
  const candidates = [...topLevelFields(outer), ...(inside ? topLevelFields(inside.children ?? []) : [])]
    .filter((c) => c.id !== field.id && TYPE_SPECS[c.type].stores !== "none" && !(c.id === inside?.id));
  const containers = allFields(outer).filter((c) => isContainer(c.type) && c.id !== field.id && !allFields(field.children ?? []).some((k) => k.id === c.id));
  const dateInput = t === "date" ? "date" : t === "time" ? "time" : "datetime-local";
  const bound = (k: "min" | "max", label: string) => {
    const v = field[k];
    const setBound = (x: number | string | undefined) => patch(k === "min" ? { min: x } : { max: x });
    if (t === "number") return <Num id={`s-${k}`} label={label} value={typeof v === "number" ? v : undefined} onChange={setBound} />;
    return (
      <div className="field"><label htmlFor={`s-${k}`}>{label}</label>
        <input id={`s-${k}`} type={dateInput} value={t === "datetime" ? toLocalInput(v) : typeof v === "string" ? v : ""}
          onChange={(e) => setBound(e.target.value ? (t === "datetime" ? new Date(e.target.value).toISOString() : e.target.value) : undefined)} />
      </div>
    );
  };

  return (
    <div className="stack">
      <Section title="Basics">
        <Text id="s-label" label="Label" value={field.label} onChange={(v) => patch({ label: v ?? "" })} />
        {has("hint") && <Text id="s-hint" label="Help text (optional)" value={field.hint} onChange={(v) => patch({ hint: v })} />}
        {has("placeholder") && <Text id="s-ph" label="Placeholder (optional)" value={field.placeholder} onChange={(v) => patch({ placeholder: v })} />}
        {spec.appearances.length > 1 && (
          <div className="field"><label htmlFor="s-app">Appearance</label>
            <select id="s-app" value={field.appearance ?? spec.appearances[0]} onChange={(e) => patch({ appearance: e.target.value === spec.appearances[0] ? undefined : e.target.value })}>
              {spec.appearances.map((a) => <option key={a} value={a}>{a.replace(/_/g, " ")}</option>)}
            </select>
          </div>
        )}
        {has("text") && <Text id="s-text" label="Note text" area value={field.text} onChange={(v) => patch({ text: v ?? "" })} />}
      </Section>

      {hasChoices(t) && (
        <Section title="Choices">
          <ChoicesEditor choices={field.choices ?? []} onChange={(c) => patch({ choices: c })} />
        </Section>
      )}

      {t === "number" && (
        <Section title="Number">
          <Check label="Whole numbers only" checked={!!field.integer} onChange={(v) => patch({ integer: v || undefined, decimals: v ? undefined : field.decimals })} />
          {!field.integer && <Num id="s-dec" label="Decimal places" min={0} max={10} value={field.decimals} onChange={(v) => patch({ decimals: v })} />}
          <Text id="s-unit" label="Unit (optional)" value={field.unit} onChange={(v) => patch({ unit: v })} />
        </Section>
      )}
      {t === "boolean" && (
        <Section title="Yes / No">
          <Text id="s-yes" label="Label for yes" value={field.true_label} onChange={(v) => patch({ true_label: v })} />
          <Text id="s-no" label="Label for no" value={field.false_label} onChange={(v) => patch({ false_label: v })} />
          <Check label="Must be yes to submit (an acknowledgement)" checked={!!field.must_be_true} onChange={(v) => patch({ must_be_true: v || undefined, required: v ? true : field.required })} />
        </Section>
      )}
      {t === "calculation" && (
        <Section title="Calculation">
          <CalcEditor idBase="s-calc" value={field.calc} onChange={(c) => patch({ calc: c })} candidates={candidates.filter((c) => c.type !== "calculation" || c.id !== field.id)} />
          <Num id="s-cdec" label="Decimal places" min={0} max={10} value={field.decimals} onChange={(v) => patch({ decimals: v })} />
          <Text id="s-cunit" label="Unit (optional)" value={field.unit} onChange={(v) => patch({ unit: v })} />
          <Check label="Save the result with the feature" checked={field.store !== false} onChange={(v) => patch({ store: v ? undefined : false })} />
        </Section>
      )}

      {(has("min") || has("min_length") || has("min_items") || has("pattern")) && (
        <Section title="Limits">
          {has("min") && bound("min", t === "number" ? "Smallest value" : "Earliest")}
          {has("max") && bound("max", t === "number" ? "Largest value" : "Latest")}
          {has("min_length") && <Num id="s-minl" label="Fewest characters" min={0} value={field.min_length} onChange={(v) => patch({ min_length: v })} />}
          {has("max_length") && <Num id="s-maxl" label="Most characters" min={1} max={5000} value={field.max_length} onChange={(v) => patch({ max_length: v })} />}
          {has("min_items") && <Num id="s-mini" label={t === "repeat" ? "Fewest entries" : t === "multi_choice" ? "Fewest choices" : "Fewest files"} min={0} value={field.min_items} onChange={(v) => patch({ min_items: v })} />}
          {has("max_items") && <Num id="s-maxi" label={t === "repeat" ? "Most entries" : t === "multi_choice" ? "Most choices" : "Most files"} min={1} max={50} value={field.max_items} onChange={(v) => patch({ max_items: v })} />}
          {has("pattern") && <Text id="s-pat" label="Required format (pattern)" value={field.pattern} onChange={(v) => patch({ pattern: v })} hint="A regular expression, for example ^[A-Z]{2}-\d{4}$" />}
          {has("pattern_message") && field.pattern && <Text id="s-patm" label="Message when it does not match" value={field.pattern_message} onChange={(v) => patch({ pattern_message: v })} />}
        </Section>
      )}

      {(has("required") || has("readonly") || has("default")) && (
        <Section title="Answering">
          {has("required") && !field.must_be_true && <Check label="Required" checked={!!field.required} onChange={(v) => patch({ required: v || undefined })} />}
          {has("required_if") && !field.required && !field.must_be_true && (
            <ConditionEditor idBase="s-reqif" title="Required only when" value={field.required_if} onChange={(c) => patch({ required_if: c })} candidates={candidates} />
          )}
          {has("readonly") && <Check label="Read-only (shown, not editable)" checked={!!field.readonly} onChange={(v) => patch({ readonly: v || undefined })} />}
          {has("default") && <DefaultEditor field={field} onChange={(v) => patch({ default: v })} />}
        </Section>
      )}

      {has("visible") && (
        <Section title="Visibility">
          <ConditionEditor idBase="s-vis" title="Show this only when" value={field.visible} onChange={(c) => patch({ visible: c })} candidates={candidates} />
        </Section>
      )}

      {issues?.map((m) => <span className="field-error" role="alert" key={m}>{m}</span>)}

      <Section title="Arrange">
        <span className="field-hint">Drag this field by its grip in the list to change its position.</span>
        {(containers.length > 0 || inside || allFields(outer).some((c) => c.children?.some((k) => k.id === field.id))) && (
          <div className="field"><label htmlFor="s-move">Put inside</label>
            <select id="s-move" value="" onChange={(e) => { if (e.target.value !== "") moveTo(e.target.value === "__top" ? null : e.target.value); }}>
              <option value="">Choose…</option>
              <option value="__top">Top level of the form</option>
              {containers.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </div>
        )}
        <Button small variant="danger" onClick={remove}>Remove</Button>
      </Section>
      <span className="field-hint mono">id: {field.id}</span>
    </div>
  );
}

function DefaultEditor({ field, onChange }: { field: FormField; onChange: (v: FormField["default"]) => void }) {
  const t = field.type, d = field.default;
  if (t === "date" || t === "datetime") return <Check label="Start with today's date" checked={d === "$today"} onChange={(v) => onChange(v ? "$today" : undefined)} />;
  if (t === "time") return <Check label="Start with the current time" checked={d === "$now"} onChange={(v) => onChange(v ? "$now" : undefined)} />;
  if (t === "boolean") {
    return (
      <div className="field"><label htmlFor="s-def">Starting answer</label>
        <select id="s-def" value={d === true ? "yes" : d === false ? "no" : ""} onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value === "yes")}>
          <option value="">None</option><option value="yes">Yes</option><option value="no">No</option>
        </select>
      </div>
    );
  }
  if (t === "choice") {
    return (
      <div className="field"><label htmlFor="s-def">Starting answer</label>
        <select id="s-def" value={typeof d === "string" ? d : ""} onChange={(e) => onChange(e.target.value || undefined)}>
          <option value="">None</option>{(field.choices ?? []).map((c) => <option key={c}>{c}</option>)}
        </select>
      </div>
    );
  }
  if (t === "multi_choice") {
    const cur = Array.isArray(d) ? d : [];
    return (
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}><legend>Starting answers</legend>
        {(field.choices ?? []).map((c) => <Check key={c} label={c} checked={cur.includes(c)} onChange={(v) => { const n = v ? [...cur, c] : cur.filter((x) => x !== c); onChange(n.length ? n : undefined); }} />)}
      </fieldset>
    );
  }
  if (t === "number") return <Num id="s-def" label="Starting value" value={typeof d === "number" ? d : undefined} onChange={(v) => onChange(v)} />;
  return <Text id="s-def" label="Starting text" value={typeof d === "string" ? d : undefined} onChange={(v) => onChange(v)} />;
}
