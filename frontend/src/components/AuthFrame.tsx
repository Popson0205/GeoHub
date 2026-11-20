import type { ReactNode } from "react";
import { BrandMark } from "./Shell";
import { useAuth } from "../lib/auth";

/** The sign-in pages' layout: a dark panel with the promise on one side, the form on the other.
 * Before sign-in the look is this deployment's install default (brand.json), so a client's own box greets
 * them with their crest and name. */
export default function AuthFrame({ children }: { children: ReactNode }) {
  const { identity } = useAuth();
  return (
    <div className="auth">
      <aside className="auth-side">
        <div className="brand-line">
          {identity.seal_url ? <img className="auth-seal" src={identity.seal_url} alt="" />
            : identity.logo_url ? <img className="brand-logo" src={identity.logo_url} alt="" />
            : <BrandMark size={32} />}
          {identity.name}
        </div>
        <div>
          <h2>Map it, collect it, share it.</h2>
          <p>Digitise over imagery, run field surveys offline, and publish reviewed data for everyone to use.</p>
        </div>
      </aside>
      <main className="auth-main">{children}</main>
    </div>
  );
}
