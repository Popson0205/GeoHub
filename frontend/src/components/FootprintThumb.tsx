import { useEffect, useRef, useState } from "react";
import { loadApi } from "../lib/api";
import { config } from "../lib/config";
import type { Geometry } from "../lib/types";
import { thumbStyle } from "./ui";

/** Plenty to show the shape and spread of the work; the full set is on the item's own page. */
const MAX_SHAPES = 400;
const PAD = 14;
const TILE = 256;
/** A single place (or a tight cluster) still shows its streets, not one building filling the card. */
const MAX_ZOOM = 16;

type Kind = "project" | "map" | "dataset";
/** Read each item once per update, however often its card scrolls in and out of view. */
const cache = new Map<string, Promise<Geometry[]>>();
function shapesOf(kind: Kind, id: string, version: string): Promise<Geometry[]> {
  const key = `${kind}:${id}@${version}`;
  let hit = cache.get(key);
  if (!hit) {
    hit = loadApi()
      .then(async (api): Promise<{ geometry?: Geometry | null; deleted?: boolean }[]> =>
        kind === "project" ? api.listFeatures(id) : kind === "map" ? api.listMapFeatures(id) : (await api.datasetFeatures(id, { limit: MAX_SHAPES })).features)
      .then((list) => list.filter((f) => f.geometry && !f.deleted).slice(0, MAX_SHAPES).map((f) => f.geometry as Geometry));
    hit.catch(() => cache.delete(key));          // a failed read is retried next time the card comes into view
    cache.set(key, hit);
  }
  return hit;
}

type XY = [number, number];
const coordsOf = (g: Geometry): XY[] =>
  g.type === "Point" ? [g.coordinates as XY] : g.type === "LineString" ? (g.coordinates as XY[]) : (g.coordinates as XY[][]).flat();

/** Web Mercator, the projection every web map's tiles use, in pixels at zoom 0 (the world is 256 px wide). */
export function mercator([lon, lat]: XY): XY {
  const s = Math.sin(Math.max(-85.05, Math.min(85.05, lat)) * Math.PI / 180);
  return [(lon + 180) / 360 * TILE, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * TILE];
}

export interface View { zoom: number; left: number; top: number; to: (p: XY) => XY }
/** The zoom and offset that fit every shape inside a w × h box, the same way the full map fits them. */
export function fitView(shapes: Geometry[], w: number, h: number): View {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const c of shapes.flatMap(coordsOf)) { const [x, y] = mercator(c); x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const fit = Math.min((w - 2 * PAD) / Math.max(x1 - x0, 1e-9), (h - 2 * PAD) / Math.max(y1 - y0, 1e-9));
  const zoom = Math.max(0, Math.min(MAX_ZOOM, Math.log2(fit)));   // between whole levels, so the shapes fill the card
  const k = 2 ** zoom;
  const left = ((x0 + x1) / 2) * k - w / 2, top = ((y0 + y1) / 2) * k - h / 2;
  return { zoom, left, top, to: (p) => { const [x, y] = mercator(p); return [x * k - left, y * k - top]; } };
}

/**
 * The basemap tiles that cover the box. Tiles come from the next whole zoom level up and are drawn a little
 * smaller, never stretched, so streets stay crisp; on sharp screens one level further.
 */
export function tilesFor(v: View, w: number, h: number, retina: boolean, url = config.basemapLightUrl) {
  const z = Math.min(Math.ceil(v.zoom - 1e-9) + (retina ? 1 : 0), 19), size = TILE * 2 ** (v.zoom - z);
  const n = 2 ** z, out: { key: string; src: string; x: number; y: number; size: number }[] = [];
  for (let ty = Math.floor(v.top / size); ty * size < v.top + h; ty++) {
    if (ty < 0 || ty >= n) continue;
    for (let tx = Math.floor(v.left / size); tx * size < v.left + w; tx++) {
      const wx = ((tx % n) + n) % n;               // across the date line the world repeats
      const src = url.replace("{z}", String(z)).replace("{x}", String(wx)).replace("{y}", String(ty))
        .replace("{s}", "abc"[(wx + ty) % 3]!).replace("{r}", "");
      out.push({ key: `${z}/${tx}/${ty}`, src, x: tx * size - v.left, y: ty * size - v.top, size });
    }
  }
  return out;
}

