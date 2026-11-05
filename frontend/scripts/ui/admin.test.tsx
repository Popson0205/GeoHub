// The GeoEstate staff console: customers and their licences, a demo licence, the customer page (licence history,
// suspension, notes, support actions), staff and their roles, the staff activity log; and the public request form.
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><body><div id=root></div></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
for (const k of ["window", "document", "navigator", "localStorage", "HTMLElement", "Node", "KeyboardEvent", "Event", "MouseEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"])
  try { Object.defineProperty(globalThis, k, { value: (dom.window as any)[k], configurable: true, writable: true }); } catch { /* read-only */ }
(dom.window as any).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const ok = (c: boolean, m: string) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };

(async () => {
  const { render, screen, fireEvent, act, within, cleanup } = await import("@testing-library/react");
  const { MemoryRouter, Route, Routes } = await import("react-router-dom");
  const { ToastProvider, ConfirmProvider } = await import("../../src/components/ui");
  const { AuthProvider } = await import("../../src/lib/auth");
  const { loadApi } = await import("../../src/lib/api");
  const { default: AdminPage, yearFrom, renewal } = await import("../../src/pages/AdminPage");
  const { default: AdminCustomerPage } = await import("../../src/pages/AdminCustomerPage");
  const { default: RequestOrgPage } = await import("../../src/pages/RequestOrgPage");
  const { demoEnd, dayAfter, describe } = await import("../../src/lib/staffConsole");
  const api: any = await loadApi();
  const text = () => document.body.textContent ?? "";
  const until = async (cond: () => boolean, ms = 5000) => { for (let t = 0; t < ms && !cond(); t += 100) await act(async () => { await new Promise((r) => setTimeout(r, 100)); }); };
  const click = async (el: HTMLElement) => { await act(async () => { fireEvent.click(el); }); };
  const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
  const confirmWith = async (label: string) => {
    const dlg = await screen.findByRole("alertdialog").catch(() => screen.findByRole("dialog"));
    await click(within(dlg).getByRole("button", { name: label }));
  };
  const iso = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

  ok(yearFrom("2026-01-15") === "2027-01-14" && yearFrom("2028-02-29") === "2029-02-28", "a year's subscription ends the day before the same date next year");
  ok(demoEnd("2026-11-03") === "2026-12-02" && dayAfter("2026-12-31") === "2027-01-01", "a demo runs 30 days; a renewal starts the day after the last end");
  ok(renewal(24).tone === "warn" && renewal(0).text === "Ends today" && renewal(-3).text === "Ended 3 days ago" && renewal(200).tone === "ok" && renewal(null).tone === "quiet", "renewal reads plainly and turns amber within 60 days");
  ok(describe({ id: 1, at: "", action: "platform.org_suspend", actor_id: null, actor_name: "A", target_type: null, target_id: null, details: { reason: "Unpaid" } }) === "suspended the customer: Unpaid"
    && describe({ id: 2, at: "", action: "team.create", actor_id: null, actor_name: "A", target_type: null, target_id: null, details: {} }) === "made a team", "staff and customer actions read as plain words");

  // the public request form, with a demo
  render(<MemoryRouter><RequestOrgPage /></MemoryRouter>);
  type(screen.getByLabelText("Organization name"), "Ibadan Roads Agency");
  type(screen.getByLabelText("Your name"), "Bisi Ade");
  type(screen.getByLabelText("Work email"), "bisi@roads.example.com");
  await click(screen.getByRole("radio", { name: /One-month demo/ }));
  ok(!!screen.getByRole("radio", { name: /Not sure yet/ }) && /\$500 a year/.test(text()), "the request form shows the plans, prices and a one-month demo");
  await click(screen.getByRole("button", { name: "Send request" }));
  await until(() => /Thank you/.test(text()));
  ok(/set up your one-month demo/.test(text()), "asking for a demo says what happens next");
  cleanup();

  await api.login("demo@geohub.test", "demo");
  const app = (at: string) => render(<MemoryRouter initialEntries={[at]}><AuthProvider><ToastProvider><ConfirmProvider>
    <Routes><Route path="/admin" element={<AdminPage />} /><Route path="/admin/customers/:orgId" element={<AdminCustomerPage />} /></Routes>
  </ConfirmProvider></ToastProvider></AuthProvider></MemoryRouter>);

  // ---- customers
  app("/admin");
  await screen.findByRole("heading", { name: "Staff console", level: 1 }, { timeout: 4000 });
  await until(() => !!screen.queryByRole("table"));
  const table = () => within(screen.getByRole("table"));
  ok(table().getAllByRole("row").length === 5 && !!table().getByText("Lagos Survey Ltd") && /a super admin/.test(text()), "customers are listed for a super admin");
  ok(!!table().getByText("24 days left") && !!table().getByText("No end date") && /7\/10/.test(text()), "renewals and people in use are shown");
  ok(/Grace period/.test(table().getByText("Ogun Farm Mapping").closest("tr")!.textContent ?? ""), "a customer past its end date is in its grace period");
  await click(screen.getByRole("button", { name: "Grace period" }));
  await until(() => table().getAllByRole("row").length === 2);
  ok(!!table().getByText("Ogun Farm Mapping"), "customers can be filtered by licence status");
  await click(screen.getByRole("button", { name: "All" }));
  await until(() => table().getAllByRole("row").length === 5);

  // set up a paid customer
  await click(screen.getByRole("button", { name: "Set up a customer" }));
  type(screen.getByLabelText("Organization name"), "Jos Mapping Co");
  type(screen.getByLabelText("Owner's name"), "Chidi Eze");
  type(screen.getByLabelText("Owner's email"), "chidi@jos.example.com");
  type(screen.getByLabelText("Subscription starts"), "2026-03-01");
  ok((screen.getByLabelText("Ends") as HTMLInputElement).value === "2027-02-28", "choosing the start fills in a year's end date");
  type(screen.getByLabelText("Field collectors"), "80");
  type(screen.getByLabelText(/Invoice number/), "GE-2026-0007");
  await click(screen.getByRole("button", { name: "Set up and email the owner" }));
  await until(() => !!screen.queryByRole("heading", { name: "Jos Mapping Co", level: 1 }));
  const made = api.s.adminOrgs.find((o: any) => o.name === "Jos Mapping Co");
  ok(!!made && made.plan === "standard" && made.caps.collectors === 80 && made.subscription_ends === "2027-02-28", "the customer is made on its plan, dates and caps");
  ok(/Chidi Eze has been emailed/.test(text()) && /GE-2026-0007/.test(text()), "the owner is emailed, and the customer page opens with the invoice in its history");
  cleanup();

  // a demo
  app("/admin");
  await click(await screen.findByRole("button", { name: "Start a demo" }, { timeout: 4000 }));
  ok((screen.getByRole("radio", { name: /^Organization Advanced/ }) as HTMLInputElement).checked && (screen.getByRole("radio", { name: /^Organization Standard/ }) as HTMLInputElement).disabled,
    "a demo is Organization Advanced");
  ok((screen.getByLabelText("Ends") as HTMLInputElement).value === iso(29), "for 30 days from today");
  type(screen.getByLabelText("Organization name"), "Kano Trial");
  type(screen.getByLabelText("Owner's name"), "Aisha Bello");
  type(screen.getByLabelText("Owner's email"), "aisha@kano.example.com");
  await click(screen.getByRole("button", { name: "Start the demo and email the owner" }));
  await until(() => !!screen.queryByRole("heading", { name: "Kano Trial", level: 1 }));
  ok(api.s.adminOrgs.find((o: any) => o.name === "Kano Trial").status === "demo" && /Demo started/.test(text()), "the demo is listed as a demo, with its start in the history");
  cleanup();

  // ---- the customer page
  app("/admin/customers/org-a");
  await screen.findByRole("heading", { name: "Lagos Survey Ltd", level: 1 }, { timeout: 4000 });
  const people = within(screen.getByRole("heading", { name: /^People/ }).closest("section")!).getByRole("table").textContent ?? "";
  ok(/Ada Obi/.test(people) && /Bola Ade/.test(people) && /Field collector/.test(people), "its people are listed with their roles");
  await click(screen.getByRole("button", { name: "Renew for a year" }));
  const lagos = () => api.s.adminOrgs.find((o: any) => o.id === "org-a");
  const oldEnd = lagos().subscription_ends;
  ok((screen.getByLabelText("Subscription starts") as HTMLInputElement).value === dayAfter(oldEnd) && (screen.getByLabelText("Ends") as HTMLInputElement).value === yearFrom(dayAfter(oldEnd)),
    "a renewal starts the day after the current end, for a year");
  type(screen.getByLabelText(/Invoice number/), "GE-2027-0002");
  await click(screen.getByRole("button", { name: "Save changes" }));
  await until(() => /Renewed/.test(text()));
  ok(lagos().subscription_ends === yearFrom(dayAfter(oldEnd)) && /GE-2027-0002/.test(text()), "the renewal is saved and kept in the licence history with its invoice");

  await click(screen.getByRole("button", { name: "Suspend" }));
  type(screen.getByLabelText(/Why\?/), "Invoice GE-2027-0002 unpaid");
  await click(screen.getByRole("button", { name: "Suspend Lagos Survey Ltd" }));
  await until(() => !!screen.queryByRole("button", { name: "Lift suspension" }));
  ok(lagos().status === "suspended" && /Suspended:.*unpaid/.test(text()), "a customer can be suspended, with the reason shown");
  await click(screen.getByRole("button", { name: "Lift suspension" }));
  await until(() => !!screen.queryByRole("button", { name: "Suspend" }));
  ok(lagos().status !== "suspended" && /Reactivated/.test(text()), "and the suspension lifted");

  type(screen.getByLabelText("New note"), "Wants 20 more collectors in January");
  await click(screen.getByRole("button", { name: "Add note" }));
  const notesList = () => within(screen.getByRole("heading", { name: "Staff notes" }).closest("section")!).queryByRole("list");
  await until(() => /Wants 20 more collectors/.test(notesList()?.textContent ?? ""));
  ok(/Wants 20 more collectors/.test(notesList()?.textContent ?? ""), "staff notes are kept on the customer");
  await click(screen.getByRole("button", { name: "Turn off two-step sign-in for Ada Obi" }));
  await confirmWith("Turn it off");
  await until(() => /Two-step sign-in is off for Ada Obi/.test(text()));
  ok(/Two-step sign-in is off for Ada Obi/.test(text()), "support can turn off someone's two-step sign-in");
  await click(screen.getByRole("button", { name: "Make Bola Ade the owner" }));
  await confirmWith("Make owner");
  await until(() => /Bola Ade is now the owner/.test(text()));
  ok(lagos().owner_name === "Bola Ade", "and make someone else the owner");
  ok(/suspended the customer: Invoice GE-2027-0002 unpaid/.test(text()) && /added a note/.test(text()), "the customer page shows what staff did");

  // other GeoEstate products: a FarmScan demo, then a paid Land Registry licence, then one taken away
  const products = () => within(screen.getByRole("heading", { name: "Other GeoEstate products" }).closest("section")!);
  ok(/None yet/.test(products().getByText(/None yet/).textContent ?? ""), "a customer starts with no other products");
  await click(products().getByRole("button", { name: "Add a product" }));
  type(products().getByLabelText("Product"), "farm");
  await click(products().getByRole("radio", { name: /month's demo/ }));
  ok(!products().queryByLabelText("From"), "a demo needs no dates");
  await click(products().getByRole("button", { name: "Give FarmScan" }));
  await until(() => /has FarmScan on a month.s demo/.test(text()));
  await until(() => products().queryAllByRole("listitem").length === 1);
  ok(/FarmScan Standard \(demo\)/.test(products().getAllByRole("listitem")[0].textContent ?? ""), "a FarmScan demo is given");
  await click(products().getByRole("button", { name: "Add a product" }));
  type(products().getByLabelText("Product"), "land");
  type(products().getByLabelText("Plan"), "advanced");
  ok((products().getByLabelText("To") as HTMLInputElement).value === yearFrom((products().getByLabelText("From") as HTMLInputElement).value), "a paid product runs a year by default");
  type(products().getByLabelText("Invoice number"), "GE-2026-0300");
  await click(products().getByRole("button", { name: "Give Land Registry" }));
  await until(() => products().getAllByRole("listitem").length === 2);
  ok(/Land Registry Advanced/.test(products().getByText(/Land Registry Advanced/).textContent ?? "") && /GE-2026-0300/.test(text()) && /Land Registry/.test(within(screen.getByRole("heading", { name: "Licence history" }).closest("section")!).getAllByRole("row")[1].textContent ?? ""),
    "a paid Land Registry licence, in the history with its invoice and product");
  const farmItem = products().getAllByRole("listitem").find((li) => /FarmScan/.test(li.textContent ?? ""))!;
  await click(within(farmItem).getByRole("button", { name: "Remove" }));
  type(products().getByLabelText(/^Why\?/), "Demo not taken up");
  await click(products().getByRole("button", { name: "Take FarmScan away" }));
  await confirmWith("Take it away");
  await until(() => products().getAllByRole("listitem").length === 1);
  ok(products().getAllByRole("listitem").length === 1 && /Taken away/.test(text()), "a product is taken away, and the history says so");

  // licence keys for the customer's own installation
  const keysCard = () => within(screen.getByRole("heading", { name: "Licence keys" }).closest("section")!);
  await until(() => !!keysCard().queryByRole("button", { name: "Make a licence key" }));
  await click(keysCard().getByRole("button", { name: "Make a licence key" }));
  type(keysCard().getByLabelText("Installation's web address"), "https://geohub.lands.example.gov.ng/app");
  type(keysCard().getByLabelText(/^Note/), "Lands bureau data centre");
  await click(keysCard().getByRole("button", { name: "Make the key" }));
  await until(() => !!keysCard().queryByLabelText("The licence key"));
  ok(/^GEOESTATE-LICENCE-1\./.test((keysCard().getByLabelText("The licence key") as HTMLTextAreaElement).value) && /Key for https:\/\/geohub\.lands\.example\.gov\.ng/.test(keysCard().getByLabelText("Licence key").textContent ?? ""),
    "staff make a licence key for an installation, carrying its licences");
  await until(() => keysCard().queryAllByRole("button", { name: /Show the key/ }).length === 1);
  ok(/Lands bureau data centre/.test(keysCard().getAllByRole("listitem")[0].textContent ?? "") && /LICENCE_PUBLIC_KEY/.test(keysCard().getByText(/Set as/).textContent ?? ""),
    "issued keys are listed, with the public key installations need");
  cleanup();

  // ---- requests: set up the demo asked for above
  app("/admin?tab=requests");
  await until(() => /Ibadan Roads Agency/.test(text()));
  const roads = screen.getByRole("heading", { name: "Ibadan Roads Agency" }).closest("li")!;
  ok(/One-month demo/.test(roads.textContent ?? ""), "a demo request says so");
  await click(within(roads as HTMLElement).getByRole("button", { name: "Start this demo" }));
  ok((screen.getByLabelText("Owner's email") as HTMLInputElement).value === "bisi@roads.example.com" && (screen.getByRole("radio", { name: /^Demo/ }) as HTMLInputElement).checked,
    "starting it fills in the form as a demo");
  await click(screen.getByRole("button", { name: "Start the demo and email the owner" }));
  await until(() => !!screen.queryByRole("heading", { name: "Ibadan Roads Agency", level: 1 }));
  ok(api.s.orgRequests.find((r: any) => r.organization === "Ibadan Roads Agency").status === "set_up", "and marks the request set up");
  cleanup();

  // ---- staff
  app("/admin?tab=staff");
  await until(() => !!screen.queryByLabelText("Email"));
  ok(/Set on the server/.test(text()) && /\(you\)/.test(text()), "the staff list shows who is set on the server");
  type(screen.getByLabelText("Email"), "funke@geoestate.example.com");
  type(screen.getByLabelText(/^Name/), "Funke Ola");
  type(screen.getByLabelText("Role"), "account_manager");
  await click(screen.getByRole("button", { name: "Add" }));
  await until(() => /Funke Ola/.test(text()));
  ok(api.s.staffList.some((m: any) => m.email === "funke@geoestate.example.com" && m.role === "account_manager") && /Not yet/.test(text()), "a super admin adds staff with a role");
  await act(async () => { fireEvent.change(screen.getByLabelText("Role of Funke Ola"), { target: { value: "support" } }); });
  await until(() => api.s.staffList.find((m: any) => m.name === "Funke Ola").role === "support");
  ok(api.s.staffList.find((m: any) => m.name === "Funke Ola").role === "support", "changes their role");
  await click(screen.getByRole("button", { name: "Remove Funke Ola from the staff" }));
  await confirmWith("Remove from staff");
  await until(() => !api.s.staffList.some((m: any) => m.name === "Funke Ola"));
  ok(!api.s.staffList.some((m: any) => m.name === "Funke Ola"), "and removes them");
  cleanup();

  // ---- activity
  app("/admin?tab=activity");
  await until(() => /removed a staff member/.test(text()));
  ok(/Demo Collector/.test(text()) && /set up the customer/.test(text()) && /changed a staff member's role to Support/.test(text()), "every staff action is in the activity log, in plain words");
  process.exit();
})();
