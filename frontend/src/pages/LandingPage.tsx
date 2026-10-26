import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../lib/auth";

const svg = (d: ReactNode) => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
);
const ICON = {
  map: svg(<><path d="M9 4L3 6.5v13L9 17l6 3 6-2.5v-13L15 7z" /><path d="M9 4v13M15 7v13" /></>),
  collect: svg(<><rect x="6" y="2.5" width="12" height="19" rx="2.5" /><path d="M12 8.2c-1.7 0-3 1.3-3 3 0 2.2 3 5 3 5s3-2.8 3-5c0-1.7-1.3-3-3-3z" /></>),
  hub: svg(<><ellipse cx="12" cy="6" rx="8" ry="3" /><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" /></>),
};

/** Home screen: what Geohub does, the three products, and how data moves between them. */
export default function LandingPage() {
  const { user } = useAuth();
  const items = [
    { icon: ICON.map, title: "Web mapping", text: "Draw points, lines and polygons over satellite imagery. Add imagery from a tile URL or a GeoTIFF, work with a team, and export your map.", to: "/maps", cta: user ? "Open web mapping" : "Sign in to map", who: "For mappers and analysts" },
    { icon: ICON.collect, title: "Data collection", text: "Build a form, invite collectors, and gather data in the field with GPS and photos, even without a signal. Review it before it goes public.", to: "/collect", cta: user ? "Open data collection" : "Sign in to collect", who: "For survey teams and field collectors" },
    { icon: ICON.hub, title: "Data hub", text: "Browse published datasets, preview them on a map, and download them in standard formats. No account needed.", to: "/hub", cta: "Browse the data hub", who: "For everyone" },
  ];
  return (
    <div style={{ width: "100%" }}>
      <section className="home-hero">
        <div className="home-hero-in">
          <h1>Geospatial data, from the field to the public.</h1>
          <p>Map over imagery, collect data offline on a phone, and publish reviewed datasets that anyone can preview and download.</p>
          <div className="row">
            {user ? <Link className="btn btn-primary" to="/maps">Open web mapping</Link> : <Link className="btn btn-primary" to="/login">Sign in</Link>}
            <Link className="btn" to="/hub">Browse the data hub</Link>
          </div>
        </div>
      </section>
      <div className="container" style={{ paddingTop: 0 }}>
        <div className="product-grid">
          {items.map((i) => (
            <article className="card product" key={i.title}>
              <div className="product-icon">{i.icon}</div>
              <h2>{i.title}</h2>
              <div className="meta">{i.who}</div>
              <p>{i.text}</p>
              <div className="actions"><Link className="btn btn-primary" to={i.to}>{i.cta}</Link></div>
            </article>
          ))}
        </div>
        <h2 className="flow-title">How data moves through Geohub</h2>
        <ol className="flow">
          <li><strong>Design</strong>Build a form for what collectors capture.</li>
          <li><strong>Collect</strong>Gather features in the field, offline if needed.</li>
          <li><strong>Review</strong>Check, fix and approve submissions.</li>
          <li><strong>Publish</strong>Release a versioned dataset to the data hub.</li>
        </ol>
      </div>
    </div>
  );
}
