import type { FormField, Props } from "./types";

/**
 * A record that another GeoEstate app asks the collector to start, filled in: FarmScan sends a scout a link to a
 * problem area, opening its scouting form with the farm, the task and what the satellite saw already answered.
 *
 *   /collect/<project>?form=<form id>&fill=<base64url JSON of answers>&at=<lat>,<lng>
 *
 * Only answers to questions the form has (outside repeat sections) are taken; `at` is where to go, shown on the map.
 */
export interface Prefill { formId: string; props: Props; at: [number, number] | null }

const fromB64url = (s: string) => {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
};
export const toB64url = (s: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function readPrefill(search: string): Prefill | null {
  const q = new URLSearchParams(search);
  const formId = q.get("form");
  if (!formId) return null;
  let props: Props = {};
  const fill = q.get("fill");
  if (fill) {
    try {
      const v = JSON.parse(fromB64url(fill));
      if (v && typeof v === "object" && !Array.isArray(v)) props = v as Props;
    } catch { props = {}; }
  }
  let at: [number, number] | null = null;
  const m = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(q.get("at") ?? "");
  if (m) {
    const lat = Number(m[1]), lng = Number(m[2]);
    if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) at = [lat, lng];
  }
  return { formId, props, at };
}

/** The answers the form can take: questions anywhere outside repeat sections, with scalar or list values. */
export function fillFor(fields: FormField[], props: Props): Props {
  const ids = new Set<string>();
  const walk = (fs: FormField[]) => fs.forEach((f) => {
    if (f.type === "group") walk(f.children ?? []);
    else if (f.type !== "repeat" && f.type !== "note") ids.add(f.id);
  });
  walk(fields);
  return Object.fromEntries(Object.entries(props).filter(([k, v]) => ids.has(k)
    && (typeof v === "string" || typeof v === "number" || typeof v === "boolean" || (Array.isArray(v) && v.every((x) => typeof x === "string")))));
}

/** The query string without the prefill, once it has been used (so a reload does not start it again). */
export function withoutPrefill(search: string): string {
  const q = new URLSearchParams(search);
  ["form", "fill", "at"].forEach((k) => q.delete(k));
  const s = q.toString();
  return s ? `?${s}` : "";
}
