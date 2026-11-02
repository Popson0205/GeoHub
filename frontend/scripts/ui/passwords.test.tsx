// Password pages: set from an emailed link, a bad link, forgot password, and a forced change after a temporary one.
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><body><div id=root></div></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
for (const k of ["window", "document", "navigator", "localStorage", "HTMLElement", "Node", "KeyboardEvent", "Event", "MouseEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"])
  try { Object.defineProperty(globalThis, k, { value: (dom.window as any)[k], configurable: true, writable: true }); } catch { /* read-only */ }
(dom.window as any).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const ok = (c: boolean, m: string) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };

(async () => {
  const { render, screen, fireEvent, act, cleanup } = await import("@testing-library/react");
  const { MemoryRouter, Route, Routes, useLocation } = await import("react-router-dom");
  const { ToastProvider } = await import("../../src/components/ui");
  const { AuthProvider, RequireAuth } = await import("../../src/lib/auth");
  const { loadApi, tokens } = await import("../../src/lib/api");
  const { SetPasswordPage, ForgotPasswordPage, ChangePasswordPage } = await import("../../src/pages/PasswordPages");
  const api: any = await loadApi();
  let path = "";
  function Where() { path = useLocation().pathname; return <p>home page</p>; }
  const mount = (at: string) => render(<MemoryRouter initialEntries={[at]}><AuthProvider><ToastProvider>
    <Routes>
      <Route path="/set-password" element={<SetPasswordPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/change-password" element={<RequireAuth><ChangePasswordPage /></RequireAuth>} />
      <Route path="/" element={<RequireAuth><Where /></RequireAuth>} />
      <Route path="/login" element={<p>login page</p>} />
    </Routes>
  </ToastProvider></AuthProvider></MemoryRouter>);
  const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 400)); });
  const text = () => document.body.textContent ?? "";

  mount("/set-password?token=nope");
  await settle();
  ok(/This link cannot be used/.test(text()) && /Get a new link/.test(text()), "a bad link says so and offers a new one");
  cleanup();

  mount("/set-password?token=demo-link");
  await screen.findByRole("heading", { name: /Welcome, Demo/ }, { timeout: 3000 });
  ok(/Your account in Osogbo Field Team is ready/.test(text()) && /demo@geohub.test/.test(text()), "the link greets the person by name and says which organization and email");
  fireEvent.change(screen.getByLabelText("New password"), { target: { value: "first-one-1" } });
  fireEvent.change(screen.getByLabelText("Type it again"), { target: { value: "second-one" } });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Set password/ })); });
  ok(/not the same/.test(text()), "two different passwords are caught before sending");
  fireEvent.change(screen.getByLabelText("Type it again"), { target: { value: "first-one-1" } });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Set password/ })); });
  await settle();
  ok(/home page/.test(text()) && !!tokens.get(), "setting the password signs them in and goes straight in");
  cleanup();

  mount("/forgot-password");
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "someone@example.com" } });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Send the link" })); });
  await settle();
  ok(/Check your email/.test(text()) && /If someone@example.com has a Geohub account/.test(text()) && /Spam and Promotions/.test(text()), "forgot password answers the same for any email, and says where to look");
  cleanup();

  // signed in with a temporary password: every page leads to choosing a new one
  const orig = api.me.bind(api);
  api.me = async () => ({ ...(await orig()), must_change_password: true });
  mount("/");
  await settle();
  ok(/Choose your own password/.test(text()) && /temporary password/.test(text()), "a temporary password must be changed before anything else");
  api.me = async () => ({ ...(await orig()), must_change_password: false });
  fireEvent.change(screen.getByLabelText("Temporary password"), { target: { value: "demo" } });
  fireEvent.change(screen.getByLabelText("New password"), { target: { value: "a-better-password" } });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save password" })); });
  await settle();
  ok(/home page/.test(text()), "once changed, they carry on");
})();
