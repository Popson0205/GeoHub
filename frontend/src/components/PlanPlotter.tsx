import { useMemo, useState } from "react";
import { t, useLang } from "../lib/i18n";
import { GRIDS, plotCoordinates, plotTraverse, type Leg, type LegFix, type Plan, type Plotted } from "../lib/surveyPlan";
import type { Geometry } from "../lib/types";
import { Button } from "./ui";

const GRID_KEY = "geohub.planGrid";
const blankLegs = (n: number): Leg[] => Array.from({ length: n }, () => ["", "", "", ""]);

/**
 * The plot's boundary from its survey plan: the grid, the starting point and each leg's bearing (degrees, minutes,
 * seconds) and distance; or the beacons' coordinates. "Plot it" shows how well it closes and the area; "Use this
 * boundary" gives the polygon and the plan to keep with the record. Works offline.
 */
export default function PlanPlotter({ initial, onPreview, onUse, onCancel }: {
  initial?: Plan | null; onPreview: (g: Geometry | null) => void; onUse: (g: Geometry, plan: Plan) => void; onCancel: () => void;
}) {
  useLang();
  const [grid, setGrid] = useState<number>(() => initial?.grid ?? (() => { try { return Number(localStorage.getItem(GRID_KEY)) || 26332; } catch { return 26332; } })());
  const [method, setMethod] = useState<"traverse" | "coordinates">(initial?.method ?? "traverse");
  const [start, setStart] = useState<[string, string]>(initial?.start ? [String(initial.start[0]), String(initial.start[1])] : ["", ""]);
  const [legs, setLegs] = useState<Leg[]>(initial?.legs ? initial.legs.map((l) => l.map(String) as Leg) : blankLegs(4));
  const [beacons, setBeacons] = useState<[string, string][]>(initial?.points ? initial.points.map(([e, n]) => [String(e), String(n)]) : [["", ""], ["", ""], ["", ""], ["", ""]]);
  const [planArea, setPlanArea] = useState(initial?.plan_area ? String(initial.plan_area) : "");
  const [result, setResult] = useState<Plotted | null>(null);
  const key = useMemo(() => JSON.stringify([grid, method, start, legs, beacons, planArea]), [grid, method, start, legs, beacons, planArea]);
  const [plottedKey, setPlottedKey] = useState("");
  const fresh = result?.ok && plottedKey === key;

  const plot = () => {
    const r = method === "traverse" ? plotTraverse(grid, start, legs, planArea) : plotCoordinates(grid, beacons);
    setResult(r); setPlottedKey(key);
    onPreview(r.ok ? r.geometry : null);
    try { localStorage.setItem(GRID_KEY, String(grid)); } catch { /* private mode */ }
  };
  /** Put the suggested closing figures into the n-th filled leg. */
  const applyFix = (f: LegFix) => {
    const at = legs.map((l, i) => (l.some((x) => x.trim()) ? i : -1)).filter((i) => i >= 0)[f.leg - 1];
    if (at == null) return;
    setLegs((ls) => ls.map((l, i) => (i === at ? [String(f.d), String(f.m), String(f.s), f.distance.toFixed(2)] : l)));
  };
  const setLeg = (i: number, j: number, v: string) => setLegs((ls) => ls.map((l, k) => (k === i ? (l.map((x, q) => (q === j ? v : x)) as Leg) : l)));
  const setBeacon = (i: number, j: number, v: string) => setBeacons((bs) => bs.map((b, k) => (k === i ? (j === 0 ? [v, b[1]] : [b[0], v]) : b)));
  const num = { inputMode: "decimal" as const, autoComplete: "off" };

  return (
    <div className="plan" aria-label={t("plan.title")}>
      <h2>{t("plan.title")}</h2>
      <span className="field-hint">{t("plan.hint")}</span>
      <div className="field"><label htmlFor="plan-grid">{t("plan.grid")}</label>
        <select id="plan-grid" value={grid} onChange={(e) => setGrid(Number(e.target.value))}>
          {GRIDS.map((g) => <option key={g.epsg} value={g.epsg}>{g.name}</option>)}
        </select></div>
      <div className="choice-row" role="group" aria-label={t("plan.title")}>
        <button type="button" className="choice" aria-pressed={method === "traverse"} onClick={() => setMethod("traverse")}>{t("plan.traverse")}</button>
        <button type="button" className="choice" aria-pressed={method === "coordinates"} onClick={() => setMethod("coordinates")}>{t("plan.coords")}</button>
      </div>
      {method === "traverse" ? <>
        <fieldset className="plan-start"><legend>{t("plan.start")}</legend>
          <div className="field"><label htmlFor="plan-e">{t("plan.easting")}</label><input id="plan-e" {...num} value={start[0]} onChange={(e) => setStart([e.target.value, start[1]])} /></div>
          <div className="field"><label htmlFor="plan-n">{t("plan.northing")}</label><input id="plan-n" {...num} value={start[1]} onChange={(e) => setStart([start[0], e.target.value])} /></div>
        </fieldset>
        <div className="field"><label htmlFor="plan-area">{t("plan.planArea")}</label><input id="plan-area" {...num} value={planArea} onChange={(e) => setPlanArea(e.target.value)} /></div>
        <span className="field-hint">{t("plan.legsHint")}</span>
        <ol className="plan-legs">
          {legs.map((l, i) => (
            <li key={i} className="plan-leg">
              <span className="plan-n">{i + 1}</span>
              <label><span>{t("plan.deg")}</span><input aria-label={`${t("plan.leg", { n: i + 1 })} ${t("plan.deg")}`} inputMode="numeric" maxLength={3} value={l[0]} onChange={(e) => setLeg(i, 0, e.target.value)} /></label>
              <label><span>{t("plan.min")}</span><input aria-label={`${t("plan.leg", { n: i + 1 })} ${t("plan.min")}`} inputMode="numeric" maxLength={2} value={l[1]} onChange={(e) => setLeg(i, 1, e.target.value)} /></label>
              <label><span>{t("plan.sec")}</span><input aria-label={`${t("plan.leg", { n: i + 1 })} ${t("plan.sec")}`} {...num} maxLength={5} value={l[2]} onChange={(e) => setLeg(i, 2, e.target.value)} /></label>
              <label className="wide"><span>{t("plan.dist")}</span><input aria-label={`${t("plan.leg", { n: i + 1 })} ${t("plan.dist")}`} {...num} value={l[3]} onChange={(e) => setLeg(i, 3, e.target.value)} /></label>
              {legs.length > 3 && <button type="button" className="plan-x" aria-label={`${t("plan.remove")} ${t("plan.leg", { n: i + 1 })}`} onClick={() => setLegs((ls) => ls.filter((_, k) => k !== i))}>×</button>}
            </li>
          ))}
        </ol>
        <Button small onClick={() => setLegs((ls) => [...ls, ["", "", "", ""]])}>{t("plan.addLeg")}</Button>
      </> : <>
        <ol className="plan-legs">
          {beacons.map((b, i) => (
            <li key={i} className="plan-leg is-coord">
              <span className="plan-n">{i + 1}</span>
              <label className="wide"><span>{t("plan.easting")}</span><input aria-label={`${t("plan.beacon", { n: i + 1 })} ${t("plan.easting")}`} {...num} value={b[0]} onChange={(e) => setBeacon(i, 0, e.target.value)} /></label>
              <label className="wide"><span>{t("plan.northing")}</span><input aria-label={`${t("plan.beacon", { n: i + 1 })} ${t("plan.northing")}`} {...num} value={b[1]} onChange={(e) => setBeacon(i, 1, e.target.value)} /></label>
              {beacons.length > 3 && <button type="button" className="plan-x" aria-label={`${t("plan.remove")} ${t("plan.beacon", { n: i + 1 })}`} onClick={() => setBeacons((bs) => bs.filter((_, k) => k !== i))}>×</button>}
            </li>
          ))}
        </ol>
        <Button small onClick={() => setBeacons((bs) => [...bs, ["", ""]])}>{t("plan.addBeacon")}</Button>
      </>}
      {result && !result.ok && <div className="state state-error" role="alert">
        {result.problem}
        {result.suspect ? <p>{t("plan.suspect", { n: result.suspect.leg, b: `${result.suspect.d}°${String(result.suspect.m).padStart(2, "0")}'${result.suspect.s}"`, d: result.suspect.distance.toFixed(2), a: result.suspect.area.toLocaleString() })}</p>
          : result.poor && !planArea.trim() ? <p>{t("plan.giveArea")}</p> : null}
        {(result.suspect || result.poor) && plottedKey === key && <div className="row">
          {result.suspect && <Button small onClick={() => applyFix(result.suspect!)}>{t("plan.useFix", { n: result.suspect.leg })}</Button>}
          {result.poor && <Button small onClick={() => { const p = result.poor!; onPreview(p.geometry); onUse(p.geometry, p.plan); }}>{t("plan.useAnyway")}</Button>}
        </div>}
      </div>}
      {result?.ok && (
        <div className={`plan-result${fresh ? "" : " is-stale"}`} role="status">
          <strong>{result.plan.ratio == null ? t("plan.exact") : t("plan.closes", { r: result.plan.ratio.toLocaleString(), m: result.plan.misclosure_m })}</strong>
          <span>{t("plan.area", { a: result.plan.area_m2.toLocaleString(), p: result.plan.perimeter_m })}</span>
          {result.warnings.map((w) => <span key={w}>{w}</span>)}
        </div>
      )}
      <div className="row" style={{ position: "sticky", bottom: 0, background: "var(--n-0)", padding: "8px 0" }}>
        <Button onClick={() => { onPreview(null); onCancel(); }}>{t("cancel")}</Button>
        {fresh ? <Button className="grow" variant="accent" onClick={() => result?.ok && onUse(result.geometry, result.plan)}>{t("plan.use")}</Button>
          : <Button className="grow" variant="primary" onClick={plot}>{t("plan.plot")}</Button>}
      </div>
    </div>
  );
}
