// The GeoEstate app switcher in Geohub's top bar: the organization's products, one click away.
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><body><div id=root></div></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
for (const k of ["window", "document", "navigator", "localStorage", "HTMLElement", "Node", "KeyboardEvent", "Event", "MouseEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"])
  try { Object.defineProperty(globalThis, k, { value: (dom.window as any)[k], configurable: true, writable: true }); } catch { /* read-only */ }
(dom.window as any).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const ok = (c: boolean, m: string) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };

(async () => {
  const { render, screen, fireEvent, act, within, cleanup } = await import("@testing-library/react");
  const { MemoryRouter } = await import("react-router-dom");
  const { AuthProvider } = await import("../../src/lib/auth");
  const { loadApi } = await import("../../src/lib/api");
  const { default: AppSwitcher } = await import("../../src/components/AppSwitcher");
  const api: any = await loadApi();
  await api.login("demo@geohub.test", "demo");
  const until = async (cond: () => boolean, ms = 4000) => { for (let t = 0; t < ms && !cond(); t += 100) await act(async () => { await new Promise((r) => setTimeout(r, 100)); }); };
  const show = () => render(<MemoryRouter><AuthProvider><AppSwitcher /></AuthProvider></MemoryRouter>);

  const base = api.orgProducts.bind(api);
  const hub = (await base())[0];
  api.orgProducts = async () => [hub];
  show();
  await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
  ok(!screen.queryByRole("button", { name: "GeoEstate apps" }), "with Geohub alone there is nothing to switch to");
  cleanup();

  api.orgProducts = async () => [hub,
    { ...hub, product: "land", name: "Land Registry", status: "active", url: "https://land.example" },
    { ...hub, product: "farm", name: "FarmScan", status: "demo", url: null }];
  show();
  await until(() => !!screen.queryByRole("button", { name: "GeoEstate apps" }));
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "GeoEstate apps" })); });
  const menu = within(screen.getByRole("menu", { name: "GeoEstate apps" }));
  const items = menu.getAllByRole("menuitem");
  ok(items.length === 3 && /You are here/.test(items[0].textContent ?? "") && items[0].getAttribute("aria-current") === "page", "Geohub is listed as where you are");
  ok(items[1].tagName === "A" && items[1].getAttribute("href") === "https://land.example" && /Parcels, titles/.test(items[1].textContent ?? ""), "Land Registry opens its own app");
  ok(items[2].getAttribute("aria-disabled") === "true" && /Demo/.test(items[2].textContent ?? ""), "a product without an address yet is shown but not opened, with its demo badge");
  await act(async () => { fireEvent.keyDown(window, { key: "Escape" }); });
  ok(!screen.queryByRole("menu"), "Escape closes it");
  process.exit();
})();
