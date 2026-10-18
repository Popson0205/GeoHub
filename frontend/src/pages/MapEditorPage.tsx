import { useMemo, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import MapView, { type MapFeature as ViewFeature } from "../components/MapView";
import { Button, ErrorState, Loading, useToast } from "../components/ui";
import { loadApi } from "../lib/api";
import { uuid } from "../lib/forms";
import { useAsync } from "../lib/hooks";
import type { Geometry, GeometryType, MapFeature, MapLayer, Props } from "../lib/types";

const DRAFT_ID = "__draft";
const TOOLS: { type: GeometryType; label: string }[] = [
  { type: "Point", label: "Point" }, { type: "LineString", label: "Line" }, { type: "Polygon", label: "Area" },
];

/** Imagery presets. "Custom URL" lets you paste any XYZ URL; check the provider's terms of use for what you add. */
const PRESETS = [
  { label: "Esri World Imagery", url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", attribution: "Tiles © Esri and contributors", max: 19 },
  { label: "OpenStreetMap", url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png", attribution: "© OpenStreetMap contributors", max: 19 },
  { label: "Custom URL", url: "", attribution: "", max: 19 },
] as const;

type Tag = { k: string; v: string };
const toTags = (p: Props): Tag[] => Object.entries(p).map(([k, v]) => ({ k, v: v === null || v === undefined ? "" : String(v) }));

/** Free key/value tags, the way open mapping tools do it. Nothing is declared in advance. */
function TagEditor({ tags, onChange, suggestions }: { tags: Tag[]; onChange: (t: Tag[]) => void; suggestions: string[] }) {
  const set = (i: number, patch: Partial<Tag>) => onChange(tags.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  return (
    <div className="stack">
      <h2>Tags</h2>
      <datalist id="tag-keys">{suggestions.map((k) => <option key={k} value={k} />)}</datalist>
      {tags.length === 0 && <span className="field-hint">No tags yet. Add one, for example building = yes.</span>}
      {tags.map((t, i) => (
        <div className="row" key={i} style={{ alignItems: "center" }}>
          <input aria-label="Tag name" list="tag-keys" placeholder="name" value={t.k} onChange={(e) => set(i, { k: e.target.value })} style={{ flex: 1, minWidth: 0 }} />
          <input aria-label="Tag value" placeholder="value" value={t.v} onChange={(e) => set(i, { v: e.target.value })} style={{ flex: 1, minWidth: 0 }} />
          <Button small onClick={() => onChange(tags.filter((_, j) => j !== i))} aria-label="Remove tag">×</Button>
        </div>
      ))}
      <Button small onClick={() => onChange([...tags, { k: "", v: "" }])}>Add tag</Button>
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
  const [hiddenLayers, setHiddenLayers] = useState<Set<string>>(new Set());
  const [hiddenSources, setHiddenSources] = useState<Set<string>>(new Set());
  const [drawType, setDrawType] = useState<GeometryType | null>(null);
  const [draft, setDraft] = useState<Geometry | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tags, setTags] = useState<Tag[]>([]);
  const [saving, setSaving] = useState(false);
  const [newLayerName, setNewLayerName] = useState<string | null>(null);
  const [imgForm, setImgForm] = useState<{ preset: number; name: string; url: string; attribution: string; max: number } | null>(null);
  const [busyImg, setBusyImg] = useState(false);

  const layers = data?.layers ?? [];
  const activeLayer: MapLayer | null = layers.find((l) => l.id === (activeLayerId || layers[0]?.id)) ?? null;
  const selected = data?.features.find((f) => f.id === selectedId) ?? null;
  const editing = !!draft || !!selected;
  const canEdit = data?.map.role !== "viewer";

  const viewFeatures: ViewFeature[] = useMemo(() => {
    const list: ViewFeature[] = (data?.features ?? []).filter((f) => !hiddenLayers.has(f.layer_id)).map((f) => ({ id: f.id, geometry: f.geometry, properties: f.properties }));
    if (draft) list.push({ id: DRAFT_ID, geometry: draft, pending: true });
    return list;
  }, [data, hiddenLayers, draft]);

  const tagNames = useMemo(() => Array.from(new Set((data?.features ?? []).flatMap((f) => Object.keys(f.properties)))).sort(), [data]);

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
    setTags(f ? toTags(f.properties) : []);
  }
  function cancelEdit() { setDraft(null); setDrawType(null); setSelectedId(null); setTags([]); }

  /** Tags to an object. Blank rows are dropped; a repeated name is an error rather than a silent overwrite. */
  function tagsToProps(): Props | null {
    const out: Props = {};
    for (const t of tags) {
      const k = t.k.trim();
      if (!k) continue;
      if (k in out) { toast(`The tag "${k}" appears twice.`, "error"); return null; }
      out[k] = t.v;
    }
    return out;
  }

  async function saveFeature() {
    const properties = tagsToProps();
    if (!properties) return;
    setSaving(true);
    try {
      const api = await loadApi();
      if (draft && activeLayer) {
        const row = await api.createMapFeature(mapId, { id: uuid(), layer_id: activeLayer.id, geometry: draft, properties });
        setData({ ...data!, features: [...data!.features, row] });
        toast("Saved.", "success");
      } else if (selected) {
        const row = await api.updateMapFeature(selected.id, { base_version: selected.version, properties });
        setData({ ...data!, features: data!.features.map((f) => (f.id === row.id ? row : f)) });
        toast("Updated.", "success");
      }
      cancelEdit();
    } catch (e) { fail(e, "Could not save."); }
    finally { setSaving(false); }
  }

  async function removeFeature(f: MapFeature) {
    if (!window.confirm("Delete this feature?")) return;
    try {
      await (await loadApi()).deleteMapFeature(f.id);
      setData({ ...data!, features: data!.features.filter((x) => x.id !== f.id) });
      cancelEdit();
      toast("Deleted.", "success");
    } catch (e) { fail(e, "Could not delete."); }
  }

  async function addLayer(e: FormEvent) {
    e.preventDefault();
    if (!newLayerName?.trim()) return;
    try {
      const l = await (await loadApi()).createMapLayer(mapId, { name: newLayerName.trim(), geometry_type: "any", fields: [] });
      setData({ ...data!, layers: [...data!.layers, l] });
      setActiveLayerId(l.id); setNewLayerName(null);
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
    } catch (err) { fail(err, "Could not add the imagery."); }
    finally { setBusyImg(false); }
  }

  async function removeImagery(id: string) {
    try {
      await (await loadApi()).deleteImagerySource(id);
      setData({ ...data!, sources: data!.sources.filter((s) => s.id !== id) });
    } catch (err) { fail(err, "Could not remove the imagery."); }
  }

  return (
    <div className="editor" style={{ flex: 1 }}>
      <aside className="side left" aria-label="Tools, layers and imagery">
        <div><h2>Map</h2><strong>{data.map.name}</strong> <Link to="/maps" style={{ marginLeft: 8, fontSize: 13 }}>All maps</Link></div>

        {canEdit && (
          <div className="stack">
            <h2>Draw</h2>
            <div className="toolbar">
              {TOOLS.map((t) => (
                <Button key={t.type} variant={drawType === t.type ? "primary" : "default"} disabled={!!draft || (!!drawType && drawType !== t.type) || !activeLayer}
                  onClick={() => { select(null); setDrawType(t.type); }}>{t.label}</Button>
              ))}
            </div>
            {activeLayer && layers.length > 1 && <span className="field-hint">Drawing into <strong>{activeLayer.name}</strong>.</span>}
          </div>
        )}

        <div className="stack">
          <h2>Imagery</h2>
          {data.sources.length === 0 && <span className="field-hint">Add imagery to digitize from.</span>}
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
        </div>

        <details className="stack">
          <summary><h2 style={{ display: "inline" }}>Layers ({layers.length})</h2></summary>
          <span className="field-hint">Optional. Use layers to group and hide features.</span>
          {layers.map((l) => (
            <div className="row" key={l.id} style={{ alignItems: "center" }}>
              <input type="checkbox" aria-label={`Show ${l.name}`} checked={!hiddenLayers.has(l.id)} onChange={(e) => setHiddenLayers((h) => toggle(h, l.id, e.target.checked))} />
              <label className="check" style={{ flex: 1 }}>
                <input type="radio" name="active-layer" checked={activeLayer?.id === l.id} onChange={() => setActiveLayerId(l.id)} />
                {l.name}<span className="mono" style={{ marginLeft: "auto" }}>{data.features.filter((f) => f.layer_id === l.id).length}</span>
              </label>
              {canEdit && layers.length > 1 && <Button small variant="danger" onClick={() => removeLayer(l)} aria-label={`Delete ${l.name}`}>×</Button>}
            </div>
          ))}
          {canEdit && newLayerName === null && <Button onClick={() => setNewLayerName("")}>Add layer</Button>}
          {newLayerName !== null && (
            <form className="row" onSubmit={addLayer}>
              <input aria-label="Layer name" autoFocus required placeholder="Layer name" value={newLayerName} onChange={(e) => setNewLayerName(e.target.value)} style={{ flex: 1, minWidth: 0 }} />
              <Button type="submit" variant="primary" small>Add</Button><Button small onClick={() => setNewLayerName(null)}>Cancel</Button>
            </form>
          )}
        </details>
      </aside>

      <MapView
        features={viewFeatures}
        selectedId={draft ? DRAFT_ID : selectedId}
        drawMode={drawType}
        onDraw={(g) => { setDraft(g); setDrawType(null); setTags([]); }}
        onCancelDraw={() => setDrawType(null)}
        onSelect={select}
        imagery={imagery}
        fitKey={mapId}
        label="Map"
      />

      <aside className="side right" aria-label="Feature details" aria-live="polite">
        {!editing && <div className="state"><strong>Nothing selected</strong>Pick Point, Line or Area and click the map, or select a feature to edit its tags.</div>}
        {editing && (
          <>
            <div><h2>{draft ? "New feature" : "Selected feature"}</h2>
              {selected && <div className="meta" style={{ fontSize: 13, color: "var(--muted)" }}>Version {selected.version} · {new Date(selected.updated_at).toLocaleDateString()}</div>}</div>
            <TagEditor tags={tags} onChange={setTags} suggestions={tagNames} />
            <div className="row" style={{ marginTop: "auto" }}>
              <Button className="grow" onClick={cancelEdit}>{draft ? "Discard" : "Close"}</Button>
              {canEdit && <Button className="grow" variant="primary" busy={saving} onClick={saveFeature}>Save</Button>}
            </div>
            {selected && canEdit && <Button variant="danger" small onClick={() => removeFeature(selected)}>Delete feature</Button>}
          </>
        )}
      </aside>
    </div>
  );
}
