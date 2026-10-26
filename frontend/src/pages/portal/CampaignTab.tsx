import { useState, type FormEvent } from "react";
import { Button, useToast } from "../../components/ui";
import { loadApi } from "../../lib/api";
import type { WorkMap } from "../../lib/types";
import { fromLocalInput, toLocalInput } from "./shared";

/** Turn a map into a mapping project or competition: a goal, a time window, and a leaderboard. */
export default function CampaignTab({ map, onChanged }: { map: WorkMap; onChanged: () => Promise<void> | void }) {
  const toast = useToast();
  const [on, setOn] = useState(map.is_campaign);
  const [goal, setGoal] = useState(map.goal);
  const [starts, setStarts] = useState(toLocalInput(map.starts_at));
  const [ends, setEnds] = useState(toLocalInput(map.ends_at));
  const [competition, setCompetition] = useState(map.competition);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function save(e: FormEvent) {
    e.preventDefault();
    setErr("");
    if (starts && ends && new Date(ends) <= new Date(starts)) { setErr("The end must be after the start."); return; }
    setBusy(true);
    try {
      await (await loadApi()).updateMap(map.id, { is_campaign: on, goal: goal.trim(), starts_at: fromLocalInput(starts), ends_at: fromLocalInput(ends), competition });
      toast("Campaign saved.", "success");
      await onChanged();
    } catch (e2) { setErr(e2 instanceof Error ? e2.message : "Could not save."); }
    finally { setBusy(false); }
  }

  return (
    <form className="card" onSubmit={save} aria-label="Campaign settings" style={{ maxWidth: 640 }}>
      <h2 style={{ margin: 0 }}>Mapping campaign</h2>
      <p className="field-hint" style={{ margin: 0 }}>Run this map as a project or a competition: set a goal and a time window, and show a leaderboard. Contributors can draw only while the campaign is open. You and your reviewers can always edit.</p>
      <label className="check"><input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} />Run this map as a campaign</label>
      <fieldset disabled={!on} style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 14, opacity: on ? 1 : 0.5 }}>
        <div className="field"><label htmlFor="goal">Goal</label><textarea id="goal" rows={2} value={goal} maxLength={2000} placeholder="For example: trace every building in Oke-Baale." onChange={(e) => setGoal(e.target.value)} /></div>
        <div className="two-col">
          <div className="field"><label htmlFor="starts">Starts</label><input id="starts" type="datetime-local" value={starts} onChange={(e) => setStarts(e.target.value)} /><span className="field-hint">Leave empty to start now.</span></div>
          <div className="field"><label htmlFor="ends">Ends</label><input id="ends" type="datetime-local" value={ends} aria-invalid={!!err || undefined} onChange={(e) => setEnds(e.target.value)} /><span className="field-hint">Leave empty for no end.</span></div>
        </div>
        <label className="check"><input type="checkbox" checked={competition} onChange={(e) => setCompetition(e.target.checked)} />Competition: show a ranked leaderboard to everyone on the map</label>
        <span className="field-hint">With dates set, only features drawn inside the window are counted. Ranking is by the number of features added; rejected features do not count.</span>
      </fieldset>
      {err && <span className="field-error" role="alert">{err}</span>}
      <div className="row"><Button type="submit" variant="primary" busy={busy}>Save campaign</Button></div>
    </form>
  );
}
