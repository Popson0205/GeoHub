import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { loadApi } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Icon, type IconName } from "./icons";

export interface SearchItem { kind: string; title: string; hint?: string; to: string; icon: IconName }

const PAGES: SearchItem[] = [
  { kind: "Page", title: "Web mapping", hint: "All maps", to: "/maps", icon: "navMap" },
  { kind: "Page", title: "Data collection", hint: "All projects", to: "/collect", icon: "navCollect" },
  { kind: "Page", title: "Dashboards", to: "/dashboards", icon: "navDash" },
  { kind: "Page", title: "Dashboard reports", to: "/dashboards/reports", icon: "navDash" },
  { kind: "Page", title: "Data hub", hint: "Published datasets", to: "/hub", icon: "navHub" },
];

/**
 * How well `q` matches `text`: whole-word starts beat the middle of a word, and letters typed in order
 * with gaps ("hlth fac" for "Health facilities") still count. 0 means no match.
 */
export function score(q: string, text: string): number {
  const t = text.toLowerCase(), words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return 1;
  let total = 0;
  for (const w of words) {
    const at = t.indexOf(w);
    if (at === 0) total += 100;
    else if (at > 0 && /[^\p{L}\p{N}]/u.test(t[at - 1]!)) total += 80;
    else if (at > 0) total += 50;
    else {
      let i = 0;
      for (const ch of t) if (ch === w[i]) i++;
      if (i < w.length) return 0;
      total += 10;
    }
  }
  return total - t.length / 100;   // shorter titles first when the match is as good
}

