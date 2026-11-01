import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import CsvImportPanel from "../components/CsvImportPanel";
import FormRenderer from "../components/FormRenderer";
import RecordTable, { cellText } from "../components/RecordTable";
import { qualityFlags } from "../lib/quality";
import ReviewPanel from "../components/ReviewPanel";
import { Icon } from "../components/icons";
import ProjectNav, { ProjectNavSkeleton } from "../components/ProjectNav";
import { Button, EmptyState, ErrorState, Loading, MoreMenu, useToast, useUndoable } from "../components/ui";
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
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "data";

/** Everything collected for a project: check it, clean it, download it and send it to the data hub. */
export default function DataPage() {
  const { projectId = "" } = useParams();
  const toast = useToast();
  const undoable = useUndoable();
  const project = useAsync((api) => api.getProject(projectId), [projectId]);
  const forms = useAsync((api) => api.listForms(projectId), [projectId]);
  const feats = useAsync((api) => api.listFeatures(projectId), [projectId]);
  const [formId, setFormId] = useState("");
  const [importing, setImporting] = useState(false);
  const [filter, setFilter] = useState<"all" | "flagged" | FeatureStatus>("all");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<Feature | null>(null);
  const [draft, setDraft] = useState<Props>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  // Review mode works through the records waiting for a decision. ?review=1 opens it directly (from a project card).
  const [params, setParams] = useSearchParams();
  const [queue, setQueue] = useState<string[] | null>(null);
  const wantsReview = params.get("review") === "1";

  const list = forms.data ?? [];
  useEffect(() => { if (!formId && list.length) setFormId((list.find((f) => f.version > 0) ?? list[0]).id); }, [list.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const form: Form | undefined = list.find((f) => f.id === formId);
  const canManage = project.data?.role === "owner" || project.data?.role === "admin";
  const cols = useMemo(() => (form ? columnFields(form.fields) : []), [form]);
  const all = useMemo(() => (feats.data ?? []).filter((f) => f.form_id === formId), [feats.data, formId]);
  // Data quality hints, worked out from this form's records (poor GPS, placed by hand, possible duplicates).
  const flags = useMemo(() => qualityFlags(all, form), [all, form]);
  const flagged = useMemo(() => all.filter((f) => (flags.get(f.id) ?? []).some((x) => x.kind !== "manual")).length, [all, flags]);
  const rows = useMemo(() => all.filter((f) => filter === "all" || (filter === "flagged" ? (flags.get(f.id) ?? []).some((x) => x.kind !== "manual") : f.status === filter)), [all, filter, flags]);
  const counts = useMemo(() => { const c: Record<string, number> = {}; for (const f of all) c[f.status] = (c[f.status] ?? 0) + 1; return c; }, [all]);
  const target = picked.size ? rows.filter((r) => picked.has(r.id)) : rows;
  const waitingAll = useMemo(() => (feats.data ?? []).filter((f) => f.status === "submitted").length, [feats.data]);

  function startReview() {
    setQueue(all.filter((f) => f.status === "submitted").map((f) => f.id));
    setEditing(null); setImporting(false); setPublishing(false); setPicked(new Set());
  }
  function stopReview() {
    setQueue(null); setEditing(null);
    if (params.has("review")) { params.delete("review"); setParams(params, { replace: true }); }
  }
  // Opened with ?review=1: pick the form that has records waiting, then start.
  useEffect(() => {
    if (!wantsReview || queue !== null || !feats.data || !list.length || !formId || !canManage) return;
    const waitingHere = feats.data.some((f) => f.form_id === formId && f.status === "submitted");
    if (!waitingHere) {
      const other = list.find((f) => feats.data!.some((r) => r.form_id === f.id && r.status === "submitted"));
      if (other && other.id !== formId) { setFormId(other.id); return; }
    }
    startReview();
  }, [wantsReview, queue, feats.data, list.length, formId, canManage]); // eslint-disable-line react-hooks/exhaustive-deps

  if (project.loading || forms.loading || feats.loading) return <><ProjectNavSkeleton /><div className="container"><Loading label="Loading records…" /></div></>;
  const err = project.error ?? forms.error ?? feats.error;
  if (err != null) return <><ProjectNav projectId={projectId} project={project.data} /><div className="container"><ErrorState error={err} onRetry={() => { void project.reload(); void forms.reload(); void feats.reload(); }} /></div></>;

  const patchLocal = (u: Feature) => feats.setData((feats.data ?? []).map((f) => (f.id === u.id ? u : f)));

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
  /** Approve or reject; true when the server took it. The review screen moves on only then. */
  async function review(ids: string[], decision: "approved" | "rejected", note?: string, quiet = false): Promise<boolean> {
    try {
      const api = await loadApi();
      const done = await Promise.all(ids.map((id) => api.reviewFeature(id, decision, note)));
      const byId = new Map(done.map((d) => [d.id, d]));
      feats.setData((cur) => (cur ?? []).map((f) => byId.get(f.id) ?? f));
      setPicked(new Set());
      if (!quiet) toast(`${done.length} ${decision}.`, "success");
      return true;
    } catch (e) { toast(e instanceof Error ? e.message : "Could not update.", "error"); void feats.reload(); return false; }
  }
  /** Records leave the table at once; they are deleted on the server when the Undo window closes. */
  function remove(ids: string[]) {
    const before = feats.data ?? [];
    const gone = before.filter((f) => ids.includes(f.id));
    if (!gone.length) return;
    undoable({
      text: `${gone.length === 1 ? "Record" : `${gone.length} records`} deleted.`,
      hide: () => { feats.setData((cur) => (cur ?? []).filter((f) => !ids.includes(f.id))); setPicked(new Set()); if (editing && ids.includes(editing.id)) setEditing(null); },
      commit: async () => { const api = await loadApi(); await Promise.all(gone.map((f) => api.deleteFeature(f.id))); },
      // Put them back where they were, not at the end of the table.
      restore: () => feats.setData((cur) => {
        const have = new Set((cur ?? []).map((f) => f.id));
        const at = new Map(before.map((f, i) => [f.id, i]));
        return [...(cur ?? []), ...gone.filter((f) => !have.has(f.id))].sort((a, b) => (at.get(a.id) ?? Infinity) - (at.get(b.id) ?? Infinity));
      }),
      failText: "Could not delete. The records have been put back.",
    });
  }

  function exportCsv() {
    const head = ["id", "status", "longitude", "latitude", "geometry", ...cols.map((c) => c.id)];
    const lines = [head.join(",")];
    for (const r of target) {
      const g = r.geometry;
      const pt = g.type === "Point" ? g.coordinates : null;
      lines.push([r.id, r.status, pt?.[0] ?? "", pt?.[1] ?? "", pt ? "" : JSON.stringify(g), ...cols.map((c) => cellText(r.properties[c.id]))].map(csvEscape).join(","));
    }
    download(`${slug(form?.name ?? "data")}.csv`, lines.join("\n"), "text/csv;charset=utf-8");
  }
  function exportGeoJson() {
    const fc = { type: "FeatureCollection", features: target.map((r) => ({ type: "Feature", id: r.id, geometry: r.geometry, properties: { status: r.status, ...r.properties } })) };
    download(`${slug(form?.name ?? "data")}.geojson`, JSON.stringify(fc, null, 2), "application/geo+json");
  }

  const shareLink = form && form.version > 0 ? `/collect/${projectId}/forms/${form.id}/share` : null;
  const picks = picked.size ? ` (${picked.size})` : "";
  return (
    <>
      <ProjectNav projectId={projectId} project={project.data} waiting={waitingAll}
        actions={canManage && list.length > 0 ? <>
          {shareLink && <Link className="btn" to={shareLink}><Icon name="share" size={18} />Share form</Link>}
          <Button onClick={() => setPublishing((p) => !p)} aria-expanded={publishing}><Icon name="globe" size={18} />Publish to data hub</Button>
        </> : undefined} />
      <div className="container" style={{ width: "100%" }}>
      {!list.length ? <EmptyState icon="form" title="No forms yet" action={canManage ? <Link className="btn btn-primary" to={`/collect/${projectId}/forms`}>Create a form</Link> : undefined}>Collected data appears here once a form is published and shared.</EmptyState> : (
        <>
          {publishing && project.data && <PublishPanel project={project.data} onClose={() => setPublishing(false)} />}
          {publishing && <p className="meta" style={{ marginTop: -12, marginBottom: 20, maxWidth: 560 }}>Approved and waiting records are published; rejected ones are left out. This form has {counts.approved ?? 0} approved and {counts.submitted ?? 0} waiting. Approve the good ones first if you only want checked data public.</p>}

          {queue && form ? (<>
          {editing && form && (
            <section className="card inline-panel" style={{ maxWidth: 640 }} aria-label="Edit record">
              <h2>Edit record</h2>
              <FormRenderer form={form} value={draft} onChange={setDraft} errors={errors} />
              <div className="row" style={{ marginTop: 12 }}><Button variant="primary" busy={saving} onClick={() => void save()}>Save</Button><Button onClick={() => setEditing(null)}>Cancel</Button></div>
            </section>
          )}
            <ReviewPanel form={form} queue={queue} features={feats.data ?? []} onDecide={(id, d, note) => review([id], d, note, true)} onEdit={startEdit} onClose={stopReview} />
          </>) : (<>
          <div className="toolbar-bar">
            <div className="field">
              <label htmlFor="d-form">Form</label>
              <select id="d-form" value={formId} onChange={(e) => { setFormId(e.target.value); setPicked(new Set()); setEditing(null); setImporting(false); }}>
                {list.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            </div>
            <div className="status-filter" role="group" aria-label="Show records">
              {(["all", "submitted", "approved", "rejected", "draft"] as const).filter((s) => s === "all" || s === filter || (counts[s] ?? 0) > 0).map((s) => (
                <button key={s} type="button" className="filter-chip" aria-pressed={filter === s} onClick={() => { setFilter(s); setPicked(new Set()); }}>
                  {s === "all" ? "All" : STATUS[s].label}<span className="filter-count">{s === "all" ? all.length : counts[s] ?? 0}</span>
                </button>
              ))}
              {(flagged > 0 || filter === "flagged") && (
                <button type="button" className="filter-chip filter-chip-flag" aria-pressed={filter === "flagged"} onClick={() => { setFilter("flagged"); setPicked(new Set()); }} title="Poor GPS accuracy or a possible duplicate">
                  <Icon name="search" size={14} />Needs a look<span className="filter-count">{flagged}</span>
                </button>
              )}
            </div>
            <div className="toolbar-actions">
              {canManage && (counts.submitted ?? 0) > 0 && <Button small variant="primary" onClick={startReview}><Icon name="check" size={16} />Review {counts.submitted} waiting</Button>}
              {canManage && form && <Button small onClick={() => setImporting((v) => !v)} aria-expanded={importing} disabled={form.version === 0} title={form.version === 0 ? "Publish the form before importing into it" : undefined}><Icon name="upload" size={16} />Import CSV</Button>}
              <MoreMenu label="Download" text={`Download${picks}`} icon="download" items={[
                { label: `CSV spreadsheet${picks}`, icon: "table", disabled: !target.length, onSelect: exportCsv },
                { label: `GeoJSON for GIS${picks}`, icon: "navMap", disabled: !target.length, onSelect: exportGeoJson },
              ]} />
            </div>
          </div>

          {importing && canManage && form && form.version > 0 && (
            <CsvImportPanel key={form.id} projectId={projectId} form={form} onClose={() => setImporting(false)} onImported={() => { setFilter("all"); void feats.reload(); }} />)}

          {canManage && picked.size > 0 && (
            <div className="selection-bar" role="toolbar" aria-label="Selected records">
              <strong>{picked.size} selected</strong>
              <Button small onClick={() => void review([...picked], "approved")}><Icon name="check" size={16} />Approve</Button>
              <Button small onClick={() => void review([...picked], "rejected")}>Reject</Button>
              <Button small onClick={() => void remove([...picked])}><Icon name="delete" size={16} />Delete</Button>
              <Button small variant="ghost" onClick={() => setPicked(new Set())}>Clear</Button>
            </div>
          )}

          {editing && form && (
            <section className="card inline-panel" style={{ maxWidth: 640 }} aria-label="Edit record">
              <h2>Edit record</h2>
              <FormRenderer form={form} value={draft} onChange={setDraft} errors={errors} />
              <div className="row" style={{ marginTop: 12 }}><Button variant="primary" busy={saving} onClick={() => void save()}>Save</Button><Button onClick={() => setEditing(null)}>Cancel</Button></div>
            </section>
          )}

          <RecordTable formId={formId} rows={rows} cols={cols} canManage={canManage} picked={picked} setPicked={setPicked} flags={flags}
            onApprove={(id) => void review([id], "approved")} onReject={(id) => void review([id], "rejected")} onEdit={startEdit} onDelete={(id) => remove([id])}
            empty={<EmptyState icon={all.length ? "search" : "inbox"} title={all.length ? "Nothing matches this filter" : "No data collected yet"}
              action={!all.length && shareLink && canManage ? <Link className="btn btn-primary" to={shareLink}><Icon name="share" size={18} />Share the form</Link> : all.length ? <Button onClick={() => setFilter("all")}>Show all records</Button> : undefined}>
              {all.length ? "No records have this status." : shareLink && canManage ? "Share the form link or add collaborators, and their records will show up here as they arrive." : "Data collected with this form shows up here."}
            </EmptyState>} />
          </>)}
        </>
      )}
      </div>
    </>
  );
}
