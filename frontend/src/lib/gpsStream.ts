/**
 * One GPS feed for the whole app. The warm-up and the capture both listen to it, so the receiver is never
 * restarted between them (a fresh watch can wait for the next position change before it reports anything).
 * The feed runs while anyone is listening and stops when the last listener leaves.
 */
type Listener = { ok: (p: GeolocationPosition) => void; err: (e: GeolocationPositionError) => void };
const listeners = new Set<Listener>();
let watchId: number | null = null;
let last: { p: GeolocationPosition; at: number } | null = null;
/** A reading this recent is handed to a new listener straight away: the person has not moved in that time. */
const FRESH_MS = 3000;

function update() {
  if (watchId == null && listeners.size) {
    watchId = navigator.geolocation.watchPosition(
      (p) => { last = { p, at: Date.now() }; for (const l of [...listeners]) l.ok(p); },
      (e) => { for (const l of [...listeners]) l.err(e); },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 },
    );
  } else if (watchId != null && !listeners.size) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null; last = null;
  }
}

/** Listen to the GPS; returns a function that stops listening. With `fresh`, a reading from the last 3 s arrives at once. */
export function listenGps(ok: Listener["ok"], err: Listener["err"] = () => undefined, fresh = true): () => void {
  const l = { ok, err };
  listeners.add(l);
  update();
  if (fresh && last && Date.now() - last.at < FRESH_MS) { const p = last.p; queueMicrotask(() => { if (listeners.has(l)) ok(p); }); }
  return () => { listeners.delete(l); update(); };
}
