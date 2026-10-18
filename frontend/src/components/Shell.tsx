import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { Button } from "./ui";

/** Top bar + page area, used by every screen except the mobile collector. */
export default function Shell() {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  return (
    <div className="app">
      <a className="skip-link" href="#main">Skip to content</a>
      <header className="topbar">
        <span className="brand">Geohub</span>
        {user && <NavLink to="/projects">Projects</NavLink>}
        <NavLink to="/hub">Data hub</NavLink>
        <span className="spacer" />
        {user ? (
          <>
            <span className="who">{user.name}</span>
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
