import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><body><div id=root></div></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
for (const k of ["window", "document", "navigator", "localStorage", "HTMLElement", "Node", "KeyboardEvent", "Event", "MouseEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
  try { Object.defineProperty(globalThis, k, { value: (dom.window as any)[k], configurable: true, writable: true }); } catch { /* read-only */ }
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).confirm = () => true; (dom.window as any).confirm = () => true;
const ok = (c: boolean, m: string) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };

(async () => {
  const { render, screen, fireEvent, act, cleanup, within } = await import("@testing-library/react");
  const { MemoryRouter, Route, Routes } = await import("react-router-dom");
  const { ToastProvider } = await import("../../src/components/ui");
  const { AuthProvider } = await import("../../src/lib/auth");
  const { loadApi } = await import("../../src/lib/api");
  const { probe } = await import("./FakeMapView");
  const { default: Editor } = await import("../../src/pages/MapEditorPage");
  const api: any = await loadApi();
  await api.login("demo@geohub.test", "demo");
  const wait = (ms = 300) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
  const p = () => probe.props;
  const click = async (name: RegExp | string, i = 0) => { await act(async () => { fireEvent.click(screen.getAllByRole("button", { name })[i]); }); };
  const open = async (id: string) => { render(<MemoryRouter initialEntries={[`/maps/${id}`]}><AuthProvider><ToastProvider><Routes><Route path="/maps/:mapId" element={<Editor />} /></Routes></ToastProvider></AuthProvider></MemoryRouter>); await screen.findByText(/saved feature/); await wait(); };
  const poly = (x: number) => ({ type: "Polygon", coordinates: [[[x, 7], [x + 0.01, 7], [x + 0.01, 7.01], [x, 7.01], [x, 7]]] });

  const maps = await api.listMaps();
  const mid = maps.find((m: any) => m.name.includes("mapathon")).id;

  // ---- owner: stage several, save once; owner's own work is approved straight away ----
  const before = (await api.listMapFeatures(mid)).length;
  await open(mid);
  ok(p().features.some((f: any) => f.state === "review") && p().features.some((f: any) => f.state === "rejected"), "features waiting for review (purple) and rejected (red) are coloured apart");
  await click(/^Polygon$/);
  // every tool is a symbol with a short visible caption, plus a full name for screen readers and a tooltip. The caption must be part of the name.
  const toolbar = screen.getByRole("toolbar", { name: "Editing tools" });
  const btns = within(toolbar).getAllByRole("button");
  ok(btns.length >= 6 && btns.every((b) => { const cap = (b.textContent ?? "").trim(); return cap.length > 0 && !!b.querySelector("svg") && !!b.getAttribute("title") && (b.getAttribute("aria-label") ?? "").toLowerCase().includes(cap.toLowerCase()); }), "editing tools are symbols with a visible caption, a full name and a tooltip");
  ok(["Select", "Reshape", "Move", "Split", "Cut", "Merge"].every((n) => !!within(toolbar).queryByRole("button", { name: n })), "every editing tool is still reachable by name");
  ok(within(screen.getByRole("toolbar", { name: "Drawing tools" })).getByRole("button", { name: "Polygon" }).getAttribute("title") === "Polygon (G)", "the polygon tool shows its shortcut");
  for (let i = 0; i < 2; i++) await act(async () => { p().onDraw(poly(4 + i * 0.1)); });
  ok(p().drawMode === "Polygon", "owner: draw tool stays on");
  await click(/^Save all/, 0); await wait(600);
  const after = await api.listMapFeatures(mid);
  ok(after.length === before + 2 && after.slice(-2).every((f: any) => f.status === "approved" && f.author === "Demo Collector"), "owner: two features saved at once, approved and attributed");
  ok(!!screen.queryByText(/Campaign portal/), "the editor links to the campaign portal");
  cleanup();

  // ---- attribute table (owner) ----
  await open(mid);
  ok(!screen.queryByRole("grid"), "the table starts closed");
  await click(/^Table \(/);
  const grid = screen.getByRole("grid");
  const total = p().features.length;
  ok(grid.getAttribute("aria-rowcount") === String(total + 1), `table has a row for every feature (${total})`);
  const rowEl = (i: number) => screen.getAllByRole("row").find((r) => r.getAttribute("aria-rowindex") === String(i + 2))!;
  const firstId = p().features[0].id;
  const cellInput = (i: number, col: string) => within(rowEl(i)).getByLabelText(new RegExp(`^${col} of `)) as HTMLInputElement;

  // edit a value in place: staged, undoable, and the map gets the new tags
  const was = p().features[0].properties.building;
  await act(async () => { fireEvent.change(cellInput(0, "building"), { target: { value: "school" } }); });
  await act(async () => { fireEvent.blur(cellInput(0, "building")); });
  ok(p().features[0].properties.building === "school" && !!screen.queryAllByText(/1 edited/).length, "editing a cell stages the change (nothing saved yet)");
  await act(async () => { fireEvent.change(cellInput(0, "building"), { target: { value: "church" } }); fireEvent.blur(cellInput(0, "building")); });
  await click(/Undo/, 0);
  ok(p().features[0].properties.building === was, "undo takes the whole cell edit back");
  await click(/Redo/);
  await click(/Undo/, 0);

  // clearing a cell removes the tag
  await act(async () => { fireEvent.change(cellInput(1, "building"), { target: { value: "" } }); fireEvent.blur(cellInput(1, "building")); });
  ok(!("building" in p().features[1].properties), "emptying a cell removes that tag");
  await click(/Undo/, 0);

  // selecting: table -> map, map -> table, range
  await act(async () => { fireEvent.click(within(rowEl(2)).getByText("Polygon")); });
  ok(p().selectedIds.length === 1 && p().selectedIds[0] === p().features[2].id, "clicking a row selects that feature on the map");
  await act(async () => { fireEvent.click(within(rowEl(5)).getByText("Polygon"), { shiftKey: true }); });
  ok(p().selectedIds.length === 4, "shift-click selects a range of rows");
  await act(async () => { p().onSelect(p().features[7].id, false); });
  ok(rowEl(7).getAttribute("aria-selected") === "true", "picking a feature on the map highlights its row");

  // set a value for many rows at once
  await act(async () => { fireEvent.click(within(rowEl(2)).getByText("Polygon")); fireEvent.click(within(rowEl(4)).getByText("Polygon"), { shiftKey: true }); });
  await act(async () => { fireEvent.change(screen.getByLabelText("Column to fill"), { target: { value: "source" } }); fireEvent.change(screen.getByLabelText("Value to set"), { target: { value: "mapathon" } }); });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /^Apply to 3/ })); });
  ok(p().features.slice(2, 5).every((f: any) => f.properties.source === "mapathon") && !p().features[5].properties.source, "set-a-value fills exactly the selected rows");
  await act(async () => { fireEvent.change(screen.getByLabelText("New column name"), { target: { value: "checked_by" } }); });
  await click(/^Add column$/);
  ok(!!screen.queryByRole("columnheader", { name: /checked_by/ }), "a new column can be added before any feature has the tag");

  // search, kind filter, sort, unsaved-only
  await act(async () => { fireEvent.change(screen.getByLabelText("Search the table"), { target: { value: "house" } }); });
  const houses = p().features.filter((f: any) => Object.values(f.properties).some((v: any) => String(v).includes("house"))).length;
  ok(houses > 0 && screen.getByRole("grid").getAttribute("aria-rowcount") === String(houses + 1), `search narrows the table (${houses} rows)`);
  await act(async () => { fireEvent.change(screen.getByLabelText("Search the table"), { target: { value: "" } }); });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /^building/ })); });
  ok(cellInput(0, "building").value === "house", "sorting by a column puts the smallest value first");
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /^building/ })); });
  ok(cellInput(0, "building").value === "yes", "clicking again sorts the other way");
  await act(async () => { fireEvent.change(screen.getByLabelText("Which features to show"), { target: { value: "unsaved" } }); });
  ok(screen.getByRole("grid").getAttribute("aria-rowcount") === "4", "'Unsaved changes' shows only the 3 rows we filled");
  await click(/Discard/);
  await click(/Close the table/);
  ok(!screen.queryByRole("grid"), "the table closes");
  cleanup();

  // ---- make the demo user a contributor on this map (someone else owns it) ----
  const s = api.s;
  s.maps.find((m: any) => m.id === mid).owner_id = "u9"; s.maps.find((m: any) => m.id === mid).owner_name = "Tolu Adeleke";
  s.mapMembers.push({ map_id: mid, user_id: "u1", name: "Demo Collector", role: "contributor", joined_at: new Date().toISOString() });
  const others = (await api.listMapFeatures(mid)).find((f: any) => f.created_by === "u2" && f.status === "approved");
  const mine = (await api.listMapFeatures(mid)).find((f: any) => f.created_by === "u1");
  await open(mid);
  ok(!!screen.queryByText(/you are a contributor/), "contributor: the editor says what the person is");
  await act(async () => { p().onSelect(others.id, false); });
  ok(!!screen.queryByText(/approved this, so it is locked/) && !!screen.queryByText(/Drawn by Amina Bello/), "contributor: someone else's approved feature is shown as locked, with its author");
  const geomBefore = JSON.stringify(p().features.find((f: any) => f.id === others.id).geometry);
  await click(/^Move$/);
  await act(async () => { p().onMove([others.id], 0.5, 0.5); });
  ok(JSON.stringify(p().features.find((f: any) => f.id === others.id).geometry) === geomBefore && !screen.queryByText(/Unsaved changes/)?.textContent?.includes("1 edited"), "contributor: moving someone else's feature does nothing");
  ok((screen.getAllByRole("button", { name: /^Delete$/ }).every((b) => (b as HTMLButtonElement).disabled)), "contributor: Delete is disabled for it");
  await click(/^Table \(/);
  const locked = screen.getAllByRole("row").find((r) => r.getAttribute("aria-rowindex") === String(p().features.findIndex((f: any) => f.id === others.id) + 2));
  ok(!!locked && (within(locked).getAllByRole("textbox") as HTMLInputElement[]).every((i) => i.disabled), "contributor: someone else's approved feature is read-only in the table");
  await click(/Close the table/);
  await click(/^Select$/);
  await click(/^Polygon$/);
  await act(async () => { p().onDraw(poly(5)); });
  await click(/^Save all/, 0); await wait(600);
  const mine2 = (await api.listMapFeatures(mid)).filter((f: any) => f.created_by === "u1" && f.status === "submitted");
  ok(mine2.length >= 1, "contributor: a new feature is saved as waiting for review");
  void mine;
  cleanup();

  // ---- campaign over: contributors cannot draw ----
  s.maps.find((m: any) => m.id === mid).ends_at = new Date(Date.now() - 864e5).toISOString();
  await open(mid);
  await click(/^Polygon$/);
  ok(p().drawMode == null && !!screen.queryByText(/Contributors cannot draw right now/), "contributor: after the campaign ends the draw tools stay off and the page says why");
  process.exit(process.exitCode ?? 0);
})().catch((e) => { console.error("ERROR", e); process.exit(1); });
