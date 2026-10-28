// Run with: npm run test:forms
import { applyDefaults, checkFieldDefs, pruneProperties, validateProperties } from "../src/lib/forms";
import { moveField, moveInto, newField, PALETTE, slugifyFieldId, TYPE_SPECS } from "../src/lib/fieldSpec";
import { evalCalc, evalCondition, resolve } from "../src/lib/logic";
import type { FormField } from "../src/lib/types";

const ok = (c: boolean, m: string) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };

const fields: FormField[] = [
  { id: "type", label: "Type", type: "choice", required: true, choices: ["Clinic", "Hospital"] },
  { id: "has_power", label: "Has power", type: "boolean" },
  { id: "power_source", label: "Power source", type: "choice", choices: ["Grid", "Solar"], required: true, visible: { field: "has_power", op: "eq", value: true } },
  { id: "w", label: "Width", type: "number", min: 0, max: 100 },
  { id: "h", label: "Height", type: "number" },
  { id: "area", label: "Area", type: "calculation", calc: { fn: "product", args: [{ field: "w" }, { field: "h" }] } },
  { id: "notes", label: "Notes", type: "note", text: "Read me" },
  { id: "site", label: "Site", type: "group", visible: { field: "type", op: "eq", value: "Hospital" }, children: [
    { id: "beds", label: "Beds", type: "number", integer: true, required: true },
  ] },
  { id: "ack", label: "I agree", type: "boolean", must_be_true: true, required: true },
  { id: "rooms", label: "Rooms", type: "repeat", min_items: 1, children: [
    { id: "room", label: "Room", type: "text", required: true },
    { id: "kind", label: "Kind", type: "choice", choices: ["Ward", "Office"] },
    { id: "ward_beds", label: "Ward beds", type: "number", visible: { field: "kind", op: "eq", value: "Ward" }, required: true },
  ] },
];
const form = { fields };

// conditions and calculations
ok(evalCondition({ all: [{ field: "a", op: "gt", value: 2 }, { not: { field: "b", op: "filled" } }] }, (id) => ({ a: 5 } as Record<string, unknown>)[id]), "all / not / gt");
ok(evalCondition({ field: "s", op: "contains", value: ["x"] }, () => ["x", "y"]), "contains on a list");
ok(evalCondition({ field: "d", op: "lt", value: "2026-02-01" }, () => "2026-01-15"), "ISO dates compare as text");
ok(evalCalc({ fn: "ratio", args: [{ field: "a" }, { const: 0 }] }, () => 4) === null, "ratio by zero is empty");
ok(evalCalc({ fn: "sum", args: [{ const: 0.1 }, { const: 0.2 }] }, () => 0) === 0.3, "sum rounds float noise");
ok(evalCalc({ fn: "concat", args: [{ field: "a" }, { field: "b" }], sep: "-" }, (id) => (id === "a" ? "x" : "")) === "x", "concat skips empty");

// visibility, required, calculation
let r = resolve(fields, { type: "Clinic" });
ok(r.hidden.has("power_source") && r.hidden.has("site") && r.hidden.has("beds"), "hidden by condition, children inherit from a hidden group");
ok(!r.required.has("power_source") && !r.required.has("beds"), "hidden fields are not required");
r = resolve(fields, { type: "Hospital", has_power: true, w: 3, h: 4 });
ok(!r.hidden.has("power_source") && r.required.has("power_source") && r.required.has("beds"), "visible when the condition holds");
ok(r.values.area === 12, "calculation is filled in");

// validation
let e = validateProperties(form, { type: "Clinic", ack: true, rooms: [{ room: "A" }] });
ok(Object.keys(e).length === 0, "valid form passes: " + JSON.stringify(e));
e = validateProperties(form, { type: "Hospital", ack: true, rooms: [{ room: "A" }] });
ok(e.beds === "Beds is required.", "required inside a visible group");
e = validateProperties(form, { type: "Clinic", ack: false, rooms: [{ room: "A" }] });
ok(!!e.ack, "acknowledgement must be accepted");
e = validateProperties(form, { type: "Clinic", ack: true });
ok(!!e.rooms, "repeat needs a row when min_items is 1");
e = validateProperties(form, { type: "Clinic", ack: true, rooms: [{ room: "A", kind: "Ward" }, { kind: "Office" }] });
ok(!!e["rooms.0.ward_beds"] && !!e["rooms.1.room"] && !e["rooms.1.ward_beds"], "errors inside repeat rows are keyed by row");
e = validateProperties(form, { type: "Clinic", ack: true, rooms: [{ room: "A" }], w: 500 });
ok(!!e.w, "max is enforced");

// pruning
const pruned = pruneProperties(form, { type: "Clinic", ack: true, has_power: false, power_source: "Grid", beds: 4, w: 2, h: 5, rooms: [{ room: "A", kind: "Office", ward_beds: 9 }] });
ok(!("power_source" in pruned) && !("beds" in pruned), "hidden answers are dropped");
ok(pruned.area === 10, "calculation is saved");
ok(JSON.stringify(pruned.rooms) === JSON.stringify([{ room: "A", kind: "Office" }]), "hidden answers inside a repeat row are dropped");
ok(pruneProperties({ fields: [{ id: "c", label: "C", type: "calculation", calc: { fn: "today" }, store: false }] }, {}).c === undefined, "store:false is not saved");

// defaults
ok(/^\d{4}-\d{2}-\d{2}$/.test(String(applyDefaults([{ id: "d", label: "D", type: "date", default: "$today" }]).d)), "$today default is applied");
ok(applyDefaults([{ id: "t", label: "T", type: "text", default: "x" }], { t: "y" }).t === "y", "defaults never overwrite an answer");

// design checks
const bad = checkFieldDefs([
  { id: "a", label: "A", type: "choice" },
  { id: "a", label: "", type: "text" },
  { id: "c1", label: "C1", type: "calculation", calc: { fn: "sum", args: [{ field: "c2" }] } },
  { id: "c2", label: "C2", type: "calculation", calc: { fn: "sum", args: [{ field: "c1" }] } },
  { id: "x", label: "X", type: "text", visible: { field: "nope", op: "filled" } },
  { id: "rep", label: "Rep", type: "repeat", children: [{ id: "inner", label: "Inner", type: "repeat", children: [] }] },
]);
ok(!!bad.a && !!bad.c1 && !!bad.c2 && !!bad.x && !!bad.inner, "design problems are found: " + JSON.stringify(bad));
ok(Object.keys(checkFieldDefs(fields)).length === 0, "the sample form has no design problems");

// registry and tree helpers
ok(PALETTE.every((p) => p.type in TYPE_SPECS), "every palette entry maps to a type");
ok(new Set(PALETTE.map((p) => p.key)).size === PALETTE.length, "palette keys are unique");
ok(PALETTE.length === 23, "23 palette entries cover the 26 requested elements (the 3 GPS ones are the form's geometry, not fields)");
ok(slugifyFieldId("Water Source!", [{ id: "water_source", label: "x", type: "text" }]) === "water_source_2", "ids are unique slugs");
const g = newField(PALETTE.find((p) => p.key === "group")!, []);
const tree = [g, newField(PALETTE.find((p) => p.key === "text")!, [g])];
const nested = moveInto(tree, tree[1].id, g.id);
ok(nested.length === 1 && nested[0].children?.length === 1, "move a field into a group");
ok(moveInto(nested, g.id, g.id) === nested, "a group cannot move into itself");
ok(moveInto(nested, tree[1].id, null).length === 2, "move a field out of a group");
ok(moveField([tree[0], tree[1]], tree[1].id, -1)[0].id === tree[1].id, "move a field up");
