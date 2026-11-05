/**
 * Sign in with GeoEstate ID, in a GeoEstate app's web page (React or anything else). Copy this one file in.
 *
 * For an app with a server, prefer the Python kit: the server keeps the secret and the tokens. This file is for the
 * browser side: it sends people to Geohub, and, for an app registered without a secret, swaps the code itself (PKCE).
 *
 *   const id = new GeoEstateId({ geohub: "https://hub.geoestate.ng", api: "https://hub.geoestate.ng/api", clientId: "farm",
 *                                redirectUri: `${location.origin}/auth/callback` });
 *   await id.signIn();                           // "Sign in" button: off to Geohub, and back to redirectUri
 *   const tokens = await id.finish(location.search);   // on the callback page
 *   id.user(tokens.access_token)                 // { name, email, org: { name, role }, product: { status, features } }
 *
 * The page must be listed in the app's redirect_uris (ID_CLIENTS) and its origin in Geohub's CORS_ORIGINS.
 */
export interface GeoEstateUser {
  sub: string; email: string; name: string; mfa: boolean;
  org: { id: string; name: string; slug: string; role: "owner" | "admin" | "member" | "collector" | "viewer" } | null;
  product: { id: "land" | "check" | "farm"; name: string; plan: string; plan_name: string; licence_kind: "paid" | "demo";
    status: "demo" | "active" | "grace" | "expired" | "suspended"; status_name: string; subscription_ends: string | null;
    grace_ends: string | null; features: string[]; limits: Record<string, number | null> } | null;
  staff_role: "super_admin" | "account_manager" | "support" | "finance" | null;
  exp: number;
}
export interface GeoEstateTokens { access_token: string; refresh_token: string; expires_in: number; token_type: "Bearer"; user: GeoEstateUser }

const KEY = "geoestate-id.pending";
const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const random = (n: number) => b64url(crypto.getRandomValues(new Uint8Array(n)));

export class GeoEstateId {
  constructor(private o: { geohub: string; api: string; clientId: string; redirectUri: string }) {}

  /** Off to Geohub's sign-in page; someone already signed in to Geohub comes straight back. */
  async signIn(returnTo = location.pathname + location.search): Promise<void> {
    const verifier = random(48), state = random(24);
    const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    sessionStorage.setItem(KEY, JSON.stringify({ verifier, state, returnTo }));
    const q = new URLSearchParams({ client_id: this.o.clientId, redirect_uri: this.o.redirectUri, state, code_challenge: challenge, code_challenge_method: "S256" });
    location.assign(`${this.o.geohub.replace(/\/$/, "")}/id/authorize?${q}`);
  }

  /** On the callback page: check the state and swap the code (apps without a secret). */
  async finish(search: string): Promise<GeoEstateTokens & { returnTo: string }> {
    const p = new URLSearchParams(search);
    const pending = JSON.parse(sessionStorage.getItem(KEY) ?? "null") as { verifier: string; state: string; returnTo: string } | null;
    sessionStorage.removeItem(KEY);
    if (!pending || p.get("state") !== pending.state || !p.get("code")) throw new Error("This sign-in did not start here. Sign in again.");
    const tokens = await this.post<GeoEstateTokens>("token", { grant_type: "authorization_code", code: p.get("code")!, redirect_uri: this.o.redirectUri, code_verifier: pending.verifier });
    return { ...tokens, returnTo: pending.returnTo };
  }

  /** The GeoEstate apps the person's organization has, for the app switcher (GeoEstateBar's `apps`). */
  async apps(accessToken: string): Promise<{ product: string; name: string; status: string; status_name: string; url: string | null; current: boolean }[]> {
    const r = await fetch(`${this.o.api.replace(/\/$/, "")}/id/apps`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!r.ok) throw new Error(`Geohub answered ${r.status}`);
    return r.json();
  }

  refresh(refreshToken: string) { return this.post<GeoEstateTokens>("token", { grant_type: "refresh_token", refresh_token: refreshToken }); }
  signOut(refreshToken: string) { return this.post<{ revoked: boolean }>("revoke", { token: refreshToken }); }

  /** The person in an access token, for showing who is signed in. Servers must check the signature (Python kit). */
  user(accessToken: string): GeoEstateUser {
    const part = accessToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(decodeURIComponent(escape(atob(part)))) as GeoEstateUser;
  }

  private async post<T>(path: string, body: Record<string, string>): Promise<T> {
    const r = await fetch(`${this.o.api.replace(/\/$/, "")}/id/${path}`, { method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: this.o.clientId, ...body }) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.detail ?? `Geohub answered ${r.status}`);
    return data as T;
  }
}
