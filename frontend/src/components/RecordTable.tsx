import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon } from "./icons";
import { Button, MoreMenu } from "./ui";
import type { QualityFlag } from "../lib/quality";
import type { Feature, FeatureStatus, FormField } from "../lib/types";

const STATUS: Record<FeatureStatus, { label: string; cls: string }> = {
  draft: { label: "Draft", cls: "badge" }, submitted: { label: "Waiting", cls: "badge badge-warn" },
  approved: { label: "Approved", cls: "badge badge-ok" }, rejected: { label: "Rejected", cls: "badge badge-bad" },
};
const PAGE_SIZES = [25, 50, 100, 250];
/** A cell as text: lists joined, objects as JSON. */
export const cellText = (v: unknown): string => (v == null ? "" : Array.isArray(v) ? v.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join("; ") : typeof v === "object" ? JSON.stringify(v) : String(v));

type SortKey = "status" | "updated" | string;
type Sort = { key: SortKey; dir: 1 | -1 } | null;
const STATUS_ORDER: Record<FeatureStatus, number> = { submitted: 0, draft: 1, rejected: 2, approved: 3 };

function valueOf(r: Feature, key: SortKey): string | number {
  if (key === "status") return STATUS_ORDER[r.status];
  if (key === "updated") return r.updated_at;
  const v = r.properties[key];
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  return cellText(v).toLowerCase();
}
/** Sort order for two cells in the chosen direction. Empty cells go last whichever way it is sorted. */
function compare(a: string | number, b: string | number, dir: 1 | -1): number {
  const ea = a === "" || a == null, eb = b === "" || b == null;
  if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1;
  if (typeof a === "number" && typeof b === "number") return dir * (a - b);
  return dir * String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

/** Remembers which columns a person hid, per form, in this browser. */
function useHiddenColumns(formId: string) {
  const key = `geohub.hiddenCols.${formId}`;
  const read = () => { try { return new Set<string>(JSON.parse(localStorage.getItem(key) ?? "[]")); } catch { return new Set<string>(); } };
  const [hidden, setHidden] = useState<Set<string>>(read);
  useEffect(() => { setHidden(read()); }, [formId]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = (next: Set<string>) => { setHidden(next); try { localStorage.setItem(key, JSON.stringify([...next])); } catch { /* private mode */ } };
  return [hidden, save] as const;
}

/**
 * The records of one form: search, sort by any column, choose columns, and pages, so a project with
 * thousands of records stays quick to work through. Ticking rows hands them to the page's selection bar.
 */
export default function RecordTable({ formId, rows, cols, canManage, picked, setPicked, onApprove, onReject, onEdit, onDelete, empty, flags }: {
  formId: string;
  /** Data quality hints per record (poor GPS, placed by hand, possible duplicate). */
  flags?: Map<string, QualityFlag[]>;
  rows: Feature[];
  cols: FormField[];
  canManage: boolean;
  picked: Set<string>;
  setPicked: (s: Set<string>) => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onEdit: (f: Feature) => void;
  onDelete: (id: string) => void;
  /** Shown when there are no rows at all (before searching). */
  empty: ReactNode;
}) {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<Sort>(null);
  const [page, setPage] = useState(0);
  const [size, setSize] = useState(50);
  const [hidden, setHidden] = useHiddenColumns(formId);
  const shownCols = cols.filter((c) => !hidden.has(c.id));

  // Search looks through every column, shown or not, plus status and date.
  const found = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return rows;
    return rows.filter((r) => STATUS[r.status].label.toLowerCase().includes(t) || r.updated_at.slice(0, 10).includes(t)
      || cols.some((c) => cellText(r.properties[c.id]).toLowerCase().includes(t)));
  }, [rows, cols, q]);
  const sorted = useMemo(() => (sort ? [...found].sort((a, b) => compare(valueOf(a, sort.key), valueOf(b, sort.key), sort.dir)) : found), [found, sort]);
  const pages = Math.max(1, Math.ceil(sorted.length / size));
  const at = Math.min(page, pages - 1);
  const shown = sorted.slice(at * size, at * size + size);

  // Back to the first page whenever what is listed changes.
  const first = useRef(true);
  useEffect(() => { if (first.current) { first.current = false; return; } setPage(0); }, [q, sort, formId, size, rows.length]);

  const sortBy = (key: SortKey) => setSort((s) => (!s || s.key !== key ? { key, dir: 1 } : s.dir === 1 ? { key, dir: -1 } : null));
  const head = (key: SortKey, label: string, cls?: string) => {
    const on = sort?.key === key;
    return (
      <th key={key} scope="col" className={cls} aria-sort={on ? (sort!.dir === 1 ? "ascending" : "descending") : undefined}>
        <button type="button" className="th-sort" onClick={() => sortBy(key)} title={`Sort by ${label}`}>
          {label}<span className="th-arrow" aria-hidden="true">{on ? (sort!.dir === 1 ? "↑" : "↓") : "↕"}</span>
        </button>
      </th>
    );
  };
  const allShownPicked = shown.length > 0 && shown.every((r) => picked.has(r.id));

  if (!rows.length) return <>{empty}</>;
  return (
    <div className="record-table">
      <div className="table-tools">
        <span className="search-field table-search">
          <Icon name="search" size={16} />
          <input type="search" className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search these records" aria-label="Search records" />
        </span>
        <span className="table-count" aria-live="polite">{q ? `${found.length} of ${rows.length} match` : `${rows.length} ${rows.length === 1 ? "record" : "records"}`}</span>
        <ColumnPicker cols={cols} hidden={hidden} onChange={setHidden} />
      </div>

      {!found.length ? (
        <div className="state">
          <span className="state-icon" aria-hidden="true"><Icon name="search" size={24} /></span>
          <strong>No records match “{q}”</strong>
          <span className="state-text">Search looks through every answer, the status and the date.</span>
          <div className="state-action"><Button onClick={() => setQ("")}>Clear search</Button></div>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr>
              {canManage && <th scope="col" className="check-col"><input type="checkbox" aria-label="Select all shown" checked={allShownPicked} onChange={(e) => {
                const next = new Set(picked);
                for (const r of shown) { if (e.target.checked) next.add(r.id); else next.delete(r.id); }
                setPicked(next);
              }} /></th>}
              {head("status", "Status", "cell-nowrap")}
              {shownCols.map((c) => head(c.id, c.label || c.id))}
              {head("updated", "Updated", "cell-nowrap")}
              {canManage && <th scope="col" className="col-sticky-end"><span className="sr-only">Actions</span></th>}
            </tr></thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} className={picked.has(r.id) ? "is-picked" : undefined}>
                  {canManage && <td className="check-col"><input type="checkbox" aria-label="Select record" checked={picked.has(r.id)} onChange={() => { const n = new Set(picked); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); setPicked(n); }} /></td>}
                  <td className="cell-nowrap">
                    <span className="status-cell">
                      <span className={STATUS[r.status].cls}>{STATUS[r.status].label}</span>
                      {(flags?.get(r.id) ?? []).map((f, i) => (
                        <span key={i} className={`flag flag-${f.kind}`} title={f.detail}><Icon name={f.kind === "duplicate" ? "duplicate" : f.kind === "gps" ? "point" : "select"} size={13} />{f.label}<span className="sr-only">: {f.detail}</span></span>
                      ))}
                    </span>
                  </td>
                  {shownCols.map((c) => <td key={c.id} className="cell-wrap">{cellText(r.properties[c.id])}</td>)}
                  <td className="cell-nowrap">{new Date(r.updated_at).toLocaleDateString()}</td>
                  {canManage && <td className="col-sticky-end">
                    <div className="row-actions">
                      {r.status !== "approved" && <Button small onClick={() => onApprove(r.id)}><Icon name="check" size={16} />Approve</Button>}
                      <Button small onClick={() => onEdit(r)}>Edit</Button>
                      <MoreMenu label="More for this record" items={[
                        ...(r.status !== "rejected" ? [{ label: "Reject", onSelect: () => onReject(r.id) }] : []),
                        { label: "Delete", icon: "delete" as const, danger: true, onSelect: () => onDelete(r.id) },
                      ]} />
                    </div>
                  </td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {found.length > PAGE_SIZES[0] && (
        <nav className="pager" aria-label="Pages of records">
          <span className="pager-range">{at * size + 1}–{Math.min(found.length, at * size + size)} of {found.length}</span>
          <label className="pager-size">Rows per page
            <select className="input" value={size} onChange={(e) => setSize(Number(e.target.value))}>{PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}</select>
          </label>
          <span className="grow" />
          <Button small onClick={() => setPage(0)} disabled={at === 0} aria-label="First page">«</Button>
          <Button small onClick={() => setPage(at - 1)} disabled={at === 0}>Previous</Button>
          <span className="pager-at" aria-current="page">Page {at + 1} of {pages}</span>
          <Button small onClick={() => setPage(at + 1)} disabled={at >= pages - 1}>Next</Button>
          <Button small onClick={() => setPage(pages - 1)} disabled={at >= pages - 1} aria-label="Last page">»</Button>
        </nav>
      )}
    </div>
  );
}

/** Tick the columns to show. Stays open while ticking; Escape or a click outside closes it. */
function ColumnPicker({ cols, hidden, onChange }: { cols: FormField[]; hidden: Set<string>; onChange: (s: Set<string>) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (root.current && !root.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); root.current?.querySelector<HTMLElement>("button")?.focus(); } };
    document.addEventListener("mousedown", onDown); document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);
  const shown = cols.length - cols.filter((c) => hidden.has(c.id)).length;
  return (
    <div className="menu col-picker" ref={root}>
      <button type="button" className="btn btn-sm menu-btn" aria-expanded={open} aria-haspopup="true" onClick={() => setOpen((v) => !v)}>
        <Icon name="table" size={16} />Columns{hidden.size ? ` (${shown} of ${cols.length})` : ""}<Icon name="chevronDown" size={14} />
      </button>
      {open && (
        <div className="menu-pop col-picker-pop" role="group" aria-label="Columns to show">
          {cols.map((c) => (
            <label key={c.id} className="check">
              <input type="checkbox" checked={!hidden.has(c.id)} onChange={() => { const n = new Set(hidden); if (n.has(c.id)) n.delete(c.id); else n.add(c.id); onChange(n); }} />
              {c.label || c.id}
            </label>
          ))}
          <div className="col-picker-foot">
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => onChange(new Set())} disabled={!hidden.size}>Show all</button>
          </div>
        </div>
      )}
    </div>
  );
}
