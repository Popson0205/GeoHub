import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><body><div id=root></div></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
for (const k of ["window", "document", "navigator", "localStorage", "HTMLElement", "Node", "KeyboardEvent", "Event", "MouseEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
  try { Object.defineProperty(globalThis, k, { value: (dom.window as any)[k], configurable: true, writable: true }); } catch { /* read-only */ }
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).confirm = () => true; (dom.window as any).confirm = () => true;
const ok = (c: boolean, m: string) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };
const rejects = async (p: Promise<unknown>, status: number) => { try { await p; return false; } catch (e: any) { return e.status === status; } };

(async () => {
  const React = (await import("react")).default;
  const { render, screen, fireEvent, act, cleanup, within } = await import("@testing-library/react");
  const { MemoryRouter, Route, Routes, useLocation } = await import("react-router-dom");
  const { ToastProvider } = await import("../../src/components/ui");
  const { AuthProvider } = await import("../../src/lib/auth");
  const { loadApi } = await import("../../src/lib/api");
  const { default: Portal } = await import("../../src/pages/MapPortalPage");
  const { default: Join } = await import("../../src/pages/JoinMapPage");
  const { default: Maps } = await import("../../src/pages/MapsPage");
  const { default: Dataset } = await import("../../src/pages/DatasetPage");

  const api: any = await loadApi();
  await api.login("demo@geohub.test", "demo");
  const wait = (ms = 400) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
  const Where = () => <div data-testid="where">{useLocation().pathname}</div>;
  const app = (path: string) => render(
    <MemoryRouter initialEntries={[path]}><AuthProvider><ToastProvider>
      <Routes>
        <Route path="/maps" element={<Maps />} /><Route path="/maps/:mapId" element={<div>EDITOR</div>} />
        <Route path="/maps/:mapId/portal" element={<Portal />} /><Route path="/join/:code" element={<Join />} /><Route path="/hub/:slug" element={<Dataset />} />
      </Routes><Where />
    </ToastProvider></AuthProvider></MemoryRouter>);

  // ---- maps list: demo campaign is there, the one we have not joined is not ----
  let maps = await api.listMaps();
  const mapathon = maps.find((m: any) => m.name.includes("mapathon"));
  ok(!!mapathon && mapathon.role === "owner" && mapathon.is_campaign && mapathon.competition && mapathon.member_count === 5, "demo campaign is listed, we own it, 5 people (owner + 4)");
  ok(!maps.some((m: any) => m.name.includes("Ibadan")), "a map we have not joined is invisible");
  ok(await rejects(api.getMap("00000000-0000-4000-8000-0000000000a2"), 404), "…and opening it directly is a 404");

  // ---- joining by link ----
  let ui = app("/join/ibadan-flood");
  await screen.findByText("Ibadan flood mapping");
  ok(!!screen.getByText(/Tolu Adeleke invited you/) && !!screen.getByText(/leaderboard/), "invitation page shows the map, the organiser and the competition");
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Join as a contributor/ })); });
  await wait();
  ok(/^\/maps\/0000.*a2$/.test(screen.getByTestId("where").textContent!), "joining takes you to the map");
  cleanup();
  ok((await api.getMap("00000000-0000-4000-8000-0000000000a2")).role === "contributor", "we are now a contributor there");
  ok(await rejects(api.joinPreview("nope"), 404), "a bad code is a 404");

  // ---- contributor rules (Ibadan: someone else owns it) ----
  const ib = "00000000-0000-4000-8000-0000000000a2";
  const mine = await api.createMapFeature(ib, { id: crypto.randomUUID(), geometry: { type: "Point", coordinates: [3.9, 7.4] }, properties: { flooded: "yes" } });
  ok(mine.status === "submitted" && mine.author === "Demo Collector", "a contributor's feature waits for review and records its author");
  ok(await rejects(api.reviewFeatures(ib, [mine.id], "approved"), 403), "contributors cannot review");
  ok(await rejects(api.updateMap(ib, { name: "Mine" }), 403), "contributors cannot change settings");
  ok(await rejects(api.publishMap(ib, { title: "x", slug: "xx", description: "", license: "CC0", visibility: "public", geometry_type: "point", tags: [], credit_contributors: true }), 403), "contributors cannot publish");
  ok((await api.updateMapFeature(ib, mine.id, { properties: { flooded: "knee deep" } })).status === "submitted", "they can edit their own feature");

  // ---- the leaderboard (UI) ----
  const report = await api.contributors(mapathon.id);
  const names = report.contributors.map((c: any) => c.name);
  ok(names.length === 5 && report.contributors[0].rank === 1, "report lists all 5 people, ranked");
  ok(report.contributors.every((c: any, i: number, a: any[]) => i === 0 || a[i - 1].added >= c.added), "sorted by features added");
  ok(report.totals.added === report.contributors.reduce((t: number, c: any) => t + c.added, 0), "totals add up");
  ui = app(`/maps/${mapathon.id}/portal`);
  await screen.findByText("Leaderboard");
  await wait();
  ok(names.every((n: string) => screen.getAllByText(n).length > 0), "every contributor is on the leaderboard page");
  ok(!!screen.getByText(/Trace every building/) && !!screen.getByText(/days left/), "campaign goal and time left are shown");
  ok(screen.getAllByRole("tab").map((t) => t.textContent).join() === "Contributors,Review,Team,Campaign,Publish", "the owner sees every tab");

  // ---- review (UI) ----
  const before = await api.listMapFeatures(mapathon.id);
  const waiting = before.filter((f: any) => f.status === "submitted");
  ok(waiting.length > 0, `there is work waiting (${waiting.length})`);
  await act(async () => { fireEvent.click(screen.getByRole("tab", { name: "Review" })); });
  await screen.findByText(/Select all/);
  await act(async () => { fireEvent.click(screen.getByLabelText(/Select all/)); });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Approve" })); });
  await wait(600);
  const after = await api.listMapFeatures(mapathon.id);
  ok(after.filter((f: any) => f.status === "submitted").length === 0 && after.filter((f: any) => f.status === "approved").length === before.filter((f: any) => f.status !== "rejected").length, "approving everything waiting leaves nothing waiting (rejected stay rejected)");
  cleanup();

  // reject with a note, then the author sees the note
  const victim = after.find((f: any) => f.created_by === "u2" && f.status === "approved");
  await api.reviewFeatures(mapathon.id, [victim.id], "rejected", "Too rough");
  ok((await api.listMapFeatures(mapathon.id)).find((f: any) => f.id === victim.id).review_note === "Too rough", "a rejection carries the reviewer's note");
  const rep2 = await api.contributors(mapathon.id);
  ok(rep2.contributors.find((c: any) => c.user_id === "u2").rejected >= 1, "rejected features show in the contributor's stats");

  // ---- publishing (UI) ----
  const approvedAreas = (await api.listMapFeatures(mapathon.id)).filter((f: any) => f.status === "approved" && f.geometry.type === "Polygon").length;
  ui = app(`/maps/${mapathon.id}/portal?tab=publish`);
  await screen.findByText("Publish to the Data hub");
  ok(!!screen.getByText(String(approvedAreas)), "publish tab counts approved areas");
  const slug = "osogbo-buildings-test";
  await act(async () => { fireEvent.change(screen.getByLabelText("Web address"), { target: { value: slug } }); });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /^Publish \d+/ })); });
  await wait(1800);
  ok(!!screen.queryByText(/Open the dataset/), "publishing shows a link to the dataset");
  cleanup();
  const ds = await api.getDataset(slug);
  ok(ds.feature_count === approvedAreas && ds.map_id === mapathon.id && ds.latest_version === 1, "dataset has exactly the approved areas");
  ok(ds.contributors.reduce((t: number, c: any) => t + c.features, 0) === approvedAreas && ds.contributors.length >= 3, "contributors are credited with their counts");
  ok((await api.datasetFeatures(slug)).features.length === approvedAreas, "the dataset's features are served");
  ok(await rejects(api.publishMap(mapathon.id, { title: "x", slug, description: "", license: "CC0", visibility: "public", geometry_type: "area", tags: [], credit_contributors: true }), 409), "the same web address cannot be used twice");
  ok(await rejects(api.publishMap(mapathon.id, { title: "x", slug: "no-lines-here", description: "", license: "CC0", visibility: "public", geometry_type: "line", tags: [], credit_contributors: true }), 409), "nothing approved of a kind: refused");
  ok((await api.listDatasets()).some((d: any) => d.slug === slug), "it appears in the public hub catalogue");
  const private1 = await api.publishMap(mapathon.id, { title: "Private", slug: "osogbo-private", description: "", license: "Private", visibility: "public", geometry_type: "area", tags: [], credit_contributors: false });
  ok(private1.dataset.visibility === "private" && !(await api.listDatasets()).some((d: any) => d.slug === "osogbo-private") && (await api.getDataset("osogbo-private")).contributors === undefined, "a Private licence is never public, and credits can be off");
  // approve another and publish a new version
  const another = (await api.listMapFeatures(mapathon.id)).find((f: any) => f.status === "rejected" && f.geometry.type === "Polygon");
  await api.reviewFeatures(mapathon.id, [another.id], "approved");
  await api.newDatasetVersion(slug);
  const ds2 = await api.getDataset(slug);
  ok(ds2.latest_version === 2 && ds2.feature_count === approvedAreas + 1, "a new version picks up newly approved features");

  // dataset page shows credits
  ui = app(`/hub/${slug}`);
  await screen.findByText("Mapped by");
  ok(!!screen.getByText(/Amina Bello/), "dataset page credits contributors by name");
  cleanup();

  // ---- team and campaign (UI/API) ----
  ui = app(`/maps/${mapathon.id}/portal?tab=team`);
  await screen.findByText("Invite people");
  const link = (screen.getByLabelText("Invitation link") as HTMLInputElement).value;
  ok(link.endsWith("/join/osogbo-mapathon"), "owner sees the invitation link");
  const roleBox = await screen.findByLabelText("Role of Chidi Okafor");
  await act(async () => { fireEvent.change(roleBox, { target: { value: "reviewer" } }); });
  await wait();
  ok((await api.listMembers(mapathon.id)).find((m: any) => m.name === "Chidi Okafor").role === "reviewer", "the owner can promote a contributor to reviewer");
  cleanup();
  await api.updateMap(mapathon.id, { ends_at: new Date(Date.now() - 864e5).toISOString() });
  ok((await api.getMap(mapathon.id)).campaign_status === "ended", "moving the end date into the past ends the campaign");
  ok(await rejects(api.updateMap(mapathon.id, { starts_at: new Date().toISOString(), ends_at: new Date(Date.now() - 1000).toISOString() }), 422), "an end before the start is refused");
  await api.updateMap(mapathon.id, { ends_at: null, join_open: false });
  ok((await api.getMap(mapathon.id)).join_code === undefined, "joining by link can be switched off");

  // maps page
  ui = app("/maps");
  await screen.findByText("Osogbo building mapathon");
  ok(!!screen.getAllByText("Ibadan flood mapping").length && screen.getAllByText("Contributor").length >= 1 && screen.getAllByText("Owner").length >= 1, "maps page shows roles");
  process.exit(process.exitCode ?? 0);
})().catch((e) => { console.error("ERROR", e); process.exit(1); });
