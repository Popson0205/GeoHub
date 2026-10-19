import { Link } from "react-router-dom";
import { useAuth } from "../lib/auth";

/** Home screen: the three products of Geohub, each with its own entry point. */
export default function LandingPage() {
  const { user } = useAuth();
  const items = [
    {
      title: "Web mapping app",
      text: "Digitise points, lines and polygons over satellite imagery, like OpenStreetMap. Add imagery from a tile URL or upload a GeoTIFF, then export your map.",
      to: "/maps", cta: user ? "Open the mapping app" : "Sign in to map", who: "For mappers and analysts",
    },
    {
      title: "Data collection",
      text: "Build forms, invite collectors and gather data in the field with offline forms, GPS and photos. Review it and publish to the data hub.",
      to: "/collect", cta: user ? "Open data collection" : "Sign in to collect", who: "For survey teams and field collectors (works on a phone)",
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
        Three tools, each on its own: map over imagery, collect data in the field, and share published datasets. Pick where you want to start.
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
