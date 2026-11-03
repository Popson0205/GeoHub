// Two-step sign-in (setting it up, signing in with it, an organization requiring it), API keys, teams, and adding
// many people from a spreadsheet.
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><body><div id=root></div></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
for (const k of ["window", "document", "navigator", "localStorage", "HTMLElement", "Node", "KeyboardEvent", "Event", "MouseEvent", "getComputedStyle",
  "requestAnimationFrame", "cancelAnimationFrame", "File", "Blob", "FileList"])
  try { Object.defineProperty(globalThis, k, { value: (dom.window as any)[k], configurable: true, writable: true }); } catch { /* read-only */ }
(dom.window as any).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
(dom.window as any).URL.createObjectURL = () => "blob:x";
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const ok = (c: boolean, m: string) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };

(async () => {
  const { render, screen, fireEvent, act, within, cleanup } = await import("@testing-library/react");
  const { MemoryRouter, Route, Routes, useLocation } = await import("react-router-dom");
  const { ToastProvider, ConfirmProvider } = await import("../../src/components/ui");
  const { AuthProvider, RequireAuth } = await import("../../src/lib/auth");
  const { loadApi, tokens } = await import("../../src/lib/api");
  const { default: LoginPage } = await import("../../src/pages/LoginPage");
  const { default: SecurityPage } = await import("../../src/pages/SecurityPage");
  const { default: OrgSettingsPage } = await import("../../src/pages/OrgSettingsPage");
  const { default: ProjectTeams } = await import("../../src/components/ProjectTeams");
  const api: any = await loadApi();
  const text = () => document.body.textContent ?? "";
  const until = async (cond: () => boolean, ms = 5000) => { for (let t = 0; t < ms && !cond(); t += 100) await act(async () => { await new Promise((r) => setTimeout(r, 100)); }); };
  const click = async (el: HTMLElement) => { await act(async () => { fireEvent.click(el); }); };
  const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
  const confirmWith = async (label: string) => {
    const dlg = await screen.findByRole("alertdialog").catch(() => screen.findByRole("dialog"));
    await click(within(dlg).getByRole("button", { name: label }));
  };
  const Where = () => <p data-testid="where">{useLocation().pathname}</p>;
  const app = (at: string) => render(<MemoryRouter initialEntries={[at]}><AuthProvider><ToastProvider><ConfirmProvider><Routes>
    <Route path="/login" element={<LoginPage />} />
    <Route path="/settings/security" element={<RequireAuth><SecurityPage /></RequireAuth>} />
    <Route path="/settings/organization" element={<RequireAuth><OrgSettingsPage /></RequireAuth>} />
    <Route path="/teams-on/:p" element={<RequireAuth><ProjectTeams projectId="p1" canManage /></RequireAuth>} />
    <Route path="*" element={<RequireAuth><Where /></RequireAuth>} />
  </Routes></ConfirmProvider></ToastProvider></AuthProvider></MemoryRouter>);

  // ---- setting up two-step sign-in
  await api.login("demo@geohub.test", "demo");
  app("/settings/security");
  const setUp = await screen.findByRole("button", { name: "Set up two-step sign-in" }, { timeout: 4000 });
  ok(/Off/.test(screen.getByRole("heading", { name: /Two-step sign-in/ }).textContent ?? ""), "two-step sign-in starts off");
  await click(setUp);
  await until(() => !!document.querySelector(".mfa-qr"));
  ok(!!screen.getByRole("img", { name: /QR code/ }) && /JBSW Y3DP/.test(text()), "a QR code and the key to type by hand are shown");
  type(screen.getByLabelText("Enter the 6-digit code the app shows"), "000000");
  await click(screen.getByRole("button", { name: "Turn on" }));
  await until(() => !!screen.queryByRole("alert"));
  ok(/not right/.test(screen.getByRole("alert").textContent ?? ""), "a wrong code is refused");
  type(screen.getByLabelText("Enter the 6-digit code the app shows"), "123456");
  await click(screen.getByRole("button", { name: "Turn on" }));
  await until(() => /Save these recovery codes/.test(text()));
  ok(document.querySelectorAll(".recovery-codes li").length === 10 && /On/.test(screen.getByRole("heading", { name: /Two-step sign-in/ }).textContent ?? ""),
    "once confirmed it is on, with ten recovery codes to save");
  ok(!!screen.getByRole("button", { name: "Download" }), "the recovery codes can be downloaded");

  // ---- API keys
  const keys = () => within(screen.getByRole("heading", { name: "API keys" }).closest("section") as HTMLElement);
  type(keys().getByLabelText("Name"), "Nightly export");
  await click(keys().getByRole("button", { name: "Make key" }));
  await until(() => /copy the key now/.test(text()) && !!keys().queryByRole("table"));
  const shown = document.querySelector(".api-key-value")?.textContent ?? "";
  ok(shown.startsWith("ghk_") && /will not be shown again/.test(text()), "a new key is shown once");
  ok(!!keys().getByRole("cell", { name: /Nightly export/ }) && /Read only/.test(keys().getByRole("table").textContent ?? ""), "and listed by name, read only");
  await click(keys().getByRole("button", { name: "Revoke Nightly export" }));
  await confirmWith("Revoke key");
  await until(() => /Revoked/.test(keys().getByRole("table").textContent ?? ""));
  ok(api.s.apiKeys[0].revoked_at != null, "a key can be revoked");
  cleanup();

  // ---- signing in with it
  tokens.clear();
  app("/login");
  await click(await screen.findByRole("button", { name: "Sign in" }, { timeout: 3000 }));
  await until(() => !!screen.queryByRole("heading", { name: "Two-step sign-in" }));
  ok(!!screen.getByRole("heading", { name: "Two-step sign-in" }) && !tokens.get(), "the password alone asks for the code next, and is not signed in yet");
  type(screen.getByLabelText("Code"), "999999");
  await click(screen.getByRole("button", { name: "Continue" }));
  await until(() => !!screen.queryByRole("alert"));
  ok(/not right/.test(screen.getByRole("alert").textContent ?? ""), "a wrong code says so");
  await click(screen.getByRole("link", { name: /Use a recovery code/ }));
  ok(!!screen.getByLabelText("Recovery code"), "a recovery code can be used instead");
  type(screen.getByLabelText("Recovery code"), "DEMO0-CODE0");
  await click(screen.getByRole("button", { name: "Continue" }));
  await until(() => !!screen.queryByTestId("where"));
  ok(screen.getByTestId("where").textContent === "/" && !!tokens.get() && api.s.mfa.recovery.length === 9, "the right code signs in, and the recovery code is used up");
  cleanup();

  // ---- the organization requires it
  app("/settings/organization");
  const sec = await screen.findByRole("heading", { name: "Two-step sign-in" }, { timeout: 4000 });
  const secCard = () => within(sec.closest("section") as HTMLElement);
  ok(/1 of 5 people have it on/.test(secCard().getByText(/people have it on/).textContent ?? "") && !!screen.getByTitle("Two-step sign-in is on"),
    "the organization page says how many people have it on, and who");
  await click(secCard().getByRole("button", { name: "Require it for everyone" }));
  await confirmWith("Require it");
  await until(() => /Everyone must use it/.test(text()));
  ok(api.s.org.require_mfa === true, "an administrator with it on can require it for everyone");
  cleanup();
  // someone without it is sent to set it up, and sees nothing else
  api.s.mfa = { enabled_at: null, pending: false, recovery: [] };
  app("/collect");
  await until(() => /requires two-step sign-in/.test(text()));
  ok(!screen.queryByTestId("where") && /Osogbo Field Team requires two-step sign-in/.test(text()), "a person without it is sent to set it up");
  ok(!screen.queryByRole("heading", { name: "API keys" }) && !screen.queryByRole("heading", { name: "Password" }), "and sees only that until it is done");
  await click(screen.getByRole("button", { name: "Set up two-step sign-in" }));
  await until(() => !!document.querySelector(".mfa-qr"));
  type(screen.getByLabelText("Enter the 6-digit code the app shows"), "123 456");
  await click(screen.getByRole("button", { name: "Turn on" }));
  await until(() => !!screen.queryByRole("button", { name: "Continue to Geohub" }));
  ok(/Save these recovery codes/.test(text()) && /stays on/.test(text()), "once set up it says it stays on, and offers to carry on");
  await click(screen.getByRole("button", { name: "Continue to Geohub" }));
  await until(() => !!screen.queryByTestId("where"));
  ok(screen.getByTestId("where").textContent === "/", "then Geohub opens as usual");
  api.s.org.require_mfa = false;
  cleanup();

  // ---- teams
  app("/settings/organization");
  const th = await screen.findByRole("heading", { name: /^Teams/ }, { timeout: 4000 });
  const teams = () => within(th.closest("section") as HTMLElement);
  ok(/0 of 2/.test(th.textContent ?? "") && /No teams yet/.test(teams().getByText(/No teams yet/).textContent ?? ""), "Standard plans have 2 teams; none yet");
  type(teams().getByLabelText("New team"), "North district");
  await click(teams().getByRole("button", { name: "Make team" }));
  await until(() => !!teams().queryByRole("heading", { name: "North district" }));
  type(teams().getByLabelText("Add someone to North district"), "u-musa");
  await click(teams().getByRole("button", { name: "Add" }));
  await until(() => /Musa Bello/.test(teams().getByRole("list", { name: "People in North district" }).textContent ?? ""));
  await click(teams().getByRole("button", { name: "Make lead" }));
  await until(() => /Lead/.test(teams().getByRole("list", { name: "People in North district" }).textContent ?? ""));
  ok(api.s.teams[0].members[0].lead === true, "people are added to a team and one is made lead");
  type(teams().getByLabelText("Add someone to North district"), "u-tolu");
  await click(teams().getByRole("button", { name: "Add" }));
  await until(() => /Tolu Adeyemi/.test(teams().getByRole("list", { name: "People in North district" }).textContent ?? ""));
  const people = within(teams().getByRole("list", { name: "People in North district" }));
  const tolu = within(people.getByText(/Tolu Adeyemi/).closest("li") as HTMLElement);
  ok(!tolu.queryByRole("button", { name: "Make lead" }), "a field collector cannot be made lead");
  const firstProject = api.s.projects[0];
  type(teams().getByLabelText(`Give North district a project`), firstProject.id);
  await click(teams().getByRole("button", { name: "Give" }));
  await until(() => !!teams().queryByRole("list", { name: "Projects of North district" }));
  ok(new RegExp(`${firstProject.name}.*as collectors`).test(teams().getByRole("list", { name: "Projects of North district" }).textContent ?? ""), "a team is given a project, as collectors");
  type(teams().getByLabelText("New team"), "South");
  await click(teams().getByRole("button", { name: "Make team" }));
  await until(() => /2 of 2/.test(th.textContent ?? ""));
  ok(!teams().queryByLabelText("New team") && /includes 2 teams/.test(teams().getByText(/includes 2 teams/).textContent ?? ""), "with every team in use, no more can be made");

  // ---- many people from a spreadsheet
  const imp = () => within(screen.getByRole("heading", { name: "Add many people" }).closest("section") as HTMLElement);
  await click(imp().getByRole("button", { name: "Add from a spreadsheet" }));
  const pick = (body: string) => act(async () => {
    fireEvent.change(imp().getByLabelText("Spreadsheet"), { target: { files: [new File([body], "people.csv", { type: "text/csv" })] } });
  });
  await pick("email,name,role,team\nnew1@example.com,New One,,North district\nbad-email,Who,,\nada@example.com,Ada Again,,\nnew2@example.com,New Two,wizard,\n");
  await click(imp().getByRole("button", { name: "Check the file" }));
  await until(() => /Nothing can be added yet/.test(text()));
  const table = () => imp().getByRole("table").textContent ?? "";
  ok(/3 rows need fixing/.test(text()) && /Not an email/.test(table()) && /Already in your organization/.test(table()) && /Unknown role/.test(table()),
    "the check marks each row that cannot be added, and why");
  ok(!imp().queryByRole("button", { name: /^Add \d/ }), "nothing can be added while rows need fixing");
  const before = api.s.orgMembers.length;
  await pick("email,name,role,team\nnew1@example.com,New One,,North district\nnew2@example.com,New Two,viewer,\n");
  await click(imp().getByRole("button", { name: "Check the file" }));
  await until(() => /Ready/.test(text()));
  ok(/All 2 rows can be added/.test(text()) && api.s.orgMembers.length === before, "a clean file is ready, and nothing has changed yet");
  await click(imp().getByRole("button", { name: "Add 2 people" }));
  await until(() => /Done\./.test(text()));
  ok(api.s.orgMembers.length === before + 2 && /welcome emails are on their way to 2/.test(text()), "then everyone is added, and emailed");
  ok(api.s.orgMembers.find((m: any) => m.email === "new2@example.com").role === "viewer" && api.s.orgMembers.find((m: any) => m.email === "new1@example.com").role === "collector",
    "each with their role, or the default");
  ok(api.s.teams.find((t: any) => t.name === "North district").members.length === 3, "and into their team");
  cleanup();

  // ---- a project's teams
  app("/teams-on/p1");
  const pt = await screen.findByRole("heading", { name: "Teams" }, { timeout: 4000 });
  const ptCard = () => within(pt.closest("section") as HTMLElement);
  await until(() => !!ptCard().queryByLabelText("Team to add"));
  type(ptCard().getByLabelText("Team to add"), api.s.teams.find((t: any) => t.name === "South").id);
  type(ptCard().getByLabelText("Their role"), "viewer");
  await click(ptCard().getByRole("button", { name: "Add team" }));
  await until(() => !!ptCard().queryByLabelText("Role of South"));
  ok((ptCard().getByLabelText("Role of South") as HTMLSelectElement).value === "viewer", "a project's admins give it a team, with a role");
  await act(async () => { fireEvent.change(ptCard().getByLabelText("Role of South"), { target: { value: "admin" } }); });
  const southId = api.s.teams.find((t: any) => t.name === "South").id;
  await until(() => api.s.projectTeams.find((x: any) => x.project_id === "p1" && x.team_id === southId)?.role === "admin");
  ok(api.s.projectTeams.find((x: any) => x.project_id === "p1" && x.team_id === southId)?.role === "admin", "and change the team's role");
  await click(ptCard().getByRole("button", { name: "Take South off this project" }));
  await until(() => !ptCard().queryByLabelText("Role of South"));
  ok(!api.s.projectTeams.some((x: any) => x.project_id === "p1" && x.team_id === api.s.teams.find((t: any) => t.name === "South").id), "and take it off again");
  cleanup();
  process.exit(process.exitCode ?? 0);
})();
