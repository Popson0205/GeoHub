import { canPlace, findField, isContainer, locate } from "./fieldSpec";
import type { FieldType, FormField } from "./types";

/** A drop position: a slot in the list of fields at the top level (parentId null) or inside a group or repeat. */
export interface Target { parentId: string | null; index: number }
export interface Box { top: number; bottom: number }
/** The measured shape of the field list on screen: each field's card, and for groups and repeats the box that holds their children. */
export interface Block { id: string; container: boolean; card: Box; kids?: Box; children: Block[] }

export const sameTarget = (a: Target | null, b: Target | null): boolean => !!a && !!b && a.parentId === b.parentId && a.index === b.index;
const listOf = (fields: FormField[], parentId: string | null): FormField[] => (parentId ? findField(fields, parentId)?.children ?? [] : fields);

/**
 * Which slot is the pointer over? Work down the list: above a field's middle means before it; in the lower half of a group
 * means at the start of its contents; inside a group's content box means somewhere in there; below everything means the end.
 * `allowInto` says whether a container may receive the thing being dragged (false treats it like a plain field).
 */
export function hit(blocks: Block[], parentId: string | null, y: number, allowInto: (containerId: string) => boolean): Target {
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const open = b.container && allowInto(b.id);
    if (open && b.kids && y >= b.kids.top && y <= b.kids.bottom) return hit(b.children, b.id, y, allowInto);
    if (y < (b.card.top + b.card.bottom) / 2) return { parentId, index: i };
    if (open && y <= b.card.bottom) return { parentId: b.id, index: 0 };
  }
  return { parentId, index: blocks.length };
}

/** Every slot in the form, in the order they appear on screen. */
export function allTargets(fields: FormField[]): Target[] {
  const out: Target[] = [];
  const visit = (list: FormField[], parentId: string | null) => {
    for (let i = 0; i <= list.length; i++) {
      out.push({ parentId, index: i });
      const f = list[i];
      if (f && isContainer(f.type)) visit(f.children ?? [], f.id);
    }
  };
  visit(fields, null);
  return out;
}

/** Is dropping `movingId` here a no-op (it would end up where it already is)? */
export function isNoop(fields: FormField[], movingId: string, t: Target): boolean {
  const loc = locate(fields, movingId);
  return !!loc && (loc.parent?.id ?? null) === t.parentId && (t.index === loc.index || t.index === loc.index + 1);
}

export interface Mover { type: FieldType; id?: string }
export const isAllowed = (fields: FormField[], m: Mover, t: Target): boolean => canPlace(fields, m.type, t.parentId, m.id) && !(m.id && isNoop(fields, m.id, t));

/**
 * A sentence for screen readers: where a field is, or would end up. Pass `movingId` when describing a slot before a move, so the
 * position is the one the field will have afterwards (taking it out of the list shifts later slots up by one).
 */
export function describeTarget(fields: FormField[], t: Target, movingId?: string): string {
  const list = listOf(fields, t.parentId);
  const parent = t.parentId ? findField(fields, t.parentId) : null;
  let total = list.length;
  let pos = t.index + 1;
  if (movingId) {
    const loc = locate(fields, movingId);
    if (loc && (loc.parent?.id ?? null) === t.parentId) { if (t.index > loc.index) pos -= 1; }
    else total += 1;                                   // arriving from another list makes this one longer
  }
  total = Math.max(total, 1);
  return `${parent ? `Inside “${parent.label || "group"}”, ` : ""}position ${Math.min(pos, total)} of ${total}`;
}
