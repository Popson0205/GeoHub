import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { csvEscape, download } from "../lib/csv";
import type { Props, ReviewStatus } from "../lib/types";
import { Button } from "./ui";

export interface TableRow {
  id: string;
  kind: "point" | "line" | "area";
  properties: Props;
  /** Not saved yet (new), changed but not saved (mod), or as on the server. */
  state: "clean" | "new" | "mod";
  status?: ReviewStatus;
  author?: string;
  /** False when the person may not change this feature (someone else's, or approved). */
  editable: boolean;
}

const ROW_H = 36;
const OVERSCAN = 6;
const COL_W = 160;
const KIND_LABEL = { point: "Point", line: "Line", area: "Polygon" } as const;
const STATE_LABEL = { new: "New", mod: "Edited", clean: "Saved" } as const;
const REVIEW_LABEL: Record<ReviewStatus, string> = { submitted: "Waiting", approved: "Approved", rejected: "Rejected" };
type Sort = { col: string; dir: 1 | -1 } | null;

const cellText = (r: TableRow, col: string): string => {
  if (col === "$kind") return KIND_LABEL[r.kind];
  if (col === "$state") return r.state === "clean" ? (r.status ? REVIEW_LABEL[r.status] : "Saved") : STATE_LABEL[r.state];
  if (col === "$author") return r.author ?? "";
  const v = r.properties[col];
  return v == null ? "" : Array.isArray(v) ? v.join("|") : String(v);
};

/** One editable cell. Typing is kept locally and committed on Enter or when you leave the cell, so each edit is one undo step. */
function Cell({ value, disabled, label, r, c, onCommit }: { value: string; disabled: boolean; label: string; r: number; c: number; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const move = (e: KeyboardEvent<HTMLInputElement>, dr: number) => {
    const next = e.currentTarget.closest<HTMLElement>('[role="grid"]')?.querySelector<HTMLInputElement>(`input[data-r="${r + dr}"][data-c="${c}"]`);
    if (next) next.focus(); else e.currentTarget.blur();
  };
  return (
    <input
      className="at-input" value={draft} disabled={disabled} aria-label={label} data-r={r} data-c={c}
      title={disabled ? "You cannot change this feature" : undefined}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { if (draft !== value) onCommit(draft); }}
      onFocus={(e) => e.target.select()}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); move(e, e.shiftKey ? -1 : 1); }
        else if (e.key === "Escape") { e.preventDefault(); setDraft(value); e.currentTarget.blur(); }
        e.stopPropagation();                         // typing must never trigger map shortcuts
      }}
    />
  );
}

/**
 * Table of every digitized feature: one row per feature, one column per tag. Click rows to select them on the map
 * (Shift for a range, Ctrl/Cmd to add), edit values in place, set a value for many rows at once, sort, filter and export.
 * Only the rows in view are drawn, so thousands of features stay fast.
 */
