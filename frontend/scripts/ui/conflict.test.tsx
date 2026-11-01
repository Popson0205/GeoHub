// A sync conflict: the collector sees only what differs, theirs beside yours, and can combine answers.
import "fake-indexeddb/auto";
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><body><div id=root></div></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
for (const k of ["window", "document", "localStorage", "HTMLElement", "Node", "Event", "MouseEvent", "getComputedStyle"])
  try { Object.defineProperty(globalThis, k, { value: (dom.window as any)[k], configurable: true, writable: true }); } catch { /* read-only */ }
Object.defineProperty(globalThis, "navigator", { value: { onLine: true, userAgent: "node" }, configurable: true });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const ok = (c: boolean, m: string) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };

(async () => {
  const { render, screen, fireEvent, act, within } = await import("@testing-library/react");
  const { loadApi } = await import("../../src/lib/api");
  const { db } = await import("../../src/lib/db");
  const { loadBundle, saveFeatureLocal, syncProject, resolveConflict } = await import("../../src/lib/sync");
  const { default: ConflictCard } = await import("../../src/components/ConflictCard");
  const api: any = await loadApi();
  await api.login("demo@geohub.test", "demo");
  const { forms } = await loadBundle("p1");
  const form = forms.find((f) => f.id === "f1")!;

  // I collect a clinic and sync. Then a supervisor fixes the name and the beds; I, offline, fix the type and the beds.
  const pt = { type: "Point" as const, coordinates: [4.55, 7.79] };
  const f = await saveFeatureLocal({ project_id: "p1", form, geometry: pt, properties: { name: "Iwo Rd Clinik", type: "Clinic", beds: 4, condition: "Good" } });
  await syncProject("p1");
  await api.updateFeature(f.id, { geometry: { type: "Point", coordinates: [4.5508, 7.79] }, properties: { name: "Iwo Road Clinic", type: "Clinic", beds: 6, condition: "Good" }, base_version: 1 });
  await saveFeatureLocal({ id: f.id, project_id: "p1", form, geometry: pt, properties: { name: "Iwo Rd Clinik", type: "Hospital", beds: 8, condition: "Good" } });
  const r = await syncProject("p1");
  const row = (await db.conflicts.get(f.id))!;
  ok(r.conflicts === 1 && !!row, "both changed it: the sync keeps it as a conflict");

  let chosen: any = null;
  render(<ConflictCard row={row} form={form} title="Iwo Rd Clinik" onResolve={(c) => { chosen = c; }} />);
  const rows = screen.getAllByRole("row").slice(1).map((x) => x.textContent ?? "");
  ok(rows.length === 4 && rows[0].startsWith("Name") && rows.some((t) => t.startsWith("Type")) && rows.some((t) => t.startsWith("Number of beds")) && rows[3].startsWith("Location"), "only the differences are listed: name, type, beds and the location, not the unchanged condition");
  ok(/88 m apart/.test(rows[3]), "it says how far apart the two locations are");
  ok(!screen.queryByRole("button", { name: "Save my choices" }), "with nothing mixed, only Keep all theirs / Keep all mine are offered");

  // Take their name and their location, keep my type and my beds.
  await act(async () => { fireEvent.click(within(screen.getByRole("radiogroup", { name: "Keep which Name" })).getByLabelText("Theirs")); });
  await act(async () => { fireEvent.click(within(screen.getByRole("radiogroup", { name: "Keep which location" })).getByLabelText("Theirs")); });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save my choices" })); });
  ok(chosen?.properties.name === "Iwo Road Clinic" && chosen.properties.type === "Hospital" && chosen.properties.beds === 8 && chosen.geometry.coordinates[0] === 4.5508, "Save my choices combines them: their name and location, my type and beds");

  await resolveConflict(f.id, chosen);
  await syncProject("p1");
  const server = (await api.listFeatures("p1")).find((x: any) => x.id === f.id);
  ok(server.properties.name === "Iwo Road Clinic" && server.properties.type === "Hospital" && server.geometry.coordinates[0] === 4.5508 && (await db.conflicts.count()) === 0, "the combination is what reaches the server, and the conflict is gone");
})();
