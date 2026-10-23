import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import FormRenderer from "../components/FormRenderer";
import { Button, EmptyState, ErrorState, Loading, useConfirm, useToast } from "../components/ui";
import { ApiError, loadApi } from "../lib/api";
import { csvEscape, download } from "../lib/csv";
import { columnFields } from "../lib/fieldSpec";
import { pruneProperties, validateProperties } from "../lib/forms";
import { useAsync } from "../lib/hooks";
import type { Feature, FeatureStatus, Form, Props } from "../lib/types";
import { PublishPanel } from "./ProjectsPage";

const STATUS: Record<FeatureStatus, { label: string; cls: string }> = {
  draft: { label: "Draft", cls: "badge" }, submitted: { label: "Waiting", cls: "badge badge-warn" },
  approved: { label: "Approved", cls: "badge badge-ok" }, rejected: { label: "Rejected", cls: "badge badge-bad" },
};
const cell = (v: unknown): string => (v == null ? "" : Array.isArray(v) ? v.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join("; ") : typeof v === "object" ? JSON.stringify(v) : String(v));
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "data";

/** Everything collected for a project: check it, clean it, download it and send it to the data hub. */
export default function DataPage() {
  const { projectId = "" } = useParams();
  const toast = useToast();
  const confirm = useConfirm();
  const project = useAsync((api) => api.getProject(projectId), [projectId]);
  const forms = useAsync((api) => api.listForms(projectId), [projectId]);
  const feats = useAsync((api) => api.listFeatures(projectId), [projectId]);
  const [formId, setFormId] = useState("");
  const [filter, setFilter] = useState<"all" | FeatureStatus>("all");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<Feature | null>(null);
  const [draft, setDraft] = useState<Props>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);

  const list = forms.data ?? [];
  useEffect(() => { if (!formId && list.length) setFormId((list.find((f) => f.version > 0) ?? list[0]).id); }, [list.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const form: Form | undefined = list.find((f) => f.id === formId);
  const canManage = project.data?.role === "owner" || project.data?.role === "admin";
  const cols = useMemo(() => (form ? columnFields(form.fields) : []), [form]);
  const all = useMemo(() => (feats.data ?? []).filter((f) => f.form_id === formId), [feats.data, formId]);
  const rows = useMemo(() => all.filter((f) => filter === "all" || f.status === filter), [all, filter]);
  const counts = useMemo(() => { const c: Record<string, number> = {}; for (const f of all) c[f.status] = (c[f.status] ?? 0) + 1; return c; }, [all]);
  const target = picked.size ? rows.filter((r) => picked.has(r.id)) : rows;

  if (project.loading || forms.loading || feats.loading) return <div className="container"><Loading /></div>;
  const err = project.error ?? forms.error ?? feats.error;
  if (err != null) return <div className="container"><ErrorState error={err} onRetry={() => { void project.reload(); void forms.reload(); void feats.reload(); }} /></div>;

  const patchLocal = (u: Feature) => feats.setData((feats.data ?? []).map((f) => (f.id === u.id ? u : f)));
  const toggle = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  function startEdit(f: Feature) { setEditing(f); setDraft({ ...f.properties }); setErrors({}); }
  async function save() {
    if (!editing || !form) return;
    const pruned = pruneProperties(form, draft);
    const errs = validateProperties(form, pruned);
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setSaving(true);
    try {
      patchLocal(await (await loadApi()).updateFeature(editing.id, { properties: pruned, base_version: editing.version }));
      toast("Saved.", "success"); setEditing(null);
    } catch (e) {
      if (e instanceof ApiError && e.fields) setErrors(e.fields);
      toast(e instanceof Error ? e.message : "Could not save.", "error");
      if (e instanceof ApiError && e.status === 409) { setEditing(null); void feats.reload(); }
    } finally { setSaving(false); }
  }
  async function review(ids: string[], decision: "approved" | "rejected") {
    try {
      const api = await loadApi();
      const done = await Promise.all(ids.map((id) => api.reviewFeature(id, decision)));
      const byId = new Map(done.map((d) => [d.id, d]));
      feats.setData((feats.data ?? []).map((f) => byId.get(f.id) ?? f));
      setPicked(new Set());
      toast(`${done.length} ${decision}.`, "success");
    } catch (e) { toast(e instanceof Error ? e.message : "Could not update.", "error"); void feats.reload(); }
  }
  async function remove(ids: string[]) {
    if (!(await confirm({ title: `Delete ${ids.length === 1 ? "this record" : `${ids.length} records`}?`, message: "They are removed from the project.", confirmLabel: "Delete", danger: true }))) return;
    try {
      const api = await loadApi();
      await Promise.all(ids.map((id) => api.deleteFeature(id)));
      feats.setData((feats.data ?? []).filter((f) => !ids.includes(f.id)));
      setPicked(new Set());
      toast("Deleted.", "success");
    } catch (e) { toast(e instanceof Error ? e.message : "Could not delete.", "error"); void feats.reload(); }
  }

  function exportCsv() {
    const head = ["id", "status", "longitude", "latitude", "geometry", ...cols.map((c) => c.id)];
    const lines = [head.join(",")];
    for (const r of target) {
      const g = r.geometry;
      const pt = g.type === "Point" ? g.coordinates : null;
      lines.push([r.id, r.status, pt?.[0] ?? "", pt?.[1] ?? "", pt ? "" : JSON.stringify(g), ...cols.map((c) => cell(r.properties[c.id]))].map(csvEscape).join(","));
    }
    download(`${slug(form?.name ?? "data")}.csv`, lines.join("\n"), "text/csv;charset=utf-8");
  }
  function exportGeoJson() {
    const fc = { type: "FeatureCollection", features: target.map((r) => ({ type: "Feature", id: r.id, geometry: r.geometry, properties: { status: r.status, ...r.properties } })) };
    download(`${slug(form?.name ?? "data")}.geojson`, JSON.stringify(fc, null, 2), "application/geo+json");
  }

  const shareLink = form && form.version > 0 ? `/collect/${projectId}/forms/${form.id}/share` : null;
  return (
    <div className="container" style={{ width: "100%" }}>
      <div className="page-head">
        <h1>Collected data</h1><span className="grow" />
        {shareLink && canManage && <Link className="btn" to={shareLink}>Share form</Link>}
        <Link className="btn" to="/collect">Back to projects</Link>
      </div>
      <p className="meta" style={{ marginTop: 0 }}>{project.data?.name}</p>

      {!list.length ? <EmptyState title="No forms yet" action={canManage ? <Link className="btn btn-primary" to={`/collect/${projectId}/forms`}>Create a form</Link> : undefined}>Collected data appears here once a form is published and shared.</EmptyState> : (
        <>
          <div className="row" style={{ flexWrap: "wrap", marginBottom: 12 }}>
            <label className="meta" htmlFor="d-form">Form</label>
            <select id="d-form" value={formId} onChange={(e) => { setFormId(e.target.value); setPicked(new Set()); setEditing(null); }}>
              {list.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
            <label className="meta" htmlFor="d-status">Show</label>
            <select id="d-status" value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
              <option value="all">All ({all.length})</option>
              {(["submitted", "approved", "rejected", "draft"] as FeatureStatus[]).map((s) => <option key={s} value={s}>{STATUS[s].label} ({counts[s] ?? 0})</option>)}
            </select>
            <span className="grow" />
            <Button small onClick={exportCsv} disabled={!target.length}>Download CSV{picked.size ? ` (${picked.size})` : ""}</Button>
            <Button small onClick={exportGeoJson} disabled={!target.length}>Download GeoJSON{picked.size ? ` (${picked.size})` : ""}</Button>
            {canManage && <Button small variant="primary" onClick={() => setPublishing((p) => !p)}>Publish to data hub</Button>}
          </div>

          {publishing && project.data && <PublishPanel project={project.data} onClose={() => setPublishing(false)} />}
          {publishing && <p className="meta" style={{ marginTop: -8 }}>Approved and waiting records are published; rejected ones are left out. This form has {counts.approved ?? 0} approved and {counts.submitted ?? 0} waiting. Approve the good ones first if you only want checked data public.</p>}

          {canManage && picked.size > 0 && (
            <div className="row" role="toolbar" aria-label="Selected records" style={{ marginBottom: 8 }}>
              <strong>{picked.size} selected</strong>
              <Button small onClick={() => void review([...picked], "approved")}>Approve</Button>
              <Button small onClick={() => void review([...picked], "rejected")}>Reject</Button>
              <Button small onClick={() => void remove([...picked])}>Delete</Button>
              <Button small onClick={() => setPicked(new Set())}>Clear</Button>
            </div>
          )}

          {editing && form && (
            <section className="card" style={{ maxWidth: 640, marginBottom: 16 }} aria-label="Edit record">
              <h2>Edit record</h2>
              <FormRenderer form={form} value={draft} onChange={setDraft} errors={errors} />
              <div className="row" style={{ marginTop: 12 }}><Button variant="primary" busy={saving} onClick={() => void save()}>Save</Button><Button onClick={() => setEditing(null)}>Cancel</Button></div>
            </section>
          )}

          {!rows.length ? <EmptyState title={all.length ? "Nothing matches this filter" : "No data collected yet"}>{all.length ? "Choose a different status above." : shareLink && canManage ? "Share the form link or add collaborators to start collecting." : "Data collected with this form shows up here."}</EmptyState> : (
            <div style={{ overflowX: "auto" }}>
              <table className="data-table">
                <thead><tr>
                  {canManage && <th scope="col"><input type="checkbox" aria-label="Select all shown" checked={picked.size > 0 && rows.every((r) => picked.has(r.id))} onChange={(e) => setPicked(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())} /></th>}
                  <th scope="col">Status</th>{cols.map((c) => <th key={c.id} scope="col">{c.label}</th>)}<th scope="col">Updated</th>{canManage && <th scope="col"><span className="sr-only">Actions</span></th>}
                </tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      {canManage && <td><input type="checkbox" aria-label="Select record" checked={picked.has(r.id)} onChange={() => toggle(r.id)} /></td>}
                      <td><span className={STATUS[r.status].cls}>{STATUS[r.status].label}</span></td>
                      {cols.map((c) => <td key={c.id}>{cell(r.properties[c.id])}</td>)}
                      <td>{new Date(r.updated_at).toLocaleDateString()}</td>
                      {canManage && <td style={{ whiteSpace: "nowrap" }}>
                        <Button small onClick={() => startEdit(r)}>Edit</Button>{" "}
                        <Button small onClick={() => void review([r.id], "approved")} disabled={r.status === "approved"}>Approve</Button>{" "}
                        <Button small onClick={() => void remove([r.id])}>Delete</Button>
                      </td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
