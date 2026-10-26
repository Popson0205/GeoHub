import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Button, ErrorState, Loading, useToast } from "../components/ui";
import { loadApi } from "../lib/api";
import { useAsync } from "../lib/hooks";
import { fmtDate, plural, timeLeft } from "./portal/shared";

/** Where an invitation link lands: what the map is, and a button to join. */
export default function JoinMapPage() {
  const { code = "" } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const { data, error, loading, reload } = useAsync((api) => api.joinPreview(code), [code]);
  const [busy, setBusy] = useState(false);

  async function join() {
    setBusy(true);
    try { const m = await (await loadApi()).joinMap(code); toast(`You joined ${m.name}.`, "success"); nav(`/maps/${m.id}`); }
    catch (e) { toast(e instanceof Error ? e.message : "Could not join.", "error"); }
    finally { setBusy(false); }
  }

  if (loading) return <Loading label="Checking the invitation…" />;
  if (error != null || !data) return <div className="container"><ErrorState error={error} onRetry={reload} /><p><Link to="/maps">Back to your maps</Link></p></div>;
  const ended = data.campaign_status === "ended";
  return (
    <div className="container" style={{ maxWidth: 640 }}>
      <section className="card" aria-label="Invitation">
        <span className="field-hint">{data.owner_name} invited you to map together</span>
        <h1 style={{ margin: 0 }}>{data.name}</h1>
        {data.description && <p style={{ margin: 0 }}>{data.description}</p>}
        {data.goal && <p style={{ margin: 0 }}><strong>Goal:</strong> {data.goal}</p>}
        <div className="field-hint">
          {plural(data.member_count, "person", "people")} on this map
          {data.campaign_status && <> · {timeLeft(data.starts_at, data.ends_at)}{data.ends_at ? ` (until ${fmtDate(data.ends_at)})` : ""}</>}
          {data.competition && " · there is a leaderboard"}
        </div>
        {data.already_member ? (
          <div className="row"><span>You are already on this map.</span><Link className="btn btn-primary" to="/maps">Go to your maps</Link></div>
        ) : ended ? (
          <span className="field-error" role="alert">This campaign has ended, so it is not taking new people.</span>
        ) : (
          <div className="row"><Button variant="primary" busy={busy} onClick={join}>Join as a contributor</Button><Link to="/maps">Not now</Link></div>
        )}
        <span className="field-hint">As a contributor you can draw features. A reviewer checks them before they are published.</span>
      </section>
    </div>
  );
}
