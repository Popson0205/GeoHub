import { useEffect, useState } from "react";
import { listenGps } from "./gpsStream";

const OK_KEY = "geohub.gps.allowed";
const remember = () => { try { localStorage.setItem(OK_KEY, "1"); } catch { /* storage unavailable */ } };
const remembered = () => { try { return localStorage.getItem(OK_KEY) === "1"; } catch { return false; } };
/** Call after the person has allowed location once, so later visits warm the GPS without asking again. */
export const gpsAllowed = remember;

/**
 * Keep the phone's GPS running while the collector is on screen, so it already has satellites when the person
 * taps "Capture". A cold GPS starts with rough Wi-Fi or cell-tower positions (often 20 to 100 m off) and takes
 * from several seconds to a minute to lock on; a warm one gives good readings at once.
 *
 * It starts only once location permission has been given (never prompting by itself), and stops whenever the app
 * is in the background or the screen is left, to save battery. Returns the latest accuracy in metres.
 */
export function useGpsWarmup(active: boolean): { accuracy: number | null; on: boolean } {
  const [allowed, setAllowed] = useState(remembered);
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden");
  const [accuracy, setAccuracy] = useState<number | null>(null);

  useEffect(() => {
    const onVis = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onVis);
    let status: PermissionStatus | null = null;
    const sync = () => { if (status?.state === "granted") { remember(); setAllowed(true); } else if (status?.state === "denied") setAllowed(false); };
    navigator.permissions?.query({ name: "geolocation" as PermissionName }).then((s) => { status = s; sync(); s.addEventListener?.("change", sync); }, () => undefined);
    const onStorage = (e: StorageEvent) => { if (e.key === OK_KEY) setAllowed(remembered()); };
    window.addEventListener("storage", onStorage);
    // a capture in this tab gives permission: pick it up without a reload
    const poll = window.setInterval(() => { if (!allowed && remembered()) setAllowed(true); }, 2000);
    return () => { document.removeEventListener("visibilitychange", onVis); status?.removeEventListener?.("change", sync); window.removeEventListener("storage", onStorage); window.clearInterval(poll); };
  }, [allowed]);

  const on = active && allowed && visible && typeof navigator !== "undefined" && !!navigator.geolocation;
  useEffect(() => {
    if (!on) { setAccuracy(null); return; }
    return listenGps(
      (p) => setAccuracy(Math.round(p.coords.accuracy)),
      (e) => { if (e.code === 1) { try { localStorage.removeItem(OK_KEY); } catch { /* ignore */ } setAllowed(false); } },
    );
  }, [on]);
  return { accuracy, on };
}
