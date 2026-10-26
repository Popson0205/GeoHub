import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKey, type PointerEvent as ReactPointer, type ReactNode } from "react";
import { allTargets, describeTarget, hit, isAllowed, isNoop, type Block, type Mover, type Target } from "../lib/dnd";
import { canPlace, findField, insertAt, isContainer, locate, moveTo, newField, type PaletteItem } from "../lib/fieldSpec";
import type { FieldType, FormField } from "../lib/types";

type Source =
  | { kind: "move"; id: string; type: FieldType; label: string }
  | { kind: "new"; item: PaletteItem; type: FieldType; label: string };
interface Line { top: number; left: number; width: number }

const THRESHOLD = 5;          // pixels the pointer must travel before a press becomes a drag
const EDGE = 64;              // distance from the top or bottom of the scroll area where dragging starts to scroll it

const scrollParent = (el: HTMLElement | null): HTMLElement => {
  for (let p = el?.parentElement ?? null; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if ((o === "auto" || o === "scroll") && p.scrollHeight > p.clientHeight) return p;
  }
  return (document.scrollingElement as HTMLElement) ?? document.documentElement;
};

/**
 * Drag and drop for the form builder's field list: reorder fields, move them in and out of groups and repeats, and drag new
 * fields in from the palette. Mouse and touch use pointer events; the keyboard picks a field up with Space, moves it with the
 * arrow keys and drops it with Space, with spoken updates for screen readers. All the placement rules live in lib/dnd.ts and lib/fieldSpec.ts.
 */
