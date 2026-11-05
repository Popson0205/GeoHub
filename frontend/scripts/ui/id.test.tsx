// GeoEstate ID: another GeoEstate app sends someone to Geohub's /id/authorize; signed in, they go straight back with a
// one-time code, or are told plainly why not.
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><body><div id=root></div></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
for (const k of ["window", "document", "navigator", "localStorage", "sessionStorage", "HTMLElement", "Node", "KeyboardEvent", "Event", "MouseEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"])
  try { Object.defineProperty(globalThis, k, { value: (dom.window as any)[k], configurable: true, writable: true }); } catch { /* read-only */ }
(dom.window as any).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const ok = (c: boolean, m: string) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };

(async () => {
  const { render, screen, act, cleanup } = await import("@testing-library/react");
  const { MemoryRouter, Route, Routes } = await import("react-router-dom");
  const { ToastProvider, ConfirmProvider } = await import("../../src/components/ui");
  const { AuthProvider, RequireAuth } = await import("../../src/lib/auth");
  const { loadApi } = await import("../../src/lib/api");
  const { default: IdAuthorizePage, leave } = await import("../../src/pages/IdAuthorizePage");
  const api: any = await loadApi();
  const text = () => document.body.textContent ?? "";
  const until = async (cond: () => boolean, ms = 5000) => { for (let t = 0; t < ms && !cond(); t += 100) await act(async () => { await new Promise((r) => setTimeout(r, 100)); }); };
  const went: string[] = [];
  leave.to = (u: string) => { went.push(u); };
  const open = (q: string) => {
    dom.reconfigure({ url: `http://localhost/id/authorize?${q}` });
    return render(<MemoryRouter initialEntries={[`/id/authorize?${q}`]}><AuthProvider><ToastProvider><ConfirmProvider><Routes>
      <Route path="/id/authorize" element={<RequireAuth><IdAuthorizePage /></RequireAuth>} />
      <Route path="/login" element={<p>The sign-in page</p>} />
    </Routes></ConfirmProvider></ToastProvider></AuthProvider></MemoryRouter>);
  };

  open("client_id=land&redirect_uri=https%3A%2F%2Fland.example%2Fcb&state=abc");
  await until(() => /The sign-in page/.test(text()));
  ok(/The sign-in page/.test(text()) && went.length === 0, "someone not signed in to Geohub signs in first");
  cleanup();

  await api.login("demo@geohub.test", "demo");
  open("client_id=land&redirect_uri=https%3A%2F%2Fland.example%2Fcb&state=abc&code_challenge=x");
  await until(() => went.length > 0);
  ok(went[0] === "https://land.example/cb?code=demo-code&state=abc", "someone signed in goes straight back to the app with a code and its state");
  cleanup();

  open("client_id=gold&redirect_uri=https%3A%2F%2Fevil.example%2Fcb");
  await until(() => /not right/.test(text()));
  ok(/This sign-in link is not right/.test(text()) && /not registered/.test(text()) && went.length === 1, "an unknown app gets no code, and the page says why");
  cleanup();

  api.me_ = ((orig: any) => () => ({ ...orig(), platform_admin: false }))(api.me_.bind(api));
  open("client_id=farm&redirect_uri=https%3A%2F%2Ffarm.example%2Fcb");
  await until(() => /Not part of/.test(text()));
  ok(/Not part of your organization's plan/.test(text()) && /does not have FarmScan/.test(text()) && /month's demo/.test(text()) && went.length === 1,
    "an organization without the product is told how to get it");
  process.exit();
})();
