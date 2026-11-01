import { useLiveQuery } from "dexie-react-hooks";
import { Link } from "react-router-dom";
import { db } from "../lib/db";
import type { Project } from "../lib/types";
import { Icon } from "./icons";

/**
 * Field data saved on this device and not sent yet, per project. Loaded on its own (it needs the offline
 * database), so the home page shows without waiting for it.
 */
export default function DeviceQueue({ projects }: { projects: Project[] }) {
  const queue = useLiveQuery(() => db.queue.toArray(), [], []);
  const byProject = new Map<string, number>();
  for (const c of queue) byProject.set(c.project_id, (byProject.get(c.project_id) ?? 0) + 1);
  const rows = [...byProject.entries()].filter(([, n]) => n > 0);
  if (!rows.length) return null;
  const name = (id: string) => projects.find((p) => p.id === id)?.name ?? "A project";
  return (
    <>
      {rows.map(([id, n]) => (
        <li key={`dev-${id}`} className="attention-row">
          <span className="attention-icon is-device" aria-hidden="true"><Icon name="upload" size={18} /></span>
          <div className="grow">
            <strong>{n} {n === 1 ? "change" : "changes"} on this device not sent yet</strong>
            <small>{name(id)} · they are sent the next time the collector is online</small>
          </div>
          <Link className="btn btn-sm" to={`/collect/${id}`}>Open collector</Link>
        </li>
      ))}
    </>
  );
}
