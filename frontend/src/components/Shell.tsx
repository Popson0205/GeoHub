import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { Button } from "./ui";

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
  return (
    <div className="app">
      <a className="skip-link" href="#main">Skip to content</a>
      <header className="topbar">
        <Link className="brand" to="/"><BrandMark />Geohub</Link>
        {user && <NavLink to="/maps">Web mapping</NavLink>}
        {user && <NavLink to="/collect">Data collection</NavLink>}
        <NavLink to="/hub">Data hub</NavLink>
        <span className="spacer" />
        {user ? (
          <>
            <span className="who"><span className="avatar" aria-hidden="true">{initials(user.name)}</span>{user.name}</span>
            <Button small onClick={async () => { await logout(); nav("/hub"); }}>Sign out</Button>
          </>
        ) : (
          <NavLink to="/login">Sign in</NavLink>
        )}
      </header>
      <main id="main" className="page" style={{ display: "flex", flexDirection: "column" }}>
        <Outlet />
      </main>
    </div>
  );
}
