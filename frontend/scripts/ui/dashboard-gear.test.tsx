import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><body><div id=root></div></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
for (const k of ["window", "document", "navigator", "localStorage", "HTMLElement", "Node", "KeyboardEvent", "Event", "MouseEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"])
  try { Object.defineProperty(globalThis, k, { value: (dom.window as any)[k], configurable: true, writable: true }); } catch { /* read-only */ }
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).confirm = () => true; (dom.window as any).confirm = () => true;
(dom.window as any).matchMedia = (dom.window as any).matchMedia ?? (() => ({ matches: true, addListener() {}, removeListener() {} }));
(dom.window as any).print = () => {};
for (const U of [dom.window.URL, globalThis.URL] as any[]) { U.createObjectURL = () => "blob:test"; U.revokeObjectURL = () => {}; }
const ok = (c: boolean, m: string) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };

// Clicking an element only highlights it. Its settings open from the gear button.
await (async () => {
  const React = (await import("react")).default;
  const { render, screen, fireEvent, act } = await import("@testing-library/react");
  const { MemoryRouter } = await import("react-router-dom");
  const { ToastProvider, ConfirmProvider } = await import("../../src/components/ui");
  const { DashboardView } = await import("../../src/pages/DashboardPage");
  const { starterWidgets } = await import("../../src/lib/dashboard");
  const form: any = { id: "f", project_id: "p", name: "Water point", geometry_type: "Point", version: 1, status: "published", fields: [
    { id: "type", label: "Type", type: "choice", choices: ["Well", "Tap"] }, { id: "depth", label: "Depth", type: "number", unit: "m" }] };
  const feats: any[] = Array.from({ length: 6 }, (_, i) => ({ id: `r${i}`, project_id: "p", form_id: "f", form_version: 1, geometry: { type: "Point", coordinates: [4, 7] }, properties: { type: i % 2 ? "Well" : "Tap", depth: 10 + i }, status: "approved", version: 1, updated_at: "2026-01-10T00:00:00Z" }));
  const dash: any = { id: "d", project_id: "p", name: "Overview", updated_at: "", config: { pages: [{ id: "main", title: "Overview", form_id: "f", widgets: starterWidgets(form).filter((w: any) => w.type !== "map") }] } };
  const click = async (el: Element) => { await act(async () => { fireEvent.click(el); }); };
  const panelOpen = () => document.querySelector(".dash-aside") !== null;

  const mount = (canEdit: boolean) => render(
    <MemoryRouter><ToastProvider><ConfirmProvider>
      <DashboardView projectId="p" dashboard={dash} forms={[form]} features={feats} canEdit={canEdit} onRefresh={() => {}} />
    </ConfirmProvider></ToastProvider></MemoryRouter>);

  const r = mount(true);
  const tiles = () => [...document.querySelectorAll<HTMLElement>(".widget")];
  const gears = () => screen.getAllByRole("button", { name: /^Settings for/ });
  ok(gears().length === tiles().length && tiles().length > 1, "in edit mode every element has a gear button");
  ok(!panelOpen(), "no settings are open to begin with");

  await click(tiles()[0]);
  ok(tiles()[0].classList.contains("is-selected") && !panelOpen(), "clicking an element highlights it but does not open its settings");
  await click(tiles()[1].querySelector(".widget-body")!);
  ok(tiles()[1].classList.contains("is-selected") && !panelOpen(), "clicking inside an element does not open its settings either");

  await click(gears()[0]);
  ok(panelOpen() && gears()[0].getAttribute("aria-expanded") === "true", "the gear button opens the settings");
  ok(!!document.querySelector(".dset-head") && !!document.querySelector(".dset-foot") && document.querySelectorAll(".dset-sec").length === 3, "the panel has a header, three sections and a footer");
  const titleOf = () => document.querySelector(".dset-titles h2")?.textContent;
  const first = titleOf();

  await click(tiles()[2]);
  ok(panelOpen() && titleOf() !== first, "with the panel open, clicking another element switches it to that element");

  await act(async () => { fireEvent.keyDown(document.querySelector(".dash-aside")!, { key: "Escape" }); });
  ok(!panelOpen(), "Escape closes the settings");
  ok(tiles()[2].classList.contains("is-selected"), "the element stays highlighted after the panel closes");

  await click(gears()[1]); await click(screen.getByRole("button", { name: "Done" }));
  ok(!panelOpen(), "Done closes the settings");
  await click(gears()[1]); await click(screen.getByRole("button", { name: "Close settings" }));
  ok(!panelOpen(), "the close button closes the settings");

  await click(gears()[0]);
  await click(document.querySelector(".dash-stage")!);
  ok(!panelOpen() && !document.querySelector(".widget.is-selected"), "clicking empty canvas clears the highlight and closes the panel");
  r.unmount();

  mount(false);
  ok(screen.queryAllByRole("button", { name: /^Settings for/ }).length === 0, "viewers get no gear button");
})();
