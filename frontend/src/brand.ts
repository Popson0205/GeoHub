/** White-label branding, chosen at build time with VITE_BRAND (default "geoestate"). Geohub is the hub and the shared
 *  sign-in, so for the Osun build it carries the suite identity — "Osun State Land Information System" — with the
 *  state's official seal on sign-in. Colours live in styles/brand.css keyed by [data-brand]; this holds names, marks
 *  and the per-brand product labels used in the app switcher. No fork. */
export type Brand = {
  id: string;
  suite: string;
  suiteFull: string;
  product: string;             // this app's label (the hub)
  vendor: string;
  logo: string;
  seal?: string;
  themeColor: string;
  poweredBy?: string;
  appLabels?: Record<string, string>;   // per-product overrides for the app switcher
};

const BRANDS: Record<string, Brand> = {
  geoestate: {
    id: "geoestate", suite: "GeoEstate", suiteFull: "GeoEstate", product: "Geohub",
    vendor: "GeoEstate NIG Limited", logo: "/icons/favicon-64.png", themeColor: "#14302a",
  },
  osun: {
    id: "osun", suite: "OSLIS", suiteFull: "Osun State Land Information System", product: "Field Data",
    vendor: "GeoEstate NIG Limited", logo: "/brand/osun-icon.svg", seal: "/brand/osun-seal.png",
    themeColor: "#064E30", poweredBy: "GeoEstate",
    appLabels: { hub: "Field Data", gis: "Cadastral Mapping", land: "Land Registry" },
  },
};

export const BRAND: Brand = BRANDS[import.meta.env.VITE_BRAND as string] ?? BRANDS.geoestate;

/** The label for a product in the app switcher, with the brand's overrides applied. */
export function appLabel(id: string, fallback: string): string {
  return BRAND.appLabels?.[id] ?? fallback;
}

/** Apply the brand to the document: colour theme (data-brand, which brand.css keys off), title, favicon, theme-color. */
export function applyBrand(): void {
  document.documentElement.dataset.brand = BRAND.id;
  document.title = BRAND.id === "geoestate" ? "Geohub" : BRAND.suiteFull;
  if (BRAND.id !== "geoestate") {
    for (const rel of ["icon", "apple-touch-icon"]) {
      let el = document.head.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
      if (!el) { el = document.createElement("link"); el.rel = rel; document.head.appendChild(el); }
      el.href = BRAND.logo;
    }
  }
  const tc = document.head.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (tc) tc.content = BRAND.themeColor;
}
