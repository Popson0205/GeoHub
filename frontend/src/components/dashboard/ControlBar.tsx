import { useMemo } from "react";
import { Button } from "../ui";
import { DateSelect } from "./DateSelect";
import { FilterDropdown } from "./FilterDropdown";
import { useExternalValues } from "./externalValues";
import {
  STATUS_LABEL, UPDATED_ID, controlLabel, controlOptions, controlValues, filterFeatures, findField, formValues, isFiltered, lastLabel, noFilters, toggleEquals, withoutField,
  type Filters, type Source,
} from "../../lib/dashboard";
import type { DashControl, Form, Feature } from "../../lib/types";

type SetFilters = (n: Filters | ((f: Filters) => Filters)) => void;

/** One category selector. Its values come from the page's records, another form, or a web address. */
function CategoryControl({ c, source, forms, features, filters, effective, now, setFilters }:
  { c: DashControl; source: Source; forms: Form[]; features: Feature[]; filters: Filters; effective: Filters; now: Date; setFilters: SetFilters }) {
  const def = findField(source.defs, c.field)!;
  const src = c.source;
  const web = useExternalValues(src);
  const fromForm = useMemo(() => (src?.type === "form" ? formValues(features, forms.find((f) => f.id === src.form_id), src.field) : []), [src, forms, features]);
  // Counts follow every other filter but not this field's own, so a second value can always be added.
  const rows = useMemo(() => filterFeatures(source.base, withoutField(effective, def.id), source.defs, now), [source, effective, def.id, now]);
  const label = controlLabel(c, source.defs), selected = controlValues(filters, c);
  const { options, listed } = controlOptions(c, def, source.base, rows, src?.type === "url" ? web.values : fromForm, selected);
  const entry = (o: { key: string; label: string }) => ({ field: def.id, value: o.key, label: `${label}: ${o.label}`, src: c.id });
  const own = (e: Filters["equals"][number]) => e.field === def.id && (e.src === c.id || e.src === undefined);
  const toggle = (o: { key: string; label: string }) => setFilters((f) => (c.multi === false ? { ...f, equals: [...f.equals.filter((e) => !own(e)), entry(o)] } : toggleEquals(f, entry(o))));
  const status = web.status === "loading" ? { kind: "loading" as const, message: web.message } : web.status === "error" ? { kind: "error" as const, message: web.message } : undefined;
  return <FilterDropdown id={`ctl-${c.id}`} label={label} options={options} selected={selected} multi={c.multi !== false} listed={listed} status={status}
    onToggle={toggle} onClear={() => setFilters((f) => ({ ...f, equals: f.equals.filter((e) => !own(e)) }))} />;
}

type Common = { filters: Filters; setFilters: SetFilters };

export interface HeaderControlsProps extends Common {
  controls: DashControl[]; source?: Source; forms: Form[]; features: Feature[]; effective: Filters; now: Date;
  /** Controls an author has not finished setting up (shown to authors only), and the way to the panel that fixes them. */
  unfinished: { id: string; label: string; message: string }[];
  editing: boolean; onEdit: () => void;
}

/** The selectors, set into the title bar as divided cells (the way an Esri dashboard header holds them). */
export function HeaderControls({ controls, source, forms, features, filters, effective, now, setFilters, unfinished, editing, onEdit }: HeaderControlsProps) {
  if (!controls.length && !unfinished.length && !editing) return null;
  return (
    <div className="dash-controls" role="group" aria-label="Filters">
      {controls.map((c) => c.kind === "date"
        ? <DateSelect key={c.id} id={`ctl-${c.id}`} label={controlLabel(c, [])} days={filters.last?.days ?? null}
            onChange={(days) => setFilters((f) => ({ ...f, last: days == null ? undefined : { days, src: c.id, ...(c.field && c.field !== UPDATED_ID ? { field: c.field } : {}) } }))} />
        : source && <CategoryControl key={c.id} c={c} source={source} forms={forms} features={features} filters={filters} effective={effective} now={now} setFilters={setFilters} />)}
      {editing && unfinished.map((u) => <button key={u.id} type="button" className="dash-control-todo" onClick={onEdit} title={u.message}>{u.label}: finish setting up</button>)}
      {editing && !controls.length && !unfinished.length && <button type="button" className="dash-control-add" onClick={onEdit}>+ Add a filter</button>}
    </div>
  );
}

/** What is filtering right now and how many records are left. A slim line that is there only while something is filtered. */
export function ActiveFilters({ filters, setFilters, shown, total }: Common & { shown: number; total: number }) {
  const chips: { key: string; text: string; remove: () => void }[] = [];
  for (const e of filters.equals) chips.push({ key: `e${e.field}|${e.value}`, text: e.label, remove: () => setFilters((f) => ({ ...f, equals: f.equals.filter((x) => x !== e) })) });
  for (const r of filters.ranges ?? []) chips.push({ key: `r${r.field}${r.from}${r.to}`, text: r.label, remove: () => setFilters((f) => ({ ...f, ranges: (f.ranges ?? []).filter((x) => x !== r) })) });
  if (filters.last) chips.push({ key: "last", text: lastLabel(filters.last.days), remove: () => setFilters((f) => ({ ...f, last: undefined })) });
  // An older shared address can still carry a review status or dates. They have no box any more, so they show here and can be removed.
  if (filters.status !== "all") chips.push({ key: "status", text: `Review status: ${STATUS_LABEL[filters.status]}`, remove: () => setFilters((f) => ({ ...f, status: "all" })) });
  if (filters.from) chips.push({ key: "from", text: `Changed from ${filters.from}`, remove: () => setFilters((f) => ({ ...f, from: undefined })) });
  if (filters.to) chips.push({ key: "to", text: `Changed until ${filters.to}`, remove: () => setFilters((f) => ({ ...f, to: undefined })) });
  if (!isFiltered(filters)) return null;
  return (
    <div className="dash-active" role="group" aria-label="Active filters">
      <ul className="dash-chips">{chips.map((c) => (
        <li key={c.key} className="chip-x">{c.text}<button type="button" aria-label={`Remove filter ${c.text}`} onClick={c.remove}>×</button></li>))}</ul>
      <Button small variant="ghost" onClick={() => setFilters(noFilters())}>Clear all</Button>
      <span className="dash-count" aria-live="polite">{shown} of {total} {total === 1 ? "record" : "records"}</span>
    </div>
  );
}
