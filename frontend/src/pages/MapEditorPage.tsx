import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import MapView, { type Bbox, type MapFeature, type MapImagery } from "../components/MapView";
import { Button, ErrorState, Loading, useToast } from "../components/ui";
import { ApiError, loadApi } from "../lib/api";
import { extOf, NEEDS_BOUNDS_EXTS, RASTER_EXTS } from "../lib/fileTypes";
import { uuid } from "../lib/forms";
import { MAP_IMPORT_EXTS, readMapFile } from "../lib/geoImport";
import { useAsync } from "../lib/hooks";
import { GEOMETRY_LABEL, type GeoFeature, type Geometry, type GeometryType, type ImageryAsset, type Props, type TileSource } from "../lib/types";

const DRAFT_ID = "__draft";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ESRI: Omit<TileSource, "id"> = {
  name: "Esri World Imagery", type: "xyz", maxzoom: 19, attribution: "Esri, Maxar, Earthstar Geographics",
  url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
};
const PRESETS: { label: string; geometry: GeometryType; tags: Record<string, string> }[] = [
  { label: "Building", geometry: "Polygon", tags: { building: "yes" } },
  { label: "Road", geometry: "LineString", tags: { highway: "road" } },
  { label: "Footpath", geometry: "LineString", tags: { highway: "path" } },
  { label: "Water", geometry: "Polygon", tags: { natural: "water" } },
  { label: "Farmland", geometry: "Polygon", tags: { landuse: "farmland" } },
  { label: "Tree", geometry: "Point", tags: { natural: "tree" } },
  { label: "Place", geometry: "Point", tags: { name: "" } },
];
const COMMON_KEYS = ["name", "building", "highway", "landuse", "natural", "amenity", "waterway", "surface", "source", "note"];

type Tag = { k: string; v: string };
const toTags = (p: Props): Tag[] => Object.entries(p).map(([k, v]) => ({ k, v: String(v ?? "") }));
/** Back to properties. Values the user did not touch keep their original type (numbers stay numbers). */
function fromTags(rows: Tag[], orig: Props): Props {
  const out: Props = {};
  for (const { k, v } of rows) {
    const key = k.trim();
    if (!key) continue;
    out[key] = key in orig && String(orig[key] ?? "") === v ? orig[key] : v;
  }
  return out;
}

