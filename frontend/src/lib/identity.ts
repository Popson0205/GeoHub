/** The app's identity — name, colour, logo and seal — resolved at runtime so ONE build serves every client.
 *
 * Nothing here is baked in at build time. The look is decided in this order (first that is set wins per field):
 *   1. the signed-in organization's brand, set by GeoEstate staff when the org is set up (user.org.brand);
 *   2. the install default for this deployment — a window.__BRAND__ an installer injected, else public/brand.json,
 *      which can be edited on an on-prem box without rebuilding;
 *   3. the built-in GeoEstate look.
 *
 * So a hosted, multi-tenant deployment shows each organization its own brand after sign-in and the GeoEstate look
 * before it; a dedicated on-prem box (e.g. a client's own server) is branded from the first screen by its brand.json.
 */
import { applyBrand, readable } from "./brand";
import type { OrgBrand } from "./types";

export interface Identity {
  /** The wordmark in the top bar and on the sign-in screen. */
  name: string;
  /** One line under the name on the sign-in screen (null hides it). */
  tagline: string | null;
  /** The brand colour; the app's greens are derived from it (see brand.ts). */
  color: string | null;
  /** A wide logo for the top bar. */
  logo_url: string | null;
  /** A square seal or crest for the sign-in screen. */
  seal_url: string | null;
}

/** The product's own look, used when no client brand is set. */
export const GEOESTATE: Identity = {
  name: "Geohub",
  tagline: "Field data, forms and dashboards · your GeoEstate account",
  color: null,
  logo_url: null,
  seal_url: null,
};

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Read an untrusted partial brand (brand.json or window.__BRAND__) into an Identity, ignoring anything unexpected. */
export function readBrand(raw: unknown): Identity {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    name: str(o.name) ?? GEOESTATE.name,
    tagline: "tagline" in o ? str(o.tagline) : GEOESTATE.tagline,
    color: str(o.color),
    logo_url: str(o.logo_url),
    seal_url: str(o.seal_url),
  };
}

// The install default is read once and then reused for the life of the page.
let installed: Identity | null = null;

/** The install default resolved so far (the GeoEstate look until loadInstallDefault() has run). */
export function installDefault(): Identity {
  return installed ?? GEOESTATE;
}

/** Resolve this deployment's default brand: an installer-injected global, else public/brand.json, else GeoEstate. */
export async function loadInstallDefault(): Promise<Identity> {
  if (installed) return installed;
  const injected = (window as unknown as { __BRAND__?: unknown }).__BRAND__;
  if (injected && typeof injected === "object") {
    installed = readBrand(injected);
    return installed;
  }
  try {
    const r = await fetch("/brand.json", { cache: "no-store" });
    if (r.ok) {
      installed = readBrand(await r.json());
      return installed;
    }
  } catch {
    /* no brand.json on this deployment → the GeoEstate look */
  }
  installed = GEOESTATE;
  return installed;
}

/** Merge a signed-in organization's brand over a base look (the install default by default). */
export function identityFor(
  org: { brand?: OrgBrand | null } | null | undefined,
  base: Identity = installDefault(),
): Identity {
  const b = org?.brand;
  if (!b) return base;
  return {
    name: str(b.name) ?? base.name,
    tagline: base.tagline,
    color: str(b.color) ?? base.color,
    logo_url: str(b.logo_url) ?? base.logo_url,
    seal_url: str(b.seal_url) ?? base.seal_url,
  };
}

const THEME_META_ID = "brand-theme-color";

/** Apply the identity to the document: colour palette, page title and the browser theme colour. */
export function applyIdentity(id: Identity): void {
  if (typeof document === "undefined") return;
  // The greens are rebuilt from the brand colour (null restores the GeoEstate palette).
  applyBrand(id.color ? { color: id.color, logo_url: null } : null);
  document.title = id.name;
  // The address-bar / task-switcher colour follows the brand (darkened so it stays legible), default GeoEstate navy.
  const themeColor = id.color ? readable(id.color) : "#14302a";
  let meta = document.getElementById(THEME_META_ID) as HTMLMetaElement | null
    ?? (document.querySelector('meta[name="theme-color"]') as HTMLMetaElement | null);
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.appendChild(meta);
  }
  meta.id = THEME_META_ID;
  meta.content = themeColor;
}