export default function AttributeTable({ rows, selectedIds, height, onHeightChange, onSelect, onZoom, onEditCell, onFill, onClose, readOnlyNote }: {
  rows: TableRow[];
  selectedIds: string[];
  height: number;
  onHeightChange: (h: number) => void;
  onSelect: (ids: string[]) => void;
  onZoom: (ids: string[]) => void;
  onEditCell: (id: string, key: string, value: string) => void;
  onFill: (ids: string[], key: string, value: string) => void;
  onClose: () => void;
  /** Shown when nothing can be edited right now (for example a campaign that has ended). */
  readOnlyNote?: string;
}) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<"" | TableRow["kind"]>("");
  const [scope, setScope] = useState<"all" | "selected" | "unsaved">("all");
  const [sort, setSort] = useState<Sort>(null);
  const [extra, setExtra] = useState<string[]>([]);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [newCol, setNewCol] = useState("");
  const [fillKey, setFillKey] = useState("");
  const [fillVal, setFillVal] = useState("");
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(0);
  const body = useRef<HTMLDivElement>(null);
  const anchor = useRef<number | null>(null);
  const drag = useRef<{ y: number; h: number } | null>(null);

  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const keys = useMemo(() => {
    const n = new Map<string, number>();
    for (const r of rows) for (const k of Object.keys(r.properties)) n.set(k, (n.get(k) ?? 0) + 1);
    return [...n].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k);
  }, [rows]);
  const cols = useMemo(() => [...keys, ...extra.filter((k) => !keys.includes(k))], [keys, extra]);
  const shownCols = cols.filter((c) => !hidden.has(c));

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    let out = rows.filter((r) => (!kind || r.kind === kind)
      && (scope === "all" || (scope === "selected" ? selected.has(r.id) : r.state !== "clean"))
      && (!q || (r.author ?? "").toLowerCase().includes(q) || Object.entries(r.properties).some(([k, v]) => `${k} ${String(v)}`.toLowerCase().includes(q))));
    if (sort) {
      const { col, dir } = sort;
      // Blank values always go last, so the first rows are the ones that have something to compare.
      out = [...out].sort((a, b) => {
        const x = cellText(a, col), y = cellText(b, col);
        if (!x || !y) return x === y ? 0 : x ? -1 : 1;
        return dir * x.localeCompare(y, undefined, { numeric: true, sensitivity: "base" });
      });
    }
    return out;
  }, [rows, kind, scope, query, sort, selected]);

  // Measure the scrolling area so only the rows in view are drawn.
  useEffect(() => {
    const el = body.current;
    if (!el) return;
    setViewH(el.clientHeight);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const vh = viewH || 400;
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const last = Math.min(shown.length, Math.ceil((scrollTop + vh) / ROW_H) + OVERSCAN);

  // A feature picked on the map scrolls into view here.
  const lastPicked = selectedIds[selectedIds.length - 1];
  useEffect(() => {
    const el = body.current;
    if (!el || !lastPicked) return;
    const i = shown.findIndex((r) => r.id === lastPicked);
    if (i < 0) return;
    const top = i * ROW_H + ROW_H;                   // the header takes the first row's space
    if (top - ROW_H < el.scrollTop) el.scrollTop = top - ROW_H;
    else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastPicked]);

  function pick(e: MouseEvent, i: number) {
    const id = shown[i].id;
    if (e.shiftKey && anchor.current != null) {
      const [a, b] = [Math.min(anchor.current, i), Math.max(anchor.current, i)];
      const range = shown.slice(a, b + 1).map((r) => r.id);
      onSelect(e.ctrlKey || e.metaKey ? [...new Set([...selectedIds, ...range])] : range);
    } else if (e.ctrlKey || e.metaKey) {
      onSelect(selected.has(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id]);
      anchor.current = i;
    } else { onSelect([id]); anchor.current = i; }
  }
  function toggleBox(i: number) {
    const id = shown[i].id;
    onSelect(selected.has(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id]);
    anchor.current = i;
  }
  const allShownPicked = shown.length > 0 && shown.every((r) => selected.has(r.id));

  function gridKey(e: KeyboardEvent) {
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    const cur = shown.findIndex((r) => r.id === lastPicked);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const i = Math.max(0, Math.min(shown.length - 1, cur < 0 ? 0 : cur + (e.key === "ArrowDown" ? 1 : -1)));
      if (shown[i]) { onSelect(e.shiftKey ? [...new Set([...selectedIds, shown[i].id])] : [shown[i].id]); anchor.current = i; }
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") { e.preventDefault(); onSelect(shown.map((r) => r.id)); }
  }

  function sortBy(col: string) { setSort((s) => (s?.col !== col ? { col, dir: 1 } : s.dir === 1 ? { col, dir: -1 } : null)); }
  const ariaSort = (col: string) => (sort?.col === col ? (sort.dir === 1 ? "ascending" : "descending") : "none");
  const sortMark = (col: string) => (sort?.col === col ? (sort.dir === 1 ? " ▲" : " ▼") : "");

  function addColumn() {
    const k = newCol.trim();
    if (!k) return;
    setExtra((x) => (x.includes(k) ? x : [...x, k]));
    setHidden((h) => { const n = new Set(h); n.delete(k); return n; });
    setFillKey(k);
    setNewCol("");
  }
  function exportCsv() {
    const head = ["id", "type", "state", "drawn_by", ...cols];
    const lines = shown.map((r) => [r.id, KIND_LABEL[r.kind], cellText(r, "$state"), r.author ?? "", ...cols.map((c) => cellText(r, c))].map(csvEscape).join(","));
    download("attribute-table.csv", [head.map(csvEscape).join(","), ...lines].join("\n"), "text/csv");
  }

  // Dragging the top edge resizes the table. The separator also works with the arrow keys.
  const down = (e: PointerEvent) => { drag.current = { y: e.clientY, h: height }; e.currentTarget.setPointerCapture(e.pointerId); };
  const move = (e: PointerEvent) => { if (drag.current) onHeightChange(Math.max(140, Math.min(window.innerHeight * 0.75, drag.current.h + (drag.current.y - e.clientY)))); };
  const up = () => { drag.current = null; };

  const editableSel = rows.filter((r) => selected.has(r.id) && r.editable);
  const gridW = 34 + 34 + 70 + 110 + 120 + shownCols.length * COL_W;

  return (
    <section className="at" style={{ height }} aria-label="Attribute table">
      <div className="at-grip" role="separator" aria-orientation="horizontal" aria-label="Resize the table" aria-valuenow={Math.round(height)} tabIndex={0}
        onPointerDown={down} onPointerMove={move} onPointerUp={up}
        onKeyDown={(e) => { if (e.key === "ArrowUp") { e.preventDefault(); onHeightChange(Math.min(window.innerHeight * 0.75, height + 40)); } else if (e.key === "ArrowDown") { e.preventDefault(); onHeightChange(Math.max(140, height - 40)); } }} />
      <div className="at-bar">
        <strong>Attribute table</strong>
        <span className="field-hint" role="status">{shown.length === rows.length ? `${rows.length} features` : `${shown.length} of ${rows.length} features`}{selectedIds.length ? ` · ${selectedIds.length} selected` : ""}</span>
        <input className="input at-search" type="search" aria-label="Search the table" placeholder="Search values…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <select className="input at-select" aria-label="Kind of feature" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
          <option value="">All kinds</option><option value="point">Points</option><option value="line">Lines</option><option value="area">Polygons</option>
        </select>
        <select className="input at-select" aria-label="Which features to show" value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
          <option value="all">All features</option><option value="selected">Selected only</option><option value="unsaved">Unsaved changes</option>
        </select>
        <details className="at-cols">
          <summary className="btn btn-sm">Columns</summary>
          <div className="at-pop" role="group" aria-label="Show columns">
            {cols.length === 0 && <span className="field-hint">No tags yet.</span>}
            {cols.map((c) => <label className="check" key={c}><input type="checkbox" checked={!hidden.has(c)} onChange={() => setHidden((h) => { const n = new Set(h); if (n.has(c)) n.delete(c); else n.add(c); return n; })} />{c}</label>)}
          </div>
        </details>
        <span className="grow" style={{ flex: 1 }} />
        <Button small disabled={!selectedIds.length} onClick={() => onZoom(selectedIds)}>Zoom to selected</Button>
        <Button small disabled={!shown.length} onClick={exportCsv}>CSV</Button>
        <Button small variant="ghost" aria-label="Close the table" onClick={onClose}>✕</Button>
      </div>
      <div className="at-bar at-tools">
        <input className="input at-select" list="at-keys" aria-label="New column name" placeholder="New column (tag name)" value={newCol} onChange={(e) => setNewCol(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addColumn(); } }} />
        <Button small disabled={!newCol.trim()} onClick={addColumn}>Add column</Button>
        <span className="at-sep" aria-hidden="true" />
        <span className="field-hint">Set a value for the selected rows:</span>
        <input className="input at-select" list="at-keys" aria-label="Column to fill" placeholder="column" value={fillKey} onChange={(e) => setFillKey(e.target.value)} />
        <input className="input at-select" aria-label="Value to set" placeholder="value (empty removes it)" value={fillVal} onChange={(e) => setFillVal(e.target.value)} />
        <Button small variant="primary" disabled={!editableSel.length || !fillKey.trim()} onClick={() => onFill(editableSel.map((r) => r.id), fillKey.trim(), fillVal)}>
          Apply to {editableSel.length || "selected"}
        </Button>
        {readOnlyNote && <span className="tag-error">{readOnlyNote}</span>}
        <datalist id="at-keys">{cols.map((c) => <option key={c} value={c} />)}</datalist>
      </div>

      {rows.length === 0 ? (
        <div className="state at-empty"><strong>Nothing digitized yet</strong>Features you draw show up here, one row each.</div>
      ) : (
        <div ref={body} className="at-body" onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)} role="grid" aria-rowcount={shown.length + 1} aria-colcount={shownCols.length + 5} tabIndex={0} onKeyDown={gridKey}>
          <div style={{ width: gridW, position: "relative", height: (shown.length + 1) * ROW_H }}>
            <div className="at-row at-head" role="row" aria-rowindex={1} style={{ height: ROW_H }}>
              <div className="at-fixed">
                <span className="at-c at-w34" role="columnheader"><input type="checkbox" aria-label="Select all shown" checked={allShownPicked} onChange={(e) => onSelect(e.target.checked ? shown.map((r) => r.id) : [])} /></span>
                <span className="at-c at-w34" role="columnheader"><span className="sr-only">Zoom</span></span>
                <span className="at-c" style={{ width: 70 }} role="columnheader" aria-sort={ariaSort("$kind")}><button type="button" className="at-sort" onClick={() => sortBy("$kind")}>Type{sortMark("$kind")}</button></span>
              </div>
              <span className="at-c" style={{ width: 110 }} role="columnheader" aria-sort={ariaSort("$state")}><button type="button" className="at-sort" onClick={() => sortBy("$state")}>State{sortMark("$state")}</button></span>
              <span className="at-c" style={{ width: 120 }} role="columnheader" aria-sort={ariaSort("$author")}><button type="button" className="at-sort" onClick={() => sortBy("$author")}>Drawn by{sortMark("$author")}</button></span>
              {shownCols.map((c) => <span key={c} className="at-c" style={{ width: COL_W }} role="columnheader" aria-sort={ariaSort(c)}><button type="button" className="at-sort" onClick={() => sortBy(c)} title={c}>{c}{sortMark(c)}</button></span>)}
            </div>
            {shown.slice(first, last).map((r, k) => {
              const i = first + k;
              const on = selected.has(r.id);
              return (
                <div key={r.id} className={`at-row${on ? " on" : ""}${r.state !== "clean" ? " dirty" : ""}`} role="row" aria-rowindex={i + 2} aria-selected={on}
                  style={{ top: (i + 1) * ROW_H, height: ROW_H }} onClick={(e) => { if ((e.target as HTMLElement).closest("input,button")) return; pick(e, i); }}>
                  <div className="at-fixed">
                    <span className="at-c at-w34" role="gridcell"><input type="checkbox" aria-label={`Select ${KIND_LABEL[r.kind].toLowerCase()} ${i + 1}`} checked={on} onChange={() => toggleBox(i)} /></span>
                    <span className="at-c at-w34" role="gridcell"><button type="button" className="at-zoom" aria-label={`Zoom to ${KIND_LABEL[r.kind].toLowerCase()} ${i + 1}`} onClick={() => onZoom([r.id])}>⌖</button></span>
                    <span className="at-c" style={{ width: 70 }} role="gridcell">{KIND_LABEL[r.kind]}</span>
                  </div>
                  <span className="at-c" style={{ width: 110 }} role="gridcell"><span className={`at-tag at-${r.state === "clean" ? r.status ?? "clean" : r.state}`}>{cellText(r, "$state")}</span></span>
                  <span className="at-c" style={{ width: 120 }} role="gridcell" title={r.author}>{r.author ?? "You"}</span>
                  {shownCols.map((c, j) => (
                    <span key={c} className="at-c" style={{ width: COL_W }} role="gridcell">
                      <Cell value={cellText(r, c)} disabled={!r.editable} label={`${c} of ${KIND_LABEL[r.kind].toLowerCase()} ${i + 1}`} r={i} c={j}
                        onCommit={(v) => { if (!on) onSelect([r.id]); onEditCell(r.id, c, v); }} />
                    </span>
                  ))}
                </div>
              );
            })}
            {shown.length === 0 && <div className="field-hint" style={{ position: "absolute", top: ROW_H + 10, left: 12 }}>No features match.</div>}
          </div>
        </div>
      )}
    </section>
  );
}

/** Convenience for callers that build rows from their own feature type. */
export type { Props };
