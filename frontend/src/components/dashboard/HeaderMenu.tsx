import { useEffect, useRef } from "react";

export interface MenuItem { label: string; onClick: () => void; disabled?: boolean; hidden?: boolean }

/** The ⋮ menu at the right of the title bar: refresh, print, and (for authors) page tools and how to arrange. */
export function HeaderMenu({ items, help }: { items: MenuItem[]; help?: string }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const away = (e: PointerEvent) => { if (el.open && !el.contains(e.target as Node)) el.open = false; };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape" && el.open) { el.open = false; el.querySelector("summary")?.focus(); } };
    document.addEventListener("pointerdown", away); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", esc); };
  }, []);
  const shown = items.filter((i) => !i.hidden);
  return (
    <details ref={ref} className="dash-menu">
      <summary aria-label="More options" title="More options"><span aria-hidden="true">⋮</span></summary>
      <div className="dash-menu-panel" role="menu">
        {shown.map((i) => <button key={i.label} type="button" role="menuitem" disabled={i.disabled} onClick={() => { if (ref.current) ref.current.open = false; i.onClick(); }}>{i.label}</button>)}
        {help && <p className="dash-menu-help">{help}</p>}
      </div>
    </details>
  );
}
