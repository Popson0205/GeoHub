import { Link } from "react-router-dom";
import type { Form, Project } from "../lib/types";
import { Icon } from "./icons";

export interface Step { id: string; title: string; text: string; done: boolean; to: string; cta: string }

/** The four steps from nothing to a first record, worked out from what the person already has. */
export function gettingStartedSteps(projects: Project[], forms: Form[]): Step[] {
  const own = projects.find((p) => p.role === "owner" || p.role === "admin");
  const published = forms.find((f) => f.version > 0);
  const anyRecords = projects.some((p) => p.feature_count > 0);
  const shared = anyRecords || projects.some((p) => p.collector_count > 1);   // the owner counts as one
  return [
    { id: "project", title: "Create a project", text: "A project holds your forms, your collectors and everything they send back.", done: !!own, to: "/collect?new=1", cta: "Create a project" },
    { id: "form", title: "Build and publish a form", text: "Choose what collectors record at each place: a name, a choice, a photo, a number.", done: !!published,
      to: own ? (forms[0] ? `/collect/${own.id}/forms/${forms[0].id}` : `/collect/${own.id}/forms`) : "/collect", cta: forms[0] ? "Finish the form" : "Build a form" },
    { id: "share", title: "Send it to your collectors", text: "Share a link, or add people so they can collect offline on their phones.", done: shared,
      to: own && published ? `/collect/${own.id}/forms/${published.id}/share` : "/collect", cta: "Share the form" },
    { id: "record", title: "Get your first record", text: "Try it yourself: open the collector and add one. It appears in Collected data for you to review.", done: anyRecords,
      to: own ? `/collect/${own.id}` : "/collect", cta: "Open the collector" },
  ];
}

/**
 * A short checklist on the home page for someone new. The next step to take is the one with a button.
 * It goes away by itself once the first record arrives, or when the person hides it.
 */
export default function GettingStarted({ steps, onHide }: { steps: Step[]; onHide: () => void }) {
  const done = steps.filter((s) => s.done).length;
  const next = steps.find((s) => !s.done);
  return (
    <section className="guide" aria-labelledby="guide-title">
      <div className="guide-head">
        <div>
          <h2 id="guide-title">Collect your first data</h2>
          <p className="muted">{done} of {steps.length} done{next ? ` · next: ${next.title.toLowerCase()}` : ""}</p>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onHide}>Hide this guide</button>
      </div>
      <div className="guide-bar" role="progressbar" aria-label="Getting started" aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={done}><span style={{ width: `${(done / steps.length) * 100}%` }} /></div>
      <ol className="guide-steps">
        {steps.map((s, i) => {
          const isNext = s === next;
          return (
            <li key={s.id} className={`guide-step${s.done ? " is-done" : ""}${isNext ? " is-next" : ""}`}>
              <span className="guide-mark" aria-hidden="true">{s.done ? <Icon name="check" size={16} /> : i + 1}</span>
              <div className="grow">
                <strong>{s.title}{s.done && <span className="sr-only"> (done)</span>}</strong>
                {!s.done && <span className="guide-text">{s.text}</span>}
              </div>
              {isNext && <Link className="btn btn-primary btn-sm" to={s.to}>{s.cta}</Link>}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
