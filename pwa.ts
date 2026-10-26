import { useCallback, useEffect, useState } from "react";

/** The browser's "install this app" event (Chrome, Edge, Android). Not in the TypeScript DOM types. */
interface InstallEvent extends Event { prompt(): Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> }

let installEvent: InstallEvent | null = null;
let waiting: ServiceWorker | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

/** Run once at start-up: register the service worker, keep data safe from eviction, listen for install. */
export function initPwa() {
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installEvent = e as InstallEvent; notify(); });
  window.addEventListener("appinstalled", () => { installEvent = null; notify(); });

  // Ask the browser not to clear collected-but-unsynced records when the phone is short on space.
  void navigator.storage?.persist?.().catch(() => undefined);

  // Only a production build has a service worker (the dev server does not build one).
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").then((reg) => {
      const watch = (w: ServiceWorker | null) => w?.addEventListener("statechange", () => {
        // "installed" with a controller already present means a new version is ready and waiting.
        if (w.state === "installed" && navigator.serviceWorker.controller) { waiting = w; notify(); }
      });
      if (reg.waiting && navigator.serviceWorker.controller) { waiting = reg.waiting; notify(); }
      reg.addEventListener("updatefound", () => watch(reg.installing));
      // Look for a new version when the app comes back to the front, and once an hour while it stays open.
      const check = () => void reg.update().catch(() => undefined);
      document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") check(); });
      setInterval(check, 60 * 60 * 1000);
    }).catch(() => undefined);
    let reloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => { if (!reloading) { reloading = true; window.location.reload(); } });
  });
}

export function applyUpdate() { waiting?.postMessage({ type: "SKIP_WAITING" }); }

export const isStandalone = () =>
  window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
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
    updateReady: !!waiting,
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
