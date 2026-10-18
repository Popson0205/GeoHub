import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import FormRenderer from "../components/FormRenderer";
import MapView, { type MapFeature } from "../components/MapView";
import { Button, ErrorState, Loading, useToast } from "../components/ui";
import { ApiError, loadApi, type Api } from "../lib/api";
import { ACCEPT, classifyFile, extOf, NEEDS_BOUNDS_EXTS, type Bounds } from "../lib/fileTypes";
import { uuid, validateProperties } from "../lib/forms";
import { useAsync } from "../lib/hooks";
import { GEOMETRY_LABEL, type Feature, type Geometry, type Props } from "../lib/types";

const DRAFT_ID = "__draft";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function EditorPage() {
  const { projectId = "" } = useParams();
  const toast = useToast();
  const { data, error, loading, reload, setData } = useAsync(async (api) => {
    const [project, forms, features, imagery] = await Promise.all([api.getProject(projectId), api.listForms(projectId), api.listFeatures(projectId), api.listImagery(projectId)]);
    return { project, forms: forms.filter((f) => f.status === "published"), features, imagery };
  }, [projectId]);

  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [hiddenImg, setHiddenImg] = useState<Set<string>>(new Set());
  const [activeFormId, setActiveFormId] = useState<string>("");
  const [drawing, setDrawing] = useState(false);
  const [draft, setDraft] = useState<Geometry | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [props, setProps] = useState<Props>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [box, setBox] = useState({ w: "", s: "", e: "", n: "" });   // optional placement for pictures without coordinates

  const forms = data?.forms ?? [];
  const activeForm = forms.find((f) => f.id === (activeFormId || forms[0]?.id)) ?? null;
  const selected = data?.features.find((f) => f.id === selectedId) ?? null;
  const editingForm = draft ? activeForm : forms.find((f) => f.id === selected?.form_id) ?? null;

  const mapFeatures: MapFeature[] = useMemo(() => {
    const list: MapFeature[] = (data?.features ?? []).filter((f) => !hidden.has(f.form_id)).map((f) => ({ id: f.id, geometry: f.geometry, properties: f.properties }));
    if (draft) list.push({ id: DRAFT_ID, geometry: draft, pending: true });
    return list;
  }, [data, hidden, draft]);

  const [tileUrls, setTileUrls] = useState<Record<string, string | null>>({});
  useEffect(() => {
    let alive = true;
    (async () => {
      const api = await loadApi();
      const next: Record<string, string | null> = {};
      for (const i of data?.imagery ?? []) if (i.status === "ready") next[i.id] = api.imageryTileUrl(i.id);
      if (alive) setTileUrls((t) => ({ ...t, ...next }));
    })();
    return () => { alive = false; };
  }, [data?.imagery]);
  const liveImagery = (data?.imagery ?? []).filter((i) => i.status === "ready" && !hiddenImg.has(i.id) && tileUrls[i.id]).map((i) => ({ id: i.id, url: tileUrls[i.id]! }));

  if (loading) return <Loading label="Loading project…" />;
  if (error != null || !data) return <div className="container"><ErrorState error={error} onRetry={reload} /></div>;

  function select(id: string | null) {
    if (draft) return;
    setSelectedId(id);
    const f = data!.features.find((x) => x.id === id);
    setProps(f ? { ...f.properties } : {});
    setErrors({});
  }
  function cancelEdit() { setDraft(null); setDrawing(false); setSelectedId(null); setProps({}); setErrors({}); }

  async function save() {
    if (!editingForm) return;
    const errs = validateProperties(editingForm, props);
    setErrors(errs);
    if (Object.keys(errs).length) { toast("Fix the highlighted fields first.", "error"); return; }
    setSaving(true);
    try {
      const api = await loadApi();
      if (draft) {
        const created = await api.createFeature({ id: uuid(), project_id: projectId, form_id: editingForm.id, form_version: editingForm.version, geometry: draft, properties: props });
        setData({ ...data!, features: [...data!.features, created] });
        toast("Feature saved.", "success");
        cancelEdit();
        setSelectedId(created.id); setProps(created.properties);
      } else if (selected) {
        const updated = await api.updateFeature(selected.id, { properties: props, base_version: selected.version });
        setData({ ...data!, features: data!.features.map((f) => (f.id === updated.id ? updated : f)) });
        toast("Changes saved.", "success");
      }
    } catch (e) {
      if (e instanceof ApiError && e.fields) setErrors(e.fields);
      if (e instanceof ApiError && e.status === 409) { toast(e.message, "error"); await reload(); }
      else toast(e instanceof Error ? e.message : "Could not save.", "error");
    } finally { setSaving(false); }
  }

  async function remove(f: Feature) {
    if (!window.confirm("Delete this feature? It stays in the history.")) return;
    try {
      await (await loadApi()).deleteFeature(f.id);
      setData({ ...data!, features: data!.features.filter((x) => x.id !== f.id) });
      cancelEdit();
      toast("Feature deleted.", "success");
    } catch (e) { toast(e instanceof Error ? e.message : "Could not delete.", "error"); }
  }

  function parseBounds(): Bounds | undefined {
    const raw = [box.w, box.s, box.e, box.n];
    if (raw.every((v) => v.trim() === "")) return undefined;
    const [w, s, e, n] = raw.map(Number);
    if (raw.some((v) => v.trim() === "" || Number.isNaN(Number(v))) || !(w < e && s < n) || w < -180 || e > 180 || s < -90 || n > 90) {
      throw new Error("Bounds must be four numbers in degrees: west < east and south < north.");
    }
    return [w, s, e, n];
  }

  /** Poll a background job until it finishes (imports usually take seconds). */
  async function waitForJob(api: Api, id: string) {
    for (let i = 0; i < 180; i++) {
      const j = await api.getJob(id);
      if (j.status === "done" || j.status === "failed") return j;
      await sleep(1000);
    }
    throw new Error("This is taking longer than expected. Check back in a minute.");
  }

  /** Imagery processing happens on the server after the upload; watch it so the map updates by itself. */
  async function watchImagery(api: Api, id: string) {
    for (let i = 0; i < 120; i++) {
      await sleep(3000);
      const a = await api.getImagery(id);
      if (a.status === "ready" || a.status === "failed") {
        const imagery = await api.listImagery(projectId); // also refreshes the signed tile URLs
        setData((d) => (d ? { ...d, imagery } : d));
        toast(a.status === "ready" ? `"${a.name}" is ready on the map.` : a.error ?? "The image could not be processed.", a.status === "ready" ? "success" : "error");
        return;
      }
    }
  }

  async function upload(file: File | undefined) {
    if (!file) return;
    const kind = classifyFile(file.name);
    if (kind === "unsupported") {
      toast(`${extOf(file.name) || "This"} files are not supported. Use an image (TIFF, JPEG, PNG...) or map data (GeoJSON, KML, GPX, GeoPackage, zipped Shapefile, CSV).`, "error");
      if (fileRef.current) fileRef.current.value = "";
      return;
    }
    setUploading(true);
    try {
      const api = await loadApi();
      if (kind === "vector") {
        // Map data is not imagery: it becomes features of the selected form.
        if (!activeForm) throw new Error("Publish a form first. Map data is imported into a form.");
        const job = await waitForJob(api, (await api.importFeatures(projectId, file, activeForm.id)).id);
        const r = job.result;
        if (job.status === "failed") throw new Error([job.error, ...(r?.errors ?? []).slice(0, 3).map((x) => `Row ${x.row}: ${x.message}`)].filter(Boolean).join(" "));
        toast(`Imported ${r?.imported ?? 0} into "${activeForm.name}"${r?.rejected ? `, ${r.rejected} skipped (${r.errors?.[0]?.message ?? "invalid"})` : ""}.`, "success");
        await reload();
      } else {
        const asset = await api.uploadImagery(projectId, file, parseBounds());
        setData({ ...data!, imagery: [...data!.imagery, asset] });
        toast(asset.status === "ready" ? "Imagery added." : "Uploaded. Processing it now; it will appear on the map when ready.", "success");
        if (asset.status !== "ready") void watchImagery(api, asset.id).catch(() => undefined);
      }
    } catch (e) { toast(e instanceof Error ? e.message : "Upload failed.", "error"); }
    finally { setUploading(false); if (fileRef.current) fileRef.current.value = ""; }
  }

  const editing = !!draft || !!selected;
  return (
    <div className="editor" style={{ flex: 1 }}>
      <aside className="side left" aria-label="Layers and tools">
        <div><h2>Project</h2><strong>{data.project.name}</strong></div>
        <div className="stack">
          <h2>Add to a form</h2>
          {forms.length === 0 ? (
            <div className="state"><span>No published forms yet.</span><Link to={`/projects/${projectId}/forms`}>Create a form</Link></div>
          ) : (
            <>
              <div className="field"><label htmlFor="af">Form</label>
                <select id="af" value={activeForm?.id ?? ""} onChange={(e) => setActiveFormId(e.target.value)} disabled={!!draft}>
                  {forms.map((f) => <option key={f.id} value={f.id}>{f.name} ({GEOMETRY_LABEL[f.geometry_type]})</option>)}
                </select></div>
              <div className="toolbar">
                <Button variant="primary" disabled={drawing || !!draft} onClick={() => { select(null); setDrawing(true); }}>Add {GEOMETRY_LABEL[activeForm!.geometry_type]}</Button>
                <Link className="btn" to={`/projects/${projectId}/forms`}>Forms</Link>
              </div>
            </>
          )}
        </div>
        <div className="stack">
          <h2>Layers</h2>
          {forms.map((f) => (
            <label className="check" key={f.id}>
              <input type="checkbox" checked={!hidden.has(f.id)} onChange={(e) => setHidden((h) => { const n = new Set(h); if (e.target.checked) n.delete(f.id); else n.add(f.id); return n; })} />
              {f.name}<span className="mono" style={{ marginLeft: "auto" }}>{data.features.filter((x) => x.form_id === f.id).length}</span>
            </label>
          ))}
        </div>
        <div className="stack">
          <h2>Imagery</h2>
          {data.imagery.length === 0 && <span className="field-hint">No imagery yet.</span>}
          {data.imagery.map((i) => (
            <label className="check" key={i.id}>
              <input type="checkbox" checked={!hiddenImg.has(i.id)} disabled={i.status !== "ready"} onChange={(e) => setHiddenImg((h) => { const n = new Set(h); if (e.target.checked) n.delete(i.id); else n.add(i.id); return n; })} />
              {i.name}<span className={`badge ${i.status === "failed" ? "badge-bad" : "badge-ok"}`} style={{ marginLeft: "auto" }}>{i.status}</span>
              {i.status === "failed" && i.error && <span className="field-hint" style={{ display: "block", flexBasis: "100%" }}>{i.error}</span>}
            </label>
          ))}
          <label className="upload" style={uploading ? { opacity: 0.6 } : undefined}>
            {uploading ? "Working…" : "Add imagery or map data"}
            <input ref={fileRef} className="sr-only" type="file" accept={ACCEPT} disabled={uploading} onChange={(e) => upload(e.target.files?.[0])} />
          </label>
          <span className="field-hint">Images: TIFF, JPEG, PNG and more. Map data (GeoJSON, KML, GPX, GeoPackage, zipped Shapefile, CSV) is imported into <strong>{activeForm?.name ?? "a form"}</strong>.</span>
          <details>
            <summary className="field-hint">Picture has no coordinates? ({NEEDS_BOUNDS_EXTS.slice(0, 3).join(" ")}…)</summary>
            <span className="field-hint">Where does it go? Degrees (WGS84), set before choosing the file. GeoTIFFs ignore this.</span>
            {([["w", "West"], ["s", "South"], ["e", "East"], ["n", "North"]] as const).map(([k, label]) => (
              <div className="field" key={k}><label htmlFor={`b-${k}`}>{label}</label><input id={`b-${k}`} inputMode="decimal" value={box[k]} onChange={(ev) => setBox((b) => ({ ...b, [k]: ev.target.value }))} /></div>
            ))}
          </details>
        </div>
      </aside>

      <MapView
        features={mapFeatures}
        selectedId={draft ? DRAFT_ID : selectedId}
        drawMode={drawing && activeForm ? activeForm.geometry_type : null}
        onDraw={(g) => { setDraft(g); setDrawing(false); setProps({}); setErrors({}); }}
        onCancelDraw={() => setDrawing(false)}
        onSelect={select}
        imagery={liveImagery}
        fitKey={projectId}
        label="Project map"
      />

      <aside className="side right" aria-label="Feature details" aria-live="polite">
        {!editing && <div className="state"><strong>Nothing selected</strong>Select a feature on the map, or add a new one.</div>}
        {editing && editingForm && (
          <>
            <div><h2>{draft ? "New feature" : "Selected feature"}</h2><strong>{editingForm.name}</strong>
              {selected && <div className="meta" style={{ fontSize: 13, color: "var(--muted)" }}>Version {selected.version} · {new Date(selected.updated_at).toLocaleDateString()}</div>}</div>
            <FormRenderer form={editingForm} value={props} onChange={setProps} errors={errors} />
            <div className="row" style={{ marginTop: "auto" }}>
              <Button className="grow" onClick={cancelEdit}>{draft ? "Cancel" : "Close"}</Button>
              <Button className="grow" variant="primary" busy={saving} onClick={save}>Save feature</Button>
            </div>
            {selected && <Button variant="danger" small onClick={() => remove(selected)}>Delete feature</Button>}
          </>
        )}
        {editing && !editingForm && <div className="state"><strong>This feature uses a form that is not published.</strong>Publish the form to edit it.</div>}
      </aside>
    </div>
  );
}
