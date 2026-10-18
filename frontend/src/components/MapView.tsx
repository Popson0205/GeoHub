import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import maplibregl, { type GeoJSONSource, type Map as MLMap, type StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { config } from "../lib/config";
import { bboxOf } from "../lib/forms";
import { translate } from "../lib/geoops";
import type { Geometry, GeometryType, Position, Props } from "../lib/types";
import { Button } from "./ui";

export interface MapFeature { id: string; geometry: Geometry; properties?: Props; pending?: boolean; /** Colours the feature: new (amber) or changed but not saved (blue). */ state?: "new" | "mod" | "clean" | "review" | "rejected" }
export interface MapImagery { id: string; url: string; maxzoom?: number; opacity?: number; attribution?: string }
export type Bbox = [number, number, number, number];

/** Tile URL templates from the wild: {-y} means TMS rows, {s} is a subdomain letter (MapLibre has neither). */
export function tileSpec(url: string): { tiles: string[]; scheme: "xyz" | "tms" } {
  const tms = url.includes("{-y}");
  return { tiles: [url.replace("{-y}", "{y}").replace("{s}", "a")], scheme: tms ? "tms" : "xyz" };
}

// ---- geometry editing helpers: a geometry as a list of editable paths (a point, a line, or the rings of an area) ----
type Path = Position[];
function pathsOf(g: Geometry): Path[] {
  if (g.type === "Point") return [[[...g.coordinates] as Position]];
  if (g.type === "LineString") return [g.coordinates.map((c) => [...c] as Position)];
  return g.coordinates.map((r) => r.slice(0, -1).map((c) => [...c] as Position));     // drop the closing vertex
}
function fromPaths(g: Geometry, paths: Path[]): Geometry {
  if (g.type === "Point") return { type: "Point", coordinates: paths[0][0] };
  if (g.type === "LineString") return { type: "LineString", coordinates: paths[0] };
  return { type: "Polygon", coordinates: paths.map((r) => [...r, r[0]]) };
}
function handlesFC(g: Geometry, paths: Path[]) {
  const features: unknown[] = [];
  paths.forEach((p, r) => {
    p.forEach((c, i) => features.push({ type: "Feature", geometry: { type: "Point", coordinates: c }, properties: { kind: "v", r, i } }));
    if (g.type === "Point") return;
    const segs = g.type === "Polygon" ? p.length : p.length - 1;
    for (let i = 0; i < segs; i++) {
      const a = p[i], b = p[(i + 1) % p.length];
      features.push({ type: "Feature", geometry: { type: "Point", coordinates: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] }, properties: { kind: "m", r, i } });
    }
  });
  return { type: "FeatureCollection", features };
}

interface Props_ {
  features: MapFeature[];
  selectedId?: string | null;
  /** When set, clicks draw a geometry of this type instead of selecting. */
  drawMode?: GeometryType | null;
  onDraw?: (g: Geometry) => void;
  onCancelDraw?: () => void;
  /** `additive` is true when the user held Shift/Ctrl/Cmd, to add to or remove from a multiple selection. */
  onSelect?: (id: string | null, additive?: boolean) => void;
  /** Several selected features (highlighted together). Takes precedence over `selectedId`. */
  selectedIds?: string[];
  /** Snap drawing and vertex dragging to the vertices of existing features. */
  snap?: boolean;
  /** Dragging a selected feature moves it. Reports the shift in degrees when the drag ends. */
  moveMode?: boolean;
  onMove?: (ids: string[], dx: number, dy: number) => void;
  /** Clicking a feature reports it with the clicked position instead of selecting it (used for "split at point"). */
  pickMode?: boolean;
  onPick?: (id: string, pos: Position) => void;
  /** Text for the hint bubble while a draw tool is active. */
  hint?: string;
  imagery?: MapImagery[];
  /** Show the OpenStreetMap base layer under imagery (default true). */
  showBase?: boolean;
  /** When set, shows draggable vertices for this geometry. Drag to move, drag a midpoint to add, right-click or double-click a vertex to remove. */
  editGeometry?: Geometry | null;
  onGeometryChange?: (g: Geometry) => void;
  /** Fly to these bounds whenever `key` changes. */
  flyTo?: { bounds: Bbox; key: number } | null;
  /** Re-fit the view when this value changes. */
  fitKey?: string;
  geolocate?: boolean;
  label?: string;
  /** Extra overlays drawn on top of the map (for example a toolbar). */
  children?: ReactNode;
}

