// Sharing a form: WhatsApp message with the link, and a QR code that can be downloaded.
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><body><div id=root></div></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
for (const k of ["window", "document", "navigator", "HTMLElement", "Node", "Event", "MouseEvent", "getComputedStyle"])
  try { Object.defineProperty(globalThis, k, { value: (dom.window as any)[k], configurable: true, writable: true }); } catch { /* read-only */ }
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const saved: Blob[] = [];
for (const U of [dom.window.URL, globalThis.URL] as any[]) { U.createObjectURL = (b: Blob) => { saved.push(b); return "blob:x"; }; U.revokeObjectURL = () => undefined; }
(dom.window.HTMLAnchorElement.prototype as any).click = function () { /* no navigation */ };
const ok = (c: boolean, m: string) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };

(async () => {
  const { render, screen, fireEvent, act } = await import("@testing-library/react");
  const { default: ShareOptions, qrPath } = await import("../../src/components/ShareOptions");
  const url = "https://geohub.example/f/water-point-abc123";
  render(<ShareOptions url={url} formName="Water point" projectName="Iwo survey" />);
  const wa = new URL(screen.getByRole("link", { name: "Send on WhatsApp" }).getAttribute("href")!);
  const text = wa.searchParams.get("text") ?? "";
  ok(wa.host === "wa.me" && text.includes(url) && text.includes("“Water point” for Iwo survey"), "WhatsApp opens with a message that names the form and carries the link");
  ok(!!screen.getByRole("img", { name: "QR code that opens Water point" }).querySelector("path")?.getAttribute("d"), "a QR code is drawn for the link");
  const a = qrPath(url), b = qrPath(url + "x");
  ok(a.size >= 29 && a.d !== b.d, "the code depends on the link and keeps a quiet zone around it");
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Download QR code" })); });
  const svg = await saved[0]?.text();
  ok(!!svg && svg.startsWith("<svg") && svg.includes('fill="#fff"') && saved[0].type.startsWith("image/svg+xml"), "Download QR code saves a printable SVG with a white background");
})();
