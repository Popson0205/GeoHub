import { NavLink } from "react-router-dom";

/** The Dashboard app's own sub-navigation, under Geohub's top bar: Dashboards and Reports, nothing else. */
export default function DashAppBar() {
  return (
    <div className="dapp-bar">
      <span className="dapp-name">Geohub Dashboard</span>
      <nav aria-label="Dashboard app">
        <NavLink to="/dashboards" end>Dashboards</NavLink>
        <NavLink to="/dashboards/reports">Reports</NavLink>
      </nav>
    </div>
  );
}
