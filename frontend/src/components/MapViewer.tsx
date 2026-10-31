import { useEffect, useMemo, useState, type ReactNode } from "react";
import MapView, { type Bbox, type MapFeature, type MapImagery } from "./MapView";
import SymbologyPanel from "./SymbologyPanel";
import { Button } from "./ui";
import { STATUS_LABEL, dashboardFields, display } from "../lib/dashboard";
import { bboxOf } from "../lib/forms";
import { SymbolIcon } from "./SymbolIcon";
import { symbolUri } from "../lib/symbols";
import { BASEMAPS, colorOf, iconOf, layerOf, legendOf, type BasemapId, type LayerStyle, type ViewerStyle } from "../lib/symbology";
import type { Feature, Form } from "../lib/types";

/** One layer of the viewer: everything collected with one form. */
export interface ViewerLayer { id: string; name: string; form: Form; features: Feature[] }
export type ViewerImagery = MapImagery & { name: string };
const TABLE_ROWS = 200;

/**
 * Shows collected data on a map and lets you change how each layer is drawn, the way a web map viewer does.
 * It never edits records: collecting and correcting data happens in the forms and in Collected data.
 * Without `onStyleChange` the styling controls are hidden (public and read-only views).
 */
export default function MapViewer({ layers, imagery = [], style, onStyleChange, label = "Map", fitKey, compact = false, footer, focus, onPickFeature }: {
  layers: ViewerLayer[]; imagery?: ViewerImagery[]; style: ViewerStyle; onStyleChange?: (next: ViewerStyle) => void;
  label?: string; fitKey?: string;
  /** A small map with no side panel (a dashboard element): just the map, its legend and the pop-up. */
  compact?: boolean;
  /** Shown at the bottom of the pop-up, for example a link to the record. */
  footer?: (f: Feature, layer: ViewerLayer) => ReactNode;
  /**
   * Zoom to these records (a new `key` each time). One record also opens its pop-up, when `popup` is true. This is how a list or a
   * chart in a dashboard sends the map somewhere. Records the map is not drawing are ignored.
   */
  focus?: { ids: string[]; key: number; popup: boolean } | null;
  /** A point was clicked (id) or the pop-up was dismissed (null). */
  onPickFeature?: (id: string | null) => void;
}) {
  const canStyle = !!onStyleChange;
  const [styling, setStyling] = useState<string | null>(null);        // layer whose style panel is open
  const [picked, setPicked] = useState<string | null>(null);          // selected feature
  const [tableOf, setTableOf] = useState<string | null>(null);        // layer whose table is open
  const [hiddenImg, setHiddenImg] = useState<Set<string>>(new Set());
  const [fly, setFly] = useState<{ bounds: Bbox; key: number } | null>(null);
  const [legendOpen, setLegendOpen] = useState(true);

  const rows = useMemo(() => layers.map((l, i) => ({ layer: l, ls: layerOf(style, l.id, i), live: l.features.filter((f) => !f.deleted) })), [layers, style]);
  const mapFeatures = useMemo<MapFeature[]>(() => {
    // One picture per distinct symbol and colour, however many points use it.
    const pics = new Map<string, { key: string; uri: string; scale?: number } | undefined>();
    const picture = (f: Feature, ls: LayerStyle, color: string) => {
      const spec = f.geometry.type === "Point" ? iconOf(f, ls) : undefined;
      if (!spec) return undefined;
      const k = JSON.stringify([spec, color]);
      if (!pics.has(k)) {
        const uri = symbolUri({ ...spec, motion: undefined }, { color, forMap: true });
        let h = 5381; for (let i = 0; i < uri.length; i++) h = ((h << 5) + h + uri.charCodeAt(i)) | 0;
        pics.set(k, uri ? { key: `ic${(h >>> 0).toString(36)}`, uri, ...(spec.size ? { scale: spec.size / 32 } : {}) } : undefined);
      }
      return pics.get(k);
    };
    return rows.filter((r) => r.ls.visible).flatMap(({ ls, live }) => live.map((f) => {
      const color = colorOf(f, ls), icon = picture(f, ls, color);
      return { id: f.id, geometry: f.geometry, properties: f.properties, look: { color, outline: ls.symbol.outline, size: ls.symbol.size, width: ls.symbol.width, opacity: ls.symbol.opacity, ...(icon ? { icon } : {}) } };
    }));
  }, [rows]);
  const owner = useMemo(() => { const m = new Map<string, { layer: ViewerLayer; f: Feature }>(); for (const r of rows) for (const f of r.live) m.set(f.id, { layer: r.layer, f }); return m; }, [rows]);
  const sel = picked ? owner.get(picked) ?? null : null;
  const shownImagery = imagery.filter((i) => !hiddenImg.has(i.id));
  const basemap = style.basemap;

  const setLayer = (id: string, next: LayerStyle) => onStyleChange?.({ ...style, layers: { ...style.layers, [id]: next } });
  const setBase = (b: BasemapId) => onStyleChange?.({ ...style, basemap: b });
  const zoomTo = (fs: Feature[]) => {
    const b = bboxOf(fs.map((f) => f.geometry));
    if (!b) return;
    // One point (or points on top of each other) would zoom to the closest level; give it about a street's width of context.
    const pad = (lo: number, hi: number) => (hi - lo < 0.0004 ? 0.0015 : 0);
    const px = pad(b[0], b[2]), py = pad(b[1], b[3]);
    setFly({ bounds: [b[0] - px, b[1] - py, b[2] + px, b[3] + py] as Bbox, key: Date.now() });
  };
  const total = rows.reduce((n, r) => n + (r.ls.visible ? r.live.length : 0), 0);
  const styled = styling ? rows.find((r) => r.layer.id === styling) : undefined;
  const table = tableOf ? rows.find((r) => r.layer.id === tableOf) : undefined;

  // Sent here by another element: zoom to the record(s) and, for one, show its pop-up.
  useEffect(() => {
    if (!focus) return;
    const hit = focus.ids.map((id) => owner.get(id)).filter((x): x is { layer: ViewerLayer; f: Feature } => !!x);
    if (!hit.length) return;
    zoomTo(hit.map((h) => h.f));
    setPicked(focus.popup && hit.length === 1 ? hit[0].f.id : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.key]);
  const pick = (id: string | null) => { setPicked(id && owner.has(id) ? id : null); onPickFeature?.(id && owner.has(id) ? id : null); };

  const popup = sel && (
    <div className="viewer-popup" role="dialog" aria-label={`${sel.layer.name} record`}>
      <div className="row" style={{ gap: 8, alignItems: "flex-start" }}>
        <div className="grow"><strong>{sel.layer.name}</strong><span className="field-hint" style={{ display: "block" }}>{STATUS_LABEL[sel.f.status]} · {new Date(sel.f.updated_at).toLocaleDateString()}</span></div>
        <Button small variant="ghost" aria-label="Close pop-up" onClick={() => pick(null)}>✕</Button>
      </div>
      <dl className="kv">
        {dashboardFields(sel.layer.form).map((d) => ({ d, v: display(sel.f, d) })).filter((x) => x.v !== "" && x.v !== "–").map(({ d, v }) => <div key={d.id} className="kv-row"><dt>{d.label}</dt><dd>{v}</dd></div>)}
      </dl>
      <div className="row" style={{ gap: 8 }}>
        <Button small onClick={() => zoomTo([sel.f])}>Zoom to</Button>
        {footer?.(sel.f, sel.layer)}
      </div>
    </div>
  );

  const legend = (
    <div className="viewer-legend" aria-label="Legend">
      <button type="button" className="viewer-legend-head" aria-expanded={legendOpen} onClick={() => setLegendOpen((o) => !o)}>Legend <span aria-hidden="true">{legendOpen ? "▾" : "▸"}</span></button>
      {legendOpen && (
        <div className="stack" style={{ gap: 8 }}>
          {rows.filter((r) => r.ls.visible).map((r) => (
            <div key={r.layer.id}>
              {rows.length > 1 && <strong style={{ fontSize: 13 }}>{r.layer.name}</strong>}
              <ul className="plain-list">
                {legendOf(r.live, r.ls).map((x) => <li key={x.label} className="row" style={{ gap: 8, fontSize: 13 }}>{x.icon ? <SymbolIcon spec={{ ...x.icon, motion: undefined, shape: x.icon.shape ?? "circle" }} size={20} color={x.color} /> : <span className="swatch" style={{ background: x.color }} aria-hidden="true" />}<span className="grow">{x.label}</span><span className="mono">{x.count}</span></li>)}
              </ul>
            </div>
          ))}
          {total === 0 && <span className="field-hint">Nothing to show on the map.</span>}
        </div>
      )}
    </div>
  );

  const map = (
    <MapView features={mapFeatures} selectedId={picked} onSelect={pick} imagery={shownImagery} basemap={basemap}
      flyTo={fly} fitKey={fitKey} label={label} geolocate={!compact}>
      {legend}
      {popup}
    </MapView>
  );
  if (compact) return <div className="viewer viewer-compact">{map}</div>;

  return (
    <div className="editor viewer">
      <aside className="side left" aria-label="Layers and styles">
        {styled ? (
          <div className="stack">
            <div className="row" style={{ gap: 8 }}><Button small onClick={() => setStyling(null)}>← Layers</Button><strong className="grow">Style: {styled.layer.name}</strong></div>
            <SymbologyPanel form={styled.layer.form} features={styled.live} value={styled.ls} onChange={(n) => setLayer(styled.layer.id, n)} />
          </div>
        ) : (
          <>
            <div className="stack">
              <h2>Layers</h2>
              {rows.length === 0 && <span className="field-hint">No published forms yet, so there is nothing to show.</span>}
              <ul className="plain-list viewer-layers">
                {rows.map(({ layer, ls, live }) => (
                  <li key={layer.id} className="viewer-layer">
                    <label className="check" style={{ minHeight: 0 }}>
                      <input type="checkbox" checked={ls.visible} onChange={(e) => setLayer(layer.id, { ...ls, visible: e.target.checked })} disabled={!canStyle} aria-label={`Show ${layer.name}`} />
                      <span className="swatch" style={{ background: ls.renderer.kind === "single" ? ls.symbol.color : "conic-gradient(#1f6b52, #2f6fb0, #d98a0b, #c0392b, #1f6b52)" }} aria-hidden="true" />
                      <span className="grow">{layer.name}</span><span className="mono">{live.length}</span>
                    </label>
                    <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                      <Button small variant="ghost" onClick={() => zoomTo(live)} disabled={!live.length}>Zoom to</Button>
                      {canStyle && <Button small variant="ghost" onClick={() => setStyling(layer.id)}>Style</Button>}
                      <Button small variant="ghost" aria-pressed={tableOf === layer.id} onClick={() => setTableOf(tableOf === layer.id ? null : layer.id)}>Table</Button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
            <div className="stack">
              <h2>Basemap</h2>
              <div role="radiogroup" aria-label="Basemap" className="stack" style={{ gap: 6 }}>
                {BASEMAPS.map((b) => <label key={b.id} className="check" style={{ minHeight: 0 }}><input type="radio" name="basemap" checked={basemap === b.id} disabled={!canStyle} onChange={() => setBase(b.id)} />{b.label}</label>)}
              </div>
            </div>
            {imagery.length > 0 && (
              <div className="stack">
                <h2>Imagery</h2>
                {imagery.map((i) => <label className="check" key={i.id}><input type="checkbox" checked={!hiddenImg.has(i.id)} onChange={(e) => setHiddenImg((h) => { const n = new Set(h); if (e.target.checked) n.delete(i.id); else n.add(i.id); return n; })} />{i.name}</label>)}
              </div>
            )}
            {!canStyle && <span className="field-hint">You can look at this map but not change how it is drawn.</span>}
          </>
        )}
      </aside>

      <div className="editor-center">
        {map}
        {table && (
          <section className="viewer-table" aria-label={`${table.layer.name} table`}>
            <div className="row" style={{ gap: 8, padding: "8px 12px" }}>
              <strong className="grow">{table.layer.name} · {table.live.length} {table.live.length === 1 ? "record" : "records"}{table.live.length > TABLE_ROWS ? ` (first ${TABLE_ROWS})` : ""}</strong>
              <Button small onClick={() => setTableOf(null)}>Close table</Button>
            </div>
            <TableBody layer={table.layer} features={table.live.slice(0, TABLE_ROWS)} pickedId={picked} onPick={(f) => { setPicked(f.id); zoomTo([f]); }} />
          </section>
        )}
      </div>
    </div>
  );
}

function TableBody({ layer, features, pickedId, onPick }: { layer: ViewerLayer; features: Feature[]; pickedId: string | null; onPick: (f: Feature) => void }) {
  const cols = useMemo(() => dashboardFields(layer.form).filter((d) => d.type !== "calculation" && d.type !== "updated").slice(0, 7), [layer.form]);
  return (
    <div className="dash-table">
      <table className="data-table">
        <thead><tr>{cols.map((c) => <th key={c.id} scope="col">{c.label}</th>)}</tr></thead>
        <tbody>
          {features.map((f) => (
            <tr key={f.id} className={f.id === pickedId ? "picked" : undefined} onClick={() => onPick(f)} style={{ cursor: "pointer" }}>
              {cols.map((c, i) => <td key={c.id}>{i === 0 ? <button type="button" className="link-btn" onClick={(e) => { e.stopPropagation(); onPick(f); }}>{display(f, c) || "–"}</button> : display(f, c)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
