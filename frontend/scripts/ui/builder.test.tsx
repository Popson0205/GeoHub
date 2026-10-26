import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><body><div id=root></div></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
for (const k of ["window", "document", "navigator", "localStorage", "HTMLElement", "Node", "KeyboardEvent", "Event", "MouseEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"])
  try { Object.defineProperty(globalThis, k, { value: (dom.window as any)[k], configurable: true, writable: true }); } catch { /* read-only */ }
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).confirm = () => true; (dom.window as any).confirm = () => true;
const ok = (c: boolean, m: string) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };

// The form builder: fields are arranged by dragging (here with the keyboard, which uses the same move rules as the mouse),
// and the old Move up / Move down buttons are gone.
(async () => {
  const React = (await import("react")).default;
  const { render, screen, fireEvent, act } = await import("@testing-library/react");
  const { MemoryRouter, Route, Routes } = await import("react-router-dom");
  const { ToastProvider, ConfirmProvider } = await import("../../src/components/ui");
  const { AuthProvider } = await import("../../src/lib/auth");
  const { loadApi } = await import("../../src/lib/api");
  const { default: Builder } = await import("../../src/pages/BuilderPage");

  const api: any = await loadApi();
  await api.login("demo@geohub.test", "demo");
  const wait = (ms = 300) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
  render(
    <MemoryRouter initialEntries={["/collect/p1/forms/f1"]}><AuthProvider><ToastProvider><ConfirmProvider>
      <Routes><Route path="/collect/:projectId/forms/:formId" element={<Builder />} /></Routes>
    </ConfirmProvider></ToastProvider></AuthProvider></MemoryRouter>);
  await screen.findByText("Health facility", {}, { timeout: 4000 }).catch(() => undefined);
  await wait(500);

  const names = () => Array.from(document.querySelectorAll(".field-card strong")).map((e) => e.textContent ?? "");
  const said = () => document.querySelector('[role="status"][aria-live="assertive"]')?.textContent ?? "";
  const grip = (label: string) => screen.getByRole("button", { name: `Reorder ${label}` });
  const key = async (el: Element, k: string) => { await act(async () => { fireEvent.keyDown(el, { key: k }); }); };
  const start = names();

  ok(start.length >= 6, `the form lists its fields (${start.length})`);
  ok(screen.getAllByRole("button", { name: /^Reorder / }).length === start.length, "every field has a grip to drag it by");

  // ---- the buttons are gone ----
  await act(async () => { fireEvent.click(document.querySelector(".field-card")!); });
  ok(!screen.queryByRole("button", { name: /Move up|Move down/ }) && !!screen.getByText(/Drag this field by its grip/), "no Move up or Move down buttons; the settings point to the grip instead");

  // ---- keyboard: pick up, move, drop ----
  await key(grip("Type"), " ");
  ok(/Picked up “Type”/.test(said()), "Space picks a field up and says so");
  ok(document.querySelectorAll(".is-moving").length === 1, "the field being moved is marked");
  await key(grip("Type"), "ArrowDown"); await key(grip("Type"), "ArrowDown");
  ok(/position 4 of/.test(said()), `arrow keys move the drop position and announce it (“${said()}”)`);
  ok(!!document.querySelector(".drop-line"), "a drop line shows where it will land");
  await key(grip("Type"), " ");
  const moved = names();
  ok(moved.indexOf("Type") === 3 && moved.length === start.length && /Moved “Type”/.test(said()), `Space drops it: Type is now 4th (${moved.slice(0, 5).join(", ")})`);
  ok(!document.querySelector(".drop-line") && !document.querySelector(".is-moving"), "the line and the marker go away after the drop");

  // ---- Escape cancels ----
  const before = names().join("|");
  await key(grip("Name"), " "); await key(grip("Name"), "ArrowDown"); await key(grip("Name"), "ArrowDown");
  await key(grip("Name"), "Escape");
  ok(names().join("|") === before && /cancelled/.test(said()), "Escape cancels the move and leaves the order alone");

  // ---- it stops at the ends ----
  const last = names()[names().length - 1];
  await key(grip(last), " "); await key(grip(last), "ArrowDown");
  ok(/can't move any further/.test(said()), "moving past the end says it can't go further");
  await key(grip(last), "Escape");
  const first = names()[0];
  await key(grip(first), " "); await key(grip(first), "ArrowUp");
  ok(/can't move any further/.test(said()), "…and so does the top");
  await key(grip(first), "Escape");

  // ---- into a group, with the keyboard ----
  await act(async () => { fireEvent.click(document.querySelector(".field-card")!); });   // select a plain field so the new group lands at the top level
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Group / Section" })); });
  const group = names()[names().length - 1];
  ok(/group/i.test(group), `a group was added (${group})`);
  await key(grip(names()[0]), " ");
  let landedInside = false;
  for (let i = 0; i < 20 && !landedInside; i++) { await key(grip(names()[0]), "ArrowDown"); landedInside = /Inside “/.test(said()); }
  ok(landedInside, `moving down reaches a slot inside the group (“${said()}”)`);
  const name0 = names()[0];
  await key(grip(name0), " ");
  const inside = Array.from(document.querySelectorAll(".tree-kids .field-card strong")).map((e) => e.textContent);
  ok(inside.includes(name0) && !names().slice(0, 1).includes(name0), `the field is now inside the group (${name0})`);

  // ---- clicking a palette item still adds a field ----
  const n = names().length;
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Date" })); });
  ok(names().length === n + 1, "clicking a field type in the palette still adds it");
})();
