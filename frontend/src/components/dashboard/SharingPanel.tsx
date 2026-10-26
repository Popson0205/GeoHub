import { useEffect, useState } from "react";
import { Button, useConfirm, useToast } from "../ui";
import { loadApi } from "../../lib/api";
import type { DashboardSharing } from "../../lib/types";

export const publicLink = (token: string) => `${window.location.origin}/d/${token}`;

/** Turn the public link of a dashboard on or off. Plain about what anyone with the link will and will not see. */
export default function SharingTab({ dashboardId, dirty }: { dashboardId: string; dirty: boolean }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [s, setS] = useState<DashboardSharing | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void loadApi().then((api) => api.getDashboardSharing(dashboardId)).then((r) => { if (live) setS(r); }).catch((e) => { if (live) setError(e instanceof Error ? e.message : "Could not load sharing."); });
    return () => { live = false; };
  }, [dashboardId]);

  async function change(patch: { public?: boolean; regenerate_link?: boolean }, done: string) {
    setBusy(true); setError("");
    try { setS(await (await loadApi()).setDashboardSharing(dashboardId, patch)); toast(done, "success"); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not change sharing."); }
    finally { setBusy(false); }
  }
  async function stop() {
    if (await confirm({ title: "Stop sharing?", message: "The link stops working for everyone at once. Sharing again later makes a new link.", confirmLabel: "Stop sharing", danger: true })) await change({ public: false }, "Sharing is off.");
  }
  async function replace() {
    if (await confirm({ title: "Replace the link?", message: "The current link stops working. Anyone you sent it to needs the new one.", confirmLabel: "Replace link" })) await change({ regenerate_link: true }, "New link created.");
  }
  async function copy(link: string) {
    try { await navigator.clipboard.writeText(link); toast("Link copied.", "success"); }
    catch { toast("Could not copy. Select the link and copy it.", "error"); }
  }

  if (!s) return error ? <p className="hint" role="alert">{error}</p> : <p className="meta">Loading…</p>;
  const link = s.share_token ? publicLink(s.share_token) : "";
  return (
    <div className="share-tab">
      {s.public ? (<>
        <p><strong>Anyone with the link</strong> can view this dashboard. They do not need to sign in.</p>
        <div className="share-link">
          <input readOnly value={link} aria-label="Public link" onFocus={(e) => e.currentTarget.select()} />
          <Button small variant="primary" onClick={() => void copy(link)}>Copy</Button>
        </div>
        <div className="row">
          <Button small onClick={() => void replace()} disabled={busy}>Replace link</Button>
          <Button small variant="danger" onClick={() => void stop()} disabled={busy}>Stop sharing</Button>
        </div>
      </>) : (<>
        <p><strong>Private.</strong> Only people on this project can see this dashboard.</p>
        <Button variant="primary" onClick={() => void change({ public: true }, "Public link created.")} disabled={busy}>Create public link</Button>
      </>)}
      {dirty && s.public && <p className="builder-hint">The link shows the last saved version. Press Save to publish your changes.</p>}
      <div className="share-rules">
        <p className="palette-group-label">What people with the link see</p>
        <ul>
          <li>Only records that have been <strong>approved</strong>. Drafts, submitted and rejected records stay private.</li>
          <li>Only the fields this dashboard uses to draw its charts, not the whole record.</li>
          <li>Never photos, recordings, files or signatures.</li>
          <li>Locations only if the dashboard has a map. A map shows the exact place of each record.</li>
          <li>Nothing from other forms or projects, and no names or emails.</li>
        </ul>
      </div>
      {error && <p className="hint" role="alert">{error}</p>}
    </div>
  );
}
