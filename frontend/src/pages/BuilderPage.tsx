import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import FormRenderer from "../components/FormRenderer";
import { Button, ErrorState, Loading, useToast } from "../components/ui";
import { loadApi } from "../lib/api";
import { FIELD_TYPE_LABEL, slugifyFieldId } from "../lib/forms";
import { useAsync } from "../lib/hooks";
import { GEOMETRY_LABEL, type FieldType, type Form, type FormField } from "../lib/types";

const TYPES = Object.keys(FIELD_TYPE_LABEL) as FieldType[];

export default function BuilderPage() {
  const { projectId = "", formId = "" } = useParams();
  const toast = useToast();
  const { data, error, loading, reload } = useAsync((api) => api.getForm(formId), [formId]);
  const [form, setForm] = useState<Form | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "publish" | null>(null);
  const [preview, setPreview] = useState(false);
  const [previewVal, setPreviewVal] = useState({});

  useEffect(() => { if (data) setForm(data); }, [data]);
  if (loading) return <Loading label="Loading form…" />;
  if (error != null || !form) return <div className="container"><ErrorState error={error ?? "Form not found."} onRetry={reload} /></div>;

  const field = form.fields.find((f) => f.id === sel) ?? null;
  const update = (patch: Partial<Form>) => setForm({ ...form, ...patch });
  const patchField = (id: string, patch: Partial<FormField>) => update({ fields: form.fields.map((f) => (f.id === id ? { ...f, ...patch } : f)) });

  function add(type: FieldType) {
    const label = `New ${FIELD_TYPE_LABEL[type].toLowerCase()} field`;
    const f: FormField = {
      id: slugifyFieldId(label, form!.fields), label, type,
      ...(type === "choice" || type === "multi_choice" ? { choices: ["Option 1", "Option 2"] } : {}),
      ...(type === "photo" ? { max_items: 3 } : {}),
    };
    update({ fields: [...form!.fields, f] });
    setSel(f.id);
  }
  function move(id: string, dir: -1 | 1) {
    const i = form!.fields.findIndex((f) => f.id === id);
    const j = i + dir;
    if (j < 0 || j >= form!.fields.length) return;
    const next = [...form!.fields];
    [next[i], next[j]] = [next[j], next[i]];
    update({ fields: next });
  }

  async function persist(publish: boolean) {
    setBusy(publish ? "publish" : "save");
    try {
      const api = await loadApi();
      let saved = await api.saveForm(form!);
      if (publish) saved = await api.publishForm(saved.id);
      setForm(saved);
      toast(publish ? `Published version ${saved.version}. Collectors get it on their next sync.` : "Draft saved.", "success");
    } catch (e) { toast(e instanceof Error ? e.message : "Could not save the form.", "error"); }
    finally { setBusy(null); }
  }

  return (
    <div className="builder" style={{ flex: 1 }}>
      <aside className="side left">
        <Link to={`/projects/${projectId}/forms`}>All forms</Link>
        <h2>Add a field</h2>
        {TYPES.map((t) => <Button key={t} onClick={() => add(t)} style={{ justifyContent: "flex-start" }}>{FIELD_TYPE_LABEL[t]}</Button>)}
      </aside>

      <section className="canvas" aria-label="Form preview">
        <div className="stack">
          <div className="row">
            <div className="field grow"><label htmlFor="form-name">Form name</label><input id="form-name" value={form.name} onChange={(e) => update({ name: e.target.value })} /></div>
            <span className="badge badge-ok">{GEOMETRY_LABEL[form.geometry_type]}</span>
          </div>
          <div className="row">
            <span className={`badge ${form.status === "published" ? "badge-ok" : "badge-warn"}`}>{form.status === "published" ? `Published v${form.version}` : "Draft"}</span>
            <span className="grow" />
            <Button small onClick={() => setPreview((v) => !v)}>{preview ? "Edit fields" : "Preview"}</Button>
          </div>
          {preview ? (
            <div className="card"><FormRenderer form={form} value={previewVal} onChange={setPreviewVal} renderPhoto={() => <span className="field-hint">Camera opens here on the phone.</span>} /></div>
          ) : form.fields.length === 0 ? (
            <div className="state"><strong>No fields yet</strong>Add a field from the left to start.</div>
          ) : (
            form.fields.map((f) => (
              <button key={f.id} className="field-card" aria-pressed={sel === f.id} onClick={() => setSel(f.id)}>
                <strong>{f.label}</strong>
                <small>{FIELD_TYPE_LABEL[f.type]}{f.required ? " · required" : ""}</small>
              </button>
            ))
          )}
        </div>
      </section>

      <aside className="side right">
        <h2>Field settings</h2>
        {field ? (
          <div className="stack">
            <div className="field"><label htmlFor="fl">Label</label><input id="fl" value={field.label} onChange={(e) => patchField(field.id, { label: e.target.value })} /></div>
            <label className="check"><input type="checkbox" checked={!!field.required} onChange={(e) => patchField(field.id, { required: e.target.checked })} />Required</label>
            {(field.type === "choice" || field.type === "multi_choice") && (
              <div className="field"><label htmlFor="fc">Choices, one per line</label>
                <textarea id="fc" value={(field.choices ?? []).join("\n")} onChange={(e) => patchField(field.id, { choices: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean) })} /></div>
            )}
            {field.type === "photo" && (
              <div className="field"><label htmlFor="fm">Maximum photos</label><input id="fm" type="number" min={1} max={10} value={field.max_items ?? 3} onChange={(e) => patchField(field.id, { max_items: Number(e.target.value) })} /></div>
            )}
            <div className="row">
              <Button small onClick={() => move(field.id, -1)}>Move up</Button>
              <Button small onClick={() => move(field.id, 1)}>Move down</Button>
              <Button small variant="danger" onClick={() => { update({ fields: form.fields.filter((f) => f.id !== field.id) }); setSel(null); }}>Remove</Button>
            </div>
            <span className="field-hint mono">id: {field.id}</span>
          </div>
        ) : <span className="field-hint">Select a field to change its label, choices or rules.</span>}
        <div className="row" style={{ marginTop: "auto" }}>
          <Button className="grow" busy={busy === "save"} disabled={!!busy} onClick={() => persist(false)}>Save draft</Button>
          <Button className="grow" variant="primary" busy={busy === "publish"} disabled={!!busy} onClick={() => persist(true)}>Publish</Button>
        </div>
      </aside>
    </div>
  );
}
