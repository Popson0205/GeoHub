import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { FilterOption } from "../../lib/dashboard";

/** The shell every selector in the bar shares: a labelled button that opens a panel, and closes on a click elsewhere or on Escape. */
export function Dropdown({ label, value, active, children, panelClass }: { label: string; value: string; active?: boolean; children: (close: () => void) => ReactNode; panelClass?: string }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const id = useId();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const away = (e: PointerEvent) => { if (el.open && !el.contains(e.target as Node)) el.open = false; };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape" && el.open) { el.open = false; el.querySelector("summary")?.focus(); } };
    document.addEventListener("pointerdown", away); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", esc); };
  }, []);
  const close = () => { if (ref.current) ref.current.open = false; };
  return (
    <div className="fdrop">
      <span className="fdrop-label" id={`${id}-l`}>{label}</span>
      <details ref={ref} className={active ? "has-value" : undefined}>
        <summary aria-labelledby={`${id}-l ${id}-v`}><span id={`${id}-v`} className="fdrop-value">{value}</span></summary>
        <div className={`fdrop-panel${panelClass ? ` ${panelClass}` : ""}`} role="group" aria-labelledby={`${id}-l`}>{children(close)}</div>
      </details>
    </div>
  );
}

const SEARCH_FROM = 9;   // a list this long gets a search box

/**
 * A category selector: pick one value or several. Counts show how many records each value has.
 * `listed` = the values come from another list (a form or a web address), so a value with no records yet can still be picked.
 */
export function FilterDropdown({ id, label, options, selected, multi = true, listed, status, onToggle, onClear }:
  { id: string; label: string; options: FilterOption[]; selected: string[]; multi?: boolean; listed?: boolean; status?: { kind: "loading" | "error"; message: string };
    onToggle: (o: FilterOption) => void; onClear: () => void }) {
  const [q, setQ] = useState("");
  const shown = selected.length === 0 ? "All" : selected.length === 1 ? (options.find((o) => o.key === selected[0])?.label ?? selected[0]) || "(blank)" : `${selected.length} selected`;
  const find = q.trim().toLowerCase();
  const list = find ? options.filter((o) => o.label.toLowerCase().includes(find)) : options;
  return (
    <Dropdown label={label} value={shown} active={selected.length > 0}>
      {(close) => (<>
        {status?.kind === "loading" && <p className="meta" role="status">{status.message}</p>}
        {status?.kind === "error" && <p className="fdrop-problem" role="alert">{status.message}</p>}
        {options.length >= SEARCH_FROM && <input type="search" className="fdrop-search" value={q} placeholder={`Search ${label.toLowerCase()}`} aria-label={`Search ${label}`} onChange={(e) => setQ(e.target.value)} />}
        {options.length === 0 && !status ? <p className="meta">No values yet.</p> : list.length === 0 && options.length > 0 ? <p className="meta">Nothing matches “{q}”.</p> : (
          <ul>{list.map((o) => {
            const zero = o.count === 0 && !selected.includes(o.key) && !listed;
            return (
              <li key={o.key}><label className={o.count === 0 && !selected.includes(o.key) ? "is-zero" : undefined}>
                <input type={multi ? "checkbox" : "radio"} name={multi ? undefined : id} checked={selected.includes(o.key)} disabled={zero}
                  onChange={() => { onToggle(o); if (!multi) close(); }} />
                <span className="fdrop-opt" title={o.label}>{o.label || "(blank)"}</span><small>{o.count}</small></label></li>
            );
          })}</ul>)}
        {selected.length > 0 && <button type="button" className="fdrop-clear" onClick={() => { onClear(); close(); }}>Clear {label}</button>}
      </>)}
    </Dropdown>
  );
}
