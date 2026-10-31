import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { isHex, symbolUri } from "../lib/symbols";
import type { SymbolSpec } from "../lib/types";

// "rgb(12, 34, 56)" or "color(srgb 0.1 0.2 0.3)" (what a browser reports for a mixed colour) to #rrggbb.
function toHex(css: string): string | null {
  const to = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(css);
  if (rgb) return `#${to(+rgb[1])}${to(+rgb[2])}${to(+rgb[3])}`;
  const srgb = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(css);
  return srgb ? `#${to(+srgb[1] * 255)}${to(+srgb[2] * 255)}${to(+srgb[3] * 255)}` : null;
}

/**
 * A symbol, drawn as a picture. With no colour of its own it takes the colour of the text around it, like an icon font would, so
 * it matches a number, a heading or a theme. `color` overrides that (a map legend passes the class colour).
 * Motion is a CSS class on the wrapper; people who ask their system for less motion get none (see the stylesheet).
 */
export function SymbolIcon({ spec, size = 24, color, label, className }: { spec?: SymbolSpec; size?: number; color?: string; label?: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [inherited, setInherited] = useState<string | undefined>();
  const needs = !!spec && !isHex(spec.color) && !isHex(color);
  useLayoutEffect(() => {
    if (needs && ref.current) setInherited(toHex(getComputedStyle(ref.current).color) ?? undefined);
  }, [needs, spec?.shape]);
  const uri = useMemo(() => symbolUri(spec, { color: isHex(color) ? color : inherited }), [spec, color, inherited]);
  if (!spec || (!spec.icon && !spec.svg)) return null;
  const motion = spec.motion && spec.motion !== "none" ? ` sym-m-${spec.motion}` : "";
  const c = isHex(spec.color) ? spec.color : isHex(color) ? color : inherited;
  return (
    <span ref={ref} className={`sym${motion}${className ? ` ${className}` : ""}`} style={{ width: size, height: size, ...(c ? { "--sym-c": c } : {}) } as CSSProperties}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}>
      {uri && <img src={uri} alt="" width={size} height={size} draggable={false} />}
    </span>
  );
}
