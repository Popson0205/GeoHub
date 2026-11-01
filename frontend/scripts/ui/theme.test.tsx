// Appearance: Auto follows the device; Light and Dark are remembered in this browser.
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><body><div id=root></div></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
for (const k of ["window", "document", "navigator", "localStorage", "HTMLElement", "Node", "KeyboardEvent", "Event", "MouseEvent", "getComputedStyle"])
  try { Object.defineProperty(globalThis, k, { value: (dom.window as any)[k], configurable: true, writable: true }); } catch { /* read-only */ }
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const ok = (c: boolean, m: string) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };

(async () => {
  const { render, screen, fireEvent, act } = await import("@testing-library/react");
  const { MemoryRouter, Route, Routes } = await import("react-router-dom");
  const { AuthProvider } = await import("../../src/lib/auth");
  const { loadApi } = await import("../../src/lib/api");
  const { getTheme } = await import("../../src/lib/theme");
  const { default: Shell } = await import("../../src/components/Shell");
  const root = document.documentElement;
  ok(getTheme() === "system" && !root.hasAttribute("data-theme"), "by default the app follows the device setting");

  const api: any = await loadApi();
  await api.login("demo@geohub.test", "demo");
  render(<MemoryRouter><AuthProvider><Routes><Route element={<Shell />}><Route index element={<p>page</p>} /></Route></Routes></AuthProvider></MemoryRouter>);
  const menu = await screen.findByRole("button", { name: /account menu/ }, { timeout: 4000 });
  await act(async () => { fireEvent.click(menu); });
  const choice = (n: string) => screen.getByRole("menuitemradio", { name: n });
  ok(choice("Auto").getAttribute("aria-checked") === "true", "the account menu shows Appearance with Auto chosen");

  await act(async () => { fireEvent.click(choice("Dark")); });
  ok(root.getAttribute("data-theme") === "dark" && localStorage.getItem("geohub.theme") === "dark" && choice("Dark").getAttribute("aria-checked") === "true", "Dark switches the page at once and is remembered");
  await act(async () => { fireEvent.click(choice("Light")); });
  ok(root.getAttribute("data-theme") === "light" && getTheme() === "light", "Light overrides a dark device");
  await act(async () => { fireEvent.click(choice("Auto")); });
  ok(!root.hasAttribute("data-theme") && localStorage.getItem("geohub.theme") === null, "Auto goes back to following the device");
})();
