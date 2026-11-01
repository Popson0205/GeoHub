import type { ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAsync } from "../lib/hooks";
import type { Project } from "../lib/types";
import { Icon, type IconName } from "./icons";

const ROLE_LABEL: Record<Project["role"], string> = { owner: "Owner", admin: "Administrator", viewer: "Viewer", collector: "Collector" };

/**
 * The header shared by every page inside a Data collection project: a way back to all projects, the project's name,
 * and tabs for its sections. The same tabs on every page mean people always know where they are and how to move on,
 * instead of each page offering its own set of "back" and shortcut buttons.
 */
export default function ProjectNav({ projectId, project, actions, compact }: {
  projectId: string;
  /** Pass the project when the page has already loaded it; otherwise it is loaded here. */
  project?: Project | null;
  /** Page-specific buttons, shown at the right of the title. */
  actions?: ReactNode;
  /** A slimmer header for full-height work surfaces such as the map. */
  compact?: boolean;
}) {
  const loaded = useAsync((api) => (project ? Promise.resolve(project) : api.getProject(projectId)), [projectId, project?.id]);
  const p = project ?? loaded.data ?? null;
  const manage = p?.role === "owner" || p?.role === "admin";
  const { pathname } = useLocation();
  const base = `/collect/${projectId}`;

  const tabs: { to: string; label: string; icon: IconName; show: boolean; match?: (path: string) => boolean }[] = [
    { to: `${base}/data`, label: "Collected data", icon: "table", show: true },
    { to: `${base}/review`, label: "Map", icon: "navMap", show: true },
    { to: `${base}/forms`, label: "Forms", icon: "form", show: manage, match: (path) => path.startsWith(`${base}/forms`) },
    { to: `/dashboards?project=${projectId}`, label: "Dashboards", icon: "navDash", show: p?.role !== "collector" },
  ];

  return (
    <header className={`project-nav${compact ? " is-compact" : ""}`}>
      <div className="project-nav-in">
        <Link className="page-back" to="/collect"><Icon name="arrowLeft" size={16} />All projects</Link>
        <div className="project-nav-row">
          <div className="project-nav-title">
            <h1>{p?.name ?? <span className="skeleton" style={{ display: "inline-block", width: 220, height: "1em" }} aria-label="Loading project" />}</h1>
            {p && !compact && (
              <p className="project-nav-meta">
                <span className="badge badge-quiet">{ROLE_LABEL[p.role] ?? p.role}</span>
                <span><Icon name="users" size={15} />{p.collector_count} {p.collector_count === 1 ? "collector" : "collectors"}</span>
                <span><Icon name="point" size={15} />{p.feature_count} {p.feature_count === 1 ? "record" : "records"}</span>
              </p>
            )}
          </div>
          <div className="project-nav-actions">
            {actions}
            <Link className="btn" to={base}><Icon name="navCollect" size={18} />Collect</Link>
          </div>
        </div>
        <nav className="project-tabs" aria-label="Project sections">
          {tabs.filter((t) => t.show).map((t) => {
            const on = t.match ? t.match(pathname) : pathname === t.to;
            return (
              <Link key={t.label} to={t.to} className={`project-tab${on ? " is-active" : ""}`} aria-current={on ? "page" : undefined}>
                <Icon name={t.icon} size={17} />{t.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}

/** The project header's shape while a page is still loading, so nothing jumps when it arrives. */
export function ProjectNavSkeleton() {
  return (
    <div className="project-nav" aria-hidden="true">
      <div className="project-nav-in" style={{ paddingBottom: 12 }}>
        <span className="skeleton" style={{ width: 96, height: 14 }} />
        <span className="skeleton" style={{ width: 280, maxWidth: "70%", height: 26 }} />
        <span className="skeleton" style={{ width: 360, maxWidth: "90%", height: 30, marginTop: 8 }} />
      </div>
    </div>
  );
}
