import { useId } from "react";
import { Button } from "../ui";
import { PanelShell } from "./Panels";
import { SymbolPicker } from "../SymbolPicker";
import { SYMBOL_PX } from "../../lib/symbols";
import {
  LAST_PRESETS, MAX_CONTROLS, STATUS_LABEL, UPDATED_ID, controlFields, controlLabel, lastLabel, controlProblem, dashboardFields, dateFields, filtersOthers, isFilterable, newControl,
  type Exclude, type FieldDef,
} from "../../lib/dashboard";
import type { DashControl, DashPage, Form, OptionSource, Widget } from "../../lib/types";

type SourceKind = "records" | "form" | "url";
const SOURCE_LABEL: Record<SourceKind, string> = { records: "This page’s records", form: "Another form in this project", url: "A web address (JSON or CSV)" };

/** One filter in the bar, set up by the author. */
/** The values a field can start on, when they are a short fixed list; null when the author has to type them. */
function startChoices(d?: FieldDef): [string, string][] | null {
  if (!d) return null;
  if (d.type === "status") return Object.entries(STATUS_LABEL);
  if (d.type === "boolean") return [["true", d.true_label || "Yes"], ["false", d.false_label || "No"]];
  return d.type === "choice" && d.choices?.length ? d.choices.slice(0, 60).map((v): [string, string] => [v, v]) : null;
}

