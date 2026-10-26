import { useEffect, useRef } from "react";
import type { FilterOption } from "../../lib/dashboard";

/** A filter the author put in the header: pick one or several values of a field. Counts show how many records each value has. */
export function FilterDropdown({ id, label, options, selected, onToggle, onClear }:
  { id: string; label: string; options: FilterOption[]; selected: string[]; onToggle: (o: FilterOption) => void; onClear: () => void }) {
  const ref = useRef<HTMLDetailsElement>(null);
  // Closes on a click elsewhere or on Escape, like a dropdown should.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const away = (e: PointerEvent) => { if (el.open && !el.contains(e.target as Node)) el.open = false; };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape" && el.open) { el.open = false; el.querySelector("summary")?.focus(); } };
    document.addEventListener("pointerdown", away); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", esc); };
  }, []);
  const shown = selected.length === 0 ? "All" : selected.length === 1 ? (options.find((o) => o.key === selected[0])?.label ?? selected[0]) || "(blank)" : `${selected.length} selected`;
  return (
    <div className="fdrop">
      <span className="fdrop-label" id={`${id}-l`}>{label}</span>
      <details ref={ref} className={selected.length ? "has-value" : undefined}>
        <summary aria-labelledby={`${id}-l ${id}-v`}><span id={`${id}-v`} className="fdrop-value">{shown}</span></summary>
        <div className="fdrop-panel" role="group" aria-labelledby={`${id}-l`}>
          {options.length === 0 ? <p className="meta">No values yet.</p> : (
            <ul>{options.map((o) => (
              <li key={o.key}><label className={o.count === 0 && !selected.includes(o.key) ? "is-zero" : undefined}>
                <input type="checkbox" checked={selected.includes(o.key)} disabled={o.count === 0 && !selected.includes(o.key)} onChange={() => onToggle(o)} />
                <span className="fdrop-opt" title={o.label}>{o.label || "(blank)"}</span><small>{o.count}</small></label></li>
            ))}</ul>)}
          {selected.length > 0 && <button type="button" className="fdrop-clear" onClick={onClear}>Clear {label}</button>}
        </div>
      </details>
    </div>
  );
}
