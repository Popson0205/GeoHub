// Platform admin (GeoEstate staff): set up a client organization, edit its plan and dates, answer requests; and the
// public "Request an organization" form.
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
  const { default: RequestOrgPage } = await import("../../src/pages/RequestOrgPage");
  const api: any = await loadApi();
  const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 400)); });
  const text = () => document.body.textContent ?? "";

  ok(yearFrom("2026-01-15") === "2027-01-14" && yearFrom("2028-02-29") === "2029-02-28", "a year's subscription ends the day before the same date next year");
  ok(renewal(24).tone === "warn" && renewal(0).text === "Ends today" && renewal(-3).text === "Ended 3 days ago" && renewal(200).tone === "ok" && renewal(null).tone === "quiet", "renewal reads plainly and turns amber within 60 days");

  // the public request form
  render(<MemoryRouter><RequestOrgPage /></MemoryRouter>);
  fireEvent.change(screen.getByLabelText("Organization name"), { target: { value: "Ibadan Roads Agency" } });
  fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "Bisi Ade" } });
  fireEvent.change(screen.getByLabelText("Work email"), { target: { value: "bisi@roads.example.com" } });
  await act(async () => { fireEvent.click(screen.getByRole("radio", { name: /Organization Advanced/ })); });
  ok(!!screen.getByRole("radio", { name: /Not sure yet/ }) && /\$500 a year/.test(text()), "the request form shows the plans and prices");
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Send request" })); });
  await settle();
  ok(/Thank you/.test(text()) && /bisi@roads.example.com/.test(text()), "sending says what happens next");
  cleanup();

  await api.login("demo@geohub.test", "demo");
  render(<MemoryRouter initialEntries={["/admin"]}><AuthProvider><ToastProvider><ConfirmProvider>
    <Routes><Route path="/admin" element={<AdminPage />} /></Routes>
  </ConfirmProvider></ToastProvider></AuthProvider></MemoryRouter>);
  await screen.findByRole("heading", { name: "Platform admin", level: 1 }, { timeout: 4000 });
  const table = within(screen.getByRole("table"));
  ok(table.getAllByRole("row").length === 4 && !!table.getByText("Lagos Survey Ltd"), "client organizations are listed with their owner");
  ok(!!table.getByText("24 days left") && !!table.getByText("No end date") && /1 to renew within 60 days/.test(text()), "renewals due soon stand out");
  ok(/7\/10/.test(text()) && /31\/50/.test(text()), "people in use are shown against each plan's caps");

  // set up a new organization
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Set up an organization" })); });
  fireEvent.change(screen.getByLabelText("Organization name"), { target: { value: "Jos Mapping Co" } });
  fireEvent.change(screen.getByLabelText("Owner's name"), { target: { value: "Chidi Eze" } });
  fireEvent.change(screen.getByLabelText("Owner's email"), { target: { value: "chidi@jos.example.com" } });
  fireEvent.change(screen.getByLabelText("Subscription starts"), { target: { value: "2026-03-01" } });
  ok((screen.getByLabelText("Ends") as HTMLInputElement).value === "2027-02-28", "choosing the start fills in a year's end date");
  fireEvent.change(screen.getByLabelText("Field collectors"), { target: { value: "80" } });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Set up and email the owner" })); });
  await settle();
  const made = api.s.adminOrgs.find((o: any) => o.name === "Jos Mapping Co");
  ok(!!made && made.plan === "standard" && made.caps.collectors === 80 && made.subscription_ends === "2027-02-28", "the organization is made on its plan, dates and caps");
  ok(/Chidi Eze has been emailed/.test(text()), "and the owner is emailed");

  // edit: plan change and a bad end date
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Edit Lagos Survey Ltd" })); });
  await act(async () => { fireEvent.click(screen.getByRole("radio", { name: /Organization Advanced/ })); });
  fireEvent.change(screen.getByLabelText("Ends"), { target: { value: "2000-01-01" } });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save changes" })); });
  await settle();
  ok((screen.getByLabelText("Ends") as HTMLInputElement).validity.rangeUnderflow && api.s.adminOrgs.find((o: any) => o.name === "Lagos Survey Ltd").plan === "standard", "an end date before the start is refused");
  fireEvent.change(screen.getByLabelText("Ends"), { target: { value: "2030-01-01" } });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save changes" })); });
  await settle();
  const lagos = api.s.adminOrgs.find((o: any) => o.name === "Lagos Survey Ltd");
  ok(lagos.plan === "advanced" && lagos.subscription_ends === "2030-01-01", "a renewal or upgrade is saved");

  // requests: the one sent above is listed, and can be set up from
  await act(async () => { fireEvent.click(screen.getByRole("tab", { name: /Requests/ })); });
  ok(/2 new/.test(screen.getByRole("tab", { name: /Requests/ }).textContent ?? "") && /Ibadan Roads Agency/.test(text()), "new requests are counted and listed");
  await act(async () => { fireEvent.change(screen.getByLabelText("Status of Ibadan Water Board"), { target: { value: "contacted" } }); });
  await settle();
  ok(api.s.orgRequests.find((r: any) => r.organization === "Ibadan Water Board").status === "contacted", "a request's progress can be marked");
  fireEvent.change(screen.getByLabelText("Staff note", { selector: "#note-req-1" }), { target: { value: "Invoice GE-0042 sent" } });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save note" })); });
  await settle();
  ok(api.s.orgRequests.find((r: any) => r.id === "req-1").note === "Invoice GE-0042 sent", "and a staff note kept");
  const roads = screen.getByRole("heading", { name: "Ibadan Roads Agency" }).closest("li")!;
  await act(async () => { fireEvent.click(within(roads as HTMLElement).getByRole("button", { name: "Set up this organization" })); });
  ok((screen.getByLabelText("Organization name") as HTMLInputElement).value === "Ibadan Roads Agency" && (screen.getByLabelText("Owner's email") as HTMLInputElement).value === "bisi@roads.example.com"
    && (screen.getByRole("radio", { name: /Organization Advanced/ }) as HTMLInputElement).checked, "setting up from a request fills in the form");
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Set up and email the owner" })); });
  await settle();
  ok(api.s.orgRequests.find((r: any) => r.organization === "Ibadan Roads Agency").status === "set_up", "and marks the request set up");
  process.exit();
})();
