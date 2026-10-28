import { applyUpdate, isCollectorApp, usePwa } from "../lib/pwa";
import { Button } from "./ui";

/** Shown over any screen when a new version of the app has been downloaded. Applied only when the person agrees. */
export function UpdateBanner() {
  const { updateReady, updateWaiting } = usePwa();
  if (!updateReady) return null;
  const auto = isCollectorApp();
  return (
    <div role="status" style={{ position: "fixed", left: 12, right: 12, bottom: "calc(12px + env(safe-area-inset-bottom, 0px))", zIndex: 1000, maxWidth: 520, margin: "0 auto", display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", borderRadius: 12, background: "#14302a", color: "#fff", boxShadow: "0 8px 24px rgba(0,0,0,.25)" }}>
      <span style={{ flex: 1 }}>{auto ? (updateWaiting ? "A new version is ready. It will load as soon as you finish this record." : "Updating…") : "A new version is ready. Save your work, then reload."}</span>
      {!auto && <Button variant="accent" onClick={applyUpdate}>Reload</Button>}
    </div>
  );
}

/** Install card for the collector's Sync tab. Hidden once the app is installed. */
export function InstallCard() {
  const { installed, canInstall, iosHint, install } = usePwa();
  if (installed) return null;
  if (!canInstall && !iosHint) return null;
  return (
    <div className="state">
      <strong>Install on this device</strong>
      {canInstall
        ? <span>Add Geohub to your home screen. It opens full screen and works with no signal.</span>
        : <span>To install: tap the Share button in Safari, then “Add to Home Screen”. It then opens full screen and works with no signal.</span>}
      {canInstall && <Button variant="primary" onClick={() => void install()}>Install app</Button>}
    </div>
  );
}
