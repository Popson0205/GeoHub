import { useMemo, useState } from "react";
import type { ConflictRow } from "../lib/db";
import { allFields, isContainer, isMedia } from "../lib/fieldSpec";
import type { Form, Geometry, Props } from "../lib/types";
import { cellText } from "./RecordTable";
import { Button } from "./ui";

type Side = "server" | "mine";
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Straight-line distance in metres between two points (enough to say how far a location moved). */
function metres(a: number[], b: number[]): number {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad, dLon = (b[0] - a[0]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function moved(a: Geometry, b: Geometry): string {
  if (a.type === "Point" && b.type === "Point") {
    const m = metres(a.coordinates as number[], b.coordinates as number[]);
    return m < 1 ? "less than 1 m apart" : m < 1000 ? `${Math.round(m)} m apart` : `${(m / 1000).toFixed(1)} km apart`;
  }
  return "different shapes";
}

/**
 * Someone else changed a record this phone also changed. Shows only what differs, theirs beside yours,
 * and lets the collector keep either version whole or pick question by question.
 */
export default function ConflictCard({ row, form, title, onResolve }: {
  row: ConflictRow; form?: Form; title: string;
  onResolve: (choice: Side | { geometry: Geometry; properties: Props }) => void;
}) {
  const diffs = useMemo(() => {
    const fields = form ? allFields(form.fields).filter((f) => !isContainer(f.type) && !isMedia(f.type)) : [];
    const known = new Set(fields.map((f) => f.id));
    const keys = [...fields.map((f) => ({ id: f.id, label: f.label || f.id })),
      ...[...new Set([...Object.keys(row.server.properties), ...Object.keys(row.mine.properties)])].filter((k) => !known.has(k) && !k.startsWith("gps_")).map((k) => ({ id: k, label: k }))];
    return keys.filter((k) => !same(row.server.properties[k.id], row.mine.properties[k.id]));
  }, [row, form]);
  const placeMoved = !same(row.server.geometry, row.mine.geometry);
  const [pick, setPick] = useState<Record<string, Side>>({});
  const sideOf = (id: string): Side => pick[id] ?? "mine";
  const mixed = new Set([...diffs.map((d) => sideOf(d.id)), ...(placeMoved ? [sideOf("__place")] : [])]).size > 1;

  function saveChoices() {
    const properties: Props = { ...row.mine.properties };
    for (const d of diffs) if (sideOf(d.id) === "server") { if (row.server.properties[d.id] === undefined) delete properties[d.id]; else properties[d.id] = row.server.properties[d.id]; }
    onResolve({ geometry: sideOf("__place") === "server" ? row.server.geometry : row.mine.geometry, properties });
  }
  const choice = (id: string, label: string) => (
    <div className="conflict-pick" role="radiogroup" aria-label={`Keep which ${label}`}>
      {(["server", "mine"] as Side[]).map((s) => (
        <label key={s} className={sideOf(id) === s ? "is-on" : undefined}>
          <input type="radio" name={`c-${row.id}-${id}`} checked={sideOf(id) === s} onChange={() => setPick((p) => ({ ...p, [id]: s }))} />
          {s === "server" ? "Theirs" : "Yours"}
        </label>
      ))}
    </div>
  );

  return (
    <section className="conflict" role="group" aria-labelledby={`c-${row.id}`}>
      <h3 id={`c-${row.id}`}>Someone else changed “{title}”</h3>
      <p className="field-hint">You both edited it before syncing. Keep one version, or choose answer by answer.</p>
      {diffs.length === 0 && !placeMoved ? (
        <p className="field-hint">The answers are the same; only the record's history differs.</p>
      ) : (
        <div className="conflict-table" role="table" aria-label="Differences">
          <div role="row" className="conflict-head"><span role="columnheader">Question</span><span role="columnheader">Theirs</span><span role="columnheader">Yours</span><span role="columnheader"><span className="sr-only">Keep</span></span></div>
          {diffs.map((d) => (
            <div role="row" key={d.id}>
              <span role="rowheader">{d.label}</span>
              <span role="cell" data-side="Theirs" className={cellText(row.server.properties[d.id]) ? undefined : "is-empty"}>{cellText(row.server.properties[d.id]) || "Not answered"}</span>
              <span role="cell" data-side="Yours" className={cellText(row.mine.properties[d.id]) ? undefined : "is-empty"}>{cellText(row.mine.properties[d.id]) || "Not answered"}</span>
              <span role="cell">{choice(d.id, d.label)}</span>
            </div>
          ))}
          {placeMoved && (
            <div role="row">
              <span role="rowheader">Location</span>
              <span role="cell" className="conflict-span">The two locations are {moved(row.server.geometry, row.mine.geometry)}</span>
              <span role="cell">{choice("__place", "location")}</span>
            </div>
          )}
        </div>
      )}
      <div className="conflict-actions">
        <Button small onClick={() => onResolve("server")}>Keep all theirs</Button>
        <Button small onClick={() => onResolve("mine")}>Keep all mine</Button>
        {mixed && <Button small variant="primary" onClick={saveChoices}>Save my choices</Button>}
      </div>
    </section>
  );
}
