import { useMemo, useState } from "react";
import MapView, { type Bbox, type MapFeature } from "../../components/MapView";
import { Button, EmptyState, useToast } from "../../components/ui";
import { loadApi } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { bboxOf } from "../../lib/forms";
import type { GeoFeature, ReviewStatus, WorkMap } from "../../lib/types";
import { ago, KIND_LABEL, kindOf, plural, STATUS_BADGE, STATUS_LABEL, statusOf, tagSummary } from "./shared";

const FILTERS: { id: ReviewStatus | "all"; label: string }[] = [
  { id: "submitted", label: "Waiting" }, { id: "approved", label: "Approved" }, { id: "rejected", label: "Rejected" }, { id: "all", label: "All" },
];
const PAGE = 100;

/** Look at what people drew and approve or reject it. Only approved features are published to the Data hub. */
export default function ReviewTab({ map, features, authorFilter, onAuthor, onChanged }: {
  map: WorkMap; features: GeoFeature[]; authorFilter: string; onAuthor: (id: string) => void; onChanged: () => Promise<void> | void;
}) {
  const toast = useToast();
  const { user } = useAuth();
  const canReview = map.role !== "contributor";
  const [status, setStatus] = useState<ReviewStatus | "all">(canReview ? "submitted" : "all");
  const [picked, setPicked] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const [fly, setFly] = useState<{ bounds: Bbox; key: number } | null>(null);

  // Contributors only ever see their own work here, so they can read the reviewers' notes.
  const author = canReview ? authorFilter : user?.id ?? "";
  const authors = useMemo(() => { const m = new Map<string, string>(); for (const f of features) if (f.created_by) m.set(f.created_by, f.author ?? "Unknown"); return [...m].sort((a, b) => a[1].localeCompare(b[1])); }, [features]);
  const counts = useMemo(() => {
    const c = { submitted: 0, approved: 0, rejected: 0, all: 0 };
    for (const f of features) if (!author || f.created_by === author) { c[statusOf(f)]++; c.all++; }
    return c;
  }, [features, author]);
  const shown = useMemo(() => features.filter((f) => (status === "all" || statusOf(f) === status) && (!author || f.created_by === author)), [features, status, author]);
  const onMap: MapFeature[] = useMemo(() => shown.map((f) => ({ id: f.id, geometry: f.geometry, properties: f.properties, state: statusOf(f) === "approved" ? "clean" : statusOf(f) === "rejected" ? "rejected" : "new" })), [shown]);

  const pickedShown = picked.filter((id) => shown.some((f) => f.id === id));
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  function look(f: GeoFeature) { const b = bboxOf([f.geometry]); if (b) setFly({ bounds: b as Bbox, key: Date.now() }); }

  async function review(to: ReviewStatus) {
    if (!pickedShown.length) return;
    setBusy(true);
    try {
      const n = await (await loadApi()).reviewFeatures(map.id, pickedShown, to, note);
      toast(`${plural(n, "feature")} ${to === "approved" ? "approved" : to === "rejected" ? "rejected" : "sent back to the waiting list"}.`, "success");
      setPicked([]); setNote("");
      await onChanged();
    } catch (e) { toast(e instanceof Error ? e.message : "Could not save the review.", "error"); }
    finally { setBusy(false); }
  }

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
        <div role="group" aria-label="Show features" className="row" style={{ gap: 6, flexWrap: "wrap" }}>
          {FILTERS.map((f) => <Button key={f.id} small variant={status === f.id ? "primary" : "default"} aria-pressed={status === f.id} onClick={() => { setStatus(f.id); setLimit(PAGE); }}>{f.label} ({counts[f.id]})</Button>)}
        </div>
        <span className="grow" />
        {canReview && (
          <label className="row" style={{ gap: 6, fontSize: 14 }}>Drawn by
            <select value={authorFilter} onChange={(e) => { onAuthor(e.target.value); setLimit(PAGE); }} className="input" style={{ width: "auto", minHeight: 36 }}>
              <option value="">Everyone</option>
              {authors.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
          </label>
        )}
      </div>
      {!canReview && <p className="field-hint" style={{ margin: 0 }}>These are your features. Reviewers approve or reject them and may leave a note.</p>}

      {canReview && (
        <div className="card" style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 10 }} role="region" aria-label="Review actions">
          <label className="check" style={{ minHeight: 0 }}>
            <input type="checkbox" checked={shown.length > 0 && pickedShown.length === shown.length} onChange={(e) => setPicked(e.target.checked ? shown.map((f) => f.id) : [])} />
            Select all {shown.length}
          </label>
          <span className="field-hint">{pickedShown.length ? `${pickedShown.length} selected` : "Tick features, then approve or reject them."}</span>
          <span className="grow" style={{ flex: 1 }} />
          <input className="input" style={{ width: 220, minHeight: 36 }} aria-label="Note for rejected features" placeholder="Note for the contributor (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
          <Button small variant="primary" disabled={!pickedShown.length || busy} onClick={() => review("approved")}>Approve</Button>
          <Button small variant="danger" disabled={!pickedShown.length || busy} onClick={() => review("rejected")}>Reject</Button>
          {status !== "submitted" && <Button small disabled={!pickedShown.length || busy} onClick={() => review("submitted")}>Back to waiting</Button>}
        </div>
      )}

      {shown.length === 0 ? (
        <EmptyState title={status === "submitted" ? "Nothing is waiting for review" : "No features here"}>{status === "submitted" ? "New work from contributors will show up here." : "Try another filter."}</EmptyState>
      ) : (
        <div className="review-grid">
          <div className="review-map"><MapView features={onMap} selectedIds={pickedShown} onSelect={(id) => id && canReview && toggle(id)} flyTo={fly} fitKey={`${map.id}:${status}:${author}`} label="Features to review" /></div>
          <ul className="review-list" aria-label="Features">
            {shown.slice(0, limit).map((f) => {
              const st = statusOf(f);
              return (
                <li key={f.id} className={pickedShown.includes(f.id) ? "picked" : ""}>
                  {canReview && <input type="checkbox" aria-label={`Select ${KIND_LABEL[kindOf(f.geometry)]} by ${f.author ?? "unknown"}`} checked={picked.includes(f.id)} onChange={() => toggle(f.id)} />}
                  <button type="button" className="review-row" onClick={() => look(f)}>
                    <span><strong>{KIND_LABEL[kindOf(f.geometry)]}</strong> · {tagSummary(f)}</span>
                    <span className="field-hint">{f.author ?? "Unknown"} · {ago(f.created_at ?? f.updated_at)}</span>
                    {f.review_note && <span className="field-hint">Note: {f.review_note}</span>}
                  </button>
                  <span className={`badge ${STATUS_BADGE[st]}`}>{STATUS_LABEL[st]}</span>
                </li>
              );
            })}
            {shown.length > limit && <li><Button small onClick={() => setLimit((l) => l + PAGE)}>Show {Math.min(PAGE, shown.length - limit)} more</Button></li>}
          </ul>
        </div>
      )}
    </div>
  );
}
