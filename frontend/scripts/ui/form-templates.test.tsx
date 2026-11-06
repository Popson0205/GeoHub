// Starting a form from a ready-made template (Land Registry's plot enumeration).
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><body><div id=root></div></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
for (const k of ["window", "document", "navigator", "localStorage", "HTMLElement", "Node", "KeyboardEvent", "Event", "MouseEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"])
  try { Object.defineProperty(globalThis, k, { value: (dom.window as any)[k], configurable: true, writable: true }); } catch { /* read-only */ }
(dom.window as any).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const ok = (c: boolean, m: string) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };

(async () => {
  const { render, screen, fireEvent, act } = await import("@testing-library/react");
  const { MemoryRouter, Route, Routes } = await import("react-router-dom");
  const { AuthProvider } = await import("../../src/lib/auth");
  const { ToastProvider } = await import("../../src/components/ui");
  const { loadApi } = await import("../../src/lib/api");
  const { default: FormsPage } = await import("../../src/pages/FormsPage");
  const api: any = await loadApi();
  await api.login("demo@geohub.test", "demo");
  const project = (await api.listProjects())[0];
  const until = async (cond: () => boolean, ms = 4000) => { for (let t = 0; t < ms && !cond(); t += 100) await act(async () => { await new Promise((r) => setTimeout(r, 100)); }); };
  let made: any[] = [];
  const real = api.createForm.bind(api);
  api.createForm = async (...a: any[]) => { made.push(a); return real(...a); };

  render(<MemoryRouter initialEntries={[`/collect/${project.id}/forms`]}><AuthProvider><ToastProvider>
    <Routes><Route path="/collect/:projectId/forms" element={<FormsPage />} /><Route path="/collect/:projectId/forms/:formId" element={<p>builder</p>} /></Routes>
  </ToastProvider></AuthProvider></MemoryRouter>);
  await until(() => !!screen.queryByRole("button", { name: /New form/ }));
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /New form/ })); });
  await until(() => !!screen.queryByText("Plot enumeration"));
  ok(!!screen.queryByText("For Land Registry"), "the land template is offered, marked for Land Registry");
  await act(async () => { fireEvent.click(screen.getByLabelText(/Plot enumeration/)); });
  ok(!screen.queryByLabelText("What do collectors capture?"), "a template brings its own shape (an area)");
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Create and open builder" })); });
  await until(() => !!screen.queryByText("builder"));
  ok(made.length === 1 && made[0][1] === "Plot enumeration" && made[0][3] === "land_enumeration", "an empty name takes the template's, and the template is sent");
  const f = (await api.listForms(project.id)).find((x: any) => x.template === "land_enumeration");
  ok(!!f && f.geometry_type === "Polygon" && f.fields.some((q: any) => q.id === "occupant_name"), "the new form maps areas and has the template's questions");
  process.exit();
})();
