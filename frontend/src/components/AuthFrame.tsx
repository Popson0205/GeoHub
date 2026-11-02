import type { ReactNode } from "react";
import { BrandMark } from "./Shell";

/** The sign-in pages' layout: a dark panel with the promise on one side, the form on the other. */
export default function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <div className="auth">
      <aside className="auth-side">
        <div className="brand-line"><BrandMark size={32} />Geohub</div>
        <div>
          <h2>Map it, collect it, share it.</h2>
          <p>Digitise over imagery, run field surveys offline, and publish reviewed data for everyone to use.</p>
        </div>
      </aside>
      <main className="auth-main">{children}</main>
    </div>
  );
}
