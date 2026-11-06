import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useParams } from "react-router-dom";
import { useLiveQuery } from "dexie-react-hooks";
import ConflictCard from "../components/ConflictCard";
import FormRenderer, { type MediaCtx } from "../components/FormRenderer";
import SignaturePad from "../components/SignaturePad";
import MapView, { type Bbox, type MapFeature } from "../components/MapView";
import { BrandMark } from "../components/Shell";
import { InstallCard } from "../components/PwaPrompts";
import { Button, ErrorState, Loading, useToast, useUndoable } from "../components/ui";
import { loadApi } from "../lib/api";
import { LANGS, setLang, t, useLang, type Lang } from "../lib/i18n";
import { combineFixes, gpsProps, isMoving, POOR_M, quality, TARGET_M, viewAround, withoutGps, type Fix } from "../lib/gps";
import PlanPlotter from "../components/PlanPlotter";
import { planText, readPlan } from "../lib/surveyPlan";
import { gpsAllowed, useGpsWarmup } from "../lib/useGpsWarmup";
import { listenGps } from "../lib/gpsStream";
import { db, type LocalFeature, type LocalMedia, type ConflictRow } from "../lib/db";
import { topLevelFields } from "../lib/fieldSpec";
import { applyDefaults, pruneProperties, uuid, validateProperties } from "../lib/forms";
import { useOnline } from "../lib/hooks";
import { isCollectorApp, setBusy, useFormManifest } from "../lib/pwa";
import { deleteFeatureLocal, loadBundle, resolveConflict, saveFeatureLocal, syncProject, syncPublic, type SyncReport } from "../lib/sync";
import { type Form, type FormField, type Geometry, type Props, type PublicForm } from "../lib/types";

interface Draft { id: string; formId: string; geometry: Geometry | null; props: Props; newMedia: string[]; existing: boolean }
const DRAFT_ID = "__draft";

