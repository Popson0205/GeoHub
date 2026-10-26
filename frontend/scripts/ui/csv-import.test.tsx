import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><body><div id=root></div></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
for (const k of ["window", "document", "navigator", "localStorage", "HTMLElement", "Node", "KeyboardEvent", "Event", "MouseEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "File", "Blob", "FileReader", "DragEvent"])
  try { Object.defineProperty(globalThis, k, { value: (dom.window as any)[k], configurable: true, writable: true }); } catch { /* read-only */ }
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).confirm = () => true; (dom.window as any).confirm = () => true;
const saved: Blob[] = [];                                   // what "Download ..." would have saved
for (const U of [dom.window.URL, globalThis.URL] as any[]) { U.createObjectURL = (b: Blob) => { saved.push(b); return "blob:test"; }; U.revokeObjectURL = () => undefined; }
(dom.window.HTMLAnchorElement.prototype as any).click = function () { /* no navigation in tests */ };
const ok = (c: boolean, m: string) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };

(async () => {
  const React = (await import("react")).default;
  const { render, screen, fireEvent, act, cleanup, within, waitFor } = await import("@testing-library/react");
  const { MemoryRouter, Route, Routes } = await import("react-router-dom");
  const { ToastProvider } = await import("../../src/components/ui");
  const { AuthProvider } = await import("../../src/lib/auth");
  const { loadApi } = await import("../../src/lib/api");
  const { default: DataPage } = await import("../../src/pages/DataPage");

  const api: any = await loadApi();
  await api.login("demo@geohub.test", "demo");
  const app = () => render(
    <MemoryRouter initialEntries={["/collect/p1/data"]}><AuthProvider><ToastProvider>
      <Routes><Route path="/collect/:projectId/data" element={<DataPage />} /></Routes>
    </ToastProvider></AuthProvider></MemoryRouter>);
  const upload = async (name: string, text: string) => {
    const input = screen.getByLabelText("CSV file to import") as HTMLInputElement;
    const file = new File([text], name, { type: "text/csv" });
    await act(async () => { fireEvent.change(input, { target: { files: [file] } }); await new Promise((r) => setTimeout(r, 50)); });
  };
  const pick = (label: RegExp | string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
  const before = (await api.listFeatures("p1")).length;

  // A semicolon file as Excel writes it: labels not ids, day-first dates, "Yes", a stray column, and some bad rows.
  const csv = [
    "Name;Type;Number of beds;Has electricity;Power source;Inspection date;Lat;Lon;Remarks",
    "Ola Clinic;clinic;12;Yes;Solar;04/03/2026;7.77;4.55;fine",
    "Bad Hospital;Hospital;ten;No;;05/03/2026;7.78;4.56;",
    "No Type;;5;No;;05/03/2026;7.79;4.57;",
    "Power Gap;Pharmacy;0;Yes;;06/03/2026;7.80;4.58;",
    "Last One;Hospital;40;No;;25/03/2026;7.81;4.59;",
  ].join("\r\n");

  let ui = app();
  await screen.findByText("Collected data");
  const open = screen.getByRole("button", { name: "Import CSV" });
  ok(!!open && !(open as HTMLButtonElement).disabled, "the Data page offers Import CSV to a project administrator");
  fireEvent.click(open);
  ok(!!screen.getByText("Import records from a CSV file") && !!screen.getByRole("button", { name: "Download a blank template" }), "it opens a panel with a template to download");

  // ---- wrong kinds of file are explained, not swallowed ----
  await upload("book.xlsx", "x");
  ok(/Save as .*CSV UTF-8/.test(screen.getByRole("alert").textContent ?? ""), "an Excel workbook is turned away with how to save it as CSV");
  await upload("shapes.geojson", "{}");
  ok(/map data, not a CSV/.test(screen.getByRole("alert").textContent ?? ""), "a map file is pointed to the map import");
  await upload("empty.csv", "");
  ok(/empty/.test(screen.getByRole("alert").textContent ?? ""), "an empty file is explained");

  // ---- the real file ----
  await upload("facilities.csv", csv);
  ok(!!screen.getByText("facilities.csv") && /5 rows/.test(document.body.textContent ?? "") && /separated by semicolons/.test(document.body.textContent ?? ""), "the file is read: name, rows, and the semicolons are noticed");
  ok((screen.getByLabelText("Longitude column") as HTMLSelectElement).value === "Lon" && (screen.getByLabelText("Latitude column") as HTMLSelectElement).value === "Lat", "the longitude and latitude columns are found even though they come in the other order");
  ok((screen.getByLabelText("Field for column Type") as HTMLSelectElement).value === "type" && (screen.getByLabelText("Field for column Number of beds") as HTMLSelectElement).value === "beds" && (screen.getByLabelText("Field for column Inspection date") as HTMLSelectElement).value === "inspected" && (screen.getByLabelText("Field for column Remarks") as HTMLSelectElement).value === "", "columns are matched to fields by their labels, and the stray one is left out");
  ok(/2 rows of 5 are ready to import/.test(document.body.textContent ?? "") && /3 rows have problems/.test(document.body.textContent ?? ""), "two rows are ready and three are held back");
  const problems = screen.getAllByRole("listitem").map((l) => l.textContent ?? "").join("\n");
  ok(/Row 3.*“ten” is not a number/.test(problems) && /Row 4.*Type is required/.test(problems) && /Row 5.*Power source is required/.test(problems), "each held-back row says which row and why, using the form's own rules (even the conditional one)");
  ok(/25\/03\/2026 has the day first/.test(document.body.textContent ?? ""), "the date order is settled from the file and explained");
  ok(/Not imported: Remarks/.test(document.body.textContent ?? ""), "columns that go nowhere are listed");

  // ---- changing a match changes the verdict ----
  pick("Field for column Name", "");
  ok(/required on the form but no column goes into it/.test(document.body.textContent ?? "") && /0 rows of 5/.test(document.body.textContent ?? "") && (screen.getByRole("button", { name: /Nothing to import yet/ }) as HTMLButtonElement).disabled, "un-matching a required field is flagged and nothing can be imported");
  pick("Field for column Name", "name");
  pick("Field for column Remarks", "name");
  ok((screen.getByLabelText("Field for column Name") as HTMLSelectElement).value === "", "giving a field to another column takes it from the first one");
  pick("Field for column Remarks", "");
  pick("Field for column Name", "name");
  ok(/2 rows of 5/.test(document.body.textContent ?? ""), "putting it back restores the count");
  pick("Mark the new records as", "draft");
  ok(/4 rows of 5/.test(document.body.textContent ?? ""), "as drafts, the rows missing required answers are allowed in (only the unreadable number is not)");
  pick("Mark the new records as", "submitted");
  const mdy = screen.queryByLabelText(/Dates like/);
  ok(!!mdy, "a day/month choice appears because the dates are not written 2026-03-04");

  // ---- the report of rows to fix ----
  saved.length = 0;
  fireEvent.click(screen.getByRole("button", { name: "Download the rows with problems" }));
  const report = saved.length ? await saved[0].text() : "";
  ok(/^\uFEFF?Row,Problem,Name,Type/.test(report) && report.includes("Bad Hospital") && report.includes("Power source is required"), "the rows with problems can be downloaded with the reason on each");

  // ---- import ----
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Import 2 records" })); await new Promise((r) => setTimeout(r, 400)); });
  await screen.findByText(/2 records imported/);
  const all = await api.listFeatures("p1");
  const ola = all.find((f: any) => f.properties.name === "Ola Clinic"), last = all.find((f: any) => f.properties.name === "Last One");
  ok(all.length === before + 2 && !all.some((f: any) => ["Bad Hospital", "No Type", "Power Gap"].includes(f.properties.name)), "only the two good rows were saved");
  ok(ola.properties.type === "Clinic" && ola.properties.beds === 12 && ola.properties.has_power === true && ola.properties.power_source === "Solar" && ola.properties.inspected === "2026-03-04" && ola.properties.remarks === undefined, "values arrive as the right types: choice, whole number, yes/no, date (04/03 read day-first)");
  ok(ola.geometry.coordinates[0] === 4.55 && ola.geometry.coordinates[1] === 7.77 && ola.status === "submitted" && last.properties.inspected === "2026-03-25", "the location is longitude then latitude, new records wait for review, and 25/03 is 25 March");
  ok(!!screen.getByRole("button", { name: "Download the rows left out" }), "after importing, the rows that were left out are still available to download");
  await waitFor(() => { if (!screen.queryByText("Ola Clinic")) throw new Error("not shown yet"); });
  ok(!!screen.getByText("Ola Clinic"), "the new records show up in the Collected data table");

  // ---- importing a second time starts clean ----
  fireEvent.click(screen.getByRole("button", { name: "Import another file" }));
  ok(!!screen.getByRole("button", { name: "Choose a CSV file" }), "Import another file goes back to choosing a file");
  cleanup();

  // ---- a polygon form wants a shape column, not coordinates ----
  ui = app();
  await screen.findByText("Collected data");
  fireEvent.change(document.getElementById("d-form")!, { target: { value: "f2" } });
  fireEvent.click(screen.getByRole("button", { name: "Import CSV" }));
  ok(/one column with the polygon as WKT or GeoJSON/.test(document.body.textContent ?? "") && !/longitude column and a latitude column/.test(document.body.textContent ?? ""), "a polygon form asks for a shape column");
  await upload("buildings.csv", 'Use,Floors,WKT\nResidential,2,"POLYGON((4.5 7.7,4.6 7.7,4.6 7.8,4.5 7.7))"\nShop,1,"POLYGON((4.5 7.7,4.6 7.7,4.6 7.8,4.5 7.7))"\nCommercial,3,POINT(4.5 7.7)');
  ok((screen.getByLabelText(/Column with the polygon/) as HTMLSelectElement).value === "WKT" && /1 row of 3 is ready/.test(document.body.textContent ?? ""), "the WKT column is found; one building is good, a point and an unknown use are held back");
  ok(/collects polygons, not points/.test(document.body.textContent ?? "") && /“Shop” is not one of the options/.test(document.body.textContent ?? ""), "the reasons are given");
  const n0 = (await api.listFeatures("p1")).length;
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Import 1 record" })); await new Promise((r) => setTimeout(r, 400)); });
  await screen.findByText(/1 record imported/);
  const poly = (await api.listFeatures("p1")).find((f: any) => f.properties.use === "Residential" && f.geometry.type === "Polygon" && f.properties.levels === 2);
  ok((await api.listFeatures("p1")).length === n0 + 1 && !!poly && poly.geometry.coordinates[0].length === 4, "the polygon was saved with its ring");
  cleanup();

  // ---- the server's own answer when nothing is usable ----
  const form1 = (await api.listForms("p1")).find((f: any) => f.id === "f1");
  const job = await api.importFeatures("p1", new File(["name,type,__lon,__lat\n,Clinic,4,7\n"], "x.csv", { type: "text/csv" }), form1.id, { lon: "__lon", lat: "__lat" });
  ok(job.status === "failed" && job.result?.rejected === 1 && /Name is required/.test(job.result?.errors?.[0]?.message ?? ""), "the API reports row errors, and a job with nothing importable fails clearly");
})().catch((e) => { console.error(e); process.exit(1); });
