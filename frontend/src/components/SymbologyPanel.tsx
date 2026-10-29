import { useMemo } from "react";
import { STATUS_ID, dashboardFields, groupFields, numberFields } from "../lib/dashboard";
import { RAMPS, classLabel, graduatedClasses, uniqueClasses, type LayerStyle, type Renderer, type SymbolStyle } from "../lib/symbology";
import type { Feature, Form } from "../lib/types";

const MODES: { id: Renderer["kind"]; label: string; hint: string }[] = [
  { id: "single", label: "Location only", hint: "One symbol for every record." },
  { id: "unique", label: "Types", hint: "A colour for each value of a field." },
  { id: "graduated", label: "Counts and amounts", hint: "A colour ramp over a number." },
];

/** Change how one layer is drawn. Every change is applied straight away; there is no Apply button. */
export default function SymbologyPanel({ form, features, value, onChange }: {
  form: Form; features: Feature[]; value: LayerStyle; onChange: (next: LayerStyle) => void;
}) {
  const defs = useMemo(() => dashboardFields(form), [form]);
  const kinds = useMemo(() => groupFields(defs).filter((d) => d.type !== "date" && d.type !== "datetime"), [defs]);
  const numbers = useMemo(() => numberFields(defs).filter((d) => !d.id.startsWith("gps_")), [defs]);
  const r = value.renderer;
  const isPoint = form.geometry_type === "Point", isLine = form.geometry_type === "LineString";
  const setSymbol = (p: Partial<SymbolStyle>) => onChange({ ...value, symbol: { ...value.symbol, ...p } });

  function pickMode(kind: Renderer["kind"]) {
    if (kind === "single") return onChange({ ...value, renderer: { kind: "single" } });
    if (kind === "unique") {
      const f = kinds.find((d) => d.id !== STATUS_ID && (d.type === "choice" || d.type === "multi_choice" || d.type === "boolean")) ?? kinds[0];
      return onChange({ ...value, renderer: f ? uniqueClasses(features, f.id) : { kind: "single" } });
    }
    const n = numbers[0];
    onChange({ ...value, renderer: n ? graduatedClasses(features, n.id, "green") : { kind: "single" } });
  }

  return (
    <div className="stack sym-panel" style={{ gap: 14 }}>
      <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend>Draw this layer by</legend>
        <div role="radiogroup" aria-label="Draw this layer by" className="stack" style={{ gap: 6 }}>
          {MODES.map((m) => {
            const unavailable = (m.id === "unique" && !kinds.length) || (m.id === "graduated" && !numbers.length);
            return (
              <label key={m.id} className="check" style={{ minHeight: 0, opacity: unavailable ? 0.5 : 1 }}>
                <input type="radio" name={`mode-${form.id}`} checked={r.kind === m.id} disabled={unavailable} onChange={() => pickMode(m.id)} />
                <span><strong>{m.label}</strong><span className="field-hint" style={{ display: "block" }}>{unavailable ? (m.id === "graduated" ? "This form has no number field." : "This form has no field to group by.") : m.hint}</span></span>
              </label>
            );
          })}
        </div>
      </fieldset>

      {r.kind === "single" && (
        <div className="field"><label htmlFor={`c-${form.id}`}>Colour</label>
          <input id={`c-${form.id}`} type="color" value={value.symbol.color} onChange={(e) => setSymbol({ color: e.target.value })} /></div>
      )}

      {r.kind === "unique" && (
        <>
          <div className="field"><label htmlFor={`uf-${form.id}`}>Field</label>
            <select id={`uf-${form.id}`} value={r.field} onChange={(e) => onChange({ ...value, renderer: uniqueClasses(features, e.target.value) })}>
              {kinds.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
            </select></div>
          <ul className="plain-list sym-classes" aria-label="Colour for each value">
            {r.classes.map((c, i) => (
              <li key={c.value} className="row" style={{ gap: 8 }}>
                <input type="color" aria-label={`Colour for ${classLabel(r.field, c.value)}`} value={c.color} onChange={(e) => onChange({ ...value, renderer: { ...r, classes: r.classes.map((x, j) => (j === i ? { ...x, color: e.target.value } : x)) } })} />
                <span className="grow">{classLabel(r.field, c.value)}</span>
              </li>
            ))}
            <li className="row" style={{ gap: 8 }}>
              <input type="color" aria-label="Colour for everything else" value={r.other} onChange={(e) => onChange({ ...value, renderer: { ...r, other: e.target.value } })} />
              <span className="grow">Other / blank</span>
            </li>
          </ul>
          {r.classes.length === 0 && <span className="field-hint">No values yet. They appear here once records are collected.</span>}
        </>
      )}

      {r.kind === "graduated" && (
        <>
          <div className="field"><label htmlFor={`gf-${form.id}`}>Number field</label>
            <select id={`gf-${form.id}`} value={r.field} onChange={(e) => onChange({ ...value, renderer: graduatedClasses(features, e.target.value, r.ramp, r.classes.length || 5) })}>
              {numbers.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
            </select></div>
          <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
            <div className="field" style={{ flex: 1 }}><label htmlFor={`gr-${form.id}`}>Colour ramp</label>
              <select id={`gr-${form.id}`} value={r.ramp} onChange={(e) => onChange({ ...value, renderer: graduatedClasses(features, r.field, e.target.value, r.classes.length || 5) })}>
                {RAMPS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
              </select></div>
            <div className="field" style={{ width: 90 }}><label htmlFor={`gn-${form.id}`}>Classes</label>
              <select id={`gn-${form.id}`} value={r.classes.length || 5} onChange={(e) => onChange({ ...value, renderer: graduatedClasses(features, r.field, r.ramp, Number(e.target.value)) })}>
                {[3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
              </select></div>
          </div>
          {r.classes.length === 0 && <span className="field-hint">None of the records has a value for this field yet.</span>}
        </>
      )}

      <div className="stack" style={{ gap: 10 }}>
        {isPoint && <Range id={`sz-${form.id}`} label="Dot size" min={3} max={20} step={1} value={value.symbol.size} unit="px" onChange={(n) => setSymbol({ size: n })} />}
        {!isPoint && <Range id={`w-${form.id}`} label={isLine ? "Line width" : "Outline width"} min={0.5} max={8} step={0.5} value={value.symbol.width} unit="px" onChange={(n) => setSymbol({ width: n })} />}
        {isPoint && <div className="field"><label htmlFor={`o-${form.id}`}>Dot outline</label><input id={`o-${form.id}`} type="color" value={value.symbol.outline} onChange={(e) => setSymbol({ outline: e.target.value })} /></div>}
        <Range id={`op-${form.id}`} label="Transparency" min={0} max={90} step={5} value={Math.round((1 - value.symbol.opacity) * 100)} unit="%" onChange={(n) => setSymbol({ opacity: Math.min(1, Math.max(0.1, 1 - n / 100)) })} />
      </div>
    </div>
  );
}

/** A slider with its value written beside it, so it can be read and used without dragging. */
function Range({ id, label, min, max, step, value, unit, onChange }: { id: string; label: string; min: number; max: number; step: number; value: number; unit: string; onChange: (n: number) => void }) {
  return (
    <div className="field"><label htmlFor={id}>{label}: <strong>{Math.round(value * 10) / 10}{unit}</strong></label>
      <input id={id} type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} /></div>
  );
}
