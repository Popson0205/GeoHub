import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useParams } from "react-router-dom";
import { useLiveQuery } from "dexie-react-hooks";
import FormRenderer, { type MediaCtx } from "../components/FormRenderer";
import SignaturePad from "../components/SignaturePad";
import MapView, { type MapFeature } from "../components/MapView";
import { Button, ErrorState, Loading, useToast } from "../components/ui";
import { loadApi } from "../lib/api";
import { db, type LocalFeature, type LocalMedia, type ConflictRow } from "../lib/db";
import { topLevelFields } from "../lib/fieldSpec";
import { applyDefaults, pruneProperties, uuid, validateProperties } from "../lib/forms";
import { useOnline } from "../lib/hooks";
import { deleteFeatureLocal, loadBundle, resolveConflict, saveFeatureLocal, syncProject, type SyncReport } from "../lib/sync";
import { GEOMETRY_LABEL, type Form, type FormField, type Geometry, type Props } from "../lib/types";

interface Draft { id: string; formId: string; geometry: Geometry | null; props: Props; newMedia: string[]; existing: boolean }
const DRAFT_ID = "__draft";

export default function CollectPage() {
  const { projectId = "" } = useParams();
  const toast = useToast();
  const online = useOnline();

  const [forms, setForms] = useState<Form[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [fromCache, setFromCache] = useState(false);
  const [name, setName] = useState("Collector");
  const [tab, setTab] = useState<"collect" | "data" | "sync">("collect");
  const [formId, setFormId] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [placing, setPlacing] = useState(false);
  const [locating, setLocating] = useState(false);
  const [accuracy, setAccuracy] = useState<number | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [report, setReport] = useState<SyncReport | null>(null);
  const [syncError, setSyncError] = useState("");
  const [syncBusy, setSyncBusy] = useState(false);
  const syncing = useRef(false);

  const features = useLiveQuery(() => db.features.where("project_id").equals(projectId).toArray(), [projectId], [] as LocalFeature[]);
  const pending = useLiveQuery(() => db.queue.where("project_id").equals(projectId).count(), [projectId], 0);
  const conflicts = useLiveQuery(() => db.conflicts.where("project_id").equals(projectId).toArray(), [projectId], [] as ConflictRow[]);
  const media = useLiveQuery(() => (draft ? db.media.where("feature_id").equals(draft.id).toArray() : Promise.resolve([] as LocalMedia[])), [draft?.id], [] as LocalMedia[]);

  const photoUrls = useMemo<Record<string, string>>(() => Object.fromEntries(media.map((m) => [m.id, URL.createObjectURL(m.blob)])), [media]);
  useEffect(() => () => { Object.values(photoUrls).forEach(URL.revokeObjectURL); }, [photoUrls]);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const b = await loadBundle(projectId);
      setForms(b.forms); setFromCache(b.fromCache);
      setFormId((cur) => cur || b.forms[0]?.id || "");
    } catch (e) { setLoadError(e); }
    try { const p = await (await loadApi()).getProject(projectId); setName(p.name); await db.meta.put({ key: `name:${projectId}`, value: p.name }); }
    catch { const cached = await db.meta.get(`name:${projectId}`); if (cached) setName(cached.value); }
  }, [projectId]);
  useEffect(() => { void load(); }, [load]);

  const sync = useCallback(async (quiet: boolean) => {
    if (syncing.current || !navigator.onLine) return;
    syncing.current = true; setSyncBusy(true);
    try {
      const r = await syncProject(projectId);
      setReport(r); setSyncError("");
      if (!quiet) toast(`Synced. Sent ${r.pushed}, received ${r.pulled}${r.conflicts ? `, ${r.conflicts} need a decision` : ""}.`, r.conflicts || r.rejected ? "info" : "success");
    } catch (e) {
      setSyncError(e instanceof Error ? e.message : "Sync failed.");
      if (!quiet) toast("Couldn't sync. Your data is safe on this device.", "error");
    } finally { syncing.current = false; setSyncBusy(false); }
  }, [projectId, toast]);

  useEffect(() => { if (online && forms) void sync(true); }, [online, forms, sync]);
  useEffect(() => { const t = setInterval(() => void sync(true), 60000); return () => clearInterval(t); }, [sync]);

  const form = forms?.find((f) => f.id === (draft?.formId ?? formId)) ?? null;
  const mapFeatures: MapFeature[] = useMemo(() => {
    const list: MapFeature[] = features.filter((f) => !f.deleted && f.id !== draft?.id).map((f) => ({ id: f.id, geometry: f.geometry, properties: f.properties, pending: f.sync !== "synced" }));
    if (draft?.geometry) list.push({ id: DRAFT_ID, geometry: draft.geometry, pending: true });
    return list;
  }, [features, draft]);

  function startDraft() { if (form) { setDraft({ id: uuid(), formId: form.id, geometry: null, props: applyDefaults(form.fields), newMedia: [], existing: false }); setErrors({}); setAccuracy(null); } }
  async function cancelDraft() {
    if (draft?.newMedia.length) await db.media.bulkDelete(draft.newMedia);
    setDraft(null); setPlacing(false); setErrors({});
  }
  function capture() {
    if (!navigator.geolocation) { toast("This device can't provide a location. Place the point on the map instead.", "error"); return; }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setAccuracy(Math.round(pos.coords.accuracy)); setLocating(false);
        setDraft((d) => d && { ...d, geometry: { type: "Point", coordinates: [pos.coords.longitude, pos.coords.latitude] } });
      },
      (err) => {
        setLocating(false);
        toast(err.code === 1 ? "Location permission is off. Allow it in settings, or place the point on the map." : "Couldn't get a location fix. Move to open sky and try again, or place the point on the map.", "error");
      },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
    );
  }

  async function save() {
    if (!draft || !form || !draft.geometry) return;
    const errs = validateProperties(form, draft.props);
    setErrors(errs);
    if (Object.keys(errs).length) { toast("Fix the highlighted fields first.", "error"); return; }
    await saveFeatureLocal({ id: draft.id, project_id: projectId, form, geometry: draft.geometry, properties: pruneProperties(form, draft.props) });
    toast(navigator.onLine ? "Saved. Syncing…" : "Saved on this device. It will sync when you're online.", "success");
    setDraft(null); setPlacing(false);
    void sync(true);
  }

  async function addMedia(field: FormField, file: Blob | undefined, ctx: MediaCtx) {
    if (!file || !draft) return;
    const cap = field.max_items ?? (field.type === "signature" ? 1 : field.type === "photo" ? 3 : 10);
    if (ctx.value.length >= cap) { toast(`You can add up to ${cap} here.`, "error"); return; }
    const id = uuid();
    const name = file instanceof File && file.name ? file.name : `${id}.${file.type.split("/")[1] ?? "bin"}`;
    await db.media.add({ id, feature_id: draft.id, field_id: field.id, name, blob: file, uploaded: 0 });
    ctx.set([...ctx.value, id]);
    setDraft((d) => d && { ...d, newMedia: [...d.newMedia, id] });
  }
  async function dropMedia(id: string, ctx: MediaCtx) {
    ctx.set(ctx.value.filter((x) => x !== id));
    const m = await db.media.get(id);
    if (m && m.uploaded === 0) await db.media.delete(id);
    setDraft((d) => d && { ...d, newMedia: d.newMedia.filter((x) => x !== id) });
  }
  const ACCEPT: Record<string, string> = { photo: "image/*", audio: "audio/*", video: "video/*", file: "application/pdf,text/plain,text/csv,image/*" };
  const renderMedia = (field: FormField, ctx: MediaCtx) => {
    const cap = field.max_items ?? (field.type === "signature" ? 1 : field.type === "photo" ? 3 : 10);
    return (
      <>
        <div className="photos">
          {ctx.value.map((id, i) => (
            <span className="media-item" key={id}>
              {photoUrls[id] && media.find((m) => m.id === id)?.blob.type.startsWith("image/") ? <img src={photoUrls[id]} alt={`${field.label} ${i + 1}`} /> : <span className="media-chip">{field.type} {i + 1}</span>}
              <button type="button" className="media-x" aria-label={`Remove ${field.label} ${i + 1}`} onClick={() => void dropMedia(id, ctx)}>×</button>
            </span>
          ))}
        </div>
        {field.type === "signature" ? (
          <SignaturePad disabled={ctx.value.length >= cap} onDone={(png) => void addMedia(field, png, ctx)} />
        ) : (
          <label className="upload">{field.type === "photo" ? "Take photo" : field.type === "audio" ? "Record audio" : field.type === "video" ? "Record video" : "Attach file"} ({ctx.value.length}/{cap})
            <input className="sr-only" type="file" accept={ACCEPT[field.type]} {...(field.type === "photo" ? (field.appearance === "camera_only" ? { capture: "environment" as const } : {}) : field.type === "file" ? {} : { capture: true })}
              onChange={(e) => { void addMedia(field, e.target.files?.[0], ctx); e.target.value = ""; }} />
          </label>
        )}
      </>
    );
  };

  function titleOf(f: LocalFeature): string {
    const fm = forms?.find((x) => x.id === f.form_id);
    const textField = fm ? topLevelFields(fm.fields).find((x) => x.type === "text") : undefined;
    return (textField && String(f.properties[textField.id] ?? "")) || fm?.name || "Feature";
  }

  const mine = features.filter((f) => !f.deleted);
  const drawMode = draft && !draft.geometry && placing && form ? form.geometry_type : null;

  return (
    <div className="collect">
      <header className="collect-head">
        <Link to="/collect" style={{ color: "#c3d2ca" }} aria-label="Back to projects">←</Link>
        <div className="grow"><small>Project</small><strong>{name}</strong></div>
        <span className={`badge ${online ? "badge-ok" : "badge-warn"}`}>{online ? "Online" : "Offline"}{pending ? ` · ${pending} to sync` : ""}</span>
      </header>

      <MapView
        features={mapFeatures}
        selectedId={draft?.geometry ? DRAFT_ID : null}
        drawMode={drawMode}
        onDraw={(g) => { setDraft((d) => d && { ...d, geometry: g }); setPlacing(false); }}
        onCancelDraw={() => setPlacing(false)}
        fitKey={`${projectId}:${features.length > 0}`}
        geolocate
        label="Collection map"
      />

      <section className="sheet" aria-label={tab === "collect" ? "Collect" : tab === "data" ? "My data" : "Sync"}>
        {forms === null && loadError == null && <Loading label="Loading your project…" />}
        {loadError != null && <ErrorState error={loadError} onRetry={load} />}
        {fromCache && <span className="badge badge-warn" style={{ alignSelf: "flex-start" }}>Using saved forms from this device</span>}

        {forms && tab === "collect" && (forms.length === 0 ? (
          <div className="state"><strong>No published forms</strong>Ask the project admin to publish a form, then sync.</div>
        ) : !draft ? (
          <>
            <h2>Collect</h2>
            {forms.length > 1 && (
              <div className="choice-row" role="group" aria-label="Form">
                {forms.map((f) => <button key={f.id} className="choice" aria-pressed={formId === f.id} onClick={() => setFormId(f.id)}>{f.name}</button>)}
              </div>
            )}
            <Button variant="accent" onClick={startDraft} disabled={!form}>New {form ? form.name.toLowerCase() : "record"}</Button>
          </>
        ) : !draft.geometry ? (
          <>
            <h2>New {form?.name.toLowerCase()}</h2>
            <span className="field-hint">Step 1: set the location.</span>
            {form?.geometry_type === "Point" && <Button variant="accent" busy={locating} onClick={capture}>Capture at my location</Button>}
            <Button onClick={() => setPlacing(true)} disabled={placing}>{form?.geometry_type === "Point" ? "Place on the map" : `Draw the ${form ? GEOMETRY_LABEL[form.geometry_type] : "shape"} on the map`}</Button>
            <Button variant="ghost" onClick={cancelDraft}>Cancel</Button>
          </>
        ) : form && (
          <>
            <div className="row"><h2 className="grow">{draft.existing ? "Edit" : "New"} {form.name.toLowerCase()}</h2>{accuracy != null && <span className="gps">GPS ±{accuracy} m</span>}</div>
            <FormRenderer form={form} value={draft.props} onChange={(p) => setDraft((d) => d && { ...d, props: p })} errors={errors} renderMedia={renderMedia} />
            <div className="row" style={{ position: "sticky", bottom: 0, background: "#fff", padding: "8px 0" }}>
              <Button onClick={cancelDraft}>Cancel</Button>
              <Button className="grow" variant="accent" onClick={save}>{online ? "Save record" : "Save on this device"}</Button>
            </div>
          </>
        ))}

        {tab === "data" && (
          <>
            <h2>My data</h2>
            {conflicts.map((c) => (
              <div className="state state-error" key={c.id} role="alert">
                <strong>Someone else changed this record</strong>
                <span>Choose which version to keep.</span>
                <div className="row"><Button small onClick={() => resolveConflict(c.id, "server")}>Keep their version</Button><Button small onClick={() => resolveConflict(c.id, "mine").then(() => sync(true))}>Keep mine</Button></div>
              </div>
            ))}
            {mine.length === 0 && <div className="state"><strong>Nothing collected yet</strong>Records you save appear here, even offline.</div>}
            {mine.map((f) => (
              <div className="list-item" key={f.id}>
                <div className="grow">
                  <strong>{titleOf(f)}</strong>
                  <small>{f.sync === "synced" ? "Synced" : f.sync === "pending" ? "Waiting to sync" : f.sync === "conflict" ? "Needs a decision" : `Not accepted: ${Object.values(f.errors ?? {}).join(" ")}`}</small>
                </div>
                <Button small onClick={() => { setDraft({ id: f.id, formId: f.form_id, geometry: f.geometry, props: { ...f.properties }, newMedia: [], existing: true }); setTab("collect"); }}>Edit</Button>
                <Button small variant="danger" onClick={() => { if (window.confirm("Delete this record?")) void deleteFeatureLocal(f.id); }}>Delete</Button>
              </div>
            ))}
          </>
        )}

        {tab === "sync" && (
          <>
            <h2>Sync</h2>
            <div className="list-item"><div className="grow"><strong>{online ? "You're online" : "You're offline"}</strong><small>{pending} change{pending === 1 ? "" : "s"} waiting to send</small></div></div>
            <Button variant="primary" busy={syncBusy} disabled={!online} onClick={() => sync(false)}>Sync now</Button>
            {!online && <span className="field-hint">Connect to the internet to sync. Your records are safe on this device.</span>}
            {syncError && <div className="state state-error" role="alert"><strong>Last sync failed</strong>{syncError}</div>}
            {report && <div className="state"><strong>Last sync</strong>Sent {report.pushed} · received {report.pulled} · photos {report.photos}{report.conflicts ? ` · ${report.conflicts} conflicts` : ""}{report.rejected ? ` · ${report.rejected} not accepted` : ""}</div>}
          </>
        )}
      </section>

      <nav className="tabbar" aria-label="Collector sections">
        {(["collect", "data", "sync"] as const).map((t) => (
          <button key={t} aria-current={tab === t} onClick={() => setTab(t)}>{t === "collect" ? "Collect" : t === "data" ? "My data" : "Sync"}{t === "sync" && pending ? ` (${pending})` : ""}</button>
        ))}
      </nav>
    </div>
  );
}
