/** Share links read like the form: /f/drainage-inventory-<32 hex characters>. Only the trailing token matters. */
const TOKEN_AT_END = /([0-9a-f]{32})$/;

export const slugify = (name: string): string =>
  name.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");

export function sharePath(formName: string, token: string): string {
  const s = slugify(formName);
  return `/f/${s ? `${s}-` : ""}${token}`;
}
export const shareUrl = (formName: string, token: string): string => `${window.location.origin}${sharePath(formName, token)}`;
/** The token from a link's last segment. Older links that are just the token keep working. */
export const tokenFromParam = (param: string): string => param.match(TOKEN_AT_END)?.[1] ?? param;
