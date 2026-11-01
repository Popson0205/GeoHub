// The first-run guide: which step is next, and that it goes away once data arrives.
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><body><div id=root></div></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
for (const k of ["window", "document", "navigator", "localStorage", "HTMLElement", "Node", "KeyboardEvent", "Event", "MouseEvent", "getComputedStyle"])
  try { Object.defineProperty(globalThis, k, { value: (dom.window as any)[k], configurable: true, writable: true }); } catch { /* read-only */ }
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const ok = (c: boolean, m: string) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };

(async () => {
  const { render, screen, cleanup } = await import("@testing-library/react");
  const { MemoryRouter } = await import("react-router-dom");
  const { default: GettingStarted, gettingStartedSteps } = await import("../../src/components/GettingStarted");
  const project = (over: any = {}) => ({ id: "p", name: "Water points", role: "owner", feature_count: 0, collector_count: 1, updated_at: "", ...over });
  const form = (over: any = {}) => ({ id: "f", project_id: "p", name: "Water point", geometry_type: "Point", version: 0, status: "draft", fields: [], ...over });
  const show = (steps: any) => render(<MemoryRouter><GettingStarted steps={steps} onHide={() => {}} /></MemoryRouter>);
  const next = () => screen.getAllByRole("link")[0];

  let s = gettingStartedSteps([], []);
  ok(s.every((x) => !x.done), "someone new has nothing done");
  show(s);
  ok(/0 of 4 done/.test(document.body.textContent ?? "") && next().getAttribute("href") === "/collect?new=1" && screen.getAllByRole("link").length === 1, "the only button is the next step: create a project");
  cleanup();

  s = gettingStartedSteps([project() as any], [form() as any]);
  show(s);
  ok(s[0].done && !s[1].done && next().textContent === "Finish the form" && next().getAttribute("href") === "/collect/p/forms/f", "with a project and a draft form, the next step opens that form");
  cleanup();

  s = gettingStartedSteps([project() as any], [form({ version: 1, status: "published" }) as any]);
  show(s);
  ok(s[1].done && next().getAttribute("href") === "/collect/p/forms/f/share", "once the form is published, the next step is sharing it");
  cleanup();

  s = gettingStartedSteps([project({ collector_count: 3 }) as any], [form({ version: 1 }) as any]);
  ok(s[2].done && !s[3].done && s[3].to === "/collect/p", "with collectors added, what is left is the first record, from the collector");
  s = gettingStartedSteps([project({ feature_count: 2 }) as any], [form({ version: 1 }) as any]);
  ok(s.every((x) => x.done), "the first record completes the guide, so the home page stops showing it");
  s = gettingStartedSteps([project({ role: "collector", feature_count: 0 }) as any], []);
  ok(!s[0].done, "being a collector on someone else's project does not count as creating one");
})();
