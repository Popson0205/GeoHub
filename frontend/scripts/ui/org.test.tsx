// The organization page: invite people, change roles, remove someone, see the plan's limits; members only look.
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
  const { default: OrgSettingsPage } = await import("../../src/pages/OrgSettingsPage");
  const api: any = await loadApi();
  await api.login("demo@geohub.test", "demo");
  const mount = () => render(<MemoryRouter initialEntries={["/settings/organization"]}><AuthProvider><ToastProvider><ConfirmProvider>
    <Routes><Route path="/settings/organization" element={<OrgSettingsPage />} /><Route path="/" element={<p>home</p>} /></Routes>
  </ConfirmProvider></ToastProvider></AuthProvider></MemoryRouter>);
  const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 400)); });

  mount();
  await screen.findByRole("heading", { name: "Osogbo Field Team", level: 1 }, { timeout: 4000 });
  const people = within(screen.getByRole("table"));
  ok(people.getAllByRole("row").length === 5 && !!people.getByText(/\(you\)/), "everyone in the organization is listed, with you marked");
  ok(/Invited/.test(document.body.textContent ?? "") && /kemi@example.com/.test(document.body.textContent ?? ""), "open invitations are listed apart");
  ok(/Unlimited/.test(document.body.textContent ?? ""), "with no limits set, the plan says unlimited");

  // invite
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "Zainab@Example.com" } });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Invite" })); });
  await settle();
  ok(/Invitation sent to zainab@example.com/.test(document.body.textContent ?? ""), "inviting someone without an account sends an invitation");

  // change a role
  await act(async () => { fireEvent.change(screen.getByLabelText("Role of Musa Bello"), { target: { value: "admin" } }); });
  await settle();
  ok(api.s.orgMembers.find((m: any) => m.email === "musa@example.com").role === "admin", "an owner can change someone's role");

  // remove, after confirming
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Remove Tolu Adeyemi" })); });
  const dlg = await screen.findByRole("alertdialog").catch(() => screen.findByRole("dialog"));
  ok(/lose access to every project and map/.test(dlg.textContent ?? ""), "removing someone says what they lose");
  await act(async () => { fireEvent.click(within(dlg).getByRole("button", { name: "Remove from organization" })); });
  await settle();
  ok(!api.s.orgMembers.some((m: any) => m.email === "tolu@example.com"), "and removes them once confirmed");

  // limits shown as meters
  cleanup();
  api.s.org.limits = { seats: 6, projects: 10 };
  mount();
  await screen.findByRole("heading", { name: "Osogbo Field Team", level: 1 }, { timeout: 4000 });
  const seats = screen.getByRole("meter", { name: "People used" });
  ok(seats.getAttribute("aria-valuemax") === "6" && /of 6/.test(document.body.textContent ?? ""), "a plan limit shows as used of total, with a meter");
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "one@example.com" } });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Invite" })); });
  await settle();
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "two@example.com" } });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Invite" })); });
  await settle();
  ok(/plan allows 6 people/.test(document.body.textContent ?? ""), "going over the seat limit explains why it was refused");

  // the email check reports each step
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Send me a test email" })); });
  await settle(); await settle();
  ok(/Email is not working yet/.test(document.body.textContent ?? "") && /BREVO_API_KEY/.test(document.body.textContent ?? ""), "Send me a test email shows each step and what to fix");

  // a member sees the organization but cannot manage it
  cleanup();
  api.s.orgMembers.find((m: any) => m.email === "demo@geohub.test").role = "member";
  mount();
  await screen.findByRole("heading", { name: "Osogbo Field Team", level: 1 }, { timeout: 4000 });
  ok(!screen.queryByLabelText("Email") && !screen.queryByRole("button", { name: /^Remove/ }) && !screen.queryByLabelText("Organization name"), "members see the people and plan but cannot invite, remove or rename");
  ok(/You are a member/.test(document.body.textContent ?? ""), "and are told their role");
})();
