import { formTemplateCsv, importFormCsv } from "../src/lib/formImport";
import { allFields } from "../src/lib/fieldSpec";
import { checkFieldDefs } from "../src/lib/forms";
const ok = (c: boolean, m: string) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };

// the downloadable template imports cleanly
const t = importFormCsv(formTemplateCsv());
ok(t.problems.length === 0, `template has no problems (${t.problems.map((p) => p.message).join("; ")})`);
ok(t.count === 12 && t.fields.length === 10, `template: 12 fields, 10 at the top (${t.count}/${t.fields.length})`);
const g = t.fields.find((f) => f.type === "group");
ok(g?.children?.length === 2, "begin group / end group nests two fields");
const cond = t.fields.find((f) => f.id === "condition");
ok(cond?.type === "choice" && cond.appearance === "radio" && cond.required && cond.choices?.join("|") === "Working|Needs repair|Broken", "select_one with choices, appearance, required");
ok(t.fields.find((f) => f.id === "households")?.integer === true && t.fields.find((f) => f.id === "households")?.max === 10000, "integer with min/max");
ok(t.fields.find((f) => f.id === "visit_date")?.default === "$today", "default today -> $today");
ok(t.fields.find((f) => f.id === "has_fence")?.default === false, "boolean default no -> false");
ok(Object.keys(checkFieldDefs(t.fields)).length === 0, "the builder's own checks find nothing wrong");

// semicolon file, BOM, XLSForm choice list rows, unknown column, existing ids
const csv = "\uFEFFtype;name;label;extra\r\nselect_one yn;ok;Is it ok?;x\r\nchoices yn;;Yes;\r\nchoices yn;;No;\r\ntext;ok;Is it ok?;\r\ngeopoint;loc;Where;\r\nbogus;a;A;\r\nend group;;;\r\n";
const r = importFormCsv(csv, [{ id: "ok", label: "Old", type: "text" }]);
ok(r.fields[0].choices?.join() === "Yes,No", "XLSForm choice rows feed select_one list");
ok(r.fields[0].id === "ok_2" && r.fields[1].id === "ok_3", `ids stay unique against the form (${r.fields.map((f) => f.id)})`);
ok(r.ignoredColumns.join() === "extra", "unknown columns are reported");
ok(r.problems.some((p) => p.line === 6 && /map/.test(p.message)), "geopoint row explained");
ok(r.problems.some((p) => p.line === 7 && /Unknown type/.test(p.message)), "unknown type reported with line number");
ok(r.problems.some((p) => /without a matching/.test(p.message)), "stray end reported");

// errors
ok(importFormCsv("").problems.length === 1, "empty file");
ok(/no “type” column/.test(importFormCsv("a,b\n1,2").problems[0].message), "missing type column");
const nested = importFormCsv("type,label\nbegin repeat,R\nbegin repeat,R2\ntext,x\nend repeat\nend repeat");
ok(nested.problems.some((p) => /another repeat/.test(p.message)) , "repeat inside repeat flagged");
const open = importFormCsv("type,label\nbegin group,G\ntext,x");
ok(open.problems.some((p) => /never closed/.test(p.message)) && allFields(open.fields).length === 2, "unclosed group closed at end");
const noCh = importFormCsv("type,label\nselect_multiple,Pick");
ok(noCh.problems.length >= 1, "choice field without choices reported");
const q = importFormCsv('type,label,choices\nselect_one,Colour,"Red, light; Blue"');
ok(q.fields[0].choices?.join("|") === "Red, light|Blue", "quoted cell with a comma keeps it inside the option");
