import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import MapView, { type Bbox, type MapFeature, type MapImagery } from "../components/MapView";
import { Button, ErrorState, Loading, useToast } from "../components/ui";
import { ApiError, loadApi } from "../lib/api";
import { extOf, NEEDS_BOUNDS_EXTS, RASTER_EXTS } from "../lib/fileTypes";
import { useAuth } from "../lib/auth";
import { bboxOf, uuid } from "../lib/forms";
import { cutByLine, mergeGeometries, splitLineAtPoint, translate } from "../lib/geoops";
import { MAP_IMPORT_EXTS, readMapFile } from "../lib/geoImport";
import { useAsync } from "../lib/hooks";
import {
  addNew, commit, effective, mergeInto, newHistory, redo, removeFeature, replaceWithPieces, reset, setGeometry, setProperties, summarize, undo,
  type Edit, type Edits, type History, type WorkFeature,
} from "../lib/staging";
import { GEOMETRY_LABEL, type GeoFeature, type Geometry, type GeometryType, type ImageryAsset, type Position, type Props, type TileSource } from "../lib/types";

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

/** What the person is doing on the map. Draw tools and Split/Cut stay on until they pick another tool or press Esc. */
type Tool = "select" | "point" | "line" | "area" | "reshape" | "move" | "split" | "cut";
const DRAW_GEOMETRY: Partial<Record<Tool, GeometryType>> = { point: "Point", line: "LineString", area: "Polygon", cut: "LineString" };
const TOOL_LABEL: Record<Tool, string> = { select: "Select", point: "Point", line: "Line", area: "Area", reshape: "Reshape", move: "Move", split: "Split", cut: "Cut" };
const TOOL_KEY: Record<Tool, string> = { select: "V", point: "P", line: "L", area: "A", reshape: "R", move: "M", split: "S", cut: "C" };
const TOOL_HELP: Record<Tool, string> = {
  select: "Click a feature to select it. Hold Shift (or turn on Multi-select) to select several.",
  point: "Click the map to add points. The tool stays on; press Esc when you are done.",
  line: "Click to add points, then double-click or press Enter to finish the line. The tool stays on for the next one.",
  area: "Click to add corners, then double-click or press Enter to finish the area. The tool stays on for the next one.",
  reshape: "Drag a point to move it. Drag a small midpoint to add a point. Right-click or double-click a point to remove it.",
  move: "Drag a selected feature to move it. Several selected features move together.",
  split: "Click a line where you want to cut it in two.",
  cut: "Draw a line across the features you want to cut, then double-click or press Enter. Cuts the selected features, or everything the line crosses if nothing is selected.",
};
const EMPTY: GeoFeature[] = [];
const DUPLICATE_OFFSET = 0.00015;                 // degrees, roughly 16 m, so a copy does not sit exactly on the original
const draftKey = (mapId: string) => `geohub:map-draft:${mapId}`;

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
const hasDuplicateKeys = (rows: Tag[]) => { const keys = rows.map((t) => t.k.trim()).filter(Boolean); return new Set(keys).size !== keys.length; };
const typeText = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Editable list of tag rows. Enter in a value starts a new row, so tagging many features stays on the keyboard. */
function TagRows({ rows, onChange, disabled }: { rows: Tag[]; onChange: (rows: Tag[]) => void; disabled?: boolean }) {
  const [focusRow, setFocusRow] = useState(-1);
  const add = () => { setFocusRow(rows.length); onChange([...rows, { k: "", v: "" }]); };
  return (
    <div className="stack" style={{ gap: 8 }}>
      {rows.map((t, i) => (
        <div className="row" key={i}>
          <input aria-label="Tag name" list="tag-keys" placeholder="name" value={t.k} autoFocus={i === focusRow} disabled={disabled} style={{ flex: "0 0 42%", minWidth: 0 }}
            onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)))} />
          <input aria-label={`Value for ${t.k || "tag"}`} placeholder="value" value={t.v} className="grow" style={{ minWidth: 0 }} disabled={disabled}
            onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))}
            onKeyDown={(e) => { if (e.key === "Enter" && i === rows.length - 1) { e.preventDefault(); add(); } }} />
          <Button small variant="ghost" aria-label="Remove tag" disabled={disabled} onClick={() => onChange(rows.filter((_, j) => j !== i))}>×</Button>
        </div>
      ))}
      <Button small onClick={add} disabled={disabled}>Add tag</Button>
      {hasDuplicateKeys(rows) && <span className="tag-error" role="alert">Two tags have the same name. Change one of them.</span>}
    </div>
  );
}

