import { useId, useMemo } from "react";
import { TEMPLATES, templateSketch, type TemplateId } from "../lib/dashboardTemplates";

/** A small picture of a template's layout: one coloured block per chart, in the place it will have. */
export function TemplateThumb({ id }: { id: TemplateId }) {
  const sketch = useMemo(() => templateSketch(id), [id]);
  const rows = Math.max(6, ...sketch.map((s) => s.row + s.rows));
  const X = 10, Y = 5, G = 1;                                   // one column = 10 units wide, one row = 5 tall, 1 unit between blocks
  return (
    <svg className="tpl-thumb" viewBox={`0 0 ${12 * X} ${rows * Y}`} preserveAspectRatio="xMidYMin meet" aria-hidden="true">
      {sketch.length === 0 && <text x={6 * X} y={rows * Y / 2} textAnchor="middle" className="tpl-empty">empty</text>}
      {sketch.map((s, i) => <rect key={i} className={`tt tt-${s.type}`} x={s.col * X + G / 2} y={s.row * Y + G / 2} width={s.cols * X - G} height={s.rows * Y - G} rx={1.5} />)}
    </svg>
  );
}

/** Choose how a new dashboard starts. Every template can be changed afterwards: move, resize, add and remove charts. */
export default function TemplatePicker({ value, onChange }: { value: TemplateId; onChange: (id: TemplateId) => void }) {
  const name = useId();
  return (
    <div className="tpl-grid" role="radiogroup" aria-label="Dashboard template">
      {TEMPLATES.map((t) => (
        <label key={t.id} className={`tpl-card${value === t.id ? " is-picked" : ""}`}>
          <input type="radio" name={name} value={t.id} checked={value === t.id} onChange={() => onChange(t.id)} />
          <TemplateThumb id={t.id} />
          <strong>{t.name}</strong>
          <small>{t.description}</small>
        </label>
      ))}
    </div>
  );
}
