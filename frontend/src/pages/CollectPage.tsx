import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useParams } from "react-router-dom";
import { useLiveQuery } from "dexie-react-hooks";
import FormRenderer, { type MediaCtx } from "../components/FormRenderer";
import SignaturePad from "../components/SignaturePad";
import MapView, { type Bbox, type MapFeature } from "../components/MapView";
import { BrandMark } from "../components/Shell";
import { InstallCard } from "../components/PwaPrompts";
import { Button, ErrorState, Loading, useConfirm, useToast } from "../components/ui";
import { loadApi } from "../lib/api";
import { combineFixes, gpsProps, viewAround, withoutGps, type Fix } from "../lib/gps";
import { db, type LocalFeature, type LocalMedia, type ConflictRow } from "../lib/db";
import { topLevelFields } from "../lib/fieldSpec";
import { applyDefaults, pruneProperties, uuid, validateProperties } from "../lib/forms";
import { useOnline } from "../lib/hooks";
import { isCollectorApp, setBusy, useFormManifest } from "../lib/pwa";
import { deleteFeatureLocal, loadBundle, resolveConflict, saveFeatureLocal, syncProject, syncPublic, type SyncReport } from "../lib/sync";
import { GEOMETRY_LABEL, type Form, type FormField, type Geometry, type Props, type PublicForm } from "../lib/types";

interface Draft { id: string; formId: string; geometry: Geometry | null; props: Props; newMedia: string[]; existing: boolean }
const DRAFT_ID = "__draft";