export function useFieldDnd({ fields, enabled, onChange, onSelect }: { fields: FormField[]; enabled: boolean; onChange: (next: FormField[]) => void; onSelect: (id: string) => void }) {
  const fieldsRef = useRef(fields);
  fieldsRef.current = fields;
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const els = useRef({ block: new Map<string, HTMLElement>(), card: new Map<string, HTMLElement>(), kids: new Map<string, HTMLElement>() });
  const [source, setSource] = useState<Source | null>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const [ghost, setGhost] = useState<{ x: number; y: number } | null>(null);
  const [line, setLine] = useState<Line | null>(null);
  const [message, setMessage] = useState("");
  const targetRef = useRef<Target | null>(null);
  const justDragged = useRef(false);
  const keyboard = useRef<{ id: string; slots: Target[]; at: number } | null>(null);
  const cleanup = useRef<(() => void) | null>(null);

  const setT = (t: Target | null) => { targetRef.current = t; setTarget(t); };
  useEffect(() => () => cleanup.current?.(), []);
  useEffect(() => { if (!enabled) { cleanup.current?.(); } }, [enabled]);

  const reg = (kind: "block" | "card" | "kids") => (id: string) => (el: HTMLElement | null) => { if (el) els.current[kind].set(id, el); else els.current[kind].delete(id); };

  // ---- geometry ----
  const measure = (list: FormField[]): Block[] => list.map((f) => {
    const c = els.current.card.get(f.id)?.getBoundingClientRect();
    const k = els.current.kids.get(f.id)?.getBoundingClientRect();
    return { id: f.id, container: isContainer(f.type), card: { top: c?.top ?? 0, bottom: c?.bottom ?? 0 }, kids: k ? { top: k.top, bottom: k.bottom } : undefined, children: f.children ? measure(f.children) : [] };
  });

  const pick = (src: Source, x: number, y: number): Target | null => {
    const wrap = wrapRef.current;
    const cur = fieldsRef.current;
    if (!wrap) return null;
    const r = wrap.getBoundingClientRect();
    if (x < r.left - 24 || x > r.right + 24) return null;                      // the pointer is outside the form column
    const mover: Mover = { type: src.type, id: src.kind === "move" ? src.id : undefined };
    const t = hit(measure(cur), null, y, (cid) => canPlace(cur, mover.type, cid, mover.id));
    return isAllowed(cur, mover, t) ? t : null;
  };

  const lineFor = (t: Target | null): Line | null => {
    const wrap = wrapRef.current;
    if (!t || !wrap) return null;
    const cur = fieldsRef.current;
    const w = wrap.getBoundingClientRect();
    const list = t.parentId ? findField(cur, t.parentId)?.children ?? [] : cur;
    if (t.index < list.length) {
      const r = els.current.card.get(list[t.index].id)?.getBoundingClientRect();
      return r ? { top: r.top - w.top - 5, left: r.left - w.left, width: r.width } : null;
    }
    if (list.length) {
      const last = list[list.length - 1];
      const b = els.current.block.get(last.id)?.getBoundingClientRect();
      const c = els.current.card.get(last.id)?.getBoundingClientRect();
      return b && c ? { top: b.bottom - w.top + 5, left: c.left - w.left, width: c.width } : null;
    }
    const k = t.parentId ? els.current.kids.get(t.parentId)?.getBoundingClientRect() : null;
    return k ? { top: k.top - w.top + 8, left: k.left - w.left + 8, width: k.width - 16 } : null;
  };
  useLayoutEffect(() => { setLine(lineFor(target)); }, [target]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- applying a drop ----
  const commit = (src: Source, t: Target): boolean => {
    const cur = fieldsRef.current;
    if (src.kind === "move") {
      const next = moveTo(cur, src.id, t.parentId, t.index);
      if (next === cur) return false;
      onChange(next);
      onSelect(src.id);
      const loc = locate(next, src.id);
      if (loc) setMessage(`Moved “${src.label}”. ${describeTarget(next, { parentId: loc.parent?.id ?? null, index: loc.index })}.`);
      return true;
    }
    const f = newField(src.item, cur);
    const next = insertAt(cur, f, t.parentId, t.index);
    onChange(next);
    onSelect(f.id);
    const loc = locate(next, f.id);
    setMessage(`Added “${f.label}”. ${loc ? describeTarget(next, { parentId: loc.parent?.id ?? null, index: loc.index }) : ""}.`);
    return true;
  };

  // ---- mouse, pen and touch ----
  function start(e: ReactPointer, src: Source) {
    if (!enabled || e.button !== 0 || cleanup.current) return;
    const x0 = e.clientX, y0 = e.clientY;
    let started = false;
    let raf = 0;
    let last = { x: x0, y: y0 };
    const scroller = scrollParent(wrapRef.current);

    const refresh = () => setT(pick(src, last.x, last.y));
    const tick = () => {
      raf = 0;
      if (!started) return;
      const box = scroller === document.scrollingElement ? { top: 0, bottom: window.innerHeight } : scroller.getBoundingClientRect();
      const dy = last.y < box.top + EDGE ? -(box.top + EDGE - last.y) : last.y > box.bottom - EDGE ? last.y - (box.bottom - EDGE) : 0;
      if (dy) { scroller.scrollBy(0, Math.max(-18, Math.min(18, dy / 3))); refresh(); raf = requestAnimationFrame(tick); }
    };
    const move = (ev: PointerEvent) => {
      if (!started) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < THRESHOLD) return;
        started = true;
        setSource(src);
        document.body.classList.add("is-dnd");
      }
      ev.preventDefault();
      last = { x: ev.clientX, y: ev.clientY };
      setGhost(last);
      refresh();
      if (!raf) raf = requestAnimationFrame(tick);
    };
    const end = (apply: boolean) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key, true);
      cancelAnimationFrame(raf);
      document.body.classList.remove("is-dnd");
      cleanup.current = null;
      const t = targetRef.current;
      if (started) { justDragged.current = true; setTimeout(() => { justDragged.current = false; }, 0); }
      setSource(null); setGhost(null); setT(null);
      if (started && apply && t) commit(src, t);
    };
    const up = () => end(true);
    const cancel = () => end(false);
    const key = (ev: KeyboardEvent) => { if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); end(false); setMessage("Move cancelled."); } };
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key, true);
    cleanup.current = () => end(false);
  }

  // ---- keyboard ----
  const stepsFor = (id: string, type: FieldType) => {
    const cur = fieldsRef.current;
    const slots = allTargets(cur);
    const loc = locate(cur, id);
    const home = loc ? Math.max(0, slots.findIndex((s) => s.parentId === (loc.parent?.id ?? null) && s.index === loc.index)) : 0;
    const valid = (s: Target) => canPlace(cur, type, s.parentId, id) && !isNoop(cur, id, s);
    return { slots, home, valid };
  };
  function keyDown(e: ReactKey, f: FormField) {
    if (!enabled) return;
    const kb = keyboard.current;
    const src: Source = { kind: "move", id: f.id, type: f.type, label: f.label || "field" };
    if (!kb) {
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        const { slots, home } = stepsFor(f.id, f.type);
        keyboard.current = { id: f.id, slots, at: home };
        setSource(src);
        setMessage(`Picked up “${src.label}”. Use the up and down arrow keys to move it, Space to drop it, Escape to cancel.`);
      }
      return;
    }
    if (kb.id !== f.id) return;
    const done = (msg: string) => { keyboard.current = null; setSource(null); setT(null); setMessage(msg); };
    if (e.key === "Escape" || e.key === "Tab") { if (e.key === "Escape") e.preventDefault(); done("Move cancelled."); return; }
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      const t = targetRef.current;
      keyboard.current = null; setSource(null); setT(null);
      if (t && commit(src, t)) return;
      setMessage(`“${src.label}” stays where it was.`);
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const dir = e.key === "ArrowDown" ? 1 : -1;
      const { slots, valid } = stepsFor(f.id, f.type);
      let i = kb.at + dir;
      while (i >= 0 && i < slots.length && !valid(slots[i])) i += dir;
      if (i < 0 || i >= slots.length) { setMessage("It can't move any further."); return; }
      kb.at = i;
      setT(slots[i]);
      setMessage(`${describeTarget(fieldsRef.current, slots[i], f.id)}.`);
      requestAnimationFrame(() => { const list = slots[i].parentId ? findField(fieldsRef.current, slots[i].parentId!)?.children ?? [] : fieldsRef.current; const near = list[Math.min(slots[i].index, list.length - 1)]; els.current.card.get(near?.id ?? "")?.scrollIntoView?.({ block: "nearest" }); });
    }
  }
  const handleBlur = (f: FormField) => { if (keyboard.current?.id === f.id) { keyboard.current = null; setSource(null); setT(null); setMessage("Move cancelled."); } };

  const moving = source?.kind === "move" ? source.id : null;
  const overlay: ReactNode = (
    <>
      {source && line && target && <div className="drop-line" style={{ top: line.top, left: line.left, width: line.width }} aria-hidden="true" />}
      {ghost && source && <div className={`drag-ghost${target ? "" : " is-blocked"}`} style={{ left: ghost.x + 14, top: ghost.y + 14 }} aria-hidden="true">{source.label}{target ? "" : " · can't drop here"}</div>}
      <div className="sr-only" role="status" aria-live="assertive">{message}</div>
    </>
  );

  return {
    wrapRef,
    overlay,
    moving,
    active: !!source,
    overEmpty: !!source && !!target && fieldsRef.current.length === 0,
    blockRef: reg("block"), cardRef: reg("card"), kidsRef: reg("kids"),
    handleProps: (f: FormField) => ({
      onPointerDown: (e: ReactPointer) => start(e, { kind: "move", id: f.id, type: f.type, label: f.label || "field" }),
      onKeyDown: (e: ReactKey) => keyDown(e, f),
      onBlur: () => handleBlur(f),
      "aria-pressed": moving === f.id,
    }),
    /** Mouse users can also drag a field by its card. Touch users drag by the grip so scrolling still works. */
    cardProps: (f: FormField) => ({
      onPointerDown: (e: ReactPointer) => { if (e.pointerType === "touch") return; start(e, { kind: "move", id: f.id, type: f.type, label: f.label || "field" }); },
      onClickCapture: (e: { preventDefault(): void; stopPropagation(): void }) => { if (justDragged.current) { e.preventDefault(); e.stopPropagation(); } },
    }),
    paletteProps: (item: PaletteItem) => ({
      onPointerDown: (e: ReactPointer) => { if (e.pointerType === "touch") return; start(e, { kind: "new", item, type: item.type, label: item.label }); },
      onClickCapture: (e: { preventDefault(): void; stopPropagation(): void }) => { if (justDragged.current) { e.preventDefault(); e.stopPropagation(); } },
    }),
  };
}