export default function MapEditorPage() {
  const { mapId = "" } = useParams();
  const toast = useToast();
  const { user } = useAuth();
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

  // ---------------- digitizing ----------------
  // Everything the person does is staged in `hist` (with undo/redo). Nothing reaches the server until "Save all".
  const [tool, setTool] = useState<Tool>("select");
  const [hist, setHist] = useState<History>(newHistory);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);              // rows shown for the one selected feature
  const [tagsRev, setTagsRev] = useState(0);                // bump to rebuild those rows from the feature (undo, presets, ...)
  const [bulkTags, setBulkTags] = useState<Tag[]>([]);      // rows applied to every selected feature at once
  const [newTags, setNewTags] = useState<Tag[]>([]);        // tags given to each new feature as it is drawn
  const [snap, setSnap] = useState(true);
  const [multi, setMulti] = useState(false);
  const [saving, setSaving] = useState(false);
  const [working, setWorking] = useState(false);            // a merge or cut is running
  const [name, setName] = useState<string | null>(null);
  const restoredFor = useRef<string | null>(null);

  const server = data?.features ?? EMPTY;
  const serverRef = useRef(server);
  serverRef.current = server;
  const histRef = useRef(hist);
  histRef.current = hist;
  const edits = hist.present;
  const work = useMemo(() => effective(server, edits), [server, edits]);
  const byId = useMemo(() => new Map(work.map((f) => [f.id, f])), [work]);
  const sel = useMemo(() => selectedIds.filter((id) => byId.has(id)), [selectedIds, byId]);
  const primary = sel.length === 1 ? byId.get(sel[0]) ?? null : null;
  const primaryId = primary?.id ?? null;
  const counts = useMemo(() => summarize(edits), [edits]);
  const dirty = counts.total > 0;
  const drawGeom = DRAW_GEOMETRY[tool] ?? null;

  // On a shared map, contributors change only their own features until a reviewer approves them. Reviewers and the owner change anything.
  const role = data?.map.role ?? "owner";
  const closed = role === "contributor" && !!data?.map.is_campaign && data.map.campaign_status !== "open";
  const canEdit = (f: WorkFeature) => role !== "contributor" || f.state === "new" || (f.meta?.created_by === user?.id && f.meta?.status !== "approved");
  /** The ids from `ids` the person may change. Says so when some are left out. */
  function editable(ids: string[], quiet = false): string[] {
    const ok = ids.filter((id) => { const f = byId.get(id); return !!f && canEdit(f); });
    if (!quiet && ok.length < ids.length) toast(ok.length ? `${ids.length - ok.length} of the selected features belong to someone else or are already approved, so they were left alone.` : "These features belong to someone else or are already approved, so you cannot change them.", "info");
    return ok;
  }

  /** Record a change (one undo step). `key` merges a burst of similar changes, such as typing in a tag, into one step. */
  function stage(next: Edits, key: string | null = null) {
    const h = commit(histRef.current, next, key);
    histRef.current = h;
    setHist(h);
  }
  const now = () => histRef.current.present;

  const mapFeatures: MapFeature[] = useMemo(() => work.map((f) => ({
    id: f.id, geometry: f.geometry, properties: f.properties,
    state: f.state !== "clean" ? f.state : f.meta?.status === "submitted" ? "review" : f.meta?.status === "rejected" ? "rejected" : "clean",
  })), [work]);

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

  // Start clean when moving to another map.
  useEffect(() => { setHist(newHistory()); setSelectedIds([]); setTool("select"); }, [mapId]);

  // Keep the tag rows in step with the one selected feature.
  useEffect(() => { setTags(primary ? toTags(primary.properties) : []); setBulkTags([]); },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [primaryId, tagsRev, sel.length > 1]);

  // Unsaved work survives a refresh, a crash or leaving the page: it is kept on this device and offered back.
  useEffect(() => {
    if (!data || data.map.id !== mapId || restoredFor.current === mapId) return;
    restoredFor.current = mapId;
    try {
      const raw = localStorage.getItem(draftKey(mapId));
      if (!raw) return;
      const saved = JSON.parse(raw) as Edits;
      const kept: Edits = {};
      for (const [id, e] of Object.entries(saved)) {
        if (e.kind === "new") kept[id] = e;
        else { const f = data.features.find((x) => x.id === id); if (f && f.version === e.base.version) kept[id] = { ...e, base: f } as Edit; }
      }
      const n = summarize(kept).total;
      if (n) { histRef.current = reset(kept); setHist(histRef.current); toast(`Restored ${typeText(n, "unsaved change", "unsaved changes")} from your last visit.`, "info"); }
      else localStorage.removeItem(draftKey(mapId));
    } catch { /* storage unavailable or damaged: start clean */ }
  }, [data, mapId, toast]);
  useEffect(() => {
    if (restoredFor.current !== mapId) return;
    try { if (summarize(edits).total) localStorage.setItem(draftKey(mapId), JSON.stringify(edits)); else localStorage.removeItem(draftKey(mapId)); } catch { /* ignore */ }
  }, [edits, mapId]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // Keyboard shortcuts (not while typing in a field). MapView handles Enter, Backspace and Esc while a shape is being drawn.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod && k === "z") { e.preventDefault(); if (e.shiftKey) redoAct(); else undoAct(); }
      else if (mod && k === "y") { e.preventDefault(); redoAct(); }
      else if (mod && k === "s") { e.preventDefault(); void saveAll(); }
      else if (mod || e.altKey) return;
      else if (e.key === "Delete" || (e.key === "Backspace" && !drawGeom)) { if (sel.length) { e.preventDefault(); removeSelected(); } }      // Backspace removes the last point while drawing instead
      else if (e.key === "Escape") { if (tool !== "select") setTool("select"); else setSelectedIds([]); }
      else { const hit = (Object.keys(TOOL_KEY) as Tool[]).find((x) => TOOL_KEY[x].toLowerCase() === k); if (hit) { e.preventDefault(); chooseTool(hit); } }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (loading) return <Loading label="Loading map…" />;
  if (error != null || !data) return <div className="container"><ErrorState error={error} onRetry={reload} /></div>;

  // ---------------- tools and selection ----------------
  function chooseTool(t: Tool) {
    if (closed && t !== "select") { toast(data?.map.campaign_status === "upcoming" ? "This campaign has not started yet." : "This campaign has ended, so contributors can no longer draw.", "info"); return; }
    if (t === "reshape" && sel.length !== 1) toast("Select one feature, then drag its points.", "info");
    if (t === "move" && !sel.length) toast("Select a feature, then drag it. You can also drag any feature directly.", "info");
    setTool(t);
  }
  function onSelect(id: string | null, additive?: boolean) {
    const add = !!additive || multi;
    if (!id) { if (!add) setSelectedIds([]); return; }
    setSelectedIds((s) => (add ? (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]) : [id]));
  }
  function undoAct() { const h = undo(histRef.current); histRef.current = h; setHist(h); setTagsRev((r) => r + 1); }
  function redoAct() { const h = redo(histRef.current); histRef.current = h; setHist(h); setTagsRev((r) => r + 1); }

  // ---------------- editing (all staged, nothing is saved yet) ----------------
  function onDraw(g: Geometry) {
    if (tool === "cut") { void cutWith(g); return; }
    const id = uuid();
    stage(addNew(now(), id, g, fromTags(newTags, {})));
    setSelectedIds([id]);                           // the new feature is selected so its tags can be filled in, and the tool stays on
  }
  function onGeometryChange(g: Geometry) { if (primaryId && editable([primaryId]).length) stage(setGeometry(now(), serverRef.current, primaryId, g)); }
  function onMove(ids: string[], dx: number, dy: number) {
    let next = now();
    for (const id of editable(ids)) { const f = byId.get(id); if (f) next = setGeometry(next, serverRef.current, id, translate(f.geometry, dx, dy)); }
    stage(next);
  }
  function updateTags(rows: Tag[]) {
    setTags(rows);
    if (!primary || !canEdit(primary) || hasDuplicateKeys(rows)) return;        // wait until the clash is fixed
    stage(setProperties(now(), serverRef.current, primary.id, fromTags(rows, primary.properties)), `tags:${primary.id}`);
  }
  function applyPreset(p: (typeof PRESETS)[number]) {
    let next = now();
    for (const id of editable(sel)) { const f = byId.get(id); if (f) next = setProperties(next, serverRef.current, id, { ...f.properties, ...p.tags }); }
    stage(next);
    setTagsRev((r) => r + 1);
  }
  function applyBulk() {
    if (hasDuplicateKeys(bulkTags)) { toast("Two tags have the same name.", "error"); return; }
    const add = fromTags(bulkTags.filter((t) => t.k.trim()), {});
    if (!Object.keys(add).length) { toast("Add at least one tag first.", "error"); return; }
    let next = now();
    for (const id of editable(sel)) { const f = byId.get(id); if (f) next = setProperties(next, serverRef.current, id, { ...f.properties, ...add }); }
    stage(next);
    toast(`Tags added to ${typeText(sel.length, "feature", "features")}.`, "success");
  }
  function removeSelected() {
    const ids = editable(sel);
    if (!ids.length) return;
    let next = now();
    for (const id of ids) next = removeFeature(next, serverRef.current, id);
    stage(next);
    setSelectedIds(sel.filter((id) => !ids.includes(id)));
  }
  function duplicateSelected() {
    let next = now();
    const ids: string[] = [];
    for (const id of sel) { const f = byId.get(id); if (!f) continue; const nid = uuid(); ids.push(nid); next = addNew(next, nid, translate(f.geometry, DUPLICATE_OFFSET, -DUPLICATE_OFFSET), { ...f.properties }); }
    stage(next);
    setSelectedIds(ids);
  }
  function splitAt(id: string, pos: Position) {
    const f = byId.get(id);
    if (!f || !editable([id]).length) return;
    if (f.geometry.type !== "LineString") { toast("Split works on lines. Use Cut to divide an area.", "error"); return; }
    const pieces = splitLineAtPoint(f.geometry, pos);
    if (!pieces) { toast("Click along the line, not at its very end.", "error"); return; }
    const r = replaceWithPieces(now(), serverRef.current, id, pieces, uuid);
    stage(r.edits);
    setSelectedIds(r.ids);
  }
  async function cutWith(g: Geometry) {
    if (g.type !== "LineString") return;
    setWorking(true);
    try {
      const cb = bboxOf([g])!;
      const candidates = (sel.length ? sel.map((id) => byId.get(id)!).filter(Boolean) : work).filter((f) => {
        if (f.geometry.type === "Point" || !canEdit(f)) return false;
        const b = bboxOf([f.geometry])!;
        return !(b[0] > cb[2] || b[2] < cb[0] || b[1] > cb[3] || b[3] < cb[1]);
      });
      let next = now();
      let cut = 0;
      const ids: string[] = [];
      for (const f of candidates) {
        const pieces = await cutByLine(f.geometry, g);
        if (!pieces) { if (sel.includes(f.id)) ids.push(f.id); continue; }
        const r = replaceWithPieces(next, serverRef.current, f.id, pieces, uuid);
        next = r.edits; ids.push(...r.ids); cut++;
      }
      if (!cut) { toast(sel.length ? "The line did not cut the selected features. Draw it all the way across, from outside to outside." : "The line did not cross any feature from edge to edge.", "error"); return; }
      stage(next);
      setSelectedIds(ids);
      toast(`Cut ${typeText(cut, "feature", "features")}.`, "success");
    } catch (e) { toast(e instanceof Error ? e.message : "Could not cut.", "error"); }
    finally { setWorking(false); }
  }
  async function mergeSelected() {
    const feats = sel.map((id) => byId.get(id)!).filter(Boolean);
    if (editable(sel).length !== sel.length) return;
    setWorking(true);
    try {
      const r = await mergeGeometries(feats.map((f) => f.geometry));
      if ("error" in r) { toast(r.error, "error"); return; }
      stage(mergeInto(now(), serverRef.current, feats.map((f) => f.id), r.geometry));
      setSelectedIds([feats[0].id]);
      toast(`Merged ${feats.length} features into one.`, "success");
    } catch (e) { toast(e instanceof Error ? e.message : "Could not merge.", "error"); }
    finally { setWorking(false); }
  }
  function discardAll() {
    if (!window.confirm(`Throw away ${typeText(counts.total, "unsaved change", "unsaved changes")}?`)) return;
    stage({});
    setSelectedIds([]);
  }

  // ---------------- saving: one click sends everything ----------------
  async function saveAll() {
    if (saving || !dirty) return;
    if (closed) { toast("This campaign is not open, so contributors cannot save changes right now.", "error"); return; }
    if (hasDuplicateKeys(tags)) { toast("Two tags on the selected feature have the same name. Fix that first.", "error"); return; }
    setSaving(true);
    try {
      const api = await loadApi();
      type Job = { id: string; edit: Edit; run: () => Promise<GeoFeature | null> };
      const jobs: Job[] = Object.entries(edits).map(([id, edit]) => ({
        id, edit,
        run: async () => {
          if (edit.kind === "new") return api.createMapFeature(mapId, { id, geometry: edit.geometry, properties: edit.properties });
          if (edit.kind === "mod") return api.updateMapFeature(mapId, id, { geometry: edit.geometry, properties: edit.properties, base_version: edit.base.version });
          await api.deleteMapFeature(mapId, id);
          return null;
        },
      }));
      const results: { job: Job; ok: boolean; value?: GeoFeature | null; error?: unknown }[] = [];
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(5, jobs.length) }, async () => {
        while (next < jobs.length) {
          const job = jobs[next++];
          try { results.push({ job, ok: true, value: await job.run() }); } catch (error) { results.push({ job, ok: false, error }); }
        }
      }));

      // Fold what succeeded into the saved list; whatever failed stays staged so nothing is lost.
      let saved = serverRef.current;
      const remaining: Edits = {};
      let made = 0, removed = 0;
      for (const r of results) {
        if (!r.ok) { remaining[r.job.id] = r.job.edit; continue; }
        const e = r.job.edit;
        if (e.kind === "new" && r.value) { saved = [...saved, r.value]; made++; }
        else if (e.kind === "mod" && r.value) saved = saved.map((f) => (f.id === r.job.id ? r.value! : f));
        else if (e.kind === "del") { saved = saved.filter((f) => f.id !== r.job.id); removed++; }
      }
      const failed = results.filter((r) => !r.ok);
      setData((d) => (d ? { ...d, features: saved, map: { ...d.map, feature_count: Math.max(0, d.map.feature_count + made - removed) } } : d));
      serverRef.current = saved;
      histRef.current = reset(remaining);
      setHist(histRef.current);
      setTagsRev((r) => r + 1);
      const okCount = results.length - failed.length;
      if (!failed.length) toast(`Saved ${typeText(okCount, "change", "changes")}.`, "success");
      else {
        const first = failed[0].error;
        toast(`Saved ${okCount}. ${failed.length} could not be saved and ${failed.length === 1 ? "is" : "are"} still waiting: ${first instanceof Error ? first.message : "unknown error"}`, "error");
        if (failed.some((f) => f.error instanceof ApiError && f.error.status === 409)) setTagsRev((r) => r + 1);
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not save.", "error");
    } finally { setSaving(false); }
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
      setSelectedIds([]);
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

  const presetGeoms = new Set<GeometryType>(sel.map((id) => byId.get(id)!.geometry.type));
  const presets = PRESETS.filter((p) => presetGeoms.has(p.geometry));
  const drawPresets = PRESETS.filter((p) => p.geometry === drawGeom);
  const tileAssets = data.assets;
  const summaryBits = [counts.created && `${counts.created} new`, counts.modified && `${counts.modified} edited`, counts.deleted && `${counts.deleted} deleted`].filter(Boolean).join(" · ");
  const toolBtn = (t: Tool, extra?: { disabled?: boolean }) => (
    <Button key={t} small variant={tool === t ? "primary" : "default"} aria-pressed={tool === t} title={`${TOOL_LABEL[t]} (${TOOL_KEY[t]})`} disabled={extra?.disabled} onClick={() => chooseTool(tool === t && t !== "select" ? "select" : t)}>{TOOL_LABEL[t]}</Button>
  );
  const saveLabel = dirty ? `Save all (${counts.total})` : "Save all";

  return (
    <div className="editor" style={{ flex: 1 }}>
      <aside className="side left" aria-label="Map tools and imagery">
        <div className="stack">
          <Link to="/maps" className="field-hint" onClick={(e) => { if (dirty && !window.confirm("You have unsaved changes. They are kept on this device, but are not saved to the map yet. Leave anyway?")) e.preventDefault(); }}>← All maps</Link>
          <input aria-label="Map name" value={name ?? data.map.name} onChange={(e) => setName(e.target.value)} onBlur={rename}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} style={{ font: "600 16px var(--font-ui)" }} />
          <span className="field-hint">{data.features.length} saved feature{data.features.length === 1 ? "" : "s"}{role !== "owner" ? ` · you are a ${role}` : ""}</span>
          <Link className="btn btn-sm" to={`/maps/${mapId}/portal`} onClick={(e) => { if (dirty && !window.confirm("You have unsaved changes. They are kept on this device, but are not saved to the map yet. Leave anyway?")) e.preventDefault(); }}>
            {data.map.is_campaign ? "Campaign portal" : "Team, review & publish"} →
          </Link>
          {data.map.is_campaign && data.map.campaign_status && <span className="field-hint">{data.map.goal ? `${data.map.goal} · ` : ""}Campaign {data.map.campaign_status === "open" ? "is open" : data.map.campaign_status === "upcoming" ? "has not started" : "has ended"}.</span>}
          {closed && <span className="tag-error" role="status">Contributors cannot draw right now.</span>}
        </div>

        <div className="changes" role="region" aria-label="Unsaved changes">
          <strong>{dirty ? "Unsaved changes" : "Everything is saved"}</strong>
          {dirty && <span className="field-hint">{summaryBits}</span>}
          <div className="row">
            <Button className="grow" variant="primary" busy={saving} disabled={!dirty} onClick={() => void saveAll()}>{saveLabel}</Button>
            <Button disabled={!dirty || saving} onClick={discardAll}>Discard</Button>
          </div>
        </div>

        <div className="stack">
          <h2>Draw</h2>
          <div className="tool-grid">{(["point", "line", "area"] as Tool[]).map((t) => toolBtn(t))}</div>
          {drawGeom && tool !== "cut" && (
            <div className="stack" style={{ gap: 8 }}>
              <span className="field-hint">Tags for each new feature</span>
              <div className="chips">{drawPresets.map((p) => <Button key={p.label} small onClick={() => setNewTags(toTags(p.tags))}>{p.label}</Button>)}</div>
              <TagRows rows={newTags} onChange={setNewTags} />
            </div>
          )}
        </div>

        <div className="stack">
          <h2>Edit</h2>
          <div className="tool-grid">
            {(["select", "reshape", "move", "split", "cut"] as Tool[]).map((t) => toolBtn(t))}
            <Button small disabled={sel.length < 2 || working} busy={working} title="Merge selected lines or areas into one" onClick={() => void mergeSelected()}>Merge</Button>
          </div>
          <div className="tool-grid">
            <Button small disabled={!sel.length} onClick={duplicateSelected}>Duplicate</Button>
            <Button small variant="danger" disabled={!sel.length || editable(sel, true).length === 0} title="Delete (Del)" onClick={removeSelected}>Delete</Button>
            <Button small disabled={!hist.past.length} title="Undo (Ctrl+Z)" onClick={undoAct}>Undo</Button>
          </div>
          <span className="field-hint">{TOOL_HELP[tool]}</span>
          <label className="check"><input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} />Snap to nearby points</label>
          <label className="check"><input type="checkbox" checked={multi} onChange={(e) => setMulti(e.target.checked)} />Multi-select (tap to add)</label>
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
          {dirty && <span className="field-hint">The export has saved features only. Save your changes first to include them.</span>}
        </div>
      </aside>

      <MapView
        features={mapFeatures}
        selectedIds={sel}
        drawMode={drawGeom}
        onDraw={onDraw}
        onCancelDraw={() => setTool("select")}
        hint={tool === "cut" ? "Draw a cutting line across the feature, then double-click or press Enter." : undefined}
        onSelect={onSelect}
        snap={snap}
        moveMode={tool === "move"}
        onMove={onMove}
        pickMode={tool === "split"}
        onPick={splitAt}
        imagery={imagery}
        showBase={showBase}
        editGeometry={tool === "reshape" && primary ? primary.geometry : null}
        onGeometryChange={onGeometryChange}
        flyTo={flyTo}
        fitKey={mapId}
        label="Map"
      >
        <div className="map-bar" role="toolbar" aria-label="Edit actions">
          <Button small variant="ghost" disabled={!hist.past.length} onClick={undoAct} title="Undo (Ctrl+Z)">↶ Undo</Button>
          <Button small variant="ghost" disabled={!hist.future.length} onClick={redoAct} title="Redo (Ctrl+Shift+Z)">↷ Redo</Button>
          <Button small variant="primary" busy={saving} disabled={!dirty} onClick={() => void saveAll()} title="Save all (Ctrl+S)">{saveLabel}</Button>
        </div>
      </MapView>

      <aside className="side right" aria-label="Feature details" aria-live="polite">
        <datalist id="tag-keys">{COMMON_KEYS.map((k) => <option key={k} value={k} />)}</datalist>
        {!sel.length && (
          <div className="state"><strong>Nothing selected</strong>
            {drawGeom && tool !== "cut" ? "Click the map to draw. Each new feature is selected so you can tag it, and the tool stays on." : "Pick Point, Line or Area to draw, or click a feature on the map."}
          </div>
        )}
        {sel.length > 1 && (
          <>
            <div><h2>Selection</h2><strong>{typeText(sel.length, "feature", "features")} selected</strong></div>
            {presets.length > 0 && (
              <div className="stack" style={{ gap: 6 }}>
                <span className="field-hint">Add a quick tag to all of them</span>
                <div className="chips">{presets.map((p) => <Button key={p.label} small onClick={() => applyPreset(p)}>{p.label}</Button>)}</div>
              </div>
            )}
            <div className="stack" style={{ gap: 8 }}>
              <h2>Tags for all</h2>
              <TagRows rows={bulkTags} onChange={setBulkTags} />
              <Button variant="primary" disabled={!bulkTags.some((t) => t.k.trim())} onClick={applyBulk}>Add to {sel.length} features</Button>
            </div>
            <span className="field-hint">Merge joins lines that meet end to end, or areas that touch. The first one you selected keeps its tags.</span>
            <Button onClick={() => setSelectedIds([])}>Clear selection</Button>
          </>
        )}
        {primary && (
          <>
            <div>
              <h2>Selected feature</h2>
              <strong>{GEOMETRY_LABEL[primary.geometry.type]}</strong>
              <div className="meta" style={{ fontSize: 13, color: "var(--muted)" }}>{primary.state === "new" ? "New · not saved yet" : primary.state === "mod" ? "Edited · not saved yet" : "Saved"}</div>
              {primary.meta?.author && <div className="meta" style={{ fontSize: 13, color: "var(--muted)" }}>Drawn by {primary.meta.author}{primary.meta.status ? ` · ${primary.meta.status === "submitted" ? "waiting for review" : primary.meta.status}` : ""}</div>}
              {primary.meta?.review_note && <div className="field-hint" role="note">Reviewer: {primary.meta.review_note}</div>}
              {!canEdit(primary) && <div className="tag-error" role="note">{primary.meta?.status === "approved" ? "A reviewer approved this, so it is locked." : "This belongs to someone else, so you can only look at it."}</div>}
            </div>
            {presets.length > 0 && (
              <div className="stack" style={{ gap: 6 }}>
                <span className="field-hint">Quick tags</span>
                <div className="chips">{presets.map((p) => <Button key={p.label} small disabled={!canEdit(primary)} onClick={() => applyPreset(p)}>{p.label}</Button>)}</div>
              </div>
            )}
            <div className="stack" style={{ gap: 8 }}>
              <h2>Tags</h2>
              {tags.length === 0 && <span className="field-hint">No tags yet. Add a name, type or any note.</span>}
              <TagRows rows={tags} onChange={updateTags} disabled={!canEdit(primary)} />
            </div>
            <div className="stack" style={{ gap: 6 }}>
              <h2>Shape</h2>
              <Button variant={tool === "reshape" ? "primary" : "default"} disabled={!canEdit(primary)} onClick={() => chooseTool(tool === "reshape" ? "select" : "reshape")}>{tool === "reshape" ? "Done reshaping" : "Reshape"}</Button>
              {tool === "reshape" && <span className="field-hint">{TOOL_HELP.reshape}</span>}
            </div>
            <div className="row" style={{ marginTop: "auto" }}>
              <Button className="grow" onClick={() => setSelectedIds([])}>Deselect</Button>
              <Button className="grow" variant="danger" disabled={!canEdit(primary)} onClick={removeSelected}>Delete</Button>
            </div>
          </>
        )}
      </aside>
    </div>
  );
}
