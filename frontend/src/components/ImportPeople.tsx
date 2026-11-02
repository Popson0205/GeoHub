import { useRef, useState } from "react";
import { Button, useToast } from "./ui";
import { loadApi } from "../lib/api";
import { csvEscape, download } from "../lib/csv";
import type { AddableRole, ImportResult, Org, PeopleKind } from "../lib/types";

const KIND_WORD: Record<PeopleKind, string> = { seats: "team seats", collectors: "field collectors", viewers: "viewers" };
const ROLE_WORD: Record<string, string> = { admin: "Administrator", member: "Member", collector: "Field collector", viewer: "Viewer" };
const TEMPLATE = "email,name,role,team,projects\nada@yourcompany.com,Ada Obi,field collector,North team,Ikeja survey; Lekki survey\nbola@yourcompany.com,Bola Ade,member,,\n";

/** Add many people at once from a spreadsheet: check it first (nothing changes), then add everyone or no one. */
export default function ImportPeople({ org, onDone }: { org: Org; onDone: () => void }) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [role, setRole] = useState<AddableRole>("collector");
  const [delivery, setDelivery] = useState<"email" | "temporary">("email");
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"check" | "add" | null>(null);
  const roles: AddableRole[] = ["collector", "viewer", "member", ...(org.role === "owner" ? ["admin" as AddableRole] : [])];

  async function run(preview: boolean) {
    if (!file) return;
    setBusy(preview ? "check" : "add"); setError("");
    try {
      const r = await (await loadApi()).importPeople(file, { preview, delivery, default_role: role });
      setResult(r);
      if (r.done) {
        const n = r.rows.length;
        toast(`${n} ${n === 1 ? "person" : "people"} added.${r.emails_queued ? ` Welcome emails are on their way to ${r.emails_queued}.` : ""}`, "success");
        onDone();
      }
    } catch (e) { setError(e instanceof Error ? e.message : "Could not read the file."); }
    finally { setBusy(null); }
  }
  function reset() { setFile(null); setResult(null); setError(""); if (input.current) input.current.value = ""; }
  function passwordsCsv() {
    const rows = result!.rows.filter((r) => r.temporary_password);
    download("geohub-temporary-passwords.csv", ["email,name,temporary password", ...rows.map((r) => [r.email, r.name, r.temporary_password].map(csvEscape).join(","))].join("\n") + "\n", "text/csv");
  }

  if (!open) return (
    <section className="card import-people" aria-labelledby="imp-h">
      <h2 id="imp-h">Add many people</h2>
      <p className="field-hint">From a spreadsheet: one row per person, with their email and name, and optionally their role, team and projects.</p>
      <Button onClick={() => setOpen(true)}>Add from a spreadsheet</Button>
    </section>
  );

  const errors = result?.rows.filter((r) => r.status === "error").length ?? 0;
  const short = result?.capacity.filter((c) => c.left != null && c.needed > c.left) ?? [];
  return (
    <section className="card import-people" aria-labelledby="imp-h">
      <h2 id="imp-h">Add many people</h2>
      {!result?.done && (
        <>
          <ol className="import-steps">
            <li>Make a spreadsheet with the columns <strong>email</strong> and <strong>name</strong>; <strong>role</strong>, <strong>team</strong> and
              <strong> projects</strong> (separated by ;) are optional. Teams and projects must already exist.{" "}
              <a href="#" onClick={(e) => { e.preventDefault(); download("geohub-people-template.csv", TEMPLATE, "text/csv"); }}>Download a template</a>.</li>
            <li>Save it as Excel (.xlsx) or CSV, and choose it here.</li>
          </ol>
          <div className="import-form">
            <div className="field">
              <label htmlFor="imp-file">Spreadsheet</label>
              <input id="imp-file" ref={input} type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                onChange={(e) => { setFile(e.target.files?.[0] ?? null); setResult(null); setError(""); }} />
            </div>
            <div className="field">
              <label htmlFor="imp-role">Role when the row has none</label>
              <select id="imp-role" className="input" value={role} onChange={(e) => { setRole(e.target.value as AddableRole); setResult(null); }}>
                {roles.map((r) => <option key={r} value={r}>{ROLE_WORD[r]}</option>)}
              </select>
            </div>
            <fieldset className="import-delivery">
              <legend>How they sign in</legend>
              <label><input type="radio" name="imp-delivery" checked={delivery === "email"} onChange={() => setDelivery("email")} /> Email each a link to choose a password</label>
              <label><input type="radio" name="imp-delivery" checked={delivery === "temporary"} onChange={() => setDelivery("temporary")} /> Temporary passwords, to download and hand out</label>
            </fieldset>
          </div>
          <div className="row-actions">
            <Button variant={result?.ok ? "default" : "primary"} disabled={!file} busy={busy === "check"} onClick={() => void run(true)}>Check the file</Button>
            {result?.ok && <Button variant="primary" busy={busy === "add"} onClick={() => void run(false)}>Add {result.rows.length} {result.rows.length === 1 ? "person" : "people"}</Button>}
            <Button variant="ghost" onClick={() => { reset(); setOpen(false); }}>Close</Button>
          </div>
        </>
      )}
      {error && <div className="field-error" role="alert">{error}</div>}
      {result && (
        <div className="import-result" role="status">
          {result.done ? (
            <p><strong>Done.</strong> {result.rows.length} added{result.emails_queued ? `; welcome emails are on their way to ${result.emails_queued}` : ""}.</p>
          ) : result.ok ? (
            <p><strong>Ready.</strong> All {result.rows.length} rows can be added. Nothing has changed yet.</p>
          ) : (
            <p className="import-bad"><strong>Nothing can be added yet.</strong> {errors > 0 && `${errors} ${errors === 1 ? "row needs" : "rows need"} fixing. `}
              {short.map((c) => `The plan has ${c.left} ${KIND_WORD[c.kind]} left; the file needs ${c.needed}. `).join("")}
              Fix the file and check it again.</p>
          )}
          <div className="table-wrap">
            <table className="data-table import-table">
              <thead><tr><th scope="col">Row</th><th scope="col">Person</th><th scope="col">Role</th><th scope="col">Team and projects</th><th scope="col">Status</th></tr></thead>
              <tbody>
                {result.rows.map((r) => (
                  <tr key={r.row} className={r.status === "error" ? "is-bad" : undefined}>
                    <td className="tnum muted">{r.row}</td>
                    <td><strong>{r.name || "—"}</strong><br /><span className="muted">{r.email}</span></td>
                    <td>{ROLE_WORD[r.role] ?? r.role}</td>
                    <td className="muted">{[r.team, ...r.projects].filter(Boolean).join(" · ") || "—"}</td>
                    <td>{r.status === "error" ? <span className="import-err">{r.error}</span>
                      : r.status === "existing" ? <span className="badge badge-info">Has an account: brought in</span>
                      : r.status === "added" ? <span className="badge badge-ok">Brought in</span>
                      : r.status === "created" ? (r.temporary_password ? <code className="org-temp-pw">{r.temporary_password}</code> : <span className="badge badge-ok">Created</span>)
                      : <span className="badge badge-quiet">New account</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {result.done && (
            <div className="row-actions">
              {result.rows.some((r) => r.temporary_password) && <Button variant="primary" onClick={passwordsCsv}>Download the temporary passwords</Button>}
              <Button onClick={reset}>Add another file</Button>
            </div>
          )}
          {result.done && result.rows.some((r) => r.temporary_password) && <p className="field-hint">The passwords are shown only now. Each person chooses their own at first sign-in.</p>}
        </div>
      )}
    </section>
  );
}
