import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { loadApi } from "../lib/api";
import type { MapFeature } from "./MapView";

// The map library is large and only the Data hub thumbnails need it here, so it loads on first use.
const MapView = lazy(() => import("./MapView"));

/** Enough to show the shape and spread of a dataset; the full set is on its page. */
const PREVIEW_FEATURES = 300;

/** Read each dataset once per version, however often its card scrolls in and out of view. */
const cache = new Map<string, Promise<MapFeature[]>>();
function previewFeatures(slug: string, version: number): Promise<MapFeature[]> {
  const key = `${slug}@${version}`;
  let hit = cache.get(key);
  if (!hit) {
    hit = loadApi()
      .then((api) => api.datasetFeatures(slug, { limit: PREVIEW_FEATURES }))
      .then((fc) => fc.features.map((f) => ({ id: String(f.id), geometry: f.geometry, properties: f.properties })));
    hit.catch(() => cache.delete(key));          // a failed read is retried next time the card comes into view
    cache.set(key, hit);
  }
  return hit;
}

/**
 * A small map of a dataset for its card on the Data hub. It only starts (and only holds a WebGL context)
 * while the card is on screen, so a long list stays light. Until then, and for a dataset with nothing to
 * draw or one that cannot be read, the card keeps the plain contour-line thumbnail.
 */
export default function DatasetThumb({ slug, version, title }: { slug: string; version: number; title: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [features, setFeatures] = useState<MapFeature[] | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el || typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { rootMargin: "160px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || features) return;
    let live = true;
    previewFeatures(slug, version).then((f) => { if (live) setFeatures(f); }).catch(() => { if (live) setFeatures([]); });
    return () => { live = false; };
  }, [visible, features, slug, version]);

  const show = useMemo(() => visible && !!features && features.length > 0, [visible, features]);
  return (
    <div ref={box} className={`thumb${show ? " thumb-map" : ""}`} aria-hidden="true" {...({ inert: "" } as Record<string, string>)}>
      {show && (
        <Suspense fallback={null}>
          <MapView preview features={features!} fitKey={`${slug}@${version}`} label={`Map preview of ${title}`} />
        </Suspense>
      )}
    </div>
  );
}
