import { useState, type ReactNode } from "react";
import { Dropdown } from "./FilterDropdown";
import { LAST_PRESETS, MAX_LAST_DAYS, cleanDays, lastLabel } from "../../lib/dashboard";

/** The date filter: All time, Today, or the last N days. Nothing else to fill in, so it is one tap for the usual choices. */
export function DateSelect({ id, label, days, onChange, icon }: { id: string; label: string; days: number | null; onChange: (days: number | null) => void; icon?: ReactNode }) {
  const [custom, setCustom] = useState("");
  const typed = cleanDays(custom);
  const isPreset = days != null && LAST_PRESETS.some((p) => p.days === days);
  const apply = (close: () => void) => { if (typed != null) { onChange(typed); setCustom(""); close(); } };
  return (
    <Dropdown label={label} value={days == null ? "All time" : lastLabel(days)} active={days != null} icon={icon}>
      {(close) => (<>
        <ul>
          {[{ days: null as number | null, label: "All time" }, ...LAST_PRESETS].map((p) => (
            <li key={p.label}><label>
              <input type="radio" name={id} checked={days === p.days} onChange={() => { onChange(p.days); close(); }} />
              <span className="fdrop-opt">{p.label}</span></label></li>
          ))}
          {days != null && !isPreset && <li><label><input type="radio" name={id} checked readOnly /><span className="fdrop-opt">{lastLabel(days)}</span></label></li>}
        </ul>
        <form className="fdrop-days" onSubmit={(e) => { e.preventDefault(); apply(close); }}>
          <label htmlFor={`${id}-n`}>Last</label>
          <input id={`${id}-n`} type="number" inputMode="numeric" min={1} max={MAX_LAST_DAYS} step={1} value={custom} placeholder="45" onChange={(e) => setCustom(e.target.value)} />
          <span>days</span>
          <button type="submit" className="fdrop-apply" disabled={typed == null || typed < 1}>Apply</button>
        </form>
      </>)}
    </Dropdown>
  );
}
