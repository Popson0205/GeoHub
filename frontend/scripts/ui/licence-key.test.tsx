// On a customer's own installation: the licence key in force, and installing the next one.
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><body><div id=root></div></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
for (const k of ["window", "document", "navigator", "localStorage", "HTMLElement", "Node", "KeyboardEvent", "Event", "MouseEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"])
  try { Object.defineProperty(globalThis, k, { value: (dom.window as any)[k], configurable: true, writable: true }); } catch { /* read-only */ }
(dom.window as any).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const ok = (c: boolean, m: string) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };

(async () => {
  const { render, screen, fireEvent, act, cleanup } = await import("@testing-library/react");
  const { ToastProvider } = await import("../../src/components/ui");
  const { loadApi, ApiError } = await import("../../src/lib/api");
  const { default: LicenceKeyCard } = await import("../../src/components/LicenceKeyCard");
  const api: any = await loadApi();
  const text = () => document.body.textContent ?? "";
  const until = async (cond: () => boolean, ms = 4000) => { for (let t = 0; t < ms && !cond(); t += 100) await act(async () => { await new Promise((r) => setTimeout(r, 100)); }); };

  render(<ToastProvider><LicenceKeyCard canInstall onInstalled={() => {}} /></ToastProvider>);
  await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
  ok(!screen.queryByRole("heading", { name: "Licence key" }), "on GeoEstate's own Geohub there is no licence key to manage");
  cleanup();

  const site = "https://geohub.lands.example.gov.ng";
  const key = { id: "k1", customer: "Lands Bureau", installation: site, issued_at: "2026-11-05T10:00:00Z", note: null, installed_at: "2026-11-05T10:05:00Z",
    products: [{ product: "hub", name: "Geohub", plan_name: "Organization Advanced", starts: "2026-11-05", ends: "2027-11-04" },
      { product: "land", name: "Land Registry", plan_name: "Land Registry Advanced", starts: "2026-11-05", ends: "2027-11-04" }] };
  let installed: any = null;
  api.orgLicenceKey = async () => ({ required: true, installed, can_check: true, installation: site });
  api.installLicenceKey = async (k: string) => {
    if (!k.startsWith("GEOESTATE-LICENCE-1.")) throw new ApiError(422, "That is not a GeoEstate licence key. Paste the whole key, from GEOESTATE-LICENCE-1 to its end.");
    installed = key; return { required: true, installed, can_check: true, installation: site };
  };
  let done = 0;
  render(<ToastProvider><LicenceKeyCard canInstall onInstalled={() => { done++; }} /></ToastProvider>);
  await until(() => /No licence key is installed/.test(text()));
  ok(/read-only until a key is installed/.test(text()) && /For https:\/\/geohub\.lands\.example\.gov\.ng/.test(text()), "without a key, the grace period and its end are explained");
  fireEvent.change(screen.getByLabelText("Paste the key from GeoEstate"), { target: { value: "hello" } });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Install the key" })); });
  await until(() => /not a GeoEstate licence key/.test(text()));
  ok(/not a GeoEstate licence key/.test(text()) && done === 0, "something that is not a key is refused, plainly");
  fireEvent.change(screen.getByLabelText("Paste the key from GeoEstate"), { target: { value: "GEOESTATE-LICENCE-1.abc.def" } });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Install the key" })); });
  await until(() => /Issued to/.test(text()));
  ok(/Issued to Lands Bureau/.test(text()) && /Land Registry Advanced until/.test(text()) && done === 1 && !!screen.getByLabelText("Install a new key (a renewal)"),
    "a key is installed, with what it gives and until when; the next one renews it");
  cleanup();

  render(<ToastProvider><LicenceKeyCard canInstall={false} onInstalled={() => {}} /></ToastProvider>);
  await until(() => /Issued to/.test(text()));
  ok(!screen.queryByRole("button", { name: "Install the key" }) && /owners and administrators install/.test(text()), "only owners and administrators install keys");
  process.exit();
})();
