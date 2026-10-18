import { useMemo, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import MapView, { type MapFeature as ViewFeature } from "../components/MapView";
import { Button, ErrorState, Loading, useToast } from "../components/ui";
import { loadApi } from "../lib/api";
import { uuid } from "../lib/forms";
import { useAsync } from "../lib/hooks";
import type { Geometry, GeometryType, LayerField, LayerFieldType, LayerGeometry, MapFeature, MapLayer, Props } from "../lib/types";

const DRAFT_ID = "__draft";
const GEOMETRY_FOR: Record<Exclude<LayerGeometry, "any">, GeometryType> = { point: "Point", line: "LineString", area: "Polygon" };
const TYPE_LABEL: Record<GeometryType, string> = { Point: "point", LineString: "line", Polygon: "area" };

/** Imagery presets. "Custom" lets you paste any XYZ URL; check the provider's terms of use for what you add. */
const PRESETS = [
  { label: "Esri World Imagery", url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", attribution: "Tiles © Esri and contributors", max: 19 },
  { label: "OpenStreetMap", url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png", attribution: "© OpenStreetMap contributors", max: 19 },
  { label: "Custom URL", url: "", attribution: "", max: 19 },
] as const;

function slug(label: string, taken: LayerField[]): string {
  const base = (label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "field").replace(/^(\d)/, "f_$1").slice(0, 36);
  let id = base, n = 2;
  while (taken.some((f) => f.id === id)) id = `${base}_${n++}`;
  return id;
}

/** Attribute inputs for a layer's own fields (no forms involved). */
function AttributeForm({ fields, value, onChange, errors }: { fields: LayerField[]; value: Props; onChange: (p: Props) => void; errors: Record<string, string> }) {
  const set = (id: string, v: unknown) => onChange({ ...value, [id]: v });
  if (fields.length === 0) return <span className="field-hint">This layer has no attribute fields.</span>;
  return (
    <div className="stack">
      {fields.map((f) => {
        const id = `attr-${f.id}`;
        const err = errors[f.id];
        return (
          <div className="field" key={f.id}>
            {f.type === "checkbox" ? (
              <label className="check"><input type="checkbox" checked={value[f.id] === true} onChange={(e) => set(f.id, e.target.checked)} />{f.label}</label>
            ) : (
              <>
                <label htmlFor={id}>{f.label}</label>
                {f.type === "choice" && f.choices?.length ? (
                  <select id={id} value={String(value[f.id] ?? "")} onChange={(e) => set(f.id, e.target.value)}>
                    <option value="">Choose…</option>
                    {f.choices.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                ) : (
                  <input id={id} type={f.type === "number" ? "number" : f.type === "date" ? "date" : "text"} inputMode={f.type === "number" ? "decimal" : undefined}
                    value={String(value[f.id] ?? "")}
                    onChange={(e) => set(f.id, f.type === "number" && e.target.value !== "" ? Number(e.target.value) : e.target.value)} />
                )}
              </>
            )}
            {err && <span className="field-error" role="alert">{err}</span>}
          </div>
        );
      })}
    </div>
  );
}

export default function MapEditorPage() {
  const { mapId = "" } = useParams();
  const toast = useToast();
  const { data, error, loading, reload, setData } = useAsync(async (api) => {
    const [map, layers, features, sources] = await Promise.all([api.getMap(mapId), api.listMapLayers(mapId), api.listMapFeatures(mapId), api.listImagerySources(mapId)]);
    return { map, layers, features, sources };
  }, [mapId]);

  const [activeLayerId, setActiveLayerId] = useState("");
  const [anyType, setAnyType] = useState<GeometryType>("Point");
  const [hiddenLayers, setHiddenLayers] = useState<Set<string>>(new Set());
  const [hiddenSources, setHiddenSources] = useState<Set<string>>(new Set());
  const [drawing, setDrawing] = useState(false);
  const [draft, setDraft] = useState<Geometry | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [props, setProps] = useState<Props>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  // new layer form
  const [layerForm, setLayerForm] = useState<{ name: string; geometry_type: LayerGeometry; fields: LayerField[] } | null>(null);
  const [fieldLabel, setFieldLabel] = useState("");
  const [fieldType, setFieldType] = useState<LayerFieldType>("text");
  // new imagery form
  const [imgForm, setImgForm] = useState<{ preset: number; name: string; url: string; attribution: string; max: number } | null>(null);
  const [busyImg, setBusyImg] = useState(false);

  const layers = data?.layers ?? [];
  const activeLayer: MapLayer | null = layers.find((l) => l.id === (activeLayerId || layers[0]?.id)) ?? null;
  const selected = data?.features.find((f) => f.id === selectedId) ?? null;
  const editingLayer = draft ? activeLayer : layers.find((l) => l.id === selected?.layer_id) ?? null;
  const drawType: GeometryType | null = activeLayer ? (activeLayer.geometry_type === "any" ? anyType : GEOMETRY_FOR[activeLayer.geometry_type]) : null;

  const viewFeatures: ViewFeature[] = useMemo(() => {
    const list: ViewFeature[] = (data?.features ?? []).filter((f) => !hiddenLayers.has(f.layer_id)).map((f) => ({ id: f.id, geometry: f.geometry, properties: f.properties }));
    if (draft) list.push({ id: DRAFT_ID, geometry: draft, pending: true });
    return list;
  }, [data, hiddenLayers, draft]);

  const imagery = (data?.sources ?? []).filter((s) => !hiddenSources.has(s.id))
    .map((s) => ({ id: s.id, url: s.url_template, tileSize: s.tile_size, minzoom: s.min_zoom, maxzoom: s.max_zoom, attribution: s.attribution }));

  if (loading) return <Loading label="Loading map…" />;
  if (error != null || !data) return <div className="container"><ErrorState error={error} onRetry={reload} /></div>;

  const fail = (e: unknown, fallback: string) => toast(e instanceof Error ? e.message : fallback, "error");
  const toggle = (set: Set<string>, id: string, on: boolean) => { const n = new Set(set); if (on) n.delete(id); else n.add(id); return n; };

  function select(id: string | null) {
    if (draft) return;
    setSelectedId(id);
    const f = data!.features.find((x) => x.id === id);
    setProps(f ? { ...f.properties } : {});
    setErrors({});
  }
  function cancelEdit() { setDraft(null); setDrawing(false); setSelectedId(null); setProps({}); setErrors({}); }

  async function saveFeature() {
    if (!editingLayer) return;
    setSaving(true);
    setErrors({});
    try {
      const api = await loadApi();
      if (draft) {
        const row = await api.createMapFeature(mapId, { id: uuid(), layer_id: editingLayer.id, geometry: draft, properties: props });
        setData({ ...data!, features: [...data!.features, row] });
        toast("Feature saved.", "success");
      } else if (selected) {
        const row = await api.updateMapFeature(selected.id, { base_version: selected.version, properties: props });
        setData({ ...data!, features: data!.features.map((f) => (f.id === row.id ? row : f)) });
        toast("Feature updated.", "success");
      }
      cancelEdit();
    } catch (e) {
      const fields = (e as { fields?: Record<string, string> }).fields;
      if (fields) setErrors(fields);
      fail(e, "Could not save the feature.");
    } finally { setSaving(false); }
  }

  async function removeFeature(f: MapFeature) {
    if (!window.confirm("Delete this feature?")) return;
    try {
      await (await loadApi()).deleteMapFeature(f.id);
      setData({ ...data!, features: data!.features.filter((x) => x.id !== f.id) });
      cancelEdit();
      toast("Feature deleted.", "success");
    } catch (e) { fail(e, "Could not delete."); }
  }

  async function createLayer(e: FormEvent) {
    e.preventDefault();
    if (!layerForm) return;
    try {
      const l = await (await loadApi()).createMapLayer(mapId, { name: layerForm.name.trim(), geometry_type: layerForm.geometry_type, fields: layerForm.fields });
      setData({ ...data!, layers: [...data!.layers, l] });
      setActiveLayerId(l.id); setLayerForm(null); setFieldLabel("");
      toast("Layer added.", "success");
    } catch (err) { fail(err, "Could not add the layer."); }
  }

  async function removeLayer(l: MapLayer) {
    if (!window.confirm(`Delete layer "${l.name}" and its features?`)) return;
    try {
      await (await loadApi()).deleteMapLayer(l.id);
      setData({ ...data!, layers: data!.layers.filter((x) => x.id !== l.id), features: data!.features.filter((f) => f.layer_id !== l.id) });
      cancelEdit(); setActiveLayerId("");
    } catch (err) { fail(err, "Could not delete the layer."); }
  }

  async function addImagery(e: FormEvent) {
    e.preventDefault();
    if (!imgForm) return;
    setBusyImg(true);
    try {
      const s = await (await loadApi()).addImagerySource(mapId, { name: imgForm.name.trim(), url_template: imgForm.url.trim(), attribution: imgForm.attribution, max_zoom: imgForm.max });
      setData({ ...data!, sources: [...data!.sources, s] });
      setImgForm(null);
      toast("Imagery added.", "success");
    } catch (err) { fail(err, "Could not add the imagery."); }
    finally { setBusyImg(false); }
  }

  async function removeImagery(id: string) {
    try {
      await (await loadApi()).deleteImagerySource(id);
      setData({ ...data!, sources: data!.sources.filter((s) => s.id !== id) });
    } catch (err) { fail(err, "Could not remove the imagery."); }
  }

  const editing = !!draft || !!selected;
  const canEdit = data.map.role !== "viewer";
  return (
    <div className="editor" style={{ flex: 1 }}>
      <aside className="side left" aria-label="Layers and imagery">
        <div><h2>Map</h2><strong>{data.map.name}</strong> <Link to="/maps" style={{ marginLeft: 8, fontSize: 13 }}>All maps</Link></div>

        <div className="stack">
          <h2>Layers</h2>
          {layers.length === 0 && <span className="field-hint">No layers yet. Add one to start drawing.</span>}
          {layers.map((l) => (
            <div className="row" key={l.id} style={{ alignItems: "center" }}>
              <input type="checkbox" aria-label={`Show ${l.name}`} checked={!hiddenLayers.has(l.id)} onChange={(e) => setHiddenLayers((h) => toggle(h, l.id, e.target.checked))} />
              <label className="check" style={{ flex: 1 }}>
                <input type="radio" name="active-layer" checked={activeLayer?.id === l.id} onChange={() => setActiveLayerId(l.id)} />
                {l.name}<span className="mono" style={{ marginLeft: "auto" }}>{data.features.filter((f) => f.layer_id === l.id).length}</span>
              </label>
              {canEdit && <Button small variant="danger" onClick={() => removeLayer(l)} aria-label={`Delete ${l.name}`}>×</Button>}
            </div>
          ))}
          {canEdit && !layerForm && <Button onClick={() => setLayerForm({ name: "", geometry_type: "any", fields: [] })}>Add layer</Button>}
          {layerForm && (
            <form className="card" onSubmit={createLayer}>
              <div className="field"><label htmlFor="ln">Layer name</label><input id="ln" required autoFocus value={layerForm.name} onChange={(e) => setLayerForm({ ...layerForm, name: e.target.value })} /></div>
              <div className="field"><label htmlFor="lg">Holds</label>
                <select id="lg" value={layerForm.geometry_type} onChange={(e) => setLayerForm({ ...layerForm, geometry_type: e.target.value as LayerGeometry })}>
                  <option value="any">Any shape</option><option value="point">Points</option><option value="line">Lines</option><option value="area">Areas</option>
                </select></div>
              <h2>Attribute fields</h2>
              {layerForm.fields.map((f) => (
                <div className="row" key={f.id}><span style={{ flex: 1 }}>{f.label} <span className="field-hint">({f.type})</span></span>
                  <Button small onClick={() => setLayerForm({ ...layerForm, fields: layerForm.fields.filter((x) => x.id !== f.id) })}>Remove</Button></div>
              ))}
              <div className="row">
                <input aria-label="Field name" placeholder="Field name" value={fieldLabel} onChange={(e) => setFieldLabel(e.target.value)} style={{ flex: 1, minWidth: 0 }} />
                <select aria-label="Field type" value={fieldType} onChange={(e) => setFieldType(e.target.value as LayerFieldType)}>
                  <option value="text">Text</option><option value="number">Number</option><option value="date">Date</option><option value="checkbox">Checkbox</option>
                </select>
                <Button small disabled={!fieldLabel.trim()} onClick={() => { setLayerForm({ ...layerForm, fields: [...layerForm.fields, { id: slug(fieldLabel, layerForm.fields), label: fieldLabel.trim(), type: fieldType }] }); setFieldLabel(""); }}>Add</Button>
              </div>
              <div className="row"><Button type="submit" variant="primary">Create layer</Button><Button onClick={() => setLayerForm(null)}>Cancel</Button></div>
            </form>
          )}
        </div>

        {canEdit && activeLayer && (
          <div className="stack">
            <h2>Draw on {activeLayer.name}</h2>
            {activeLayer.geometry_type === "any" && (
              <div className="field"><label htmlFor="at">Shape</label>
                <select id="at" value={anyType} disabled={drawing || !!draft} onChange={(e) => setAnyType(e.target.value as GeometryType)}>
                  <option value="Point">Point</option><option value="LineString">Line</option><option value="Polygon">Area</option>
                </select></div>
            )}
            <Button variant="primary" disabled={drawing || !!draft} onClick={() => { select(null); setDrawing(true); }}>Add {drawType ? TYPE_LABEL[drawType] : "feature"}</Button>
          </div>
        )}

        <div className="stack">
          <h2>Imagery</h2>
          {data.sources.length === 0 && <span className="field-hint">No imagery yet. Add a tile URL to digitize from.</span>}
          {data.sources.map((s) => (
            <div className="row" key={s.id} style={{ alignItems: "center" }}>
              <label className="check" style={{ flex: 1 }}>
                <input type="checkbox" checked={!hiddenSources.has(s.id)} onChange={(e) => setHiddenSources((h) => toggle(h, s.id, e.target.checked))} />{s.name}
              </label>
              {canEdit && <Button small onClick={() => removeImagery(s.id)} aria-label={`Remove ${s.name}`}>×</Button>}
            </div>
          ))}
          {canEdit && !imgForm && <Button onClick={() => setImgForm({ preset: 0, name: PRESETS[0].label, url: PRESETS[0].url, attribution: PRESETS[0].attribution, max: PRESETS[0].max })}>Add imagery from URL</Button>}
          {imgForm && (
            <form className="card" onSubmit={addImagery}>
              <div className="field"><label htmlFor="ip">Source</label>
                <select id="ip" value={imgForm.preset} onChange={(e) => { const p = PRESETS[Number(e.target.value)]; setImgForm({ preset: Number(e.target.value), name: p.label === "Custom URL" ? "" : p.label, url: p.url, attribution: p.attribution, max: p.max }); }}>
                  {PRESETS.map((p, i) => <option key={p.label} value={i}>{p.label}</option>)}
                </select></div>
              <div className="field"><label htmlFor="in">Name</label><input id="in" required value={imgForm.name} onChange={(e) => setImgForm({ ...imgForm, name: e.target.value })} /></div>
              <div className="field"><label htmlFor="iu">Tile URL</label>
                <input id="iu" required placeholder="https://host/{z}/{x}/{y}.png" value={imgForm.url} onChange={(e) => setImgForm({ ...imgForm, url: e.target.value })} />
                <span className="field-hint">Use {"{z}"}, {"{x}"} and {"{y}"}. Tiles load straight from the provider, so follow its terms of use.</span></div>
              <div className="field"><label htmlFor="ia">Attribution</label><input id="ia" value={imgForm.attribution} onChange={(e) => setImgForm({ ...imgForm, attribution: e.target.value })} /></div>
              <div className="field"><label htmlFor="iz">Max zoom</label><input id="iz" type="number" min={0} max={24} value={imgForm.max} onChange={(e) => setImgForm({ ...imgForm, max: Number(e.target.value) })} /></div>
              <div className="row"><Button type="submit" variant="primary" busy={busyImg}>Add imagery</Button><Button onClick={() => setImgForm(null)}>Cancel</Button></div>
            </form>
          )}
          <span className="field-hint">Uploading your own GeoTIFF or image to a map is coming next.</span>
        </div>
      </aside>

      <MapView
        features={viewFeatures}
        selectedId={draft ? DRAFT_ID : selectedId}
        drawMode={drawing ? drawType : null}
        onDraw={(g) => { setDraft(g); setDrawing(false); setProps({}); setErrors({}); }}
        onCancelDraw={() => setDrawing(false)}
        onSelect={select}
        imagery={imagery}
        fitKey={mapId}
        label="Map"
      />

      <aside className="side right" aria-label="Feature details" aria-live="polite">
        {!editing && <div className="state"><strong>Nothing selected</strong>{layers.length === 0 ? "Add a layer, then draw on it." : "Select a feature on the map, or draw a new one."}</div>}
        {editing && editingLayer && (
          <>
            <div><h2>{draft ? "New feature" : "Selected feature"}</h2><strong>{editingLayer.name}</strong>
              {selected && <div className="meta" style={{ fontSize: 13, color: "var(--muted)" }}>Version {selected.version} · {new Date(selected.updated_at).toLocaleDateString()}</div>}</div>
            <AttributeForm fields={editingLayer.fields} value={props} onChange={setProps} errors={errors} />
            <div className="row" style={{ marginTop: "auto" }}>
              <Button className="grow" onClick={cancelEdit}>{draft ? "Cancel" : "Close"}</Button>
              {canEdit && <Button className="grow" variant="primary" busy={saving} onClick={saveFeature}>Save feature</Button>}
            </div>
            {selected && canEdit && <Button variant="danger" small onClick={() => removeFeature(selected)}>Delete feature</Button>}
          </>
        )}
      </aside>
    </div>
  );
}
