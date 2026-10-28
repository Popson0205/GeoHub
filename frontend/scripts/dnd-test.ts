// Headless checks for drag-and-drop ordering in the form builder: moving fields, nesting rules, and where a drop lands.
import { canPlace, insertAt, moveTo } from "../src/lib/fieldSpec";
import { allTargets, describeTarget, hit, isAllowed, isNoop, type Block } from "../src/lib/dnd";
import type { FormField } from "../src/lib/types";

const ok = (c: boolean, m: string) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };
const f = (id: string, type: FormField["type"] = "text", children?: FormField[]): FormField => ({ id, label: id.toUpperCase(), type, ...(children ? { children } : {}) } as FormField);
const ids = (l: FormField[]) => l.map((x) => x.id).join(",");
const tree = (): FormField[] => [f("a"), f("b"), f("g", "group", [f("g1"), f("g2")]), f("c"), f("r", "repeat", [f("r1")])];

// ---- moving ----
let t = tree();
ok(ids(moveTo(t, "a", null, 2)) === "b,a,g,c,r", "drop a field lower in the same list");
ok(ids(moveTo(t, "c", null, 0)) === "c,a,b,g,r", "drop a field to the top");
ok(moveTo(t, "b", null, 1) === t && moveTo(t, "b", null, 2) === t, "dropping a field where it already is changes nothing");
ok(ids(moveTo(t, "a", null, 5)) === "b,g,c,r,a", "drop at the very end");
const into = moveTo(t, "a", "g", 1);
ok(ids(into) === "b,g,c,r" && ids(into.find((x) => x.id === "g")!.children!) === "g1,a,g2", "drag a field into a group, between its fields");
const out = moveTo(t, "g1", null, 0);
ok(ids(out) === "g1,a,b,g,c,r" && ids(out.find((x) => x.id === "g")!.children!) === "g2", "drag a field out of a group");
ok(ids(moveTo(t, "g2", "g", 0).find((x) => x.id === "g")!.children!) === "g2,g1", "reorder inside a group");
const wholeGroup = moveTo(t, "g", null, 0);
ok(ids(wholeGroup) === "g,a,b,c,r" && ids(wholeGroup[0].children!) === "g1,g2", "moving a group takes its contents with it");
const nested = moveTo(t, "g", "r", 0);
ok(ids(nested.find((x) => x.id === "r")!.children!) === "g,r1", "a group can move into a repeat");

// ---- rules ----
ok(moveTo(t, "g", "g", 0) === t && moveTo(t, "g", "g1", 0) === t, "a group never moves into itself");
ok(moveTo(t, "a", "b", 0) === t, "nothing can be dropped inside a plain field");
ok(!canPlace(t, "repeat", "r") && canPlace(t, "repeat", "g") && canPlace(t, "repeat", null), "a repeat cannot sit inside a repeat, but can sit in a group");
const gWithRepeat = [f("g", "group", [f("inner", "repeat", [f("x")])]), f("r", "repeat", [])];
ok(moveTo(gWithRepeat, "g", "r", 0) === gWithRepeat, "a group that holds a repeat cannot move into a repeat");
ok(ids(insertAt(t, f("n"), "g", 1).find((x) => x.id === "g")!.children!) === "g1,n,g2" && ids(insertAt(t, f("n"), null, 99)) === "a,b,g,c,r,n", "a new field is inserted at a slot, and the slot is clamped");

// ---- slots ----
const slots = allTargets(t);
ok(slots.length === 6 + 3 + 2 && slots[0].index === 0 && slots[0].parentId === null, "every gap in the form is a slot (top level, group, repeat)");
ok(slots[3].parentId === "g" && slots[5].parentId === "g" && slots[6].parentId === null && slots[6].index === 3, "slots come in the order they appear on screen");
ok(isNoop(t, "b", { parentId: null, index: 1 }) && isNoop(t, "b", { parentId: null, index: 2 }) && !isNoop(t, "b", { parentId: null, index: 3 }) && !isNoop(t, "b", { parentId: "g", index: 1 }), "a slot right above or below a field is a no-op for it");
ok(!isAllowed(t, { type: "text", id: "a" }, { parentId: null, index: 1 }) && isAllowed(t, { type: "text", id: "a" }, { parentId: null, index: 3 }) && !isAllowed(t, { type: "repeat" }, { parentId: "r", index: 0 }), "allowed means placeable and not a no-op");
ok(describeTarget(t, { parentId: null, index: 2 }) === "position 3 of 5" && describeTarget(t, { parentId: "g", index: 0 }) === "Inside “G”, position 1 of 2" && describeTarget(t, { parentId: null, index: 5 }) === "position 5 of 5", "slots are described in words for screen readers");
ok(describeTarget(t, { parentId: null, index: 4 }, "b") === "position 4 of 5" && describeTarget(t, { parentId: null, index: 0 }, "b") === "position 1 of 5", "before a move, the position is the one the field will have after it (later slots shift up)");
ok(describeTarget(t, { parentId: "g", index: 1 }, "a") === "Inside “G”, position 2 of 3", "moving in from another list, that list gains one");

// ---- what is under the pointer ----
const card = (top: number): { top: number; bottom: number } => ({ top, bottom: top + 50 });
const blocks: Block[] = [
  { id: "a", container: false, card: card(0), children: [] },
  { id: "b", container: false, card: card(60), children: [] },
  { id: "g", container: true, card: card(120), kids: { top: 175, bottom: 295 }, children: [
    { id: "g1", container: false, card: card(180), children: [] }, { id: "g2", container: false, card: card(240), children: [] }] },
  { id: "c", container: false, card: card(310), children: [] },
  { id: "r", container: true, card: card(370), kids: { top: 425, bottom: 465 }, children: [] },
];
const yes = () => true;
const at = (y: number, allow: (id: string) => boolean = yes) => hit(blocks, null, y, allow);
ok(JSON.stringify(at(5)) === '{"parentId":null,"index":0}' && JSON.stringify(at(40)) === '{"parentId":null,"index":1}', "top half of a card drops before it, bottom half drops after it");
ok(JSON.stringify(at(-20)) === '{"parentId":null,"index":0}' && JSON.stringify(at(900)) === '{"parentId":null,"index":5}', "above everything is the start, below everything is the end");
ok(JSON.stringify(at(150)) === '{"parentId":"g","index":0}', "lower half of a group's card drops into the start of the group");
ok(JSON.stringify(at(190)) === '{"parentId":"g","index":0}' && JSON.stringify(at(228)) === '{"parentId":"g","index":1}' && JSON.stringify(at(285)) === '{"parentId":"g","index":2}', "inside a group the same halves rule picks the slot");
ok(JSON.stringify(at(300)) === '{"parentId":null,"index":3}', "just below a group's contents is the slot after the group");
ok(JSON.stringify(at(440)) === '{"parentId":"r","index":0}', "an empty repeat accepts a drop in its box");
ok(JSON.stringify(at(190, (id) => id !== "g")) === '{"parentId":null,"index":3}', "a group that cannot take the dragged field is treated like a plain field");
