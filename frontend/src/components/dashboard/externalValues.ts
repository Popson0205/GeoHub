import { useEffect, useState } from "react";
import { parseExternalValues, safeHttpsUrl } from "../../lib/dashboard";
import type { OptionSource } from "../../lib/types";

// The values of a category selector that come from a web address. Fetched by the viewer's browser (so the address has to allow
// it), at most once per address and column until "Refresh data" is pressed, with a time limit and a size limit.
const cache = new Map<string, Promise<string[]>>();
const LIMIT_MS = 10_000, LIMIT_CHARS = 2_000_000;

export function clearExternalValues() { cache.clear(); }

function load(url: string, column?: string): Promise<string[]> {
  const key = `${url}\n${column ?? ""}`;
  let p = cache.get(key);
  if (!p) {
    p = (async () => {
      const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), LIMIT_MS);
      try {
        let res: Response;
        try { res = await fetch(url, { signal: ctl.signal, credentials: "omit", referrerPolicy: "no-referrer", headers: { Accept: "application/json, text/csv;q=0.9, text/plain;q=0.8" } }); }
        catch { throw new Error("The list could not be loaded. The address may be down, or it does not let other websites read it."); }
        if (!res.ok) throw new Error(`The address answered with an error (${res.status}).`);
        const values = parseExternalValues((await res.text()).slice(0, LIMIT_CHARS), column);
        if (!values.length) throw new Error(column ? `No values found in “${column}”. Check the column name.` : "No values found at this address.");
        return values;
      } finally { clearTimeout(timer); }
    })();
    cache.set(key, p);
    p.catch(() => cache.delete(key));
  }
  return p;
}

export type ExternalValues = { status: "idle" | "loading" | "ready" | "error"; values: string[]; message: string };
const IDLE: ExternalValues = { status: "idle", values: [], message: "" };

/** The list a "web address" source returns. `idle` for any other source, so it is safe to call for every selector. */
export function useExternalValues(source: OptionSource | undefined): ExternalValues {
  const url = source?.type === "url" ? safeHttpsUrl(source.url) : null, column = source?.type === "url" ? source.column : undefined;
  const [state, setState] = useState<ExternalValues>(IDLE);
  useEffect(() => {
    if (!url) { setState(IDLE); return; }
    let live = true;
    setState({ status: "loading", values: [], message: "Loading the list…" });
    load(url, column).then((values) => { if (live) setState({ status: "ready", values, message: "" }); },
      (e) => { if (live) setState({ status: "error", values: [], message: e instanceof Error ? e.message : "The list could not be loaded." }); });
    return () => { live = false; };
  }, [url, column]);
  return state;
}