/**
 * A small map of a project's records, a map's features or a dataset, on its card: the real basemap (the
 * light one the maps use) with the shapes on top. Plain image tiles and an SVG, no map library, so a long list
 * stays light. It loads only once the card is on screen. Until then, offline, or with nothing to draw, the card
 * keeps its contour placeholder.
 */
export default function FootprintThumb({ kind, id, version, height }: { kind: Kind; id: string; version: string; height?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [shapes, setShapes] = useState<Geometry[] | null>(null);
  const [loaded, setLoaded] = useState(0);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => { const r = el.getBoundingClientRect(); if (r.width && r.height) setSize((s) => (s && Math.abs(s.w - r.width) < 1 && Math.abs(s.h - r.height) < 1 ? s : { w: r.width, h: r.height })); };
    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    if (typeof IntersectionObserver === "undefined") { setVisible(true); return () => ro?.disconnect(); }
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setVisible(true); io.disconnect(); } }, { rootMargin: "200px" });
    io.observe(el);
    return () => { io.disconnect(); ro?.disconnect(); };
  }, []);
  useEffect(() => {
    if (!visible) return;
    let live = true;
    shapesOf(kind, id, version).then((s) => { if (live) setShapes(s); }).catch(() => { if (live) setShapes([]); });
    return () => { live = false; };
  }, [visible, kind, id, version]);

  const w = size?.w ?? 320, h = size?.h ?? 104;
  const view = shapes && shapes.length ? fitView(shapes, w, h) : null;   // before the card is measured, a typical card size
  const tiles = view ? tilesFor(view, w, h, (typeof devicePixelRatio === "number" ? devicePixelRatio : 1) > 1.2) : [];
  useEffect(() => { setLoaded(0); }, [view?.zoom, view?.left, view?.top]);
  const path = (pts: XY[], close: boolean) => pts.map((p, i) => `${i ? "L" : "M"}${view!.to(p).map((n) => n.toFixed(1)).join(" ")}`).join("") + (close ? "Z" : "");

  return (
    <div ref={box} className={`thumb thumb-footprint${loaded > 0 ? " has-tiles" : ""}`} style={{ ...thumbStyle(id), ...(height ? { height } : {}) }} aria-hidden="true">
      {view && (
        <>
          <div className="thumb-tiles">
            {tiles.map((t) => (
              <img key={t.key} src={t.src} alt="" width={t.size} height={t.size} loading="lazy" decoding="async" draggable={false} referrerPolicy="strict-origin-when-cross-origin"
                style={{ left: t.x, top: t.y, width: t.size, height: t.size }}
                onLoad={(e) => { e.currentTarget.classList.add("is-in"); setLoaded((n) => n + 1); }}
                onError={(e) => { e.currentTarget.style.display = "none"; }} />
            ))}
          </div>
          <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} focusable="false">
            {shapes!.map((g, i) => {
              if (g.type === "Polygon") return <path key={i} className="fp-area" d={(g.coordinates as XY[][]).map((ring) => path(ring, true)).join("")} />;
              if (g.type === "LineString") return <path key={i} className="fp-line" d={path(g.coordinates as XY[], false)} />;
              const [x, y] = view.to(g.coordinates as XY);
              return <circle key={i} className="fp-point" cx={x.toFixed(1)} cy={y.toFixed(1)} r={3.6} />;
            })}
          </svg>
          {loaded > 0 && <span className="thumb-credit">© OpenStreetMap{config.basemapLightUrl.includes("carto") ? " © CARTO" : ""}</span>}
        </>
      )}
    </div>
  );
}