/** `pub` is set when the collector is opened from a share link: no sign-in, records are sent through the public route. */
export default function CollectPage({ pub }: { pub?: PublicForm } = {}) {
  const { projectId: routeProjectId = "" } = useParams();
  const lang = useLang();   // re-render in the chosen language
  // Records made through a share link are kept under their own local key so they never mix with a signed-in collector's data.
  const projectId = pub ? `public:${pub.token}` : routeProjectId;
  const toast = useToast();
  const undoable = useUndoable();
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
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
  const [plotting, setPlotting] = useState(false);                 // an area from its survey plan (components/PlanPlotter)
  const [planPreview, setPlanPreview] = useState<Geometry | null>(null);
  const [locating, setLocating] = useState(false);
  const [accuracy, setAccuracy] = useState<number | null>(null);
  /** The capture in progress or just finished: how many readings were used, and whether the person moved. */
  const [reading, setReading] = useState<{ used: number; moved: boolean } | null>(null);
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
      if (!quiet) toast(`${t("toast.syncDone", { sent: r.pushed, got: r.pulled })}${r.conflicts ? ` ${t("toast.syncDecide", { n: r.conflicts })}` : ""}`, r.conflicts || r.rejected ? "info" : "success");
    } catch (e) {
      setSyncError(e instanceof Error ? e.message : "Sync failed.");
      if (!quiet) toast(t("toast.syncError"), "error");
    } finally { syncing.current = false; setSyncBusy(false); }
  }, [projectId, pub, toast, collectOnly]);

  useEffect(() => { if (online && forms) void sync(true); }, [online, forms, sync]);
  useEffect(() => { const timer = setInterval(() => void sync(true), 60000); return () => clearInterval(timer); }, [sync]);

  // Installing from a shared form's page installs that form, opening on its own link.
  useFormManifest(pub ? { name: pub.form.name, startUrl: window.location.pathname } : null);

  const form = forms?.find((f) => f.id === (draft?.formId ?? formId)) ?? null;
  const mapFeatures: MapFeature[] = useMemo(() => {
    const list: MapFeature[] = (collectOnly ? [] : features).filter((f) => !f.deleted && f.id !== draft?.id).map((f) => ({ id: f.id, geometry: f.geometry, properties: f.properties, pending: f.sync !== "synced" }));
    if (draft?.geometry) list.push({ id: DRAFT_ID, geometry: draft.geometry, pending: true });
    else if (planPreview) list.push({ id: DRAFT_ID, geometry: planPreview, pending: true });
    return list;
  }, [features, draft, collectOnly, planPreview]);

  function startDraft() { if (form) { setDraft({ id: uuid(), formId: form.id, geometry: null, props: applyDefaults(form.fields), newMedia: [], existing: false }); setErrors({}); setAccuracy(null); } }
  async function cancelDraft() {
    stopWatch();
    if (draft?.newMedia.length) await db.media.bulkDelete(draft.newMedia);
    setDraft(null); setPlacing(false); setPlotting(false); setPlanPreview(null); setErrors({});
  }
  const bboxOf = (g: Geometry): Bbox => {
    const pts = (g as { coordinates: number[][][] }).coordinates[0];
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  };
  const previewPlan = (g: Geometry | null) => { setPlanPreview(g); if (g) setFlyTo({ bounds: bboxOf(g), key: Date.now() }); };
  const usePlan = (g: Geometry, plan: Parameters<typeof planText>[0]) => {
    setAccuracy(null); setPlotting(false); setPlanPreview(null);
    setDraft((d) => d && { ...d, geometry: g, props: { ...withoutGps(d.props), gps_src: "plan", plan_json: planText(plan) } });
  };
  // While a record is open, an app update waits instead of reloading the page and losing it.
  const drafting = draft !== null;
  useEffect(() => { setBusy(drafting); return () => setBusy(false); }, [drafting]);

  // Capturing watches the GPS for a few seconds and averages the good readings, instead of trusting a single one.
  const [flyTo, setFlyTo] = useState<{ bounds: Bbox; key: number } | null>(null);
  const showOnMap = useCallback((lon: number, lat: number, hacc: number) => setFlyTo({ bounds: viewAround(lon, lat, hacc), key: Date.now() }), []);
  const watchRef = useRef<(() => void) | null>(null);
  const timerRef = useRef<number | null>(null);
  const stopWatch = useCallback(() => {
    watchRef.current?.();
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    watchRef.current = timerRef.current = null;
    setLocating(false);
  }, []);
  useEffect(() => stopWatch, [stopWatch]);
  // Keep the GPS warm while someone is about to capture, so the first readings are already good.
  const warm = useGpsWarmup(tab === "collect" && !!form && form.geometry_type === "Point" && !locating && (!draft || !draft.geometry));

  /**
   * Watch the GPS and average the readings, dropping ones that jump away, until the result is good (±5 m from
   * at least five readings) or 45 seconds pass. The person can stop sooner with "Use this location". If they
   * walk off, averaging starts again from where they now stand.
   */
  function capture() {
    if (!navigator.geolocation) { toast(t("gps.noDevice"), "error"); return; }
    stopWatch(); setLocating(true); setAccuracy(null); setReading(null);
    let fixes: Fix[] = [];
    const MIN_FIXES = 5, MAX_FIXES = 60, MAX_MS = 45000;
    watchRef.current = listenGps(
      (pos) => {
        const c = pos.coords;
        gpsAllowed();
        fixes.push({ lon: c.longitude, lat: c.latitude, acc: c.accuracy, alt: c.altitude, altAcc: c.altitudeAccuracy, speed: c.speed });
        let moved = false;
        if (isMoving(fixes)) { fixes = fixes.slice(-1); moved = true; }
        const r = combineFixes(fixes);
        setAccuracy(Math.round(r.hacc));
        setReading((cur) => ({ used: r.used, moved: moved || (!!cur?.moved && fixes.length < 3) }));
        setDraft((d) => d && { ...d, geometry: { type: "Point", coordinates: [r.lon, r.lat] }, props: { ...withoutGps(d.props), ...gpsProps(r) } });
        const settled = (fixes.length >= MIN_FIXES && r.hacc <= TARGET_M) || fixes.length >= MAX_FIXES;
        // Zoom to the first reading, and again when the reading has settled. In between the map is left alone, so it does not fight the person panning it.
        if (fixes.length === 1 || moved || settled) showOnMap(r.lon, r.lat, r.hacc);
        if (settled) stopWatch();
      },
      (err) => {
        stopWatch();
        if (fixes.length) return;   // a reading was already taken; keep it
        toast(err.code === 1 ? t("gps.denied") : t("gps.noFix"), "error");
      },
    );
    timerRef.current = window.setTimeout(() => { if (fixes.length) { const r = combineFixes(fixes); showOnMap(r.lon, r.lat, r.hacc); stopWatch(); } }, MAX_MS);
  }

  async function save() {
    if (!draft || !form || !draft.geometry) return;
    const errs = validateProperties(form, draft.props);
    setErrors(errs);
    if (Object.keys(errs).length) { toast(t("toast.fixFields"), "error"); return; }
    await saveFeatureLocal({ id: draft.id, project_id: projectId, form, geometry: draft.geometry, properties: pruneProperties(form, draft.props) });
    toast(navigator.onLine ? t("toast.savedSyncing") : t("toast.savedOffline"), "success");
    setDraft(null); setPlacing(false);
    void sync(true);
  }

  async function addMedia(field: FormField, file: Blob | undefined, ctx: MediaCtx) {
    if (!file || !draft) return;
    const cap = field.max_items ?? (field.type === "signature" ? 1 : field.type === "photo" ? 3 : 10);
    if (ctx.value.length >= cap) { toast(t("media.cap", { n: cap }), "error"); return; }
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
              <button type="button" className="media-x" aria-label={t("media.remove", { name: field.label, i: i + 1 })} onClick={() => void dropMedia(id, ctx)}>×</button>
            </span>
          ))}
        </div>
        {field.type === "signature" ? (
          <SignaturePad disabled={ctx.value.length >= cap} onDone={(png) => void addMedia(field, png, ctx)} />
        ) : (
          <label className="upload">{field.type === "photo" ? t("media.photo") : field.type === "audio" ? t("media.audio") : field.type === "video" ? t("media.video") : t("media.file")} ({ctx.value.length}/{cap})
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

  // A record deleted a moment ago stays hidden while its Undo is on screen.
  const visible = features.filter((f) => !f.deleted && !hiddenIds.has(f.id));
  // Records a reviewer sent back, with their note. They are listed on their own, first.
  const returned = visible.filter((f) => f.status === "rejected" && f.sync === "synced");
  const mine = visible.filter((f) => !returned.includes(f));
  const editRecord = (f: LocalFeature) => { setDraft({ id: f.id, formId: f.form_id, geometry: f.geometry, props: { ...f.properties }, newMedia: [], existing: true }); setTab("collect"); };
  const returnedList = returned.length > 0 && (
    <section className="returned" aria-labelledby="returned-title">
      <h2 id="returned-title">{t("returned.title")}</h2>
      <p className="field-hint">{t(returned.length === 1 ? "returned.one" : "returned.many")}</p>
      {returned.map((f) => (
        <div className="list-item returned-item" key={f.id}>
          <div className="grow">
            <strong>{titleOf(f)}</strong>
            {f.review_note ? <blockquote className="returned-note"><span className="sr-only">{t("returned.noteLabel")} </span>{f.review_note}</blockquote> : <small>{t("returned.noNote")}</small>}
          </div>
          <Button small variant="primary" onClick={() => editRecord(f)}>{t("returned.fix")}</Button>
        </div>
      ))}
    </section>
  );
  const rejected = features.filter((f) => f.sync === "rejected");
  const drawMode = draft && !draft.geometry && placing && form ? form.geometry_type : null;

  return (
    // Before a record is started the sheet only holds the form choice and one button: size it to that and give
    // the rest of the screen to the map, so the button sits low in thumb reach and the field is easy to see.
    <main className={`collect${tab === "collect" && !draft && forms && forms.length > 0 ? " is-idle" : ""}`}>
      <h1 className="sr-only">Data collector</h1>
      <header className="collect-head">
        {pub ? <BrandMark size={24} /> : <Link to="/collect" style={{ color: "#c3d2ca" }} aria-label={t("head.back")}>←</Link>}
        <div className="grow"><small>{pub ? t("head.shared") : t("head.project")}</small><strong>{name}</strong></div>
        <label className="lang-pick">
          <span className="sr-only">{t("head.language")}</span>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z" /></svg>
          <select value={lang} onChange={(e) => setLang(e.target.value as Lang)}>
            {LANGS.map((l) => <option key={l.id} value={l.id} lang={l.id === "pcm" ? "pcm" : l.id}>{l.name}</option>)}
          </select>
        </label>
        <span className={`badge ${online ? "badge-ok" : "badge-warn"}`}>{online ? t("head.online") : t("head.offline")}{pending ? ` · ${pending} to sync` : ""}</span>
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

      <section className="sheet" aria-label={tab === "collect" ? t("tab.collect") : tab === "data" ? t("tab.data") : t("tab.sync")}>
        {forms === null && loadError == null && <Loading label={t("load.project")} />}
        {loadError != null && <ErrorState error={loadError} onRetry={load} />}
        {fromCache && <span className="badge badge-warn" style={{ alignSelf: "flex-start" }}>{t("load.cached")}</span>}

        {forms && tab === "collect" && (forms.length === 0 ? (
          <div className="state"><strong>{t("forms.none.title")}</strong>{t("forms.none.text")}</div>
        ) : !draft ? (
          <>
            {collectOnly && returnedList}
            <h2>{t("collect.title")}</h2>
            {forms.length > 1 && (
              <div className="choice-row" role="group" aria-label={t("collect.form")}>
                {forms.map((f) => <button key={f.id} className="choice" aria-pressed={formId === f.id} onClick={() => setFormId(f.id)}>{f.name}</button>)}
              </div>
            )}
            <Button variant="accent" onClick={startDraft} disabled={!form}>{t("collect.new", { name: form ? form.name.toLowerCase() : "" }).trim()}</Button>
          </>
        ) : !draft.geometry && plotting ? (
          <PlanPlotter initial={readPlan(draft.props.plan_json)} onPreview={previewPlan} onUse={usePlan} onCancel={() => setPlotting(false)} />
        ) : !draft.geometry ? (
          <>
            <h2>{t("collect.new", { name: form?.name.toLowerCase() ?? "" })}</h2>
            <span className="field-hint">{t("collect.step1")}{locating && accuracy != null ? ` ${t("collect.holdStill", { m: accuracy })}` : ""}</span>
            {form?.geometry_type === "Point" && !locating && warm.on && (
              <span className={`gps-ready is-${warm.accuracy == null ? "wait" : quality(warm.accuracy)}`} role="status">
                <span className="gps-dot" aria-hidden="true" />{warm.accuracy == null ? t("gps.finding") : t("gps.ready", { m: warm.accuracy })}
              </span>
            )}
            {form?.geometry_type === "Point" && <Button variant="accent" busy={locating} onClick={capture}>{t("collect.capture")}</Button>}
            {form?.geometry_type === "Polygon" && <Button variant="accent" onClick={() => setPlotting(true)}>{t("plan.open")}</Button>}
            <Button onClick={() => setPlacing(true)} disabled={placing}>{form?.geometry_type === "Point" ? t("collect.place") : form?.geometry_type === "Polygon" ? t("plan.noPlan") : t("collect.draw")}</Button>
            <Button variant="ghost" onClick={cancelDraft}>{t("cancel")}</Button>
          </>
        ) : form && (
          <>
            <div className="row"><h2 className="grow">{t(draft.existing ? "collect.edit" : "collect.new", { name: form.name.toLowerCase() })}</h2>{accuracy != null && <span className={`gps is-${quality(accuracy)}`} role="status">GPS ±{accuracy} m{typeof draft.props.gps_elev_m === "number" ? ` · ${t("gps.elev", { m: draft.props.gps_elev_m })}` : ""}{locating ? ` · ${t("gps.averaging")}${reading && reading.used > 1 ? ` (${t("gps.readings", { n: reading.used })})` : ""}` : ""}</span>}</div>
            {locating && draft.geometry?.type === "Point" && (
              <div className="gps-panel" aria-live="polite">
                <span>{reading?.moved ? t("gps.moved") : t("gps.standStill")}</span>
                <Button small onClick={stopWatch}>{t("gps.useNow")}</Button>
              </div>
            )}
            {!locating && accuracy != null && accuracy > POOR_M && draft.props.gps_src === "gps" && (
              <div className="gps-panel is-poor" role="note">
                <span>{t("gps.tip")}</span>
                <Button small onClick={capture}>{t("gps.again")}</Button>
              </div>
            )}
            {readPlan(draft.props.plan_json) && (() => { const p = readPlan(draft.props.plan_json)!; return (
              <div className="plan-entry" role="note"><span><strong>{t("plan.from")}</strong> · {p.flagged ? <>{t("plan.flagged")} · </> : null}{p.ratio == null ? t("plan.exact") : t("plan.closes", { r: p.ratio.toLocaleString(), m: p.misclosure_m })} · {p.area_m2.toLocaleString()} m²</span>
                <Button small onClick={() => { setDraft((d) => d && { ...d, geometry: null }); setPlotting(true); }}>{t("plan.replot")}</Button></div>); })()}
            <FormRenderer form={form} value={draft.props} onChange={(p) => setDraft((d) => d && { ...d, props: p })} errors={errors} renderMedia={renderMedia} />
            <div className="row" style={{ position: "sticky", bottom: 0, background: "var(--n-0)", padding: "8px 0" }}>
              <Button onClick={cancelDraft}>{t("cancel")}</Button>
              <Button className="grow" variant="accent" onClick={save}>{online ? t("collect.saveOnline") : t("collect.saveOffline")}</Button>
            </div>
          </>
        ))}

        {tab === "data" && (
          <>
            {returnedList}
            <h2>{t("data.title")}</h2>
            {conflicts.map((c) => (
              <ConflictCard key={c.id} row={c} form={forms?.find((f) => f.id === c.mine.form_id)} title={titleOf(c.mine)}
                onResolve={(choice) => void resolveConflict(c.id, choice).then(() => { if (choice !== "server") void sync(true); })} />
            ))}
            {mine.length === 0 && !returned.length && <div className="state"><strong>{t("data.empty.title")}</strong>{t("data.empty.text")}</div>}
            {mine.map((f) => (
              <div className="list-item" key={f.id}>
                <div className="grow">
                  <strong>{titleOf(f)}</strong>
                  <small>{f.sync === "synced" ? t("status.synced") : f.sync === "pending" ? t("status.pending") : f.sync === "conflict" ? t("status.conflict") : t("status.rejected", { why: Object.values(f.errors ?? {}).join(" ") })}</small>
                </div>
                {(!pub || f.sync !== "synced") && <Button small onClick={() => editRecord(f)}>{t("edit")}</Button>}
                {(!pub || f.sync !== "synced") && <Button small variant="danger" onClick={() => undoable({
                  text: t("toast.deleted", { name: titleOf(f) }),
                  hide: () => setHiddenIds((h) => new Set(h).add(f.id)),
                  commit: async () => { await deleteFeatureLocal(f.id); setHiddenIds((h) => { const n = new Set(h); n.delete(f.id); return n; }); },
                  restore: () => setHiddenIds((h) => { const n = new Set(h); n.delete(f.id); return n; }),
                })}>{t("delete")}</Button>}
              </div>
            ))}
          </>
        )}

        {tab === "sync" && (
          <>
            <h2>{t("sync.title")}</h2>
            <InstallCard />
            <div className="list-item"><div className="grow"><strong>{online ? t("sync.online") : t("sync.offline")}</strong><small>{pending === 1 ? t("sync.waitOne") : t("sync.waitMany", { n: pending })}</small></div></div>
            <Button variant="primary" busy={syncBusy} disabled={!online} onClick={() => sync(false)}>{t("sync.now")}</Button>
            {!online && <span className="field-hint">{t("sync.offlineText")}</span>}
            {syncError && <div className="state state-error" role="alert"><strong>{t("sync.failed")}</strong>{syncError}</div>}
            {collectOnly && rejected.length > 0 && (
              <div className="state state-error" role="alert">
                <strong>{rejected.length === 1 ? t("sync.refusedOne") : t("sync.refusedMany", { n: rejected.length })}</strong>
                <span>{t("sync.refusedText")}</span>
                <Button small variant="danger" onClick={() => rejected.forEach((f) => void deleteFeatureLocal(f.id))}>{t("sync.discard")}</Button>
              </div>
            )}
            {report && <div className="state"><strong>{t("sync.last")}</strong>{t("sync.report", { sent: report.pushed, got: report.pulled, photos: report.photos })}{report.conflicts ? ` · ${report.conflicts} conflicts` : ""}{report.rejected ? ` · ${report.rejected} not accepted` : ""}</div>}
          </>
        )}
      </section>

      <nav className="tabbar" aria-label={t("tab.sections")}>
        {((collectOnly ? ["collect", "sync"] : ["collect", "data", "sync"]) as readonly ("collect" | "data" | "sync")[]).map((s) => (
          <button key={s} aria-current={tab === s} onClick={() => setTab(s)}>{s === "collect" ? t("tab.collect") : s === "data" ? t("tab.data") : t("tab.sync")}{s === "sync" && pending ? ` (${pending})` : ""}{s === "data" && returned.length > 0 && <span className="tab-count"><span className="sr-only">, </span>{returned.length}<span className="sr-only"> {t("tab.returned")}</span></span>}</button>
        ))}
      </nav>
    </main>
  );
}
