import { Button } from "../ui";
import {
  GRID_COLUMNS, MAX_ROWS, METRIC_LABEL, MIN_COLS, MIN_ROWS, WIDGET_LABEL, dateFields, defaultTitle, groupFields, isStatic, numberFields, safeEmbedUrl, usesMetric,
  type FieldDef, type Rect,
} from "../../lib/dashboard";
import type { Form, Metric, Widget } from "../../lib/types";

const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

/** Settings of the selected element: what it shows, where it gets its records, and where it sits. */
export function WidgetSettings({ w, rect, manual = false, onRect, defs, index, count, forms = [], pageFormId, onForm, onChange, onMove, onRemove, onClose, onRegion }:
  { w: Widget; rect?: Rect; manual?: boolean; onRect?: (p: Partial<Rect>) => void; defs: FieldDef[]; index: number; count: number; forms?: Form[]; pageFormId?: string; onForm?: (formId: string) => void;
    onChange: (p: Partial<Widget>) => void; onMove: (by: -1 | 1) => void; onRemove: () => void; onClose: () => void; onRegion?: (r: "body" | "sidebar") => void }) {
  const nums = numberFields(defs);
  const side = w.region === "sidebar";
  const setMetric = (metric: Metric) => onChange({ metric, metric_field: metric === "count" ? undefined : w.metric_field ?? nums[0]?.id });
  const fieldBoxes = (label: string, ids: string[], set: (ids: string[]) => void, extra: [string, string][] = [], max = 12) => (
    <div className="field"><span id="wcl" className="label">{label}</span>
      <div className="cols" role="group" aria-labelledby="wcl">
        {defs.map((d) => {
          const on = ids.includes(d.id);
          return <label key={d.id}><input type="checkbox" checked={on} disabled={!on && ids.length >= max} onChange={() => set(toggle(ids, d.id))} />{d.label}</label>;
        })}
        {extra.map(([id, text]) => <label key={id}><input type="checkbox" checked={ids.includes(id)} onChange={() => set(toggle(ids, id))} />{text}</label>)}
      </div></div>
  );
  return (
    <aside className="dash-aside" aria-label="Chart settings">
      <div className="row" style={{ alignItems: "center" }}><h2 style={{ flex: 1 }}>{WIDGET_LABEL[w.type]}</h2><Button small variant="ghost" onClick={onClose} aria-label="Close settings">Close</Button></div>
      <div className="field"><label htmlFor="wt">Title</label><input id="wt" value={w.title} placeholder={defaultTitle({ ...w, title: "" }, defs)} onChange={(e) => onChange({ title: e.target.value })} maxLength={120} /></div>
      {!isStatic(w.type) && onForm && forms.length > 1 && (
        <div className="field"><label htmlFor="wsrc">Records from</label>
          <select id="wsrc" value={w.form_id ?? ""} onChange={(e) => onForm(e.target.value)}>
            {pageFormId && <option value="">This page's form</option>}
            {forms.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select></div>
      )}
      {onRegion && (
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" checked={side} onChange={(e) => onRegion(e.target.checked ? "sidebar" : "body")} />Show in the side column</label>
      )}
      {side ? <small className="meta">The side column stacks its elements top to bottom, beside the main grid.</small>
        : onRect && rect ? (
        <fieldset className="dash-rect">
          <legend>Position and size</legend>
          <div className="dash-rect-grid">
            <div className="field"><label htmlFor="rc">Left (column)</label><input id="rc" type="number" min={1} max={GRID_COLUMNS} value={rect.col + 1} onChange={(e) => onRect({ col: Number(e.target.value) - 1 })} /></div>
            <div className="field"><label htmlFor="rr">Top (row)</label><input id="rr" type="number" min={1} value={rect.row + 1} onChange={(e) => onRect({ row: Number(e.target.value) - 1 })} /></div>
            <div className="field"><label htmlFor="rs">Wide (columns)</label><input id="rs" type="number" min={MIN_COLS} max={GRID_COLUMNS} value={rect.cols} onChange={(e) => onRect({ cols: Number(e.target.value) })} /></div>
            <div className="field"><label htmlFor="rh">Tall (rows)</label><input id="rh" type="number" min={MIN_ROWS} max={MAX_ROWS} value={rect.rows} onChange={(e) => onRect({ rows: Number(e.target.value) })} /></div>
          </div>
          <div className="row"><Button small onClick={() => onRect({ col: 0, cols: GRID_COLUMNS })}>Full row</Button></div>
          <small className="meta">The page is 12 columns wide. You can also drag this chart by its title bar, and resize it by its edges or corner.</small>
        </fieldset>
      ) : (<>
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" checked={w.wide === true} onChange={(e) => onChange({ wide: e.target.checked || undefined })} />Full row</label>
        <small className="meta">Size and position are set automatically until you move or resize a chart.</small>
      </>)}

      {(w.type === "bar" || w.type === "pie") && (
        <div className="field"><label htmlFor="wf">Group by</label>
          <select id="wf" value={w.field ?? ""} onChange={(e) => onChange({ field: e.target.value })}>
            {groupFields(defs).map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
          </select></div>
      )}
      {w.type === "line" && (<>
        <div className="field"><label htmlFor="wf">Date to plot</label>
          <select id="wf" value={w.field ?? ""} onChange={(e) => onChange({ field: e.target.value })}>
            {dateFields(defs).map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
          </select></div>
        <div className="field"><label htmlFor="wb">Group by</label>
          <select id="wb" value={w.bucket} onChange={(e) => onChange({ bucket: e.target.value as Widget["bucket"] })}>
            <option value="day">Day</option><option value="week">Week</option><option value="month">Month</option>
          </select></div>
      </>)}
      {usesMetric(w.type) && (<>
        <div className="field"><label htmlFor="wm">Show</label>
          <select id="wm" value={w.metric} onChange={(e) => setMetric(e.target.value as Metric)}>
            {(Object.keys(METRIC_LABEL) as Metric[]).map((m) => <option key={m} value={m} disabled={m !== "count" && !nums.length}>{METRIC_LABEL[m]}</option>)}
          </select>
          {!nums.length && <small className="meta">Add a number field to the form to total or average it.</small>}</div>
        {w.metric !== "count" && (
          <div className="field"><label htmlFor="wmf">of the field</label>
            <select id="wmf" value={w.metric_field ?? ""} onChange={(e) => onChange({ metric_field: e.target.value })}>
              {nums.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
            </select></div>
        )}
      </>)}
      {w.type === "gauge" && (<>
        <div className="field"><label htmlFor="wtg">Target (full dial)</label>
          <input id="wtg" type="number" min={1} value={w.target ?? ""} placeholder="For example 500"
            onChange={(e) => onChange({ target: e.target.value === "" ? undefined : Math.max(0, Number(e.target.value)) || undefined, target_field: e.target.value === "" ? w.target_field : undefined })} /></div>
        <div className="field"><label htmlFor="wtf">or the total of a number field</label>
          <select id="wtf" value={w.target_field ?? ""} disabled={w.target != null} onChange={(e) => onChange({ target_field: e.target.value || undefined })}>
            <option value="">Choose a field…</option>
            {nums.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
          </select></div>
      </>)}
      {(w.type === "bar" || w.type === "pie") && (
        <div className="field"><label htmlFor="wl">Groups shown</label><input id="wl" type="number" min={2} max={50} value={w.limit} onChange={(e) => onChange({ limit: Math.min(50, Math.max(2, Number(e.target.value) || 8)) })} /></div>
      )}
      {w.type === "table" && (<>
        {fieldBoxes("Columns (up to 12)", w.columns, (columns) => onChange({ columns }), [["__status", "Review status"], ["__updated", "Date record changed"]])}
        <div className="field"><label htmlFor="wl">Rows shown</label><input id="wl" type="number" min={1} max={50} value={w.limit} onChange={(e) => onChange({ limit: Math.min(50, Math.max(1, Number(e.target.value) || 10)) })} /></div>
      </>)}
      {w.type === "list" && (<>
        <div className="field"><label htmlFor="wlt">Heading of each row</label>
          <select id="wlt" value={w.title_field ?? ""} onChange={(e) => onChange({ title_field: e.target.value })}>
            <option value="" disabled>Choose a field…</option>
            {defs.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
          </select></div>
        {fieldBoxes("Shown under it (up to 6)", w.subtitle_fields ?? [], (subtitle_fields) => onChange({ subtitle_fields }), [], 6)}
        <div className="field"><label htmlFor="wl">Rows shown</label><input id="wl" type="number" min={1} max={50} value={w.limit} onChange={(e) => onChange({ limit: Math.min(50, Math.max(1, Number(e.target.value) || 10)) })} /></div>
      </>)}
      {w.type === "details" && (<>
        {fieldBoxes("Fields to show (none ticked = all)", w.columns, (columns) => onChange({ columns }), [], 12)}
        <small className="meta">Shows the most recently changed record that passes the filters.</small>
      </>)}
      {w.type === "rich_text" && (
        <div className="field"><label htmlFor="wc">Text</label>
          <textarea id="wc" rows={6} maxLength={4000} value={w.content ?? ""} placeholder="A note, instructions or context for this dashboard" onChange={(e) => onChange({ content: e.target.value })} />
          <small className="meta">**bold**, *italic* and line breaks work. Nothing else is formatted.</small></div>
      )}
      {w.type === "embedded" && (
        <div className="field"><label htmlFor="wu">Web address</label>
          <input id="wu" type="url" maxLength={500} value={w.url ?? ""} placeholder="https://example.com/page" onChange={(e) => onChange({ url: e.target.value })} aria-invalid={!!w.url && !safeEmbedUrl(w.url)} />
          <small className="meta">Must start with https://. Some sites refuse to be shown inside another page.</small></div>
      )}
      {w.type === "map" && <p className="meta">Shows where the records are. Records waiting for review are amber, rejected ones red.</p>}

      <div className="row">
        {!manual && !side && <Button small onClick={() => onMove(-1)} disabled={index <= 0}>Move earlier</Button>}
        {!manual && !side && <Button small onClick={() => onMove(1)} disabled={index >= count - 1}>Move later</Button>}
        <Button small variant="danger" onClick={onRemove}>Remove</Button>
      </div>
    </aside>
  );
}