const DEFAULT_CENTER: [number, number] = [4.5418, 7.7827];
const STYLE: StyleSpecification = {
  version: 8,
  sources: { base: { type: "raster", tiles: [config.basemapUrl], tileSize: 256, attribution: "© OpenStreetMap contributors", maxzoom: 19 } },
  layers: [{ id: "base", type: "raster", source: "base" }],
};
const FEATURE_LAYERS = ["features-fill", "features-line", "features-point"];
const empty = { type: "FeatureCollection", features: [] };
const GREEN = "#1f6b52";
const ORANGE = "#b8431a";
const AMBER = "#d98a0b";
const BLUE = "#2f6fb0";
const PURPLE = "#7b5ea7";
const RED = "#c0392b";
const SNAP_PX = 12;
/** Colour by state: new = amber, changed = blue, saved = green; on shared maps also waiting for review = purple, rejected = red. */
const byState = (): maplibregl.ExpressionSpecification => ["match", ["get", "state"], "new", AMBER, "mod", BLUE, "review", PURPLE, "rejected", RED, GREEN];

function asFC(features: MapFeature[]) {
  return {
    type: "FeatureCollection",
    features: features.map((f) => ({ type: "Feature", geometry: f.geometry, properties: { ...(f.properties ?? {}), fid: f.id, state: f.state ?? (f.pending ? "new" : "clean") } })),
  };
}

