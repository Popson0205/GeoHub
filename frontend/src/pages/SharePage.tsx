import { useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { Button, EmptyState, ErrorState, Loading, useConfirm, useToast } from "../components/ui";
import { loadApi } from "../lib/api";
import { useAsync } from "../lib/hooks";
import { shareUrl } from "../lib/share";
import type { Role, ShareMode } from "../lib/types";

const MODES: { id: ShareMode; title: string; text: string }[] = [
  { id: "public", title: "Public", text: "Anyone with the link can fill in the form. They do not need to sign in." },
  { id: "collaborators", title: "Collaborators only", text: "Only people you add below. They sign in (or create an account) to collect." },
];
const ROLE_LABEL: Record<string, string> = { owner: "Owner", admin: "Admin", collector: "Collector", viewer: "Viewer" };

/** Where a form owner copies the link, decides who may use it, and adds collaborators. */
export default function SharePage() {
  const { projectId = "", formId = "" } = useParams();
  const toast = useToast();
  const confirm = useConfirm();
  const form = useAsync((api) => api.getForm(formId), [formId]);
  const sharing = useAsync((api) => api.getSharing(formId), [formId]);
  const members = useAsync((api) => api.listProjectMembers(projectId), [projectId]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Exclude<Role, "owner">>("collector");
  const [busy, setBusy] = useState(false);

  if (form.loading || sharing.loading) return <div className="container"><Loading /></div>;
  const err = form.error ?? sharing.error;
  if (err != null || !form.data || !sharing.data) return <div className="container"><ErrorState error={err} onRetry={() => { void form.reload(); void sharing.reload(); }} /></div>;
  const s = sharing.data;
  const url = shareUrl(form.data.name, s.share_token);

  async function copy() {
    try { await navigator.clipboard.writeText(url); toast("Link copied.", "success"); }
    catch { toast("Could not copy. Select the link and copy it by hand.", "error"); }
  }
  async function setMode(m: ShareMode) {
    if (m === s.share_mode) return;
    try { sharing.setData(await (await loadApi()).setSharing(formId, { share_mode: m })); toast(m === "public" ? "The link is now public." : "Only collaborators can use the link now.", "success"); }
    catch (e) { toast(e instanceof Error ? e.message : "Could not change sharing.", "error"); }
  }
  async function renew() {
    if (!(await confirm({ title: "Create a new link?", message: "The old link stops working straight away. Anyone using it will need the new one.", confirmLabel: "Create new link", danger: true }))) return;
    try { sharing.setData(await (await loadApi()).setSharing(formId, { regenerate_link: true })); toast("New link created.", "success"); }
    catch (e) { toast(e instanceof Error ? e.message : "Could not create a new link.", "error"); }
  }
  async function add(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await (await loadApi()).addProjectMember(projectId, email.trim(), role);
      toast(`Added ${email.trim()}.`, "success");
      setEmail("");
      await members.reload();
    } catch (er) { toast(er instanceof Error ? er.message : "Could not add that person.", "error"); }
    finally { setBusy(false); }
  }
  async function changeRole(id: string, r: Role) {
    try { await (await loadApi()).setProjectMemberRole(projectId, id, r); await members.reload(); }
    catch (er) { toast(er instanceof Error ? er.message : "Could not change the role.", "error"); }
  }
  async function remove(id: string, who: string) {
    if (!(await confirm({ title: `Remove ${who}?`, message: "They lose access to this project and its data.", confirmLabel: "Remove", danger: true }))) return;
    try { await (await loadApi()).removeProjectMember(projectId, id); await members.reload(); }
    catch (er) { toast(er instanceof Error ? er.message : "Could not remove them.", "error"); }
  }

  return (
    <div className="container" style={{ width: "100%" }}>
      <div className="page-head">
        <h1>Share “{form.data.name}”</h1><span className="grow" />
        <Link className="btn" to={`/collect/${projectId}/data`}>Collected data</Link>
        <Link className="btn" to={`/collect/${projectId}/forms/${formId}`}>Back to builder</Link>
      </div>

      {!s.published ? (
        <EmptyState title="Publish the form first" action={<Link className="btn btn-primary" to={`/collect/${projectId}/forms/${formId}`}>Open builder</Link>}>
          The share link starts working once the form is published.
        </EmptyState>
      ) : (
        <>
          <section className="card" style={{ maxWidth: 640, marginBottom: 20 }} aria-label="Form link">
            <h2>Link</h2>
            <div className="field">
              <label htmlFor="share-url">Anyone you share this with opens the form here</label>
              <div style={{ display: "flex", gap: 8 }}>
                <input id="share-url" readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
                <Button variant="primary" onClick={copy}>Copy link</Button>
              </div>
            </div>
            <div className="row"><a className="btn btn-sm" href={url} target="_blank" rel="noreferrer">Open</a><Button small onClick={renew}>Create new link</Button></div>
          </section>

          <section className="card" style={{ maxWidth: 640, marginBottom: 20 }} aria-label="Who can use the link">
            <h2>Who can use the link</h2>
            <div role="radiogroup" aria-label="Who can use the link" className="stack" style={{ gap: 8 }}>
              {MODES.map((m) => (
                <label key={m.id} style={{ display: "flex", gap: 10, alignItems: "flex-start", cursor: "pointer" }}>
                  <input type="radio" name="share-mode" checked={s.share_mode === m.id} onChange={() => void setMode(m.id)} />
                  <span><strong>{m.title}</strong><br /><span className="meta">{m.text}</span></span>
                </label>
              ))}
              <label style={{ display: "flex", gap: 10, alignItems: "flex-start", opacity: 0.6 }}>
                <input type="radio" name="share-mode" disabled />
                <span><strong>Organization</strong> <span className="badge badge-info">Coming soon</span><br /><span className="meta">Anyone in your organization, signed in with their organization account.</span></span>
              </label>
            </div>
            {s.share_mode === "public" && <p className="meta" style={{ marginBottom: 0 }}>Public answers arrive as “Waiting” in <Link to={`/collect/${projectId}/data`}>Collected data</Link>. Check them before publishing to the data hub. Photo, audio, video and file questions can only be answered from the mobile collector.</p>}
          </section>
        </>
      )}

      <section className="card" style={{ maxWidth: 640 }} aria-label="Collaborators">
        <h2>Collaborators</h2>
        <p className="meta" style={{ marginTop: 0 }}>People you add can collect data for this project. If they have no account yet, they create one with the same email and are added automatically.</p>
        <form onSubmit={add} style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
          <input type="email" required aria-label="Email address" placeholder="name@example.com" value={email} onChange={(e) => setEmail(e.target.value)} style={{ flex: "1 1 220px" }} />
          <select aria-label="Role" value={role} onChange={(e) => setRole(e.target.value as Exclude<Role, "owner">)}>
            <option value="collector">Collector</option><option value="viewer">Viewer</option><option value="admin">Admin</option>
          </select>
          <Button type="submit" variant="primary" busy={busy}>Add</Button>
        </form>
        {members.loading && <Loading />}
        {members.error != null && <ErrorState error={members.error} onRetry={members.reload} />}
        {(members.data ?? []).map((m) => (
          <div key={m.id} style={{ display: "flex", gap: 10, alignItems: "center", padding: "8px 0", borderTop: "1px solid var(--border, #ddd)" }}>
            <span className="grow" style={{ minWidth: 0 }}>
              <strong>{m.name ?? m.email}</strong>{m.name && <><br /><span className="meta">{m.email}</span></>}
              {m.status === "invited" && <> <span className="badge badge-warn">Invited</span></>}
            </span>
            {m.role === "owner"
              ? <span className="badge">Owner</span>
              : <select aria-label={`Role for ${m.email}`} value={m.role} onChange={(e) => void changeRole(m.id, e.target.value as Role)}>
                  {(["admin", "collector", "viewer"] as const).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                </select>}
            {m.role !== "owner" && <Button small aria-label={`Remove ${m.email}`} onClick={() => void remove(m.id, m.name ?? m.email)}>Remove</Button>}
          </div>
        ))}
      </section>
    </div>
  );
}
