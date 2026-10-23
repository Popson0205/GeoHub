import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import FormRenderer from "../components/FormRenderer";
import MapView, { type MapFeature } from "../components/MapView";
import { BrandMark } from "../components/Shell";
import { Button, ErrorState, Loading } from "../components/ui";
import { ApiError, loadApi } from "../lib/api";
import { applyDefaults, pruneProperties, uuid, validateProperties } from "../lib/forms";
import type { Geometry, Props, PublicForm } from "../lib/types";

const PLACE_HINT = { Point: "Tap the map to mark the spot.", LineString: "Tap the map to add points. Double-tap to finish the line.", Polygon: "Tap the map to add corners. Double-tap to close the area." } as const;

/** The page behind a share link (/f/:token). Public links work without signing in; collaborator links ask people to sign in. */
export default function PublicFormPage() {
  const { token = "" } = useParams();
  const nav = useNavigate();
  const [pf, setPf] = useState<PublicForm | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [id, setId] = useState(uuid);
  const [props, setProps] = useState<Props>({});
  const [geometry, setGeometry] = useState<Geometry | null>(null);
  const [placing, setPlacing] = useState(true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [submitError, setSubmitError] = useState("");

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const f = await (await loadApi()).getPublicForm(token);
        if (!live) return;
        setPf(f); setProps(applyDefaults(f.form.fields));
      } catch (e) {
        if (!live) return;
        if (e instanceof ApiError && e.status === 401) nav("/login", { replace: true, state: { from: `/f/${token}` } });
        else setError(e);
      }
    })();
    return () => { live = false; };
  }, [token, nav]);

  const mapFeatures = useMemo<MapFeature[]>(() => (geometry ? [{ id: "answer", geometry, state: "new" }] : []), [geometry]);

  const shell = (children: ReactNode) => (
    <div style={{ maxWidth: 640, margin: "0 auto", padding: "16px 16px 48px" }}>
      <header style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}><BrandMark /><strong>Geohub</strong></header>
      {children}
    </div>
  );

  if (error != null) {
    const status = error instanceof ApiError ? error.status : 0;
    return shell(
      <div className="card">
        <h1 style={{ marginTop: 0 }}>{status === 403 ? "You do not have access yet" : status === 404 ? "This link does not work" : "Could not open the form"}</h1>
        <p>{error instanceof Error ? error.message : "Something went wrong."}</p>
        {status === 403 && <p className="meta">Ask the form's owner to add your email as a collaborator, or sign in with a different account.</p>}
        {status === 403 && <Link className="btn" to="/login" state={{ from: `/f/${token}` }}>Use a different account</Link>}
        {status === 0 && <ErrorState error={error} onRetry={() => window.location.reload()} />}
      </div>,
    );
  }
  if (!pf) return shell(<Loading label="Opening the form…" />);
  if (pf.access === "member") return <Navigate to={`/collect/${pf.form.project_id}`} replace />;

  const form = pf.form;

  async function submit() {
    setSubmitError("");
    const pruned = pruneProperties(form, props);
    const errs = validateProperties(form, pruned);
    if (!geometry) errs.geometry = "Mark the location on the map.";
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      await (await loadApi()).submitPublic(token, { id, geometry: geometry as Geometry, properties: pruned });
      setDone(true);
    } catch (e) {
      if (e instanceof ApiError && e.fields) setErrors(e.fields);
      setSubmitError(e instanceof Error ? e.message : "Could not send your answers.");
    } finally { setBusy(false); }
  }
  function again() {
    setId(uuid()); setProps(applyDefaults(form.fields)); setGeometry(null); setPlacing(true); setErrors({}); setDone(false);
  }

  if (done) {
    return shell(
      <div className="card" role="status">
        <h1 style={{ marginTop: 0 }}>Thank you</h1>
        <p>Your answers to “{form.name}” were sent to {pf.project_name}.</p>
        <Button variant="primary" onClick={again}>Send another answer</Button>
      </div>,
    );
  }

  return shell(
    <>
      <h1 style={{ marginBottom: 4 }}>{form.name}</h1>
      <p className="meta" style={{ marginTop: 0 }}>{pf.project_name}</p>

      <section aria-label="Location" style={{ marginBottom: 16 }}>
        <h2 style={{ fontSize: "var(--fs-lg, 1.1rem)" }}>Location</h2>
        <div style={{ position: "relative", height: 320, borderRadius: 8, overflow: "hidden" }}>
          <MapView features={mapFeatures} selectedId={geometry ? "answer" : null} drawMode={placing ? form.geometry_type : null}
            onDraw={(g) => { setGeometry(g); setPlacing(false); setErrors((e) => { const { geometry: _g, ...rest } = e; return rest; }); }}
            onCancelDraw={() => setPlacing(false)} geolocate label="Where is it?" />
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          {placing ? <span className="meta">{PLACE_HINT[form.geometry_type]}</span>
            : <Button small onClick={() => { setGeometry(null); setPlacing(true); }}>{geometry ? "Place again" : "Mark on map"}</Button>}
        </div>
        {errors.geometry && <p role="alert" className="field-error">{errors.geometry}</p>}
      </section>

      <FormRenderer form={form} value={props} onChange={setProps} errors={errors} />
      {submitError && <div className="state state-error" role="alert"><strong>Not sent</strong><span>{submitError}</span></div>}
      <div className="row" style={{ marginTop: 16 }}><Button variant="primary" busy={busy} onClick={() => void submit()}>Send</Button></div>
    </>,
  );
}
