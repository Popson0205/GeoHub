import { Link } from "react-router-dom";
import { useAuth } from "../lib/auth";

/** Home screen: the three products of Geohub, each with its own entry point. */
export default function LandingPage() {
  const { user } = useAuth();
  const items = [
    {
      title: "Web mapping app",
      text: "Design forms, edit features on the map with imagery, manage collectors and publish datasets.",
      to: "/projects", cta: user ? "Open the mapping app" : "Sign in to map", who: "For project owners and admins",
    },
    {
      title: "Data collection",
      text: "Collect features in the field with offline forms, GPS and photos. Syncs when you are back online.",
      to: "/collect", cta: user ? "Start collecting" : "Sign in to collect", who: "For field collectors (works on a phone)",
    },
    {
      title: "Public data hub",
      text: "Browse published datasets, preview them on a map and download them. No account needed.",
      to: "/hub", cta: "Browse the data hub", who: "For everyone",
    },
  ];
  return (
    <div className="container" style={{ width: "100%" }}>
      <div className="page-head"><h1>Geohub</h1></div>
      <p style={{ color: "var(--muted)", maxWidth: 640, marginTop: 0 }}>
        Collect spatial data in the field, edit it on a map, and publish it for anyone to use. Pick where you want to start.
      </p>
      <div className="grid-cards" style={{ marginTop: 24 }}>
        {items.map((i) => (
          <article className="card" key={i.title}>
            <h2>{i.title}</h2>
            <div className="meta">{i.who}</div>
            <p style={{ margin: 0, flex: 1 }}>{i.text}</p>
            <div className="actions"><Link className="btn btn-primary" to={i.to}>{i.cta}</Link></div>
          </article>
        ))}
      </div>
    </div>
  );
}
