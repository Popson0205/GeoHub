import { useCallback, useEffect, useState } from "react";

/** The browser's "install this app" event (Chrome, Edge, Android). Not in the TypeScript DOM types. */
interface InstallEvent extends Event { prompt(): Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> }

let installEvent: InstallEvent | null = null;
let updated = false;          // a newer version has taken over from the one on screen
let reloadPending = false;
let busy = false;             // the person is part-way through something that a reload would lose
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

/** Tell the app whether a reload right now would lose unsaved work (for example a record being filled in). */
export function setBusy(on: boolean) { busy = on; if (!on) tryReload(); }

const typing = () => {
  const a = document.activeElement as HTMLElement | null;
  return !!a && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable);
};
function tryReload() {
  if (!reloadPending || busy || typing()) return;
  reloadPending = false;
  window.location.reload();
}

/** Run once at start-up: register the service worker, keep data safe from eviction, listen for install. */
export function initPwa() {
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installEvent = e as InstallEvent; notify(); });
  window.addEventListener("appinstalled", () => { installEvent = null; notify(); });

  // Ask the browser not to clear collected-but-unsynced records when the phone is short on space.
  void navigator.storage?.persist?.().catch(() => undefined);

  // In `npm run dev` the worker is a pass-through (it caches nothing), so installability can still be tested on localhost.
  if (!("serviceWorker" in navigator)) return;
  // Was the page already under a service worker when it opened? Then a change of worker means a real update.
  const hadController = !!navigator.serviceWorker.controller;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).then((reg) => {
      // Look for a new version whenever it is likely to exist: coming back to the app, getting a connection, hourly.
      const check = () => void reg.update().catch(() => undefined);
      document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { check(); tryReload(); } });
      window.addEventListener("online", check);
      setInterval(check, 60 * 60 * 1000);
      check();
    }).catch(() => undefined);
  });
  // The new version activates by itself. The collector then reloads at the first quiet moment (never mid-record or
  // mid-typing); the website only offers a Reload button, so an administrator's unsaved edits are never thrown away.
  let first = !hadController;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (first) { first = false; return; }   // the very first install taking control is not an update
    updated = true; notify();
    if (isCollectorApp()) { reloadPending = true; tryReload(); }
  });
  setInterval(tryReload, 3000);
  document.addEventListener("focusout", () => setTimeout(tryReload, 300));
}

export function applyUpdate() { window.location.reload(); }

export const isStandalone = () =>
  window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
/**
 * True in the installed app (home-screen launch). That app is for collecting only: no data viewing, editing,
 * map review or publishing. To try it in a normal browser tab, open any page with ?mode=collector once.
 */
export function isCollectorApp(): boolean {
  try {
    if (new URLSearchParams(window.location.search).get("mode") === "collector") sessionStorage.setItem("geohub.collector", "1");
    return isStandalone() || sessionStorage.getItem("geohub.collector") === "1";
  } catch { return isStandalone(); }
}
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

export function usePwa() {
  const [, tick] = useState(0);
  useEffect(() => { const l = () => tick((n) => n + 1); listeners.add(l); return () => { listeners.delete(l); }; }, []);
  const install = useCallback(async () => {
    if (!installEvent) return;
    await installEvent.prompt();
    await installEvent.userChoice;
    installEvent = null; notify();
  }, []);
  return {
    installed: isStandalone(),
    canInstall: !!installEvent,
    /** iPhone and iPad have no install button for web apps; the person adds it from the Share menu. */
    iosHint: isIos() && !isStandalone(),
    install,
    updateReady: updated,
    /** The collector is waiting for a quiet moment (for example until the open record is saved) to reload by itself. */
    updateWaiting: reloadPending,
    applyUpdate,
  };
}

/**
 * Make "Install" on a shared form's page install that form (its name, opening on its own link) rather than the whole app.
 * Chrome reads the manifest when asked, so swapping the link's target is enough. Restored when the page closes.
 */
export function useFormManifest(info: { name: string; startUrl: string } | null) {
  useEffect(() => {
    if (!info) return;
    const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
    if (!link) return;
    const before = link.href;
    const abs = (p: string) => new URL(p, window.location.origin).href;
    const manifest = {
      id: info.startUrl, name: info.name, short_name: info.name.slice(0, 12), start_url: abs(info.startUrl), scope: abs("/"),
      display: "standalone", background_color: "#14302a", theme_color: "#14302a",
      icons: [
        { src: abs("/icons/icon-192.png"), sizes: "192x192", type: "image/png", purpose: "any" },
        { src: abs("/icons/icon-512.png"), sizes: "512x512", type: "image/png", purpose: "any" },
        { src: abs("/icons/icon-maskable-512.png"), sizes: "512x512", type: "image/png", purpose: "maskable" },
      ],
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(manifest)], { type: "application/manifest+json" }));
    link.href = url;
    return () => { link.href = before; URL.revokeObjectURL(url); };
  }, [info?.name, info?.startUrl]); // eslint-disable-line react-hooks/exhaustive-deps
}
