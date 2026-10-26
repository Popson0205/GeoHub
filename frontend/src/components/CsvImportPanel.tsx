import { useId, useMemo, useRef, useState, type DragEvent } from "react";
import { loadApi } from "../lib/api";
import { download } from "../lib/csv";
import {
  MAX_IMPORT_MB, MAX_IMPORT_ROWS, autoMap, buildUploadCsv, delimiterName, detectLocation, guessDateOrder,
  importableFields, parseCsv, prepare, problemsCsv, templateCsv, type DateOrder, type ImportStatus, type Location, type Parsed, type RowProblem,
} from "../lib/csvImport";
import { GEOMETRY_LABEL, type Form } from "../lib/types";
import { Button, useToast } from "./ui";

const STATUS_LABEL: Record<ImportStatus, string> = { submitted: "Waiting for review", approved: "Approved", draft: "Draft" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "data";
const plural = (n: number, one: string, many = one + "s") => `${n.toLocaleString()} ${n === 1 ? one : many}`;

interface Outcome { imported: number; serverRejected: { row: number; message: string }[]; failed?: string; left: RowProblem[]; parsed: Parsed; status: ImportStatus }

/**
 * Import many records into one form from a CSV file. Nothing is saved until the person presses Import, and only the rows that
 * pass the form's own rules are sent. The rest are listed with the reason, and can be downloaded, fixed and imported again.
 */
export default function CsvImportPanel({ projectId, form, onClose, onImported }: {
  projectId: string; form: Form; onClose: () => void; onImported: (count: number) => void;
}) {
  const toast = useToast();
  const uid = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const fields = useMemo(() => importableFields(form), [form]);
  const point = form.geometry_type === "Point";

  const [fileName, setFileName] = useState("");
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [over, setOver] = useState(false);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [locMode, setLocMode] = useState<"lonlat" | "geometry">(point ? "lonlat" : "geometry");
  const [cols, setCols] = useState({ lon: "", lat: "", geom: "" });
  const [status, setStatus] = useState<ImportStatus>("submitted");
  const [dateOrder, setDateOrder] = useState<DateOrder>("dmy");
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const location: Location = locMode === "lonlat"
    ? (cols.lon && cols.lat ? { kind: "lonlat", lon: cols.lon, lat: cols.lat } : { kind: "none" })
    : (cols.geom ? { kind: "geometry", column: cols.geom } : { kind: "none" });
  const prepared = useMemo(() => (parsed ? prepare(parsed, { form, mapping, location, dateOrder, status }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [parsed, form, mapping, locMode, cols.lon, cols.lat, cols.geom, dateOrder, status]);

  // Columns holding dates written as 4/3/2026 need to be told which comes first, the day or the month.
  const dateColumns = useMemo(() => (parsed ? parsed.headers.filter((h) => { const f = fields.find((x) => x.id === mapping[h]); return f && (f.type === "date" || f.type === "datetime"); }) : []), [parsed, fields, mapping]);
  const dateGuess = useMemo(() => guessDateOrder(dateColumns.flatMap((h) => parsed!.rows.map((r) => r[parsed!.headers.indexOf(h)]))), [parsed, dateColumns]);
  const needsDateChoice = dateColumns.length > 0 && !dateGuess.iso;

  function reset() { setParsed(null); setFileName(""); setError(""); setNotice(""); setMapping({}); setOutcome(null); setShowAll(false); setProgress(0); if (fileInput.current) fileInput.current.value = ""; }

  async function readFile(file: File) {
    setError(""); setNotice("");
    const lower = file.name.toLowerCase();
    if (/\.(xlsx|xls|xlsm|ods)$/.test(lower)) return setError("That is a spreadsheet file. In Excel or Sheets choose File, then Save as (or Download as), and pick “CSV UTF-8”. Then choose that file here.");
    if (/\.(geojson|json|kml|gpx|gpkg|zip)$/.test(lower)) return setError("That is map data, not a CSV. Use the map editor’s import for GeoJSON, KML, GPX, GeoPackage and Shapefile files.");
    if (file.size > MAX_IMPORT_MB * 1024 * 1024) return setError(`That file is larger than ${MAX_IMPORT_MB} MB. Split it into smaller files.`);
    let text: string;
    try {
      const buf = await file.arrayBuffer();
      text = new TextDecoder("utf-8").decode(buf);
      if (text.includes("\uFFFD")) { text = new TextDecoder("windows-1252").decode(buf); setNotice("This file is not UTF-8, so it was read as Windows-1252 (what Excel’s plain “CSV” uses). If any letters look wrong, save it as “CSV UTF-8” and choose it again."); }
    } catch { return setError("That file could not be read."); }
    const p = parseCsv(text);
    if (!p.headers.length) return setError("That file is empty. The first row must hold the column names.");
    if (!p.rows.length) return setError("That file has column names but no rows of data.");
    if (p.rows.length > MAX_IMPORT_ROWS) return setError(`That file has ${p.rows.length.toLocaleString()} rows. The limit is ${MAX_IMPORT_ROWS.toLocaleString()} at a time. Split it into smaller files.`);
    const loc = detectLocation(p.headers, form.geometry_type);
    const skip = new Set(loc.kind === "lonlat" ? [loc.lon, loc.lat] : loc.kind === "geometry" ? [loc.column] : []);
    const map = autoMap(p.headers, fields, skip);
    setLocMode(loc.kind === "lonlat" ? "lonlat" : point && loc.kind === "none" ? "lonlat" : "geometry");
    setCols({ lon: loc.kind === "lonlat" ? loc.lon : "", lat: loc.kind === "lonlat" ? loc.lat : "", geom: loc.kind === "geometry" ? loc.column : "" });
    const dateIds = new Set(fields.filter((f) => f.type === "date" || f.type === "datetime").map((f) => f.id));
    const guess = guessDateOrder(p.headers.filter((h) => dateIds.has(map[h])).flatMap((h) => p.rows.map((r) => r[p.headers.indexOf(h)])));
    setDateOrder(guess.order);
    setMapping(map); setParsed(p); setFileName(file.name);
  }
  const onDrop = (e: DragEvent) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files?.[0]; if (f) void readFile(f); };

  /** Choosing a field for a column takes it away from any other column that had it. */
  const setField = (header: string, id: string) => setMapping((cur) => {
    const next = { ...cur, [header]: id };
    if (id) for (const k of Object.keys(next)) if (k !== header && next[k] === id) next[k] = "";
    return next;
  });

  async function run() {
    if (!parsed || !prepared || !prepared.valid.length) return;
    const ids = [...new Set(Object.values(mapping).filter(Boolean))];
    const built = buildUploadCsv(prepared.valid, ids, form.geometry_type);
    if (built.text.length > MAX_IMPORT_MB * 1024 * 1024) return setError(`The rows to import are larger than ${MAX_IMPORT_MB} MB. Split the file into smaller files.`);
    setError(""); setBusy(true); setProgress(0);
    const sent = prepared.valid, left = prepared.problems, usedStatus = status;
    try {
      const api = await loadApi();
      const upload = new File([built.text], `${(fileName.replace(/\.[^.]*$/, "") || "import")}.csv`, { type: "text/csv" });
      let job = await api.importFeatures(projectId, upload, form.id, { status: usedStatus, ...built.location });
      for (let i = 0; i < 300 && job.status !== "done" && job.status !== "failed"; i++) { await sleep(1000); job = await api.getJob(job.id); setProgress(job.progress); }
      if (job.status !== "done" && job.status !== "failed") throw new Error("This is taking longer than expected. Check Collected data in a minute to see whether the records arrived.");
      const r = job.result;
      // The server counts rows in the file it was sent. Turn them back into row numbers in the person's own file.
      const rejected = (r?.errors ?? []).map((e) => ({ row: sent[e.row - 2]?.rowNo ?? e.row, message: e.message }));
      const imported = r?.imported ?? 0;
      setOutcome({ imported, serverRejected: rejected, failed: job.status === "failed" ? job.error ?? "The import failed." : undefined, left, parsed, status: usedStatus });
      if (imported > 0) { onImported(imported); toast(`Imported ${plural(imported, "record")} into “${form.name}”.`, "success"); }
    } catch (e) { setError(e instanceof Error ? e.message : "The import failed."); }
    finally { setBusy(false); }
  }

  const saveProblems = (p: Parsed, list: RowProblem[]) => download(`${slug(form.name)}-rows-to-fix.csv`, problemsCsv(p, list), "text/csv;charset=utf-8");

  // ---------------------------------------------------------------------------------------------------- finished
  if (outcome) {
    const bad = outcome.serverRejected, skipped = outcome.left.length;
    return (
      <section className="card csv-import" aria-labelledby={`${uid}-h`}>
        <div className="row"><h2 id={`${uid}-h`}>Import finished</h2><span className="grow" /><Button small onClick={onClose}>Close</Button></div>
        {outcome.failed
          ? <p role="alert" className="csv-bad"><strong>Nothing was imported.</strong> {outcome.failed}</p>
          : <p role="status"><strong>{plural(outcome.imported, "record")} imported</strong> into “{form.name}” as {STATUS_LABEL[outcome.status].toLowerCase()}.
            {outcome.status === "submitted" && " They are in the table now. Select them to approve or reject."}</p>}
        {skipped > 0 && <p className="meta">{plural(skipped, "row")} in your file {skipped === 1 ? "was" : "were"} left out because of the problems listed before importing.</p>}
        {bad.length > 0 && (
          <div><p className="meta"><strong>{plural(bad.length, "row")} {bad.length === 1 ? "was" : "were"} rejected by the server:</strong></p>
            <ul className="csv-problems">{bad.slice(0, 20).map((b) => <li key={b.row}><b>Row {b.row}</b> {b.message}</li>)}</ul></div>)}
        <div className="row" style={{ flexWrap: "wrap" }}>
          {skipped > 0 && <Button small onClick={() => saveProblems(outcome.parsed, outcome.left)}>Download the rows left out</Button>}
          <Button small onClick={reset}>Import another file</Button>
          <Button small variant="primary" onClick={onClose}>Done</Button>
        </div>
      </section>
    );
  }

  // ---------------------------------------------------------------------------------------------------- choose a file
  if (!parsed || !prepared) {
    return (
      <section className="card csv-import" aria-labelledby={`${uid}-h`}>
        <div className="row"><h2 id={`${uid}-h`}>Import records from a CSV file</h2><span className="grow" /><Button small onClick={onClose}>Close</Button></div>
        <p className="meta">Add many records to “{form.name}” at once. Each row becomes one record. You will check everything before anything is saved.</p>
        <div className={`csv-drop${over ? " is-over" : ""}`} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop}>
          <Button variant="primary" onClick={() => fileInput.current?.click()}>Choose a CSV file</Button>
          <span className="meta">or drop it here</span>
          <input ref={fileInput} type="file" accept=".csv,.tsv,.txt,text/csv,text/plain" className="sr-only" aria-label="CSV file to import" onChange={(e) => { const f = e.target.files?.[0]; if (f) void readFile(f); }} />
        </div>
        {error && <p role="alert" className="csv-bad">{error}</p>}
        <ul className="csv-help">
          <li>The first row holds the column names. Comma, semicolon and tab files all work.</li>
          <li>{point
            ? "Every row needs a location: a longitude column and a latitude column (decimal degrees), or one column with a WKT or GeoJSON point."
            : `Every row needs a location: one column with the ${GEOMETRY_LABEL[form.geometry_type]} as WKT or GeoJSON, in longitude and latitude degrees.`}</li>
          <li>Columns are matched to fields by name. You can change any match on the next screen.</li>
          <li>Up to {MAX_IMPORT_MB} MB and {MAX_IMPORT_ROWS.toLocaleString()} rows at a time. Photos and other attachments cannot be imported.</li>
        </ul>
        <div><Button small onClick={() => download(`${slug(form.name)}-template.csv`, templateCsv(form), "text/csv;charset=utf-8")}>Download a blank template</Button></div>
      </section>
    );
  }

  // ---------------------------------------------------------------------------------------------------- review
  const { valid, problems } = prepared;
  const shown = showAll ? problems.slice(0, 100) : problems.slice(0, 6);
  const sample = (h: string) => { const i = parsed.headers.indexOf(h); return parsed.rows.map((r) => r[i]).filter((v) => v.trim() !== "").slice(0, 2).join(" · "); };
  const headerOptions = <>{parsed.headers.map((h) => <option key={h} value={h}>{h}</option>)}</>;
  const canImport = valid.length > 0 && !busy;

  return (
    <section className="card csv-import" aria-labelledby={`${uid}-h`}>
      <div className="row"><h2 id={`${uid}-h`}>Import records from a CSV file</h2><span className="grow" /><Button small onClick={onClose}>Close</Button></div>
      <p className="meta"><strong>{fileName}</strong> · {plural(parsed.rows.length, "row")} · {plural(parsed.headers.length, "column")} · separated by {delimiterName(parsed.delimiter)}
        {" "}<Button small onClick={reset}>Choose another file</Button></p>
      {notice && <p className="meta" role="status">{notice}</p>}

      <div className="csv-step">
        <h3>1. Where are the records?</h3>
        {point && (
          <div className="field"><label htmlFor={`${uid}-mode`}>The location is in</label>
            <select id={`${uid}-mode`} value={locMode} onChange={(e) => setLocMode(e.target.value as "lonlat" | "geometry")}>
              <option value="lonlat">Two columns: longitude and latitude</option><option value="geometry">One column with a WKT or GeoJSON point</option>
            </select></div>)}
        {locMode === "lonlat"
          ? <div className="csv-pair">
            <div className="field"><label htmlFor={`${uid}-lon`}>Longitude column</label><select id={`${uid}-lon`} value={cols.lon} onChange={(e) => setCols({ ...cols, lon: e.target.value })}><option value="">Choose…</option>{headerOptions}</select></div>
            <div className="field"><label htmlFor={`${uid}-lat`}>Latitude column</label><select id={`${uid}-lat`} value={cols.lat} onChange={(e) => setCols({ ...cols, lat: e.target.value })}><option value="">Choose…</option>{headerOptions}</select></div>
          </div>
          : <div className="field"><label htmlFor={`${uid}-geom`}>Column with the {GEOMETRY_LABEL[form.geometry_type]} (WKT or GeoJSON)</label><select id={`${uid}-geom`} value={cols.geom} onChange={(e) => setCols({ ...cols, geom: e.target.value })}><option value="">Choose…</option>{headerOptions}</select></div>}
        <small className="meta">Coordinates are decimal degrees in WGS 84, the same as GPS.</small>
      </div>

      <div className="csv-step">
        <h3>2. Match the columns to the form’s fields</h3>
        <div className="csv-scroll">
          <table className="csv-map">
            <caption className="sr-only">Which column of your file goes into which field</caption>
            <thead><tr><th scope="col">Column in your file</th><th scope="col">Example</th><th scope="col">Goes into</th></tr></thead>
            <tbody>
              {parsed.headers.map((h) => (
                <tr key={h}>
                  <th scope="row">{h}</th>
                  <td className="meta">{sample(h) || "(empty)"}</td>
                  <td>
                    <select aria-label={`Field for column ${h}`} value={mapping[h] ?? ""} onChange={(e) => setField(h, e.target.value)}>
                      <option value="">Do not import</option>
                      {fields.map((f) => <option key={f.id} value={f.id}>{f.label || f.id}</option>)}
                    </select>
                    {(cols.lon === h || cols.lat === h || cols.geom === h) && !mapping[h] && <small className="meta"> used for the location</small>}
                  </td>
                </tr>))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="csv-step csv-options">
        <h3>3. Options</h3>
        <div className="field"><label htmlFor={`${uid}-status`}>Mark the new records as</label>
          <select id={`${uid}-status`} value={status} onChange={(e) => setStatus(e.target.value as ImportStatus)}>
            {(Object.keys(STATUS_LABEL) as ImportStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
          </select>
          {status === "draft" && <small className="meta">Drafts can be incomplete: required fields are not checked.</small>}</div>
        {needsDateChoice && (
          <div className="field"><label htmlFor={`${uid}-dates`}>Dates like 03/04/2026 are written</label>
            <select id={`${uid}-dates`} value={dateOrder} onChange={(e) => setDateOrder(e.target.value as DateOrder)}>
              <option value="dmy">Day / month / year (3 April)</option><option value="mdy">Month / day / year (4 March)</option>
            </select>
            <small className="meta">{dateGuess.decisive ? `Your file settles it: ${dateGuess.order === "dmy" ? "a value like 25/03/2026 has the day first." : "a value like 03/25/2026 has the month first."}` : "Nothing in the file settles it, so check this."}</small></div>)}
      </div>

      <div className="csv-step" aria-live="polite">
        <h3>4. Check</h3>
        {prepared.locationMissing
          ? <p className="csv-warn" role="status">Choose the location {locMode === "lonlat" ? "columns" : "column"} above. Without {locMode === "lonlat" ? "them" : "it"} no record can be imported.</p>
          : <p><strong>{plural(valid.length, "row")} of {parsed.rows.length.toLocaleString()} {valid.length === 1 ? "is" : "are"} ready to import.</strong>
            {problems.length > 0 && <> {plural(problems.length, "row")} {problems.length === 1 ? "has a problem and will be" : "have problems and will be"} left out.</>}</p>}
        {prepared.missingRequired.length > 0 && (
          <p className="csv-warn">{prepared.missingRequired.map((f) => `“${f.label || f.id}”`).join(", ")} {prepared.missingRequired.length === 1 ? "is" : "are"} required on the form but no column goes into {prepared.missingRequired.length === 1 ? "it" : "them"}. Match a column in step 2, or every row will be held back.</p>)}
        {prepared.ignoredColumns.length > 0 && <p className="meta">Not imported: {prepared.ignoredColumns.join(", ")}.</p>}
        {problems.length > 0 && !prepared.locationMissing && (
          <>
            <ul className="csv-problems">{shown.map((p) => <li key={p.rowNo}><b>Row {p.rowNo}</b> {p.messages.join(" ")}</li>)}</ul>
            <div className="row" style={{ flexWrap: "wrap" }}>
              {problems.length > 6 && <Button small onClick={() => setShowAll((s) => !s)}>{showAll ? "Show fewer" : `Show ${Math.min(problems.length, 100)} of ${problems.length.toLocaleString()}`}</Button>}
              <Button small onClick={() => saveProblems(parsed, problems)}>Download the rows with problems</Button>
            </div>
            <small className="meta">Fix those rows in a spreadsheet and import the file again, or leave them out.</small>
          </>)}
      </div>

      {error && <p role="alert" className="csv-bad">{error}</p>}
      <div className="row" style={{ flexWrap: "wrap" }}>
        <Button variant="primary" busy={busy} disabled={!canImport} onClick={() => void run()}>
          {busy ? `Importing… ${progress}%` : valid.length ? `Import ${plural(valid.length, "record")}` : "Nothing to import yet"}
        </Button>
        <Button onClick={onClose} disabled={busy}>Cancel</Button>
      </div>
    </section>
  );
}
