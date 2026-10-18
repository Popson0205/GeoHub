import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl, { type GeoJSONSource, type Map as MLMap, type StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { config } from "../lib/config";
import { bboxOf } from "../lib/forms";
import type { Geometry, GeometryType, Position, Props } from "../lib/types";
import { Button } from "./ui";

export interface MapFeature { id: string; geometry: Geometry; properties?: Props; pending?: boolean }
export interface MapImagery { id: string; url: string; tileSize?: 256 | 512; minzoom?: number; maxzoom?: number; attribution?: string }

interface Props_ {
  features: MapFeature[];
  selectedId?: string | null;
  /** When set, clicks draw a geometry of this type instead of selecting. */
  drawMode?: GeometryType | null;
  onDraw?: (g: Geometry) => void;
  onCancelDraw?: () => void;
  onSelect?: (id: string | null) => void;
  imagery?: MapImagery[];
  /** Re-fit the view when this value changes. */
  fitKey?: string;
  geolocate?: boolean;
  label?: string;
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

function asFC(features: MapFeature[]) {
  return {
    type: "FeatureCollection",
    features: features.map((f) => ({ type: "Feature", geometry: f.geometry, properties: { ...(f.properties ?? {}), fid: f.id, pending: f.pending ? 1 : 0 } })),
  };
}

export default function MapView({ features, selectedId, drawMode, onDraw, onCancelDraw, onSelect, imagery = [], fitKey, geolocate, label = "Map" }: Props_) {
  const box = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const [ready, setReady] = useState(false);
  const [vertices, setVertices] = useState<Position[]>([]);

  // Latest callbacks/state for event handlers registered once.
  const live = useRef({ drawMode, onDraw, onSelect, vertices });
  live.current = { drawMode, onDraw, onSelect, vertices };

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
      map.addLayer({ id: "features-fill", type: "fill", source: "features", filter: ["==", ["geometry-type"], "Polygon"], paint: { "fill-color": GREEN, "fill-opacity": 0.28 } });
      map.addLayer({ id: "features-line", type: "line", source: "features", filter: ["!=", ["geometry-type"], "Point"], paint: { "line-color": GREEN, "line-width": 2.5 } });
      map.addLayer({
        id: "features-point", type: "circle", source: "features", filter: ["==", ["geometry-type"], "Point"],
        paint: { "circle-radius": 8, "circle-color": ["case", ["==", ["get", "pending"], 1], "#d98a0b", GREEN], "circle-stroke-color": "#fff", "circle-stroke-width": 2.5 },
      });
      map.addLayer({ id: "sel-fill", type: "fill", source: "selected", filter: ["==", ["geometry-type"], "Polygon"], paint: { "fill-color": ORANGE, "fill-opacity": 0.3 } });
      map.addLayer({ id: "sel-line", type: "line", source: "selected", filter: ["!=", ["geometry-type"], "Point"], paint: { "line-color": ORANGE, "line-width": 4 } });
      map.addLayer({ id: "sel-point", type: "circle", source: "selected", filter: ["==", ["geometry-type"], "Point"], paint: { "circle-radius": 11, "circle-color": ORANGE, "circle-stroke-color": "#fff", "circle-stroke-width": 3 } });
      map.addLayer({ id: "draft-line", type: "line", source: "draft", filter: ["!=", ["geometry-type"], "Point"], paint: { "line-color": ORANGE, "line-width": 3, "line-dasharray": [2, 1.5] } });
      map.addLayer({ id: "draft-point", type: "circle", source: "draft", filter: ["==", ["geometry-type"], "Point"], paint: { "circle-radius": 6, "circle-color": "#fff", "circle-stroke-color": ORANGE, "circle-stroke-width": 3 } });
      setReady(true);
    });

    map.on("click", (e) => {
      const { drawMode: mode, onDraw: draw, onSelect: select } = live.current;
      const pos: Position = [e.lngLat.lng, e.lngLat.lat];
      if (mode === "Point") { draw?.({ type: "Point", coordinates: pos }); return; }
      if (mode) { setVertices((v) => [...v, pos]); return; }
      const hit = map.queryRenderedFeatures(e.point, { layers: FEATURE_LAYERS })[0];
      select?.(hit ? String(hit.properties?.fid) : null);
    });
    map.on("dblclick", (e) => {
      const { drawMode: mode } = live.current;
      if (mode === "LineString" || mode === "Polygon") { e.preventDefault(); finish(); }
    });
    map.on("mousemove", (e) => {
      const over = map.queryRenderedFeatures(e.point, { layers: FEATURE_LAYERS }).length > 0;
      map.getCanvas().style.cursor = live.current.drawMode ? "crosshair" : over ? "pointer" : "";
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
  useEffect(() => { setVertices([]); }, [drawMode]);

  // Features
  useEffect(() => {
    if (!ready) return;
    (mapRef.current!.getSource("features") as GeoJSONSource).setData(asFC(features) as never);
  }, [features, ready]);

  // Selection highlight
  useEffect(() => {
    if (!ready) return;
    const sel = features.filter((f) => f.id === selectedId);
    (mapRef.current!.getSource("selected") as GeoJSONSource).setData(asFC(sel) as never);
  }, [features, selectedId, ready]);

  // Draft while drawing
  useEffect(() => {
    if (!ready) return;
    const fc: { type: string; features: unknown[] } = { type: "FeatureCollection", features: [] };
    vertices.forEach((c) => fc.features.push({ type: "Feature", geometry: { type: "Point", coordinates: c }, properties: {} }));
    if (vertices.length > 1) fc.features.push({ type: "Feature", geometry: { type: "LineString", coordinates: drawMode === "Polygon" && vertices.length > 2 ? [...vertices, vertices[0]] : vertices }, properties: {} });
    (mapRef.current!.getSource("draft") as GeoJSONSource).setData(fc as never);
  }, [vertices, drawMode, ready]);

  // Imagery (raster tile layers sit under the vector layers)
  const imageryKey = useMemo(() => imagery.map((i) => [i.id, i.url, i.tileSize, i.minzoom, i.maxzoom].join("~")).join("|"), [imagery]);
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    for (const l of map.getStyle().layers) if (l.id.startsWith("img-")) map.removeLayer(l.id);
    for (const id of Object.keys(map.getStyle().sources)) if (id.startsWith("img-")) map.removeSource(id);
    for (const img of imagery) {
      map.addSource(`img-${img.id}`, { type: "raster", tiles: [img.url], tileSize: img.tileSize ?? 256, minzoom: img.minzoom, maxzoom: img.maxzoom, attribution: img.attribution });
      map.addLayer({ id: `img-${img.id}`, type: "raster", source: `img-${img.id}` }, "features-fill");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageryKey, ready]);

  // Fit to data when asked
  const fitted = useRef<string | null>(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || fitted.current === (fitKey ?? "")) return;
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
      {drawMode && (
        <div className="map-hint" role="status">
          {drawMode === "Point" ? "Tap the map to place the point." : `Tap to add points. ${vertices.length} added. Double-tap or press Finish when done.`}
        </div>
      )}
      {drawMode && (
        <div className="map-overlay">
          {drawMode !== "Point" && <Button small onClick={() => setVertices((v) => v.slice(0, -1))} disabled={!vertices.length}>Undo</Button>}
          {drawMode !== "Point" && <Button small variant="primary" onClick={finish} disabled={vertices.length < needed}>Finish</Button>}
          <Button small onClick={() => { setVertices([]); onCancelDraw?.(); }}>Cancel</Button>
        </div>
      )}
    </div>
  );
}