export default function MapEditorPage() {
  const { mapId = "" } = useParams();
  const toast = useToast();
  const { data, error, loading, reload, setData } = useAsync(async (api) => {
    const [map, features, imagery] = await Promise.all([api.getMap(mapId), api.listMapFeatures(mapId), api.listMapImagery(mapId)]);
    return { map, features, assets: imagery.assets, layers: imagery.layers };
  }, [mapId]);

  // imagery panel
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [opacity, setOpacity] = useState<Record<string, number>>({});
  const [showBase, setShowBase] = useState(true);
  const [flyTo, setFlyTo] = useState<{ bounds: Bbox; key: number } | null>(null);
  const [addTab, setAddTab] = useState<"url" | "file">("url");
  const [srcName, setSrcName] = useState("");
  const [srcUrl, setSrcUrl] = useState("");
  const [srcMax, setSrcMax] = useState("");
  const [box, setBox] = useState({ w: "", s: "", e: "", n: "" });
  const [busy, setBusy] = useState<"" | "source" | "imagery" | "import">("");
  const imgRef = useRef<HTMLInputElement>(null);
  const dataRef = useRef<HTMLInputElement>(null);

  // drawing and editing
  const [drawing, setDrawing] = useState<GeometryType | null>(null);
  const [draft, setDraft] = useState<Geometry | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [geom, setGeom] = useState<Geometry | null>(null);            // geometry of the selected feature, possibly reshaped
  const [editShape, setEditShape] = useState(false);
  const [tags, setTags] = useState<Tag[]>([]);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState<string | null>(null);

  const selected = data?.features.find((f) => f.id === selectedId) ?? null;
  const editing = !!draft || !!selected;
  const shown: Geometry | null = draft ?? geom;
  const dirty = !!draft || (!!selected && (JSON.stringify(geom) !== JSON.stringify(selected.geometry) ||
    JSON.stringify(fromTags(tags, selected.properties)) !== JSON.stringify(selected.properties)));

  const mapFeatures: MapFeature[] = useMemo(() => {
    const list: MapFeature[] = (data?.features ?? []).map((f) => ({ id: f.id, geometry: f.id === selectedId && geom ? geom : f.geometry, properties: f.properties }));
    if (draft) list.push({ id: DRAFT_ID, geometry: draft, pending: true });
    return list;
  }, [data?.features, selectedId, geom, draft]);

  const sources = data?.map.sources ?? [];
  const imagery: MapImagery[] = useMemo(() => {
    const out: MapImagery[] = [];
    for (const s of sources) if (!hidden.has(s.id)) out.push({ id: s.id, url: s.url, maxzoom: s.maxzoom, attribution: s.attribution, opacity: opacity[s.id] ?? 1 });
    for (const l of data?.layers.imagery ?? []) if (!hidden.has(l.id)) out.push({ id: l.id, url: l.url, opacity: opacity[l.id] ?? 1 });
    return out;
  }, [sources, data?.layers, hidden, opacity]);

  // Signed tile URLs for uploaded imagery expire; refresh them before they do.
  useEffect(() => {
    if (!data?.layers.imagery.length) return;
    const t = setInterval(async () => {
      try { const r = await (await loadApi()).listMapImagery(mapId); setData((d) => (d ? { ...d, assets: r.assets, layers: r.layers } : d)); } catch { /* try again later */ }
    }, 45 * 60 * 1000);
    return () => clearInterval(t);
  }, [data?.layers.imagery.length, mapId, setData]);

  if (loading) return <Loading label="Loading map…" />;
  if (error != null || !data) return <div className="container"><ErrorState error={error} onRetry={reload} /></div>;

  // ---------------- selection and saving ----------------
  function clearSelection() { setDraft(null); setDrawing(null); setSelectedId(null); setGeom(null); setEditShape(false); setTags([]); }
  function select(id: string | null) {
    if (draft) return;
    if (id === selectedId) return;
    if (dirty && !window.confirm("Discard your unsaved changes?")) return;
    const f = data!.features.find((x) => x.id === id);
    setSelectedId(f ? f.id : null); setGeom(f ? f.geometry : null); setEditShape(false); setTags(f ? toTags(f.properties) : []);
  }
  function applyPreset(p: (typeof PRESETS)[number]) {
    setTags((t) => {
      const next = [...t];
      for (const [k, v] of Object.entries(p.tags)) { const i = next.findIndex((r) => r.k === k); if (i >= 0) next[i] = { k, v }; else next.push({ k, v }); }
      return next;
    });
  }
  async function save() {
    const rows = tags.filter((t) => t.k.trim() || t.v.trim());
    const keys = rows.map((t) => t.k.trim());
    if (rows.some((t) => !t.k.trim())) { toast("Every tag needs a name.", "error"); return; }
    if (new Set(keys).size !== keys.length) { toast("Two tags have the same name.", "error"); return; }
    setSaving(true);
    try {
      const api = await loadApi();
      if (draft) {
        const created = await api.createMapFeature(mapId, { id: uuid(), geometry: draft, properties: fromTags(rows, {}) });
        setData({ ...data!, features: [...data!.features, created], map: { ...data!.map, feature_count: data!.map.feature_count + 1 } });
        clearSelection();
        setSelectedId(created.id); setGeom(created.geometry); setTags(toTags(created.properties));
        toast("Feature saved.", "success");
      } else if (selected && geom) {
        const updated = await api.updateMapFeature(mapId, selected.id, { geometry: geom, properties: fromTags(rows, selected.properties), base_version: selected.version });
        setData({ ...data!, features: data!.features.map((f) => (f.id === updated.id ? updated : f)) });
        setGeom(updated.geometry); setTags(toTags(updated.properties)); setEditShape(false);
        toast("Changes saved.", "success");
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not save.", "error");
      if (e instanceof ApiError && e.status === 409) await reload();
    } finally { setSaving(false); }
  }
  async function remove(f: GeoFeature) {
    if (!window.confirm("Delete this feature?")) return;
    try {
      await (await loadApi()).deleteMapFeature(mapId, f.id);
      setData({ ...data!, features: data!.features.filter((x) => x.id !== f.id), map: { ...data!.map, feature_count: Math.max(0, data!.map.feature_count - 1) } });
      clearSelection();
      toast("Feature deleted.", "success");
    } catch (e) { toast(e instanceof Error ? e.message : "Could not delete.", "error"); }
  }

  // ---------------- imagery ----------------
  async function saveSources(next: TileSource[]) {
    const m = await (await loadApi()).updateMap(mapId, { sources: next });
    setData((d) => (d ? { ...d, map: m } : d));
  }
  async function addSource(src: Omit<TileSource, "id">) {
    setBusy("source");
    try {
      await saveSources([...sources, { ...src, id: uuid().replace(/-/g, "").slice(0, 12) }]);
      setSrcName(""); setSrcUrl(""); setSrcMax("");
      toast(`"${src.name}" added. Check the map.`, "success");
    } catch (e) { toast(e instanceof Error ? e.message : "Could not add the imagery.", "error"); }
    finally { setBusy(""); }
  }
  function addFromForm() {
    const url = srcUrl.trim();
    let host = "Imagery";
    try { host = new URL(url.replace(/\{[^}]*\}/g, "0")).hostname; } catch { toast("That is not a valid web address.", "error"); return; }
    if (!/^https?:\/\//i.test(url) || !url.includes("{z}") || !url.includes("{x}") || !(url.includes("{y}") || url.includes("{-y}"))) {
      toast("The URL must start with https:// and contain {z}, {x} and {y}.", "error"); return;
    }
    if (url.startsWith("http://") && window.location.protocol === "https:") { toast("This page is secure (https), so the browser blocks http:// tiles. Use an https:// address.", "error"); return; }
    const max = srcMax.trim() === "" ? undefined : Number(srcMax);
    if (max !== undefined && (!Number.isInteger(max) || max < 0 || max > 24)) { toast("Max zoom must be a whole number from 0 to 24.", "error"); return; }
    void addSource({ name: srcName.trim() || host, type: "xyz", url, ...(max !== undefined ? { maxzoom: max } : {}) });
  }
  async function removeSource(s: TileSource) {
    try { await saveSources(sources.filter((x) => x.id !== s.id)); } catch (e) { toast(e instanceof Error ? e.message : "Could not remove it.", "error"); }
  }
  function parseBounds(): [number, number, number, number] | undefined {
    const raw = [box.w, box.s, box.e, box.n];
    if (raw.every((v) => v.trim() === "")) return undefined;
    const [w, s, e, n] = raw.map(Number);
    if (raw.some((v) => v.trim() === "" || Number.isNaN(Number(v))) || !(w < e && s < n) || w < -180 || e > 180 || s < -90 || n > 90) {
      throw new Error("Bounds must be four numbers in degrees: west < east and south < north.");
    }
    return [w, s, e, n];
  }
  async function refreshImagery() {
    const r = await (await loadApi()).listMapImagery(mapId);
    setData((d) => (d ? { ...d, assets: r.assets, layers: r.layers } : d));
    return r;
  }
  async function watchImagery(id: string) {
    const api = await loadApi();
    for (let i = 0; i < 120; i++) {
      await sleep(3000);
      const a = await api.getImagery(id);
      if (a.status === "ready" || a.status === "failed") {
        const r = await refreshImagery();
        toast(a.status === "ready" ? `"${a.name}" is ready on the map.` : a.error ?? "The image could not be processed.", a.status === "ready" ? "success" : "error");
        const l = r.layers.imagery.find((x) => x.id === id);
        if (l?.bounds) setFlyTo({ bounds: l.bounds, key: Date.now() });
        return;
      }
    }
  }
  async function uploadImagery(file: File | undefined) {
    if (!file) return;
    if (!RASTER_EXTS.includes(extOf(file.name))) {
      toast(`${extOf(file.name) || "This"} files are not imagery. Use TIFF, JPEG, PNG, JP2 and similar. For points, lines and areas use "Import data".`, "error");
      if (imgRef.current) imgRef.current.value = "";
      return;
    }
    setBusy("imagery");
    try {
      const asset = await (await loadApi()).uploadMapImagery(mapId, file, parseBounds());
      setData((d) => (d ? { ...d, assets: [...d.assets, asset] } : d));
      toast(asset.status === "ready" ? "Imagery added." : "Uploaded. Processing it now; it will appear on the map when ready.", "success");
      if (asset.status !== "ready") void watchImagery(asset.id).catch(() => undefined);
    } catch (e) { toast(e instanceof Error ? e.message : "Upload failed.", "error"); }
    finally { setBusy(""); if (imgRef.current) imgRef.current.value = ""; }
  }
  async function removeAsset(a: ImageryAsset) {
    if (!window.confirm(`Remove "${a.name}" from this map?`)) return;
    try { await (await loadApi()).deleteImagery(a.id); await refreshImagery(); } catch (e) { toast(e instanceof Error ? e.message : "Could not remove it.", "error"); }
  }
  const toggle = (id: string, on: boolean) => setHidden((h) => { const n = new Set(h); if (on) n.delete(id); else n.add(id); return n; });

  // ---------------- data in and out ----------------
  async function importData(file: File | undefined) {
    if (!file) return;
    setBusy("import");
    try {
      const parsed = await readMapFile(file);
      if (!parsed.length) throw new Error("No points, lines or areas were found in this file.");
      const r = await (await loadApi()).importMapFeatures(mapId, parsed);
      toast(`Imported ${r.imported} feature${r.imported === 1 ? "" : "s"}${r.rejected ? `, ${r.rejected} skipped (${r.errors[0]?.message ?? "invalid"})` : ""}.`, r.imported ? "success" : "error");
      clearSelection();
      await reload();
    } catch (e) { toast(e instanceof Error ? e.message : "Import failed.", "error"); }
    finally { setBusy(""); if (dataRef.current) dataRef.current.value = ""; }
  }
  async function exportData() {
    try {
      const blob = await (await loadApi()).exportMap(mapId);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${data!.map.name.replace(/[^A-Za-z0-9._-]+/g, "-") || "map"}.geojson`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch (e) { toast(e instanceof Error ? e.message : "Export failed.", "error"); }
  }
  async function rename() {
    const n = (name ?? "").trim();
    setName(null);
    if (!n || n === data!.map.name) return;
    try { const m = await (await loadApi()).updateMap(mapId, { name: n }); setData((d) => (d ? { ...d, map: m } : d)); }
    catch (e) { toast(e instanceof Error ? e.message : "Could not rename the map.", "error"); }
  }

  const geomType = shown?.type;
  const presets = PRESETS.filter((p) => p.geometry === geomType);
  const tileAssets = data.assets;

  return (
    <div className="editor" style={{ flex: 1 }}>
      <aside className="side left" aria-label="Map tools and imagery">
        <div className="stack">
          <Link to="/maps" className="field-hint">← All maps</Link>
          <input aria-label="Map name" value={name ?? data.map.name} onChange={(e) => setName(e.target.value)} onBlur={rename}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} style={{ font: "600 16px var(--font-ui)" }} />
          <span className="field-hint">{data.features.length} feature{data.features.length === 1 ? "" : "s"}</span>
        </div>

        <div className="stack">
          <h2>Draw</h2>
          <div className="toolbar">
            {(["Point", "LineString", "Polygon"] as GeometryType[]).map((t) => (
              <Button key={t} variant={drawing === t ? "primary" : "default"} disabled={!!draft || (!!drawing && drawing !== t)}
                onClick={() => { if (selected && dirty && !window.confirm("Discard your unsaved changes?")) return; clearSelection(); setDrawing(t); }}>
                {GEOMETRY_LABEL[t][0].toUpperCase() + GEOMETRY_LABEL[t].slice(1)}
              </Button>
            ))}
          </div>
          <span className="field-hint">Pick a tool, then click the map. Select a feature to change its tags or reshape it.</span>
        </div>

        <div className="stack">
          <h2>Imagery</h2>
          <label className="check"><input type="checkbox" checked={showBase} onChange={(e) => setShowBase(e.target.checked)} />OpenStreetMap</label>
          {sources.map((s) => (
            <div className="stack" style={{ gap: 4 }} key={s.id}>
              <div className="row">
                <label className="check grow"><input type="checkbox" checked={!hidden.has(s.id)} onChange={(e) => toggle(s.id, e.target.checked)} />{s.name}</label>
                <Button small variant="ghost" aria-label={`Remove ${s.name}`} onClick={() => removeSource(s)}>×</Button>
              </div>
              {!hidden.has(s.id) && <input type="range" min={0.1} max={1} step={0.05} aria-label={`${s.name} opacity`} value={opacity[s.id] ?? 1} onChange={(e) => setOpacity((o) => ({ ...o, [s.id]: Number(e.target.value) }))} />}
            </div>
          ))}
          {tileAssets.map((a) => {
            const live = data.layers.imagery.find((l) => l.id === a.id);
            return (
              <div className="stack" style={{ gap: 4 }} key={a.id}>
                <div className="row">
                  <label className="check grow"><input type="checkbox" checked={!hidden.has(a.id)} disabled={a.status !== "ready"} onChange={(e) => toggle(a.id, e.target.checked)} />{a.name}</label>
                  <span className={`badge ${a.status === "failed" ? "badge-bad" : "badge-ok"}`}>{a.status}</span>
                  {live?.bounds && <Button small variant="ghost" aria-label={`Zoom to ${a.name}`} onClick={() => setFlyTo({ bounds: live.bounds!, key: Date.now() })}>⌖</Button>}
                  <Button small variant="ghost" aria-label={`Remove ${a.name}`} onClick={() => removeAsset(a)}>×</Button>
                </div>
                {a.status === "failed" && a.error && <span className="field-hint">{a.error}</span>}
                {a.status === "ready" && !hidden.has(a.id) && <input type="range" min={0.1} max={1} step={0.05} aria-label={`${a.name} opacity`} value={opacity[a.id] ?? 1} onChange={(e) => setOpacity((o) => ({ ...o, [a.id]: Number(e.target.value) }))} />}
              </div>
            );
          })}
          <details>
            <summary><strong>Add imagery</strong></summary>
            <div className="stack" style={{ marginTop: 10 }}>
              <div className="toolbar" role="tablist" aria-label="Imagery source">
                <Button small role="tab" aria-selected={addTab === "url"} variant={addTab === "url" ? "primary" : "default"} onClick={() => setAddTab("url")}>Web URL</Button>
                <Button small role="tab" aria-selected={addTab === "file"} variant={addTab === "file" ? "primary" : "default"} onClick={() => setAddTab("file")}>Upload file</Button>
              </div>
              {addTab === "url" ? (
                <>
                  <div className="field"><label htmlFor="su">Tile URL</label>
                    <input id="su" placeholder="https://…/{z}/{x}/{y}.png" value={srcUrl} onChange={(e) => setSrcUrl(e.target.value)} spellCheck={false} />
                    <span className="field-hint">Use {"{z}"}, {"{x}"} and {"{y}"} for zoom, column and row. {"{-y}"} (TMS) also works.</span></div>
                  <div className="field"><label htmlFor="sn">Name (optional)</label><input id="sn" value={srcName} onChange={(e) => setSrcName(e.target.value)} /></div>
                  <div className="field"><label htmlFor="sm">Max zoom (optional)</label><input id="sm" inputMode="numeric" placeholder="e.g. 19" value={srcMax} onChange={(e) => setSrcMax(e.target.value)} /></div>
                  <Button variant="primary" busy={busy === "source"} disabled={!srcUrl.trim()} onClick={addFromForm}>Add to map</Button>
                  <Button small busy={busy === "source"} onClick={() => addSource(ESRI)}>Quick add: Esri World Imagery</Button>
                  <span className="field-hint">Only use imagery you are allowed to trace from; the provider's terms apply. The tile server must allow other websites to load its tiles.</span>
                </>
              ) : (
                <>
                  <label className="upload" style={busy === "imagery" ? { opacity: 0.6 } : undefined}>
                    {busy === "imagery" ? "Uploading…" : "Choose an image file"}
                    <input ref={imgRef} className="sr-only" type="file" accept={RASTER_EXTS.join(",")} disabled={busy === "imagery"} onChange={(e) => uploadImagery(e.target.files?.[0])} />
                  </label>
                  <span className="field-hint">GeoTIFF is best. JPEG, PNG, JP2 and more also work. Large files take a few minutes to process.</span>
                  <details>
                    <summary className="field-hint">Picture has no coordinates? ({NEEDS_BOUNDS_EXTS.slice(0, 3).join(" ")}…)</summary>
                    <span className="field-hint">Where does it go? Degrees (WGS84), set before choosing the file. GeoTIFFs ignore this.</span>
                    {([["w", "West"], ["s", "South"], ["e", "East"], ["n", "North"]] as const).map(([k, label]) => (
                      <div className="field" key={k}><label htmlFor={`mb-${k}`}>{label}</label><input id={`mb-${k}`} inputMode="decimal" value={box[k]} onChange={(ev) => setBox((b) => ({ ...b, [k]: ev.target.value }))} /></div>
                    ))}
                  </details>
                </>
              )}
            </div>
          </details>
        </div>

        <div className="stack">
          <h2>Data</h2>
          <label className="upload" style={busy === "import" ? { opacity: 0.6 } : undefined}>
            {busy === "import" ? "Importing…" : "Import data"}
            <input ref={dataRef} className="sr-only" type="file" accept={MAP_IMPORT_EXTS.join(",")} disabled={busy === "import"} onChange={(e) => importData(e.target.files?.[0])} />
          </label>
          <span className="field-hint">GeoJSON, KML or GPX. Points, lines and areas are added to this map.</span>
          <Button onClick={exportData} disabled={!data.features.length}>Export GeoJSON</Button>
        </div>
      </aside>

      <MapView
        features={mapFeatures}
        selectedId={draft ? DRAFT_ID : selectedId}
        drawMode={drawing}
        onDraw={(g) => { setDraft(g); setDrawing(null); setTags([]); setGeom(null); }}
        onCancelDraw={() => setDrawing(null)}
        onSelect={select}
        imagery={imagery}
        showBase={showBase}
        editGeometry={editShape && !draft ? geom : null}
        onGeometryChange={(g) => setGeom(g)}
        flyTo={flyTo}
        fitKey={mapId}
        label="Map"
      />

      <aside className="side right" aria-label="Feature details" aria-live="polite">
        {!editing && <div className="state"><strong>Nothing selected</strong>Choose Point, Line or Area to draw, or click a feature on the map.</div>}
        {editing && shown && (
          <>
            <div>
              <h2>{draft ? "New feature" : "Selected feature"}</h2>
              <strong>{GEOMETRY_LABEL[shown.type]}</strong>
              {selected && <div className="meta" style={{ fontSize: 13, color: "var(--muted)" }}>Version {selected.version}{dirty ? " · unsaved changes" : ""}</div>}
            </div>
            {presets.length > 0 && (
              <div className="stack" style={{ gap: 6 }}>
                <span className="field-hint">Quick tags</span>
                <div className="chips">{presets.map((p) => <Button key={p.label} small onClick={() => applyPreset(p)}>{p.label}</Button>)}</div>
              </div>
            )}
            <div className="stack" style={{ gap: 8 }}>
              <h2>Tags</h2>
              <datalist id="tag-keys">{COMMON_KEYS.map((k) => <option key={k} value={k} />)}</datalist>
              {tags.length === 0 && <span className="field-hint">No tags yet. Add a name, type or any note.</span>}
              {tags.map((t, i) => (
                <div className="row" key={i}>
                  <input aria-label="Tag name" list="tag-keys" placeholder="name" value={t.k} style={{ flex: "0 0 42%", minWidth: 0 }} onChange={(e) => setTags((r) => r.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)))} />
                  <input aria-label={`Value for ${t.k || "tag"}`} placeholder="value" value={t.v} className="grow" style={{ minWidth: 0 }} onChange={(e) => setTags((r) => r.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))} />
                  <Button small variant="ghost" aria-label="Remove tag" onClick={() => setTags((r) => r.filter((_, j) => j !== i))}>×</Button>
                </div>
              ))}
              <Button small onClick={() => setTags((r) => [...r, { k: "", v: "" }])}>Add tag</Button>
            </div>
            {selected && (
              <div className="stack" style={{ gap: 6 }}>
                <h2>Shape</h2>
                <Button variant={editShape ? "primary" : "default"} onClick={() => setEditShape((v) => !v)}>{editShape ? "Done reshaping" : "Reshape"}</Button>
                {editShape && <span className="field-hint">Drag a point to move it. Drag a small midpoint to add a point. Right-click or double-click a point to remove it. Save when you are done.</span>}
              </div>
            )}
            <div className="row" style={{ marginTop: "auto" }}>
              <Button className="grow" onClick={() => { if (dirty && !window.confirm("Discard your unsaved changes?")) return; clearSelection(); }}>{draft ? "Cancel" : "Close"}</Button>
              <Button className="grow" variant="primary" busy={saving} disabled={!dirty} onClick={save}>Save</Button>
            </div>
            {selected && <Button variant="danger" small onClick={() => remove(selected)}>Delete feature</Button>}
          </>
        )}
      </aside>
    </div>
  );
}
