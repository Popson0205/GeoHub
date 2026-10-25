import { useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { Icon } from "./icons";

export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="8" fill="#e4f4ea" />
      <path d="M16 6.5c-3.9 0-7 3-7 6.9 0 5 7 11.6 7 11.6s7-6.6 7-11.6c0-3.9-3.1-6.9-7-6.9z" fill="#17634c" />
      <circle cx="16" cy="13.4" r="2.8" fill="#e4f4ea" />
    </svg>
  );
}
const initials = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";

/** Top bar + page area, used by every screen except the mobile collector. */
export default function Shell() {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [navOpen, setNavOpen] = useState(false);     // phone menu
  const [userOpen, setUserOpen] = useState(false);
  const userRef = useRef<HTMLDivElement>(null);

  // Close menus when the page changes, on Escape, and on a click outside the user menu.
  useEffect(() => { setNavOpen(false); setUserOpen(false); }, [loc.pathname]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setNavOpen(false); setUserOpen(false); } };
    const onDown = (e: MouseEvent) => { if (userRef.current && !userRef.current.contains(e.target as Node)) setUserOpen(false); };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("mousedown", onDown); };
  }, []);

  return (
    <div className="app">
      <a className="skip-link" href="#main">Skip to content</a>
      <header className="topbar">
        <Link className="brand" to="/"><BrandMark />Geohub</Link>
        <nav id="main-nav" className={`topnav${navOpen ? " is-open" : ""}`} aria-label="Main">
          {user && <NavLink to="/maps"><Icon name="navMap" size={18} />Web mapping</NavLink>}
          {user && <NavLink to="/collect"><Icon name="navCollect" size={18} />Data collection</NavLink>}
          {user && <NavLink to="/dashboards"><Icon name="navDash" size={18} />Dashboards</NavLink>}
          <NavLink to="/hub"><Icon name="navHub" size={18} />Data hub</NavLink>
        </nav>
        <span className="spacer" />
        {user ? (
          <div className="menu" ref={userRef}>
            <button type="button" className="user-btn" aria-label={`${user.name}, account menu`} aria-haspopup="menu" aria-expanded={userOpen} onClick={() => setUserOpen((v) => !v)}>
              <span className="avatar" aria-hidden="true">{initials(user.name)}</span>
              <span className="user-name">{user.name}</span>
              <Icon name="chevronDown" size={16} />
            </button>
            {userOpen && (
              <div className="menu-pop" role="menu" aria-label="Account">
                <div className="menu-head"><strong>{user.name}</strong>{user.email && <span>{user.email}</span>}</div>
                <button type="button" role="menuitem" className="menu-item is-danger" onClick={async () => { setUserOpen(false); await logout(); nav("/hub"); }}>
                  <Icon name="logout" size={18} />Sign out
                </button>
              </div>
            )}
          </div>
        ) : (
          <NavLink className="signin" to="/login">Sign in</NavLink>
        )}
        <button type="button" className="nav-toggle" aria-label={navOpen ? "Close menu" : "Open menu"} aria-expanded={navOpen} aria-controls="main-nav" onClick={() => setNavOpen((v) => !v)}>
          <Icon name={navOpen ? "close" : "menu"} size={20} />
        </button>
      </header>
      <main id="main" className="page" style={{ display: "flex", flexDirection: "column" }}>
        <Outlet />
      </main>
    </div>
  );
}
