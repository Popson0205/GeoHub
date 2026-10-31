import { useId, useMemo, useState } from "react";
import { SymbolIcon } from "./SymbolIcon";
import { ICONS, MAX_SVG, MAX_SVG_MAP, MOTIONS, SHAPES, isHex, sanitizeSvg } from "../lib/symbols";
import type { SymbolMotion, SymbolShape, SymbolSpec } from "../lib/types";

/**
 * Choose a symbol: from the library, or paste / upload your own SVG code. Then its colour, the shape behind it and (where the place can
 * show it) an animation. `onChange(undefined)` removes the symbol. Used for indicators, lists, selectors and map points.
 */
export function SymbolPicker({ value, onChange, motion = true, forMap = false, autoColor = "Automatic", defaultShape = "plain" }:
  { value?: SymbolSpec; onChange: (s: SymbolSpec | undefined) => void; motion?: boolean; forMap?: boolean; autoColor?: string; defaultShape?: SymbolShape }) {
  const id = useId();
  const [tab, setTab] = useState<"library" | "svg">(value?.svg ? "svg" : "library");
  const [q, setQ] = useState("");
  const limit = forMap ? MAX_SVG_MAP : MAX_SVG;
  const found = useMemo(() => { const t = q.trim().toLowerCase(); return t ? ICONS.filter((i) => `${i.label} ${i.tags} ${i.id}`.toLowerCase().includes(t)) : ICONS; }, [q]);
  const set = (p: Partial<SymbolSpec>) => {
    const n: SymbolSpec = { ...(value ?? {}), ...p };
    for (const k of Object.keys(n) as (keyof SymbolSpec)[]) if (n[k] === undefined || n[k] === "none") delete n[k];
    onChange(n.icon || n.svg ? n : undefined);
  };
  const check = value?.svg ? sanitizeSvg(value.svg, limit) : null;
  const upload = (f?: File) => {
    if (!f) return;
    if (f.size > limit * 4) { onChange({ ...(value ?? {}), svg: "x".repeat(limit + 1), icon: undefined }); return; }   // shows the "too long" message
    const rd = new FileReader();
    rd.onload = () => set({ svg: String(rd.result ?? ""), icon: undefined });
    rd.readAsText(f);
  };
  return (
    <div className="sympick">
      <div className="sympick-now">
        <span className="sympick-preview">{value ? <SymbolIcon spec={{ ...value, motion: motion ? value.motion : undefined }} size={44} color={forMap ? "#1f6b52" : undefined} label="Current symbol" /> : <span className="meta">None</span>}</span>
        {value && <button type="button" className="link-btn" onClick={() => onChange(undefined)}>Remove symbol</button>}
      </div>
      <div className="sympick-tabs" role="tablist" aria-label="Symbol source">
        {(["library", "svg"] as const).map((t) => <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? "is-on" : undefined} onClick={() => setTab(t)}>{t === "library" ? "Library" : "My SVG code"}</button>)}
      </div>
      {tab === "library" ? (<>
        <input type="search" className="fdrop-search" value={q} placeholder="Search symbols (power, water, building…)" aria-label="Search symbols" onChange={(e) => setQ(e.target.value)} />
        <div className="sympick-grid" role="group" aria-label="Library symbols">
          {found.map((i) => <button key={i.id} type="button" title={i.label} aria-label={i.label} aria-pressed={!value?.svg && value?.icon === i.id} onClick={() => set({ icon: i.id, svg: undefined })}><SymbolIcon spec={{ icon: i.id }} size={26} /></button>)}
          {found.length === 0 && <p className="meta">No symbol matches “{q}”.</p>}
        </div>
      </>) : (
        <div className="field">
          <label htmlFor={`${id}-svg`}>SVG code</label>
          <textarea id={`${id}-svg`} className="sympick-code" rows={6} spellCheck={false} value={value?.svg ?? ""} placeholder={'<svg viewBox="0 0 24 24"><path d="M13 2L4 14h7l-1 8 9-12h-7z"/></svg>'}
            onChange={(e) => set({ svg: e.target.value, icon: undefined })} aria-describedby={`${id}-note`} />
          <div className="row" style={{ gap: 12 }}>
            <label className="link-btn sympick-file">Upload an .svg file<input type="file" accept=".svg,image/svg+xml" hidden onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ""; }} /></label>
            {value?.svg && <button type="button" className="link-btn" onClick={() => set({ svg: undefined })}>Clear code</button>}
          </div>
          <div id={`${id}-note`} aria-live="polite">
            {check && !check.ok && <p className="fdrop-problem" role="alert">{check.error}</p>}
            {check?.ok && check.notes.length > 0 && <p className="meta">Left out for safety: {check.notes.join(", ")}.</p>}
            {check?.ok && <p className="meta">Shapes only: scripts, styles, links, images and text are never kept. Up to {limit} characters.</p>}
            {!check && <p className="meta">Paste the code of an icon (it should start with &lt;svg). Up to {limit} characters.</p>}
          </div>
        </div>
      )}
      {value && (<div className="sympick-opts">
        <div className="field"><label htmlFor={`${id}-sh`}>Shape behind it</label>
          <select id={`${id}-sh`} value={value.shape ?? defaultShape} onChange={(e) => set({ shape: e.target.value as SymbolShape })}>{SHAPES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select></div>
        <div className="field"><label htmlFor={`${id}-co`}>Colour</label>
          <div className="row" style={{ gap: 8 }}>
            <input id={`${id}-co`} type="color" value={isHex(value.color) ? value.color : "#1f6b52"} onChange={(e) => set({ color: e.target.value })} />
            <span className="meta">{value.color ?? autoColor}</span>
            {value.color && <button type="button" className="link-btn" onClick={() => set({ color: undefined })}>{autoColor}</button>}
          </div></div>
        {motion && <div className="field"><label htmlFor={`${id}-mo`}>Animation</label>
          <select id={`${id}-mo`} value={value.motion ?? "none"} onChange={(e) => set({ motion: e.target.value as SymbolMotion })}>{MOTIONS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</select>
          {value.motion && <small className="meta">Stops for people whose device is set to reduce motion.</small>}</div>}
      </div>)}
    </div>
  );
}