/** `pub` is set when the collector is opened from a share link: no sign-in, records are sent through the public route. */
export default function CollectPage({ pub }: { pub?: PublicForm } = {}) {
  const { projectId: routeProjectId = "" } = useParams();
  // Records made through a share link are kept under their own local key so they never mix with a signed-in collector's data.
  const projectId = pub ? `public:${pub.token}` : routeProjectId;
  const toast = useToast();
  const confirm = useConfirm();
  const online = useOnline();
  // The installed app only collects: no "My data", no records on the map, nothing pulled from the server.
  const collectOnly = isCollectorApp();

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
    if (pub) { setForms([pub.form]); setFromCache(false); setFormId(pub.form.id); setName(pub.project_name); return; }
    try {
      const b = await loadBundle(projectId, collectOnly);
      setForms(b.forms); setFromCache(b.fromCache);
      setFormId((cur) => cur || b.forms[0]?.id || "");
    } catch (e) { setLoadError(e); }
    try { const p = await (await loadApi()).getProject(projectId); setName(p.name); await db.meta.put({ key: `name:${projectId}`, value: p.name }); }
    catch { const cached = await db.meta.get(`name:${projectId}`); if (cached) setName(cached.value); }
  }, [projectId, pub, collectOnly]);
  useEffect(() => { void load(); }, [load]);

  const sync = useCallback(async (quiet: boolean) => {
    if (syncing.current || !navigator.onLine) return;
    syncing.current = true; setSyncBusy(true);
    try {
      const r = pub ? await syncPublic(pub.token, projectId, { collectOnly }) : await syncProject(projectId, { collectOnly });
      setReport(r); setSyncError("");
      if (!quiet) toast(`Synced. Sent ${r.pushed}, received ${r.pulled}${r.conflicts ? `, ${r.conflicts} need a decision` : ""}.`, r.conflicts || r.rejected ? "info" : "success");
    } catch (e) {
      setSyncError(e instanceof Error ? e.message : "Sync failed.");
      if (!quiet) toast("Couldn't sync. Your data is safe on this device.", "error");
    } finally { syncing.current = false; setSyncBusy(false); }
  }, [projectId, pub, toast, collectOnly]);

  useEffect(() => { if (online && forms) void sync(true); }, [online, forms, sync]);
  useEffect(() => { const t = setInterval(() => void sync(true), 60000); return () => clearInterval(t); }, [sync]);

  // Installing from a shared form's page installs that form, opening on its own link.
  useFormManifest(pub ? { name: pub.form.name, startUrl: window.location.pathname } : null);

  const form = forms?.find((f) => f.id === (draft?.formId ?? formId)) ?? null;
  const mapFeatures: MapFeature[] = useMemo(() => {
    const list: MapFeature[] = (collectOnly ? [] : features).filter((f) => !f.deleted && f.id !== draft?.id).map((f) => ({ id: f.id, geometry: f.geometry, properties: f.properties, pending: f.sync !== "synced" }));
    if (draft?.geometry) list.push({ id: DRAFT_ID, geometry: draft.geometry, pending: true });
    return list;
  }, [features, draft, collectOnly]);

  function startDraft() { if (form) { setDraft({ id: uuid(), formId: form.id, geometry: null, props: applyDefaults(form.fields), newMedia: [], existing: false }); setErrors({}); setAccuracy(null); } }
  async function cancelDraft() {
    stopWatch();
    if (draft?.newMedia.length) await db.media.bulkDelete(draft.newMedia);
    setDraft(null); setPlacing(false); setErrors({});
  }
  // While a record is open, an app update waits instead of reloading the page and losing it.
  const drafting = draft !== null;
  useEffect(() => { setBusy(drafting); return () => setBusy(false); }, [drafting]);

  // Capturing watches the GPS for a few seconds and averages the good readings, instead of trusting a single one.
  const [flyTo, setFlyTo] = useState<{ bounds: Bbox; key: number } | null>(null);
  const showOnMap = useCallback((lon: number, lat: number, hacc: number) => setFlyTo({ bounds: viewAround(lon, lat, hacc), key: Date.now() }), []);
  const watchRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);
  const stopWatch = useCallback(() => {
    if (watchRef.current != null) navigator.geolocation.clearWatch(watchRef.current);
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    watchRef.current = timerRef.current = null;
    setLocating(false);
  }, []);
  useEffect(() => stopWatch, [stopWatch]);

  function capture() {
    if (!navigator.geolocation) { toast("This device can't provide a location. Place the point on the map instead.", "error"); return; }
    stopWatch(); setLocating(true); setAccuracy(null);
    const fixes: Fix[] = [];
    const GOOD = 3, MAX_FIXES = 12, MAX_MS = 15000;
    watchRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const c = pos.coords;
        fixes.push({ lon: c.longitude, lat: c.latitude, acc: c.accuracy, alt: c.altitude, altAcc: c.altitudeAccuracy });
        const r = combineFixes(fixes);
        setAccuracy(Math.round(r.hacc));
        setDraft((d) => d && { ...d, geometry: { type: "Point", coordinates: [r.lon, r.lat] }, props: { ...withoutGps(d.props), ...gpsProps(r) } });
        const settled = (fixes.length >= 3 && r.hacc <= GOOD) || fixes.length >= MAX_FIXES;
        // Zoom to the first reading, and again when the reading has settled. In between the map is left alone, so it does not fight the person panning it.
        if (fixes.length === 1 || settled) showOnMap(r.lon, r.lat, r.hacc);
        if (settled) stopWatch();
      },
      (err) => {
        stopWatch();
        if (fixes.length) return;   // a reading was already taken; keep it
        toast(err.code === 1 ? "Location permission is off. Allow it in settings, or place the point on the map." : "Couldn't get a location fix. Move to open sky and try again, or place the point on the map.", "error");
      },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
    );
    timerRef.current = window.setTimeout(() => { if (fixes.length) { const r = combineFixes(fixes); showOnMap(r.lon, r.lat, r.hacc); stopWatch(); } }, MAX_MS);
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
  const rejected = features.filter((f) => f.sync === "rejected");
  const drawMode = draft && !draft.geometry && placing && form ? form.geometry_type : null;

  return (
    <main className="collect">
      <h1 className="sr-only">Data collector</h1>
      <header className="collect-head">
        {pub ? <BrandMark size={24} /> : <Link to="/collect" style={{ color: "#c3d2ca" }} aria-label="Back to projects">←</Link>}
        <div className="grow"><small>{pub ? "Shared form" : "Project"}</small><strong>{name}</strong></div>
        <span className={`badge ${online ? "badge-ok" : "badge-warn"}`}>{online ? "Online" : "Offline"}{pending ? ` · ${pending} to sync` : ""}</span>
      </header>

      <MapView
        features={mapFeatures}
        selectedId={draft?.geometry ? DRAFT_ID : null}
        drawMode={drawMode}
        onDraw={(g) => { setAccuracy(null); setDraft((d) => d && { ...d, geometry: g, props: { ...withoutGps(d.props), gps_src: "map" } }); setPlacing(false); }}
        onCancelDraw={() => setPlacing(false)}
        fitKey={collectOnly ? projectId : `${projectId}:${features.length > 0}`}
        geolocate
        flyTo={flyTo}
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
            <span className="field-hint">Step 1: set the location.{locating && accuracy != null ? ` Holding still improves it. Now ±${accuracy} m.` : ""}</span>
            {form?.geometry_type === "Point" && <Button variant="accent" busy={locating} onClick={capture}>Capture at my location</Button>}
            <Button onClick={() => setPlacing(true)} disabled={placing}>{form?.geometry_type === "Point" ? "Place on the map" : `Draw the ${form ? GEOMETRY_LABEL[form.geometry_type] : "shape"} on the map`}</Button>
            <Button variant="ghost" onClick={cancelDraft}>Cancel</Button>
          </>
        ) : form && (
          <>
            <div className="row"><h2 className="grow">{draft.existing ? "Edit" : "New"} {form.name.toLowerCase()}</h2>{accuracy != null && <span className="gps">GPS ±{accuracy} m{typeof draft.props.gps_elev_m === "number" ? ` · ${draft.props.gps_elev_m} m elev.` : ""}{locating ? " · averaging…" : ""}</span>}</div>
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
                {(!pub || f.sync !== "synced") && <Button small onClick={() => { setDraft({ id: f.id, formId: f.form_id, geometry: f.geometry, props: { ...f.properties }, newMedia: [], existing: true }); setTab("collect"); }}>Edit</Button>}
                {(!pub || f.sync !== "synced") && <Button small variant="danger" onClick={async () => { if (await confirm({ title: "Delete this record?", message: "It is removed from this device and will not be sent.", confirmLabel: "Delete record", danger: true })) void deleteFeatureLocal(f.id); }}>Delete</Button>}
              </div>
            ))}
          </>
        )}

        {tab === "sync" && (
          <>
            <h2>Sync</h2>
            <InstallCard />
            <div className="list-item"><div className="grow"><strong>{online ? "You're online" : "You're offline"}</strong><small>{pending} change{pending === 1 ? "" : "s"} waiting to send</small></div></div>
            <Button variant="primary" busy={syncBusy} disabled={!online} onClick={() => sync(false)}>Sync now</Button>
            {!online && <span className="field-hint">Connect to the internet to sync. Your records are safe on this device.</span>}
            {syncError && <div className="state state-error" role="alert"><strong>Last sync failed</strong>{syncError}</div>}
            {collectOnly && rejected.length > 0 && (
              <div className="state state-error" role="alert">
                <strong>{rejected.length} record{rejected.length === 1 ? " was" : "s were"} not accepted</strong>
                <span>The server refused {rejected.length === 1 ? "it" : "them"}. Discard {rejected.length === 1 ? "it" : "them"} and collect again.</span>
                <Button small variant="danger" onClick={() => rejected.forEach((f) => void deleteFeatureLocal(f.id))}>Discard</Button>
              </div>
            )}
            {report && <div className="state"><strong>Last sync</strong>Sent {report.pushed} · received {report.pulled} · photos {report.photos}{report.conflicts ? ` · ${report.conflicts} conflicts` : ""}{report.rejected ? ` · ${report.rejected} not accepted` : ""}</div>}
          </>
        )}
      </section>

      <nav className="tabbar" aria-label="Collector sections">
        {((collectOnly ? ["collect", "sync"] : ["collect", "data", "sync"]) as readonly ("collect" | "data" | "sync")[]).map((t) => (
          <button key={t} aria-current={tab === t} onClick={() => setTab(t)}>{t === "collect" ? "Collect" : t === "data" ? "My data" : "Sync"}{t === "sync" && pending ? ` (${pending})` : ""}</button>
        ))}
      </nav>
    </main>
  );
}
