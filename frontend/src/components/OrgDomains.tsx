import { useEffect, useState, type FormEvent } from "react";
import { Button, useConfirm, useToast } from "./ui";
import { loadApi } from "../lib/api";
import type { DomainRole, OrgDomain } from "../lib/types";

const JOIN_AS: Record<DomainRole, string> = { member: "Member", collector: "Field collector", viewer: "Viewer" };

/** An organization's company email domains: add one, prove it with a DNS record, and choose how people join. */
export default function OrgDomains({ onChange }: { onChange?: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [list, setList] = useState<OrgDomain[] | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notFound, setNotFound] = useState<Record<string, string>>({});

  useEffect(() => { void loadApi().then((api) => api.listDomains()).then(setList, () => setList([])); }, []);
  const put = (d: OrgDomain) => setList((l) => l!.map((x) => (x.domain === d.domain ? d : x)));
  const msg = (e: unknown, what: string) => (e instanceof Error ? e.message : what);

  async function add(e: FormEvent) {
    e.preventDefault();
    setBusy("add"); setError("");
    try { const d = await (await loadApi()).addDomain(draft); setList((l) => [...(l ?? []), d]); setDraft(""); }
    catch (err) { setError(msg(err, "Could not add the domain.")); } finally { setBusy(null); }
  }
  async function verify(d: OrgDomain) {
    setBusy(d.domain); setNotFound((n) => ({ ...n, [d.domain]: "" }));
    try { put(await (await loadApi()).verifyDomain(d.domain)); toast(`${d.domain} is verified.`, "success"); onChange?.(); }
    catch (err) { setNotFound((n) => ({ ...n, [d.domain]: msg(err, "Not verified yet.") })); } finally { setBusy(null); }
  }
  async function update(d: OrgDomain, patch: { auto_join?: boolean; role?: DomainRole }) {
    setBusy(d.domain);
    try { put(await (await loadApi()).updateDomain(d.domain, patch)); } catch (err) { toast(msg(err, "Could not save."), "error"); } finally { setBusy(null); }
  }
  async function remove(d: OrgDomain) {
    if (!(await confirm({ title: `Remove ${d.domain}?`, danger: true, confirmLabel: "Remove domain",
      message: "New people on this domain stop joining by it. People already in the organization stay." }))) return;
    setBusy(d.domain);
    try { await (await loadApi()).removeDomain(d.domain); setList((l) => l!.filter((x) => x.domain !== d.domain)); }
    catch (err) { toast(msg(err, "Could not remove."), "error"); } finally { setBusy(null); }
  }
  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); toast("Copied.", "success"); } catch { toast("Select the value and copy it.", "info"); }
  }

  return (
    <section className="card org-domains" aria-labelledby="org-domains-h">
      <h2 id="org-domains-h">Company email domains</h2>
      <p className="field-hint">People with an email on your domain join your organization when they sign up: at once with Google or Microsoft, or after confirming a link we email them. They count against your plan like anyone you add.</p>
      <form className="org-rename" onSubmit={add}>
        <div className="field"><label htmlFor="dom-new" className="sr-only">Domain</label>
          <input id="dom-new" placeholder="yourcompany.com" value={draft} onChange={(e) => setDraft(e.target.value)} autoComplete="off" spellCheck={false} /></div>
        <Button type="submit" busy={busy === "add"} disabled={!draft.trim()}>Add domain</Button>
      </form>
      {error && <div className="field-error" role="alert">{error}</div>}
      {list && list.length > 0 && (
        <ul className="org-domain-list">
          {list.map((d) => (
            <li key={d.domain}>
              <div className="org-domain-head">
                <strong>{d.domain}</strong>
                <span className={`badge ${d.verified ? "badge-ok" : "badge-warn"}`}>{d.verified ? "Verified" : "Not verified"}</span>
              </div>
              {d.verified ? (
                <div className="org-domain-opts">
                  <label className="check"><input type="checkbox" checked={d.auto_join} disabled={busy === d.domain} onChange={(e) => void update(d, { auto_join: e.target.checked })} /> New sign-ups join automatically</label>
                  <label className="org-domain-role">They join as
                    <select className="input" value={d.role} disabled={busy === d.domain || !d.auto_join} onChange={(e) => void update(d, { role: e.target.value as DomainRole })}>
                      {(Object.keys(JOIN_AS) as DomainRole[]).map((r) => <option key={r} value={r}>{JOIN_AS[r]}</option>)}
                    </select>
                  </label>
                </div>
              ) : (
                <div className="org-domain-dns">
                  <p>To prove the domain is yours, add this record where you manage its DNS (your domain registrar or host), then check:</p>
                  <dl>
                    <div><dt>Type</dt><dd><code>TXT</code></dd></div>
                    <div><dt>Name</dt><dd><code>@</code> <span className="muted">(the domain itself)</span></dd></div>
                    <div><dt>Value</dt><dd><code className="org-domain-value">{d.record.value}</code> <Button small variant="ghost" onClick={() => void copy(d.record.value)} aria-label={`Copy the record value for ${d.domain}`}>Copy</Button></dd></div>
                  </dl>
                  {notFound[d.domain] && <div className="field-error" role="alert">{notFound[d.domain]}</div>}
                  <p className="field-hint">Can't change DNS? GeoEstate can verify it for you.</p>
                </div>
              )}
              <div className="org-domain-actions">
                {!d.verified && <Button small onClick={() => void verify(d)} busy={busy === d.domain}>Check now</Button>}
                <Button small variant="ghost" onClick={() => void remove(d)} disabled={busy === d.domain} aria-label={`Remove ${d.domain}`}>Remove</Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