/** Everything the person can open, fetched when the search first opens. Forms and dashboards come per project. */
async function gather(): Promise<SearchItem[]> {
  const api = await loadApi();
  const [maps, projects, datasets] = await Promise.all([
    api.listMaps().catch(() => []), api.listProjects().catch(() => []), api.listDatasets().catch(() => []),
  ]);
  const few = projects.slice(0, 30);
  const [forms, dashboards] = await Promise.all([
    Promise.all(few.map((p) => api.listForms(p.id).catch(() => []))),
    Promise.all(few.map((p) => api.listDashboards(p.id).catch(() => []))),
  ]);
  const pname = new Map(projects.map((p) => [p.id, p.name]));
  return [
    ...maps.map((m): SearchItem => ({ kind: "Map", title: m.name, hint: m.description || undefined, to: `/maps/${m.id}`, icon: "navMap" })),
    ...projects.map((p): SearchItem => ({ kind: "Project", title: p.name, hint: p.description || undefined, to: p.role === "collector" ? `/collect/${p.id}` : `/collect/${p.id}/data`, icon: "navCollect" })),
    ...projects.filter((p) => p.role === "owner" || p.role === "admin").map((p): SearchItem => ({ kind: "Activity", title: `${p.name} activity`, hint: "Who changed what", to: `/collect/${p.id}/activity`, icon: "inbox" })),
    ...forms.flat().map((f): SearchItem => ({ kind: "Form", title: f.name, hint: pname.get(f.project_id), to: `/collect/${f.project_id}/forms/${f.id}`, icon: "form" })),
    ...dashboards.flat().map((d): SearchItem => ({ kind: "Dashboard", title: d.name, hint: pname.get(d.project_id), to: `/dashboards/${d.id}`, icon: "navDash" })),
    ...datasets.map((d): SearchItem => ({ kind: "Dataset", title: d.title, hint: pname.get(d.project_id) ?? "Data hub", to: `/hub/${d.slug}`, icon: "navHub" })),
  ];
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");
export const shortcutLabel = isMac ? "⌘K" : "Ctrl K";

/**
 * Jump to any map, project, form, dashboard, dataset or page by typing part of its name.
 * Opens from the top bar button, with Ctrl K / ⌘K, or with "/" when nothing is being typed in.
 */
export default function QuickSearch() {
  const { user } = useAuth();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [items, setItems] = useState<SearchItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName));
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey) && !e.altKey) { e.preventDefault(); setOpen((v) => !v); }
      else if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey) { e.preventDefault(); setOpen(true); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!open) { opener.current?.focus?.(); return; }
    opener.current = document.activeElement as HTMLElement | null;
    setQ(""); setActive(0);
    requestAnimationFrame(() => input.current?.focus());
  }, [open]);
  // Load what the person can open each time the search opens (and once sign-in finishes), so new work shows up.
  useEffect(() => {
    if (!open || !user) return;
    let live = true;
    setFailed(false);
    gather().then((l) => { if (live) setItems(l); }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [open, user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const pages = useMemo(() => (user ? PAGES : PAGES.filter((p) => p.to === "/hub")), [user]);
  const results = useMemo(() => {
    const all = [...pages, ...(items ?? [])];
    if (!q.trim()) return [...pages, ...(items ?? []).slice(0, 6)];
    return all.map((it) => ({ it, s: Math.max(score(q, it.title), score(q, `${it.kind} ${it.title}`) * 0.6, it.hint ? score(q, it.hint) * 0.4 : 0) }))
      .filter((r) => r.s > 0).sort((a, b) => b.s - a.s).slice(0, 12).map((r) => r.it);
  }, [q, items, pages]);
  useEffect(() => { setActive(0); }, [q]);
  useEffect(() => { list.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView?.({ block: "nearest" }); }, [active]);

  function go(it: SearchItem | undefined) { if (!it) return; setOpen(false); nav(it.to); }
  function onKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === "Home" && e.ctrlKey) { setActive(0); }
    else if (e.key === "Enter") { e.preventDefault(); go(results[active]); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setOpen(false); }
    else if (e.key === "Tab") { e.preventDefault(); }   // keep focus in the search while it is open
  }

  return (
    <>
      <button type="button" className="search-btn" onClick={() => setOpen(true)} aria-label={`Search (${shortcutLabel})`} aria-haspopup="dialog" aria-keyshortcuts="Control+K Meta+K /">
        <Icon name="search" size={18} /><span className="search-btn-text">Search</span><kbd>{shortcutLabel}</kbd>
      </button>
      {open && (
        <div className="qs-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
          <div className="qs" role="dialog" aria-modal="true" aria-label="Search Geohub">
            <div className="qs-field">
              <Icon name="search" size={20} />
              <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey}
                role="combobox" aria-expanded="true" aria-controls="qs-list" aria-autocomplete="list"
                aria-activedescendant={results[active] ? `qs-${active}` : undefined}
                placeholder="Search maps, projects, forms, dashboards, datasets…" aria-label="Search" autoComplete="off" spellCheck={false} />
              <kbd>Esc</kbd>
            </div>
            <ul id="qs-list" ref={list} role="listbox" aria-label="Results" className="qs-list">
              {results.map((it, i) => (
                <li key={`${it.kind}:${it.to}`} id={`qs-${i}`} data-i={i} role="option" aria-selected={i === active}
                  className={i === active ? "is-active" : undefined} onMouseMove={() => setActive(i)} onClick={() => go(it)}>
                  <span className="qs-icon"><Icon name={it.icon} size={18} /></span>
                  <span className="qs-text"><strong>{it.title}</strong>{it.hint && <span>{it.hint}</span>}</span>
                  <span className="qs-kind">{it.kind}</span>
                </li>
              ))}
            </ul>
            <div className={`qs-foot${results.length && !failed && (items !== null || !user) ? " has-keys" : ""}`} aria-live="polite">
              {results.length === 0 ? (items === null && !failed && user ? "Looking…" : `Nothing called “${q}”.`)
                : failed ? "Some of your work could not be loaded, so only pages are shown."
                : items === null && user ? "Loading your maps and projects…"
                : <><span><kbd>↑</kbd><kbd>↓</kbd> to move</span><span><kbd>Enter</kbd> to open</span></>}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
