// Branding (logo, colour, email sender) and publishing to "your organization only".
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><head></head><body><div id=root></div></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
for (const k of ["window", "document", "navigator", "localStorage", "HTMLElement", "Node", "KeyboardEvent", "Event", "MouseEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "File", "FileReader", "Blob"])
  try { Object.defineProperty(globalThis, k, { value: (dom.window as any)[k], configurable: true, writable: true }); } catch { /* read-only */ }
(dom.window as any).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const ok = (c: boolean, m: string) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };

(async () => {
  const { render, screen, fireEvent, act, within, cleanup } = await import("@testing-library/react");
  const { MemoryRouter, Route, Routes } = await import("react-router-dom");
  const { ToastProvider, ConfirmProvider } = await import("../../src/components/ui");
  const { AuthProvider } = await import("../../src/lib/auth");
  const { loadApi } = await import("../../src/lib/api");
  const brand = await import("../../src/lib/brand");
  const { default: OrgSettingsPage } = await import("../../src/pages/OrgSettingsPage");
  const { PublishPanel } = await import("../../src/pages/ProjectsPage");
  const api: any = await loadApi();
  const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 400)); });
  const text = () => document.body.textContent ?? "";

  const y = brand.readable("#ffd400");
  ok(y !== "#ffd400" && brand.contrast(brand.parseHex(y)!, [255, 255, 255]) >= 4.5, "a light colour is darkened until white text on it reads");
  ok(brand.readable("#0b5cad") === "#0b5cad", "a colour that already reads is kept");
  const p = brand.palette("#c81e1e")!;
  ok(brand.contrast(brand.parseHex(p.dark["--green-700"])!, [18, 22, 20]) >= 4.5, "in dark mode, link text made from the colour still reads");
  brand.applyBrand({ color: "#c81e1e", logo_url: null });
  const style = document.getElementById("org-brand")?.textContent ?? "";
  ok(/--green-600:#c81e1e/.test(style) && /data-theme="dark"/.test(style), "the colour replaces the brand green, for light and dark themes");
  brand.applyBrand(null);
  ok(!document.getElementById("org-brand"), "and goes away with no brand");

  await api.login("demo@geohub.test", "demo");
  const mount = () => render(<MemoryRouter initialEntries={["/settings/organization"]}><AuthProvider><ToastProvider><ConfirmProvider>
    <Routes><Route path="/settings/organization" element={<OrgSettingsPage />} /></Routes>
  </ConfirmProvider></ToastProvider></AuthProvider></MemoryRouter>);
  mount();
  await screen.findByRole("heading", { name: "Branding" }, { timeout: 4000 });
  const card = () => within(screen.getByRole("heading", { name: "Branding" }).closest("section") as HTMLElement);
  fireEvent.change(card().getByLabelText("Colour"), { target: { value: "zzz" } });
  ok(/Use a colour like/.test(text()), "a colour that is not one says so");
  fireEvent.change(card().getByLabelText("Colour"), { target: { value: "#ffd400" } });
  ok(new RegExp(`Darkened to ${y}`).test(text()), "the preview says when the colour will be darkened, and to what");
  fireEvent.change(card().getByLabelText("Emails come from"), { target: { value: "Osogbo Field Team" } });
  fireEvent.change(card().getByLabelText(/Replies go to/), { target: { value: "help@osogbo.example.com" } });
  await act(async () => { fireEvent.click(card().getByRole("button", { name: "Save branding" })); });
  await settle(); await settle();
  const saved = api.s.org.branding;
  ok(saved.color === y && saved.sender_name === "Osogbo Field Team" && saved.reply_to === "help@osogbo.example.com", "colour, sender name and reply-to are saved");
  ok((document.getElementById("org-brand")?.textContent ?? "").includes(`--green-600:${y}`), "and the app takes on the colour at once");

  const logo = new File([new Uint8Array([137, 80, 78, 71])], "logo.png", { type: "image/png" });
  await act(async () => { fireEvent.change(document.getElementById("brand-logo")!, { target: { files: [logo] } }); });
  await settle(); await settle();
  ok(!!card().getByRole("img", { name: "Osogbo Field Team logo" }) && !!card().getByRole("button", { name: "Replace logo" }), "a logo can be uploaded");
  const svg = new File(["<svg/>"], "logo.svg", { type: "image/svg+xml" });
  await act(async () => { fireEvent.change(document.getElementById("brand-logo")!, { target: { files: [svg] } }); });
  await settle();
  ok(/PNG, JPEG or WebP/.test(card().getByRole("alert").textContent ?? ""), "other files are refused");
  await act(async () => { fireEvent.click(card().getByRole("button", { name: "Remove" })); });
  await settle();
  ok(!api.s.org.branding.logo_url && !!card().getByText("No logo"), "and removed");
  cleanup();

  // publishing to the organization only
  render(<MemoryRouter><AuthProvider><ToastProvider><PublishPanel project={api.s.projects[0]} onClose={() => {}} /></ToastProvider></AuthProvider></MemoryRouter>);
  await settle(); await settle();
  const who = screen.getByLabelText("Who can see it") as HTMLSelectElement;
  ok([...who.options].some((o) => o.text === "Everyone in Osogbo Field Team"), "Organization plans can publish to everyone in the organization");
  fireEvent.change(screen.getByLabelText("Licence"), { target: { value: "Private" } });
  ok([...who.options].find((o) => o.value === "public")!.disabled && who.value === "private", "a Private licence is never public");
  fireEvent.change(who, { target: { value: "organization" } });
  ok(/Only people signed in to your organization/.test(text()), "and says who will see it");
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Publish" })); });
  await settle(); await settle();
  ok(api.s.datasets.some((d: any) => d.visibility === "organization" && d.license === "Private"), "the dataset is published for the organization only");
  process.exit();
})();
