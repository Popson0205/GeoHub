import { useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Button, ErrorState, Loading, useToast } from "../../components/ui";
import { loadApi } from "../../lib/api";
import { useAsync } from "../../lib/hooks";
import type { GeoFeature, Job, License, WorkMap } from "../../lib/types";
import { fmtDate, KIND_LABEL, kindOf, plural, slugify, statusOf } from "./shared";

type Kind = "point" | "line" | "area";
const LICENSES: { id: License; label: string }[] = [
  { id: "CC BY 4.0", label: "CC BY 4.0 (share with credit)" }, { id: "ODbL", label: "ODbL (open database, share-alike)" }, { id: "CC0", label: "CC0 (public domain)" }, { id: "Private", label: "Private (members only)" },
];

async function waitFor(job: Job): Promise<Job> {
  const api = await loadApi();
  for (let i = 0; i < 90 && job.status !== "done" && job.status !== "failed"; i++) { await new Promise((r) => setTimeout(r, 1000)); job = await api.getJob(job.id); }
  return job;
}

/** Publish the approved features to the Data hub, one kind of feature per dataset. */
export default function PublishTab({ map, features }: { map: WorkMap; features: GeoFeature[] }) {
  const toast = useToast();
  const published = useAsync((api) => api.mapDatasets(map.id), [map.id]);
  const approved = useMemo(() => { const c: Record<Kind, number> = { point: 0, line: 0, area: 0 }; for (const f of features) if (statusOf(f) === "approved") c[kindOf(f.geometry)]++; return c; }, [features]);
  const waiting = features.filter((f) => statusOf(f) === "submitted").length;
  const NAME: Record<Kind, string> = { point: "point", line: "line", area: "polygon" };
  const PLURAL: Record<Kind, string> = { point: "points", line: "lines", area: "polygons" };
  const first = (["area", "line", "point"] as Kind[]).find((k) => approved[k] > 0) ?? "area";

  const [kind, setKind] = useState<Kind>(first);
  const [title, setTitle] = useState(map.name);
  const [slug, setSlug] = useState(`${slugify(map.name)}-${PLURAL[kind]}`);
  const [slugEdited, setSlugEdited] = useState(false);
  const [description, setDescription] = useState(map.description);
  const [license, setLicense] = useState<License>("CC BY 4.0");
  const [visibility, setVisibility] = useState<"public" | "private">("public");
  const [tags, setTags] = useState("");
  const [credit, setCredit] = useState(true);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState("");

  const suffix = (k: Kind) => PLURAL[k];
  function pickKind(k: Kind) { setKind(k); if (!slugEdited) setSlug(`${slugify(title || map.name)}-${suffix(k)}`); }
  function pickTitle(t: string) { setTitle(t); if (!slugEdited) setSlug(`${slugify(t)}-${suffix(kind)}`); }

  async function publish(e: FormEvent) {
    e.preventDefault();
    setErr(""); setDone(null);
    setBusy(true);
    try {
      const api = await loadApi();
      const r = await api.publishMap(map.id, { title: title.trim(), slug, description, license, visibility: license === "Private" ? "private" : visibility, geometry_type: kind, tags: tags.split(",").map((t) => t.trim()).filter(Boolean), credit_contributors: credit });
      const job = await waitFor(r.job);
      if (job.status === "failed") throw new Error(job.error || "Publishing failed.");
      if (job.status !== "done") throw new Error("Publishing is taking a while. Check the list below in a minute.");
      setDone(r.dataset.slug);
      toast("Published to the Data hub.", "success");
      await published.reload();
    } catch (e2) { setErr(e2 instanceof Error ? e2.message : "Could not publish."); }
    finally { setBusy(false); }
  }
  async function newVersion(slug: string) {
    try {
      const job = await waitFor(await (await loadApi()).newDatasetVersion(slug));
      if (job.status === "failed") throw new Error(job.error || "Publishing failed.");
      toast("New version published.", "success");
      await published.reload();
    } catch (e) { toast(e instanceof Error ? e.message : "Could not publish a new version.", "error"); }
  }

  return (
    <div className="stack" style={{ gap: 24 }}>
      <section className="card" aria-label="What will be published">
        <h2 style={{ margin: 0 }}>Publish to the Data hub</h2>
        <p style={{ margin: 0 }}>Only features a reviewer has <strong>approved</strong> are published, and a dataset holds one kind of feature.</p>
        <div className="stat-grid">
          {(["area", "line", "point"] as Kind[]).map((k) => <div className="card stat" key={k}><strong>{approved[k]}</strong><span>approved {PLURAL[k]}</span></div>)}
          <div className="card stat"><strong>{waiting}</strong><span>still waiting for review</span></div>
        </div>
        {waiting > 0 && <p className="field-hint" style={{ margin: 0 }}>{plural(waiting, "feature")} will be left out until reviewed. <Link to="?tab=review">Go to Review</Link></p>}
      </section>

      <form className="card" onSubmit={publish} aria-label="Publish settings" style={{ maxWidth: 640 }}>
        <div className="field">
          <label htmlFor="kind">What to publish</label>
          <select id="kind" value={kind} onChange={(e) => pickKind(e.target.value as Kind)}>
            {(["area", "line", "point"] as Kind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]} features ({approved[k]} approved)</option>)}
          </select>
        </div>
        <div className="field"><label htmlFor="ptitle">Title</label><input id="ptitle" required maxLength={200} value={title} onChange={(e) => pickTitle(e.target.value)} /></div>
        <div className="field">
          <label htmlFor="pslug">Web address</label>
          <input id="pslug" required pattern="[a-z0-9][a-z0-9\-]{1,62}" value={slug} onChange={(e) => { setSlug(e.target.value.toLowerCase()); setSlugEdited(true); }} />
          <span className="field-hint">/hub/{slug || "…"}. Lowercase letters, numbers and hyphens.</span>
        </div>
        <div className="field"><label htmlFor="pdesc">Description</label><textarea id="pdesc" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} /></div>
        <div className="two-col">
          <div className="field"><label htmlFor="plic">Licence</label><select id="plic" value={license} onChange={(e) => setLicense(e.target.value as License)}>{LICENSES.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}</select></div>
          <div className="field"><label htmlFor="pvis">Who can see it</label><select id="pvis" value={license === "Private" ? "private" : visibility} disabled={license === "Private"} onChange={(e) => setVisibility(e.target.value as "public" | "private")}><option value="public">Everyone</option><option value="private">Map members only</option></select></div>
        </div>
        <div className="field"><label htmlFor="ptags">Tags</label><input id="ptags" value={tags} placeholder="buildings, osogbo" onChange={(e) => setTags(e.target.value)} /><span className="field-hint">Separate with commas.</span></div>
        <label className="check"><input type="checkbox" checked={credit} onChange={(e) => setCredit(e.target.checked)} />Credit contributors by name on the dataset page</label>
        {err && <span className="field-error" role="alert">{err}</span>}
        {done && <span role="status">Published. <Link to={`/hub/${done}`}>Open the dataset</Link></span>}
        <div className="row"><Button type="submit" variant="primary" busy={busy} disabled={approved[kind] === 0}>{approved[kind] === 0 ? `No approved ${NAME[kind]} features yet` : `Publish ${plural(approved[kind], NAME[kind])}`}</Button></div>
      </form>

      <section className="card" aria-label="Published datasets">
        <h2 style={{ margin: 0 }}>Published from this map</h2>
        {published.loading && <Loading label="Loading…" />}
        {published.error != null && <ErrorState error={published.error} onRetry={published.reload} />}
        {published.data && published.data.length === 0 && <span className="field-hint">Nothing published yet.</span>}
        {published.data && published.data.length > 0 && (
          <ul className="plain-list">
            {published.data.map((d) => (
              <li key={d.slug} className="row" style={{ flexWrap: "wrap" }}>
                <div className="grow"><Link to={`/hub/${d.slug}`}><strong>{d.title}</strong></Link><div className="field-hint">Version {d.latest_version} · {plural(d.feature_count, "feature")} · {fmtDate(d.updated_at)} · {d.visibility === "private" ? "members only" : "public"}</div></div>
                <Button small onClick={() => newVersion(d.slug)}>Publish new version</Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
