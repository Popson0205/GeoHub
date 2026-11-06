// Plotting a plot from its survey plan in the collector (lib/surveyPlan, components/PlanPlotter).
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><body><div id=root></div></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
for (const k of ["window", "document", "navigator", "localStorage", "HTMLElement", "Node", "KeyboardEvent", "Event", "MouseEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"])
  try { Object.defineProperty(globalThis, k, { value: (dom.window as any)[k], configurable: true, writable: true }); } catch { /* read-only */ }
(dom.window as any).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const ok = (c: boolean, m: string) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };

(async () => {
  const { bearing, plotTraverse, plotCoordinates, readPlan, planText } = await import("../../src/lib/surveyPlan");
  ok(bearing("123", "30", "15") === 123 + 30 / 60 + 15 / 3600 && bearing("90", "", "") === 90, "degrees, minutes and seconds make a bearing");
  ok(bearing("360", "0", "0") === null && bearing("10", "60", "0") === null && bearing("10", "1.5", "0") === null, "out-of-range parts are refused");

  // a 30 m x 20 m plot on Minna / UTM 32N (the FCT), the last leg 4 mm short: it closes 1 in 25,000 and is adjusted
  const r = plotTraverse(26332, ["331600", "993000"], [["90", "0", "0", "30"], ["180", "0", "0", "20"], ["270", "0", "0", "30"], ["0", "0", "0", "19.996"]]);
  ok(r.ok && r.plan.ratio === 24999 && Math.abs(r.plan.area_m2 - 600) < 0.2, "the traverse's closure and area are worked out");
  const first = r.ok ? (r.geometry as any).coordinates[0][0] : [0, 0];
  // the same point from pyproj (Land Registry's engine): 7.467447212, 8.981148208
  ok(Math.abs(first[0] - 7.467447212) < 2e-8 && Math.abs(first[1] - 8.981148208) < 2e-8, "the grid is turned into longitude and latitude as Land Registry does (Minna datum)");
  ok(r.ok && (r.geometry as any).coordinates[0].length === 5, "the boundary is a closed ring of the four corners");
  const bad = plotTraverse(26332, ["331600", "993000"], [["90", "0", "0", "30"], ["180", "0", "0", "20"], ["270", "0", "0", "30"], ["0", "0", "0", "15"]]);
  ok(!bad.ok && /does not close/.test(bad.problem), "a traverse that does not close is refused with how far out it is");
  const far = plotTraverse(26332, ["1", "2"], [["90", "0", "0", "30"], ["180", "0", "0", "20"], ["270", "0", "0", "30"], ["0", "0", "0", "20"]]);
  ok(!far.ok && /outside Nigeria/.test(far.problem), "a wrong starting point that lands outside Nigeria is caught");
  const twisted = plotCoordinates(26332, [["0", "0"], ["10", "10"], ["10", "0"], ["0", "10"]].map(([e, n]) => [String(331600 + Number(e)), String(993000 + Number(n))]) as [string, string][]);
  ok(!twisted.ok && /crosses itself/.test(twisted.problem), "beacons out of order (a bow tie) are caught");
  ok(r.ok && readPlan(planText(r.plan))?.legs?.[3][3] === 19.996, "the plan is kept with the record and read back");

  const { render, screen, fireEvent, act } = await import("@testing-library/react");
  const { default: PlanPlotter } = await import("../../src/components/PlanPlotter");
  let used: any = null, preview: any = null;
  render(<PlanPlotter onPreview={(g) => { preview = g; }} onUse={(g, p) => { used = { g, p }; }} onCancel={() => undefined} />);
  const type = (label: string, v: string) => fireEvent.change(screen.getByLabelText(label), { target: { value: v } });
  type("Easting (m)", "331600"); type("Northing (m)", "993000");
  [["90", "30"], ["180", "20"], ["270", "30"], ["0", "20"]].forEach(([d, L], i) => { type(`Leg ${i + 1} Degrees`, d); type(`Leg ${i + 1} Distance (m)`, L); });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Plot it" })); });
  ok(!!screen.queryByText("Closes exactly") && !!preview, "plotting shows how it closes and previews it on the map");
  type("Leg 1 Seconds", "5");
  ok(!screen.queryByRole("button", { name: "Use this boundary" }), "changing a figure means plotting again");
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Plot it" })); });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Use this boundary" })); });
  ok(used?.g?.type === "Polygon" && used.p.legs[0][2] === 5 && used.p.grid === 26332, "the boundary and its plan go to the record");
  process.exit();
})();
