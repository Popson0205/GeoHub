import { useEffect, useRef, useState } from "react";
import { loadApi } from "../lib/api";
import type { Geometry } from "../lib/types";
import { thumbStyle } from "./ui";

/** Plenty to show the shape and spread of the work; the full set is on the item's own page. */
const MAX_SHAPES = 400;
const W = 320, H = 120, PAD = 12;

type Shape = Geometry;
/** Read each item once per update, however often its card scrolls in and out of view. */
const cache = new Map<string, Promise<Shape[]>>();
function shapesOf(kind: "project" | "map", id: string, version: string): Promise<Shape[]> {
  const key = `${kind}:${id}@${version}`;
  let hit = cache.get(key);
  if (!hit) {
    hit = loadApi()
      .then((api): Promise<{ geometry?: Geometry | null; deleted?: boolean }[]> => (kind === "project" ? api.listFeatures(id) : api.listMapFeatures(id)))
      .then((list) => list.filter((f) => f.geometry && !f.deleted).slice(0, MAX_SHAPES).map((f) => f.geometry as Geometry));
    hit.catch(() => cache.delete(key));
    cache.set(key, hit);
  }
  return hit;
}

type XY = [number, number];
const coordsOf = (g: Geometry): XY[] =>
  g.type === "Point" ? [g.coordinates as XY] : g.type === "LineString" ? (g.coordinates as XY[]) : (g.coordinates as XY[][]).flat();

/** Fit the shapes into the thumbnail, keeping their real proportions (longitude shrinks away from the equator). */
function project(shapes: Shape[]) {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of shapes.flatMap(coordsOf)) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const k = Math.cos(((y0 + y1) / 2) * Math.PI / 180);
  const MIN = 0.004;                                   // about 400 m: a single place still gets some room around it
  const dx = Math.max((x1 - x0) * k, MIN), dy = Math.max(y1 - y0, MIN);
  const s = Math.min((W - 2 * PAD) / dx, (H - 2 * PAD) / dy);
  const cx = ((x0 + x1) / 2) * k, cy = (y0 + y1) / 2;
  return ([x, y]: XY): XY => [W / 2 + (x * k - cx) * s, H / 2 - (y - cy) * s];
}

/**
 * The real outline of a project's records or a map's features, drawn as a small picture on its card.
 * It loads only once the card is on screen and needs no map library or tiles, so lists stay fast and it
 * works offline. Until then, and when there is nothing to draw, the card keeps its contour placeholder.
 */
export default function FootprintThumb({ kind, id, version, height }: { kind: "project" | "map"; id: string; version: string; height?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [shapes, setShapes] = useState<Shape[] | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el || typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setVisible(true); io.disconnect(); } }, { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    let live = true;
    shapesOf(kind, id, version).then((s) => { if (live) setShapes(s); }).catch(() => { if (live) setShapes([]); });
    return () => { live = false; };
  }, [visible, kind, id, version]);

  const to = shapes && shapes.length ? project(shapes) : null;
  const path = (pts: XY[], close: boolean) => pts.map((p, i) => `${i ? "L" : "M"}${to!(p).map((n) => n.toFixed(1)).join(" ")}`).join("") + (close ? "Z" : "");
  return (
    <div ref={box} className="thumb thumb-footprint" style={{ ...thumbStyle(id), ...(height ? { height } : {}) }} aria-hidden="true">
      {to && (
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" focusable="false">
          {shapes!.map((g, i) => {
            if (g.type === "Polygon") return <path key={i} className="fp-area" d={(g.coordinates as XY[][]).map((ring) => path(ring, true)).join("")} />;
            if (g.type === "LineString") return <path key={i} className="fp-line" d={path(g.coordinates as XY[], false)} />;
            const [x, y] = to(g.coordinates as XY);
            return <circle key={i} className="fp-point" cx={x.toFixed(1)} cy={y.toFixed(1)} r={3.4} />;
          })}
        </svg>
      )}
    </div>
  );
}
