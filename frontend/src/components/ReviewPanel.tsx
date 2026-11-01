import { useCallback, useEffect, useMemo, useState } from "react";
import MapView from "./MapView";
import { Icon } from "./icons";
import { Button } from "./ui";
import { dashboardFields, display } from "../lib/dashboard";
import { allFields, isMedia } from "../lib/fieldSpec";
import { loadApi } from "../lib/api";
import type { Feature, Form, MediaItem } from "../lib/types";

type Decision = "approved" | "rejected";

/**
 * Review waiting records one at a time: the answers, where it was collected, and the decision.
 * A / R / E decide or edit, J and K (or the arrow keys) move, Escape finishes. After a decision the
 * next waiting record opens, so a reviewer can work through a queue without reaching for the mouse.
 */
export default function ReviewPanel({ form, queue, features, onDecide, onEdit, onClose }: {
  form: Form;
  /** The ids to go through, in order. Fixed when review starts, so decided records keep their place. */
  queue: string[];
  /** Live records, so edits and decisions made here show at once. */
  features: Feature[];
  onDecide: (id: string, decision: Decision, note?: string) => Promise<boolean>;
  onEdit: (f: Feature) => void;
  onClose: () => void;
}) {
  const byId = useMemo(() => new Map(features.map((f) => [f.id, f])), [features]);
  const items = useMemo(() => queue.map((id) => byId.get(id)).filter((f): f is Feature => !!f), [queue, byId]);
  const [at, setAt] = useState(0);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<Decision | null>(null);
  const [tally, setTally] = useState({ approved: 0, rejected: 0 });
  const cur = items[Math.min(at, items.length - 1)];
  const waiting = items.filter((f) => f.status === "submitted").length;
  const done = items.length > 0 && waiting === 0;

  const defs = useMemo(() => dashboardFields(form), [form]);
  const media = useMemo(() => allFields(form.fields).filter((f) => isMedia(f.type)), [form]);
  // The current record's photos and files, fetched when it opens (links expire, so they are not kept).
  const [files_, setFiles] = useState<MediaItem[] | null>(null);
  const [viewing, setViewing] = useState<MediaItem | null>(null);
  const hasMedia = !!cur && media.some((m) => { const v = cur.properties[m.id]; return Array.isArray(v) ? v.length > 0 : !!v; });
  useEffect(() => {
    if (!cur || !hasMedia) { setFiles([]); return; }
    let live = true;
    setFiles(null);
    loadApi().then((api) => api.getFeatureMedia(cur.id)).then((m) => { if (live) setFiles(m); }).catch(() => { if (live) setFiles([]); });
    return () => { live = false; };
  }, [cur?.id, hasMedia]); // eslint-disable-line react-hooks/exhaustive-deps

  const go = useCallback((i: number) => { setAt(Math.max(0, Math.min(items.length - 1, i))); setNote(""); }, [items.length]);
  /** The next record still waiting, after this one, wrapping round to the start. */
  const nextWaiting = useCallback((from: number, list: Feature[]) => {
    for (let k = 1; k <= list.length; k++) {
      const i = (from + k) % list.length;
      if (list[i].status === "submitted") return i;
    }
    return -1;
  }, []);

  const decide = useCallback(async (d: Decision) => {
    if (!cur || busy) return;
    setBusy(d);
    const okDone = await onDecide(cur.id, d, note.trim() || undefined);
    setBusy(null);
    if (!okDone) return;
    setTally((t) => ({ ...t, [d]: t[d] + 1 }));
    setNote("");
    // The list has not re-rendered yet: count this record as decided when looking for the next one.
    const after = items.map((f) => (f.id === cur.id ? { ...f, status: d } : f));
    const n = nextWaiting(at, after);
    if (n >= 0) setAt(n);
  }, [cur, busy, onDecide, note, items, at, nextWaiting]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (viewing) { if (e.key === "Escape") { e.preventDefault(); setViewing(null); } return; }   // the photo viewer has the keyboard
      const t = e.target as HTMLElement | null;
      if (t && (t.closest("input, textarea, select, [contenteditable=true]") || t.closest(".dialog"))) {
        if (e.key === "Escape" && t.closest("textarea, input")) (t as HTMLElement).blur();
        return;
      }
      const k = e.key.toLowerCase();
      if (k === "escape") { onClose(); return; }
      if (!cur) return;
      if (k === "a" && cur.status !== "approved") { e.preventDefault(); void decide("approved"); }
      else if (k === "r" && cur.status !== "rejected") { e.preventDefault(); void decide("rejected"); }
      else if (k === "e") { e.preventDefault(); onEdit(cur); }
      else if (k === "j" || k === "arrowright") { e.preventDefault(); go(at + 1); }
      else if (k === "k" || k === "arrowleft") { e.preventDefault(); go(at - 1); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [cur, decide, onEdit, onClose, go, at, viewing]);

  if (!items.length) {
    return (
      <section className="review card" aria-label="Review records">
        <div className="state"><span className="state-icon" aria-hidden="true"><Icon name="check" size={24} /></span><strong>Nothing waiting for review</strong><span className="state-text">New records from collectors will show up here.</span><div className="state-action"><Button onClick={onClose}>Back to the table</Button></div></div>
      </section>
    );
  }

  const progress = Math.round(((items.length - waiting) / items.length) * 100);
  return (
    <section className="review" aria-label="Review records">
      <header className="review-head">
        <div className="review-title">
          <h2>Review “{form.name}”</h2>
          <p className="muted" aria-live="polite">
            {done ? "All caught up." : `${waiting} of ${items.length} still waiting`}
            {(tally.approved > 0 || tally.rejected > 0) && ` · ${tally.approved} approved, ${tally.rejected} rejected just now`}
          </p>
        </div>
        <div className="review-progress" role="progressbar" aria-label="Reviewed" aria-valuemin={0} aria-valuemax={items.length} aria-valuenow={items.length - waiting}>
          <span style={{ width: `${progress}%` }} />
        </div>
        <Button variant="ghost" onClick={onClose} aria-keyshortcuts="Escape">Finish reviewing<kbd aria-hidden="true">Esc</kbd></Button>
      </header>

      {done ? (
        <div className="state review-done">
          <span className="state-icon" aria-hidden="true"><Icon name="check" size={24} /></span>
          <strong>Every record has a decision</strong>
          <span className="state-text">{tally.approved} approved and {tally.rejected} rejected in this session. Approved records are what dashboards and the data hub show.</span>
          <div className="state-action"><Button variant="primary" onClick={onClose}>Back to the table</Button></div>
        </div>
      ) : cur && (
        <>
          <div className="review-body">
            <div className="review-record card">
              <div className="review-record-head">
                <span className="mono muted">Record {at + 1} of {items.length}</span>
                <span className={`badge ${cur.status === "approved" ? "badge-ok" : cur.status === "rejected" ? "badge-bad" : "badge-warn"}`}>{cur.status === "submitted" ? "Waiting" : cur.status === "approved" ? "Approved" : cur.status === "rejected" ? "Rejected" : "Draft"}</span>
                <span className="grow" />
                <span className="muted">Sent {new Date(cur.updated_at).toLocaleString()}</span>
              </div>
              <dl className="review-answers">
                {defs.map((d) => {
                  const v = display(cur, d);
                  return <div key={d.id}><dt>{d.label}</dt><dd className={v ? undefined : "is-empty"}>{v ? `${v}${d.unit && v ? ` ${d.unit}` : ""}` : "Not answered"}</dd></div>;
                })}
                {media.map((m) => {
                  const v = cur.properties[m.id];
                  const ids = Array.isArray(v) ? (v as string[]) : v ? [String(v)] : [];
                  const files = (files_ ?? []).filter((f) => ids.includes(f.id) || f.field_id === m.id);
                  const word = m.type === "photo" ? (ids.length === 1 ? "photo" : "photos") : ids.length === 1 ? "file" : "files";
                  return (
                    <div key={m.id}><dt>{m.label || m.id}</dt>
                      <dd className={ids.length ? undefined : "is-empty"}>
                        {!ids.length ? "None" : files.length ? (
                          <span className="review-media">
                            {files.map((f, i) => f.kind === "photo" || f.kind === "image" || f.kind === "signature"
                              ? <button key={f.id} type="button" className="review-thumb" onClick={() => setViewing(f)} aria-label={`View ${m.label || "photo"} ${i + 1} of ${files.length} larger`}><img src={f.url} alt="" loading="lazy" /></button>
                              : f.kind === "audio" ? <audio key={f.id} controls src={f.url} preload="none" aria-label={`${m.label || "Recording"} ${i + 1}`} />
                              : f.kind === "video" ? <video key={f.id} controls src={f.url} preload="none" className="review-video" aria-label={`${m.label || "Video"} ${i + 1}`} />
                              : <a key={f.id} href={f.url} target="_blank" rel="noreferrer">Open file {i + 1}</a>)}
                            {ids.length > files.length && <span className="muted review-media-missing">{ids.length - files.length} more not uploaded yet</span>}
                          </span>
                        ) : files_ === null ? <span className="muted">Loading {ids.length} {word}…</span>
                          : <span className="muted">{ids.length} {word}, not uploaded yet (still on the collector's phone)</span>}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            </div>
            <div className="review-map">
              <MapView features={[{ id: cur.id, geometry: cur.geometry, state: "review" }]} selectedId={cur.id} fitKey={cur.id} label="Where this record was collected" />
            </div>
          </div>

          <footer className="review-actions">
            <div className="review-nav">
              <Button onClick={() => go(at - 1)} disabled={at === 0} aria-label="Previous record" title="Previous record (K)"><Icon name="arrowLeft" size={18} /></Button>
              <Button onClick={() => go(at + 1)} disabled={at >= items.length - 1} aria-label="Next record" title="Next record (J)"><span style={{ display: "inline-flex", transform: "scaleX(-1)" }}><Icon name="arrowLeft" size={18} /></span></Button>
            </div>
            <label className="review-note">
              <span className="sr-only">Note to the collector (optional)</span>
              <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note to the collector (optional)" maxLength={500} />
            </label>
            <Button onClick={() => onEdit(cur)} aria-keyshortcuts="E">Edit<kbd aria-hidden="true">E</kbd></Button>
            <Button variant="danger" busy={busy === "rejected"} disabled={!!busy || cur.status === "rejected"} onClick={() => void decide("rejected")} aria-keyshortcuts="R">Reject<kbd aria-hidden="true">R</kbd></Button>
            <Button variant="primary" busy={busy === "approved"} disabled={!!busy || cur.status === "approved"} onClick={() => void decide("approved")} aria-keyshortcuts="A"><Icon name="check" size={18} />Approve<kbd aria-hidden="true">A</kbd></Button>
          </footer>
        </>
      )}
      {viewing && (
        <div className="dialog-backdrop lightbox" onMouseDown={(e) => { if (e.target === e.currentTarget) setViewing(null); }}>
          <figure className="lightbox-figure" role="dialog" aria-modal="true" aria-label="Photo">
            <img src={viewing.url} alt="Photo attached to this record" />
            <figcaption>
              <a href={viewing.original_url ?? viewing.url} target="_blank" rel="noreferrer">Open full size</a>
              <Button small onClick={() => setViewing(null)} autoFocus>Close<kbd aria-hidden="true">Esc</kbd></Button>
            </figcaption>
          </figure>
        </div>
      )}
    </section>
  );
}