function ControlEditor({ c, defs, forms, earlier, onChange, onRemove }: { c: DashControl; defs: FieldDef[]; forms: Form[]; /** Category selectors above this one: the ones it can be narrowed by. */ earlier: DashControl[]; onChange: (c: DashControl) => void; onRemove: () => void }) {
  const id = useId();
  const field = controlFields(defs).find((d) => d.id === c.field), choices = startChoices(field), start = c.start ?? [];
  const setStart = (v: string[]) => onChange({ ...c, start: v.length ? v : undefined });
  const problem = controlProblem(c, defs, forms);
  const kind: SourceKind = c.source?.type ?? "records";
  const lookup = c.source?.type === "form" ? forms.find((f) => f.id === (c.source as Extract<OptionSource, { type: "form" }>).form_id) : undefined;
  const setSource = (k: SourceKind) => {
    if (k === "records") onChange({ ...c, source: undefined });
    else if (k === "url") onChange({ ...c, source: { type: "url", url: "" } });
    else {
      const f = forms.find((x) => controlFields(dashboardFields(x)).some((d) => d.type !== "status")) ?? forms[0];
      onChange({ ...c, source: { type: "form", form_id: f?.id ?? "", field: controlFields(dashboardFields(f)).find((d) => d.type !== "status")?.id ?? "" } });
    }
  };
  const setField = (field: string) => {
    // A label the author never typed follows the field.
    const prev = defs.find((d) => d.id === c.field)?.label;
    onChange({ ...c, field, label: !c.label || c.label === prev ? (defs.find((d) => d.id === field)?.label ?? c.label) : c.label });
  };
  return (
    <div className="ctl-edit">
      <div className="ctl-edit-head">
        <strong>{c.kind === "date" ? "Date filter" : "Category selector"}</strong>
        <Button small variant="ghost" onClick={onRemove}>Remove</Button>
      </div>
      <div className="field"><label htmlFor={`${id}-l`}>Name shown in the bar</label>
        <input id={`${id}-l`} value={c.label} maxLength={40} placeholder={controlLabel({ ...c, label: "" }, defs)} onChange={(e) => onChange({ ...c, label: e.target.value })} /></div>
      {c.kind === "date" ? (
        <div className="field"><label htmlFor={`${id}-f`}>Date it looks at</label>
          <select id={`${id}-f`} value={c.field ?? UPDATED_ID} onChange={(e) => onChange({ ...c, field: e.target.value })}>
            {dateFields(defs).map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
          </select>
          <small className="meta">Viewers choose All time, Today, or the last number of days they type.</small></div>
      ) : null}
      {c.kind === "date" ? (
        <div className="field"><label htmlFor={`${id}-sd`}>Starts on</label>
          <select id={`${id}-sd`} value={c.start_days == null ? "" : String(c.start_days)} onChange={(e) => onChange({ ...c, start_days: e.target.value === "" ? undefined : Number(e.target.value) })}>
            <option value="">All time</option>
            {LAST_PRESETS.map((p) => <option key={p.days} value={String(p.days)}>{p.label}</option>)}
            {c.start_days != null && !LAST_PRESETS.some((p) => p.days === c.start_days) && <option value={String(c.start_days)}>{lastLabel(c.start_days)}</option>}
          </select>
          <small className="meta">What the dashboard shows when it is opened. Viewers can change it.</small></div>
      ) : (<>
        <div className="field"><label htmlFor={`${id}-f`}>Field it filters</label>
          <select id={`${id}-f`} value={c.field ?? ""} onChange={(e) => setField(e.target.value)}>
            <option value="" disabled>Choose a field…</option>
            {controlFields(defs).map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
          </select></div>
        <div className="field"><label htmlFor={`${id}-s`}>Values come from</label>
          <select id={`${id}-s`} value={kind} onChange={(e) => setSource(e.target.value as SourceKind)}>
            {(Object.keys(SOURCE_LABEL) as SourceKind[]).map((k) => <option key={k} value={k}>{SOURCE_LABEL[k]}</option>)}
          </select></div>
        {c.source?.type === "form" && (<>
          <div className="field"><label htmlFor={`${id}-sf`}>Form</label>
            <select id={`${id}-sf`} value={c.source.form_id} onChange={(e) => onChange({ ...c, source: { type: "form", form_id: e.target.value, field: controlFields(dashboardFields(forms.find((f) => f.id === e.target.value))).find((d) => d.type !== "status")?.id ?? "" } })}>
              <option value="" disabled>Choose a form…</option>
              {forms.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select></div>
          <div className="field"><label htmlFor={`${id}-sv`}>Field with the values</label>
            <select id={`${id}-sv`} value={c.source.field} onChange={(e) => onChange({ ...c, source: { type: "form", form_id: (c.source as { form_id: string }).form_id, field: e.target.value } })}>
              <option value="" disabled>Choose a field…</option>
              {controlFields(dashboardFields(lookup)).filter((d) => d.type !== "status").map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
            </select></div>
        </>)}
        {c.source?.type === "url" && (<>
          <div className="field"><label htmlFor={`${id}-u`}>Address</label>
            <input id={`${id}-u`} type="url" inputMode="url" value={c.source.url} maxLength={500} placeholder="https://example.org/zones.csv" onChange={(e) => onChange({ ...c, source: { type: "url", url: e.target.value, ...(c.source?.type === "url" && c.source.column ? { column: c.source.column } : {}) } })} /></div>
          <div className="field"><label htmlFor={`${id}-c`}>Column or property (optional)</label>
            <input id={`${id}-c`} value={c.source.column ?? ""} maxLength={80} placeholder="name" onChange={(e) => onChange({ ...c, source: { type: "url", url: (c.source as { url: string }).url, ...(e.target.value.trim() ? { column: e.target.value.trim() } : {}) } })} />
            <small className="meta">A CSV needs a header row; without a column, the first one is used. The address has to allow other websites to read it.</small></div>
        </>)}
        {kind !== "records" && <small className="meta">Records are kept when the field equals a picked value exactly.</small>}
        <label className="check-row"><input type="checkbox" checked={c.multi !== false} onChange={(e) => onChange({ ...c, multi: e.target.checked ? undefined : false, start: e.target.checked ? c.start : c.start?.slice(0, 1) })} /> Allow picking several values</label>
        {earlier.length > 0 && (
          <div className="field"><label htmlFor={`${id}-nb`}>Narrowed by</label>
            <select id={`${id}-nb`} value={c.narrow_by ?? ""} onChange={(e) => onChange({ ...c, narrow_by: e.target.value || undefined })}>
              <option value="">Nothing: list every value</option>
              {earlier.map((e) => <option key={e.id} value={e.id}>{controlLabel(e, defs)}</option>)}
            </select>
            <small className="meta">While that selector has a pick, this one lists only the values found with it (the LGAs of the chosen State). A pick that no longer fits is let go.</small></div>)}
        <fieldset className="field start-values"><legend>Starts on</legend>
          {choices && c.multi === false ? (
            <select aria-label="Starting value" value={start[0] ?? ""} onChange={(e) => setStart(e.target.value ? [e.target.value] : [])}>
              <option value="">Nothing picked</option>{choices.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          ) : choices ? (
            <div className="act-targets">{choices.map(([v, l]) => <label key={v}><input type="checkbox" checked={start.includes(v)} onChange={(e) => setStart(e.target.checked ? [...start, v] : start.filter((x) => x !== v))} />{l}</label>)}</div>
          ) : (
            <input aria-label="Starting values, separated by commas" key={start.join("|")} defaultValue={start.join(", ")} placeholder="Value, another value" maxLength={400}
              onBlur={(e) => setStart(e.target.value.split(",").map((x) => x.trim()).filter(Boolean).slice(0, c.multi === false ? 1 : 20))} />)}
          <small className="meta">Picked when the dashboard is opened without a filter in its link. Viewers can change or clear it.</small>
        </fieldset>
      </>)}
      <details className="sym-marker" open={!!c.symbol}>
        <summary>Symbol{c.symbol ? " (set)" : ""}</summary>
        <SymbolPicker value={c.symbol} onChange={(symbol) => onChange({ ...c, symbol })} defaultSize={SYMBOL_PX.selector} />
      </details>
      {problem && <p className="hint" role="status">{problem}</p>}
    </div>
  );
}

export interface FiltersPanelProps {
  page: DashPage; defs: FieldDef[]; forms: Form[]; canEdit: boolean;
  titleOf: (w: Widget) => string;
  onControls: (c: DashControl[]) => void;
  onExclude: (e: Exclude) => void;
  onClose: () => void;
}

/** Add the filters viewers use, and decide which elements each one changes. */
export function FiltersPanel({ page, defs, forms, canEdit, titleOf, onControls, onExclude, onClose }: FiltersPanelProps) {
  const controls = page.controls ?? [], exclude = page.exclude;
  const hasDate = controls.some((c) => c.kind === "date");
  const mk = (kind: DashControl["kind"]) => onControls([...controls, newControl(kind, defs)]);
  const set = (c: DashControl) => onControls(controls.map((x) => (x.id === c.id ? c : x)));
  // Taking a selector away also frees any selector that was narrowed by it.
  const drop = (c: DashControl) => { onControls(controls.filter((x) => x.id !== c.id).map((x) => (x.narrow_by === c.id ? { ...x, narrow_by: undefined } : x))); if (exclude?.[c.id]) onExclude(without(exclude, c.id)); };

  const targets = page.widgets.filter(isFilterable);
  const sources: { id: string; name: string; hint: string }[] = [
    ...controls.map((c) => ({ id: c.id, name: controlLabel(c, defs), hint: c.kind === "date" ? "Date filter" : "Category selector" })),
    ...page.widgets.filter(filtersOthers).map((w) => ({ id: w.id, name: titleOf(w), hint: "When someone clicks in it" })),
  ];
  const skipped = (src: string) => exclude?.[src] ?? [];
  const setSkipped = (src: string, ids: string[]) => {
    const next = { ...(exclude ?? {}) };
    if (ids.length) next[src] = ids; else delete next[src];
    onExclude(Object.keys(next).length ? next : undefined);
  };
  return (
    <PanelShell title="Filters" onClose={onClose}>
      {!canEdit ? <p className="meta">Read-only for your role.</p> : (<>
        <p className="builder-hint">Filters sit in a bar under the title. Viewers pick values there, and the elements below change to match.</p>
        {!page.form_id && <p className="hint">Choose the form this page shows first (View, Pages).</p>}
        {controls.map((c, i) => <ControlEditor key={c.id} c={c} defs={defs} forms={forms} earlier={controls.slice(0, i).filter((x) => x.kind === "category")} onChange={set} onRemove={() => drop(c)} />)}
        <div className="ctl-add">
          <Button small onClick={() => mk("category")} disabled={!page.form_id || controls.length >= MAX_CONTROLS}>+ Category selector</Button>
          <Button small onClick={() => mk("date")} disabled={!page.form_id || hasDate || controls.length >= MAX_CONTROLS}>+ Date filter</Button>
        </div>
        {controls.length >= MAX_CONTROLS && <small className="meta">A page can have up to {MAX_CONTROLS} filters.</small>}

        <h4 className="ctl-heading">What each filter changes</h4>
        <p className="builder-hint">Every filter changes every element unless you untick it here. Clicking a bar, slice or line point filters the others too.</p>
        {sources.length === 0 || targets.length === 0
          ? <p className="meta">Add a filter and some elements to choose what changes what.</p>
          : sources.map((s) => {
            const list = targets.filter((t) => t.id !== s.id), off = skipped(s.id);
            return (
              <fieldset key={s.id} className="ctl-links">
                <legend>{s.name}<small>{s.hint}</small></legend>
                <div className="ctl-links-quick">
                  <button type="button" className="link-btn" onClick={() => setSkipped(s.id, [])}>All</button>
                  <button type="button" className="link-btn" onClick={() => setSkipped(s.id, list.map((t) => t.id))}>None</button>
                </div>
                {list.map((t) => (
                  <label key={t.id} className="check-row">
                    <input type="checkbox" checked={!off.includes(t.id)} onChange={(e) => setSkipped(s.id, e.target.checked ? off.filter((x) => x !== t.id) : [...off, t.id])} /> {titleOf(t)}
                  </label>))}
              </fieldset>);
          })}
        <small className="meta">Changes are kept when you press Save.</small>
      </>)}
    </PanelShell>
  );
}
const without = (e: NonNullable<Exclude>, key: string): Exclude => { const n = { ...e }; delete n[key]; return Object.keys(n).length ? n : undefined; };