export default function MapView({ features, selectedId, selectedIds, snap = false, moveMode = false, onMove, pickMode = false, onPick, hint, drawMode, onDraw, onCancelDraw, onSelect, imagery = [], showBase = true, editGeometry = null, onGeometryChange, flyTo, fitKey, geolocate, label = "Map", children }: Props_) {
  const box = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const [ready, setReady] = useState(false);
  const [vertices, setVertices] = useState<Position[]>([]);

  // Latest callbacks/state for event handlers registered once.
  const selIds = useMemo(() => selectedIds ?? (selectedId ? [selectedId] : []), [selectedIds, selectedId]);
  const live = useRef({ drawMode, onDraw, onCancelDraw, onSelect, vertices, editGeometry, onGeometryChange, snap, moveMode, onMove, pickMode, onPick, features, selIds });
  live.current = { drawMode, onDraw, onCancelDraw, onSelect, vertices, editGeometry, onGeometryChange, snap, moveMode, onMove, pickMode, onPick, features, selIds };
  const moving = useRef<{ start: { lng: number; lat: number }; ids: string[]; dx: number; dy: number } | null>(null);

  // Every vertex of every feature, for snapping. Only built while snapping is on.
  const snapTargets = useMemo(() => {
    if (!snap) return [] as { id: string; c: Position }[];
    const out: { id: string; c: Position }[] = [];
    const walk = (id: string, c: unknown) => { if (Array.isArray(c) && typeof c[0] === "number") out.push({ id, c: c as Position }); else if (Array.isArray(c)) c.forEach((x) => walk(id, x)); };
    for (const f of features) walk(f.id, f.geometry.coordinates);
    return out;
  }, [features, snap]);
  const targetsRef = useRef(snapTargets);
  targetsRef.current = snapTargets;
  /** Nearest existing vertex within SNAP_PX of the pointer, ignoring the features in `skip`. */
  function snapAt(map: MLMap, at: { lng: number; lat: number }, pt: { x: number; y: number }, skip: string[]): Position | null {
    if (!live.current.snap) return null;
    const a = map.unproject([pt.x + SNAP_PX, pt.y]), b = map.unproject([pt.x, pt.y + SNAP_PX]);
    const wLng = Math.abs(a.lng - at.lng), wLat = Math.abs(b.lat - at.lat);
    let best: Position | null = null, bd = SNAP_PX;
    for (const t of targetsRef.current) {
      if (Math.abs(t.c[0] - at.lng) > wLng || Math.abs(t.c[1] - at.lat) > wLat || skip.includes(t.id)) continue;
      const q = map.project(t.c as [number, number]);
      const d = Math.hypot(q.x - pt.x, q.y - pt.y);
      if (d <= bd) { bd = d; best = t.c; }
    }
    return best;
  }
  const editPaths = useRef<Path[] | null>(null);
  const drag = useRef<{ r: number; i: number } | null>(null);
  const justDragged = useRef(false);
  const snapShow = useRef<((p: Position | null) => void) | null>(null);
  const hitRef = useRef<((pt: { x: number; y: number }) => maplibregl.MapGeoJSONFeature | undefined) | null>(null);

  useEffect(() => {
    if (!box.current) return;
    const map = new maplibregl.Map({ container: box.current, style: STYLE, center: DEFAULT_CENTER, zoom: 13, attributionControl: { compact: true } });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");
    if (geolocate) map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: true, showAccuracyCircle: true }), "top-right");

    map.on("load", () => {
      map.addSource("features", { type: "geojson", data: empty as never });
      map.addSource("selected", { type: "geojson", data: empty as never });
      map.addSource("draft", { type: "geojson", data: empty as never });
      map.addSource("handles", { type: "geojson", data: empty as never });
      map.addSource("snap", { type: "geojson", data: empty as never });
      map.addLayer({ id: "features-fill", type: "fill", source: "features", filter: ["==", ["geometry-type"], "Polygon"], paint: { "fill-color": byState(), "fill-opacity": 0.28 } });
      map.addLayer({ id: "features-line", type: "line", source: "features", filter: ["!=", ["geometry-type"], "Point"], paint: { "line-color": byState(), "line-width": 2.5 } });
      map.addLayer({
        id: "features-point", type: "circle", source: "features", filter: ["==", ["geometry-type"], "Point"],
        paint: { "circle-radius": 8, "circle-color": byState(), "circle-stroke-color": "#fff", "circle-stroke-width": 2.5 },
      });
      map.addLayer({ id: "sel-fill", type: "fill", source: "selected", filter: ["==", ["geometry-type"], "Polygon"], paint: { "fill-color": ORANGE, "fill-opacity": 0.3 } });
      map.addLayer({ id: "sel-line", type: "line", source: "selected", filter: ["!=", ["geometry-type"], "Point"], paint: { "line-color": ORANGE, "line-width": 4 } });
      map.addLayer({ id: "sel-point", type: "circle", source: "selected", filter: ["==", ["geometry-type"], "Point"], paint: { "circle-radius": 11, "circle-color": ORANGE, "circle-stroke-color": "#fff", "circle-stroke-width": 3 } });
      map.addLayer({ id: "draft-line", type: "line", source: "draft", filter: ["!=", ["geometry-type"], "Point"], paint: { "line-color": ORANGE, "line-width": 3, "line-dasharray": [2, 1.5] } });
      map.addLayer({ id: "draft-point", type: "circle", source: "draft", filter: ["==", ["geometry-type"], "Point"], paint: { "circle-radius": 6, "circle-color": "#fff", "circle-stroke-color": ORANGE, "circle-stroke-width": 3 } });
      map.addLayer({ id: "snap-ring", type: "circle", source: "snap", paint: { "circle-radius": 9, "circle-color": "#ffffff", "circle-opacity": 0.2, "circle-stroke-color": "#0b57d0", "circle-stroke-width": 3 } });
      map.addLayer({ id: "edit-m", type: "circle", source: "handles", filter: ["==", ["get", "kind"], "m"], paint: { "circle-radius": 5, "circle-color": "#fff", "circle-opacity": 0.8, "circle-stroke-color": ORANGE, "circle-stroke-width": 1.5 } });
      map.addLayer({ id: "edit-v", type: "circle", source: "handles", filter: ["==", ["get", "kind"], "v"], paint: { "circle-radius": 7, "circle-color": "#fff", "circle-stroke-color": ORANGE, "circle-stroke-width": 3 } });

      const showSnap = (p: Position | null) => (map.getSource("snap") as GeoJSONSource).setData((p ? { type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Point", coordinates: p }, properties: {} }] } : empty) as never);
      snapShow.current = showSnap;
      const hitAt = (pt: { x: number; y: number }) => map.queryRenderedFeatures([[pt.x - 6, pt.y - 6], [pt.x + 6, pt.y + 6]], { layers: FEATURE_LAYERS })[0];
      hitRef.current = hitAt;

      // ---- moving whole features ----
      const startMove = (e: maplibregl.MapMouseEvent | maplibregl.MapTouchEvent) => {
        const L = live.current;
        if (!L.moveMode || drag.current || moving.current) return;
        if (map.queryRenderedFeatures(e.point, { layers: ["edit-v", "edit-m"] }).length) return;
        const hit = hitAt(e.point);
        if (!hit) return;
        const fid = String(hit.properties?.fid);
        const ids = L.selIds.includes(fid) ? L.selIds : [fid];
        if (!L.selIds.includes(fid)) L.onSelect?.(fid, false);
        e.preventDefault();
        map.dragPan.disable();
        moving.current = { start: { lng: e.lngLat.lng, lat: e.lngLat.lat }, ids, dx: 0, dy: 0 };
      };
      const moveMove = (e: maplibregl.MapMouseEvent | maplibregl.MapTouchEvent) => {
        const m = moving.current;
        if (!m) return;
        m.dx = e.lngLat.lng - m.start.lng; m.dy = e.lngLat.lat - m.start.lat;
        const shifted = live.current.features.map((f) => (m.ids.includes(f.id) ? { ...f, geometry: translate(f.geometry, m.dx, m.dy) } : f));
        (map.getSource("features") as GeoJSONSource).setData(asFC(shifted) as never);
        (map.getSource("selected") as GeoJSONSource).setData(asFC(shifted.filter((f) => m.ids.includes(f.id))) as never);
      };
      const endMove = () => {
        const m = moving.current;
        if (!m) return;
        moving.current = null;
        map.dragPan.enable();
        justDragged.current = true;
        setTimeout(() => { justDragged.current = false; }, 80);
        if (m.dx === 0 && m.dy === 0) { (map.getSource("features") as GeoJSONSource).setData(asFC(live.current.features) as never); return; }
        live.current.onMove?.(m.ids, m.dx, m.dy);
      };
      map.on("mousedown", startMove);
      map.on("touchstart", startMove);
      map.on("mousemove", moveMove);
      map.on("touchmove", moveMove);
      map.on("mouseup", endMove);
      map.on("touchend", endMove);

      // ---- vertex editing ----
      const refresh = () => {
        const g = live.current.editGeometry, paths = editPaths.current;
        if (!g || !paths) return;
        (map.getSource("selected") as GeoJSONSource).setData(asFC([{ id: "edit", geometry: fromPaths(g, paths) }]) as never);
        (map.getSource("handles") as GeoJSONSource).setData(handlesFC(g, paths) as never);
      };
      const startDrag = (e: maplibregl.MapLayerMouseEvent | maplibregl.MapLayerTouchEvent) => {
        const f = e.features?.[0], paths = editPaths.current;
        if (!f || !paths || !live.current.editGeometry || drag.current) return;
        e.preventDefault();
        const { kind, r, i } = f.properties as { kind: string; r: number; i: number };
        let at = i;
        if (kind === "m") {                       // a midpoint becomes a new vertex right after segment i
          const a = paths[r][i], b = paths[r][(i + 1) % paths[r].length];
          paths[r].splice(i + 1, 0, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
          at = i + 1;
        }
        drag.current = { r, i: at };
        map.dragPan.disable();
        refresh();
      };
      const moveDrag = (e: maplibregl.MapMouseEvent | maplibregl.MapTouchEvent) => {
        const d = drag.current, paths = editPaths.current;
        if (!d || !paths) return;
        const sp = snapAt(map, e.lngLat, e.point, live.current.selIds);
        paths[d.r][d.i] = sp ?? [e.lngLat.lng, e.lngLat.lat];
        showSnap(sp);
        refresh();
      };
      const endDrag = () => {
        const d = drag.current, paths = editPaths.current, g = live.current.editGeometry;
        if (!d || !paths || !g) return;
        drag.current = null;
        showSnap(null);
        map.dragPan.enable();
        justDragged.current = true;
        setTimeout(() => { justDragged.current = false; }, 80);
        live.current.onGeometryChange?.(fromPaths(g, paths));
      };
      const removeVertex = (e: maplibregl.MapLayerMouseEvent) => {
        const f = e.features?.[0], paths = editPaths.current, g = live.current.editGeometry;
        if (!f || !paths || !g || g.type === "Point") return;
        e.preventDefault();
        const { r, i } = f.properties as { r: number; i: number };
        if (paths[r].length <= (g.type === "Polygon" ? 3 : 2)) return;        // keep a valid shape
        paths[r].splice(i, 1);
        refresh();
        live.current.onGeometryChange?.(fromPaths(g, paths));
      };
      for (const layer of ["edit-v", "edit-m"]) {
        map.on("mousedown", layer, startDrag);
        map.on("touchstart", layer, startDrag);
      }
      map.on("mousemove", moveDrag);
      map.on("touchmove", moveDrag);
      map.on("mouseup", endDrag);
      map.on("touchend", endDrag);
      map.on("contextmenu", "edit-v", removeVertex);
      map.on("dblclick", "edit-v", removeVertex);
      setReady(true);
    });

    map.on("click", (e) => {
      if (justDragged.current || map.queryRenderedFeatures(e.point, { layers: ["edit-v", "edit-m"] }).length) return;
      const { drawMode: mode, onDraw: draw, onSelect: select, pickMode: pick, onPick: picked } = live.current;
      const pos: Position = snapAt(map, e.lngLat, e.point, mode ? [] : live.current.selIds) ?? [e.lngLat.lng, e.lngLat.lat];
      if (mode === "Point") { draw?.({ type: "Point", coordinates: pos }); return; }
      if (mode) {
        // a double-click sends two clicks first; ignore the second one so the last point is not doubled
        setVertices((v) => { const last = v[v.length - 1]; if (last) { const q = map.project(last as [number, number]); if (Math.hypot(q.x - e.point.x, q.y - e.point.y) < 4) return v; } return [...v, pos]; });
        return;
      }
      if (live.current.moveMode) return;
      const hit = hitRef.current?.(e.point);
      if (pick) { if (hit) picked?.(String(hit.properties?.fid), [e.lngLat.lng, e.lngLat.lat]); return; }
      const oe = e.originalEvent as MouseEvent | undefined;
      select?.(hit ? String(hit.properties?.fid) : null, !!(oe && (oe.shiftKey || oe.ctrlKey || oe.metaKey)));
    });
    map.on("dblclick", (e) => {
      const { drawMode: mode } = live.current;
      if (mode === "LineString" || mode === "Polygon") { e.preventDefault(); finish(); }
    });
    map.on("mousemove", (e) => {
      if (drag.current || moving.current) return;
      const L = live.current;
      if (L.drawMode) snapShow.current?.(snapAt(map, e.lngLat, e.point, []));
      const handle = map.queryRenderedFeatures(e.point, { layers: ["edit-v", "edit-m"] }).length > 0;
      const over = !!hitRef.current?.(e.point);
      map.getCanvas().style.cursor = L.drawMode || L.pickMode ? "crosshair" : handle ? "move" : over ? (L.moveMode ? "grab" : "pointer") : "";
    });
    return () => { map.remove(); mapRef.current = null; setReady(false); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function finish() {
    const { drawMode: mode, onDraw: draw, vertices: v } = live.current;
    if (mode === "LineString" && v.length >= 2) draw?.({ type: "LineString", coordinates: v });
    else if (mode === "Polygon" && v.length >= 3) draw?.({ type: "Polygon", coordinates: [[...v, v[0]]] });
    else return;
    setVertices([]);
  }
  useEffect(() => { setVertices([]); if (!drawMode) snapShow.current?.(null); }, [drawMode]);

  // Keyboard while drawing: Enter finishes, Backspace / Ctrl+Z removes the last point, Esc cancels the shape, then the tool.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const L = live.current;
      if (!L.drawMode) return;
      const t = e.target as HTMLElement | null;
      if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
      if (e.key === "Enter") { e.preventDefault(); finish(); }
      else if ((e.key === "Backspace" || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z")) && L.vertices.length) { e.preventDefault(); setVertices((v) => v.slice(0, -1)); }
      else if (e.key === "Escape") { e.preventDefault(); if (L.vertices.length) setVertices([]); else L.onCancelDraw?.(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Features
  useEffect(() => {
    if (!ready) return;
    (mapRef.current!.getSource("features") as GeoJSONSource).setData(asFC(features) as never);
  }, [features, ready]);

  // Selection highlight
  useEffect(() => {
    if (!ready) return;
    const sel = features.filter((f) => selIds.includes(f.id));
    (mapRef.current!.getSource("selected") as GeoJSONSource).setData(asFC(sel) as never);
  }, [features, selIds, ready]);

  // Vertex handles for the geometry being edited
  useEffect(() => {
    if (!ready) return;
    const map = mapRef.current!;
    if (drag.current) return;
    if (!editGeometry) {
      editPaths.current = null;
      (map.getSource("handles") as GeoJSONSource).setData(empty as never);
      return;
    }
    editPaths.current = pathsOf(editGeometry);
    (map.getSource("handles") as GeoJSONSource).setData(handlesFC(editGeometry, editPaths.current) as never);
  }, [editGeometry, ready]);

  // Draft while drawing
  useEffect(() => {
    if (!ready) return;
    const fc: { type: string; features: unknown[] } = { type: "FeatureCollection", features: [] };
    vertices.forEach((c) => fc.features.push({ type: "Feature", geometry: { type: "Point", coordinates: c }, properties: {} }));
    if (vertices.length > 1) fc.features.push({ type: "Feature", geometry: { type: "LineString", coordinates: drawMode === "Polygon" && vertices.length > 2 ? [...vertices, vertices[0]] : vertices }, properties: {} });
    (mapRef.current!.getSource("draft") as GeoJSONSource).setData(fc as never);
  }, [vertices, drawMode, ready]);

  // Imagery (raster tile layers sit under the vector layers)
  const imageryKey = useMemo(() => imagery.map((i) => `${i.id}|${i.url}|${i.maxzoom ?? ""}`).join("||"), [imagery]);
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    for (const l of map.getStyle().layers) if (l.id.startsWith("img-")) map.removeLayer(l.id);
    for (const id of Object.keys(map.getStyle().sources)) if (id.startsWith("img-")) map.removeSource(id);
    for (const img of imagery) {
      const { tiles, scheme } = tileSpec(img.url);
      map.addSource(`img-${img.id}`, { type: "raster", tiles, scheme, tileSize: 256, ...(img.maxzoom ? { maxzoom: img.maxzoom } : {}), ...(img.attribution ? { attribution: img.attribution } : {}) });
      map.addLayer({ id: `img-${img.id}`, type: "raster", source: `img-${img.id}`, paint: { "raster-opacity": img.opacity ?? 1 } }, "features-fill");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageryKey, ready]);
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    for (const img of imagery) if (map.getLayer(`img-${img.id}`)) map.setPaintProperty(`img-${img.id}`, "raster-opacity", img.opacity ?? 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imagery.map((i) => i.opacity ?? 1).join(","), ready]);
  useEffect(() => {
    const map = mapRef.current;
    if (ready && map) map.setLayoutProperty("base", "visibility", showBase ? "visible" : "none");
  }, [showBase, ready]);
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !flyTo) return;
    map.fitBounds([[flyTo.bounds[0], flyTo.bounds[1]], [flyTo.bounds[2], flyTo.bounds[3]]], { padding: 40, maxZoom: 19 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flyTo?.key, ready]);

  // Fit to data when asked
  const fitted = useRef<string | null>(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || fitted.current === (fitKey ?? "")) return;
    if (features.some((f) => f.state === "new" || f.pending)) { fitted.current = fitKey ?? ""; return; }     // the user is already drawing: do not move the view
    const bb = bboxOf(features.map((f) => f.geometry));
    if (!bb) return;
    fitted.current = fitKey ?? "";
    map.fitBounds([[bb[0], bb[1]], [bb[2], bb[3]]], { padding: 60, maxZoom: 17, duration: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, fitKey, features.length]);

  const needed = drawMode === "LineString" ? 2 : 3;
  return (
    <div className="map-wrap">
      <div ref={box} className="map" role="region" aria-label={label} />
      {children}
      {drawMode && (
        <div className="map-hint" role="status">
          {hint ?? (drawMode === "Point" ? "Tap the map to place the point." : `Tap to add points. ${vertices.length} added. Double-tap or press Finish when done.`)}
        </div>
      )}
      {drawMode && (
        <div className="map-overlay">
          {drawMode !== "Point" && <Button small onClick={() => setVertices((v) => v.slice(0, -1))} disabled={!vertices.length}>Undo</Button>}
          {drawMode !== "Point" && <Button small variant="primary" onClick={finish} disabled={vertices.length < needed}>Finish</Button>}
          <Button small onClick={() => { if (vertices.length) setVertices([]); else onCancelDraw?.(); }}>{vertices.length ? "Clear points" : "Stop drawing"}</Button>
        </div>
      )}
    </div>
  );
}
