// Data quality hints: poor GPS, placed by hand, possible duplicates.
import { qualityFlags, distanceM } from "../src/lib/quality";
const ok = (c: boolean, m: string) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };

const form: any = { id: "f", fields: [{ id: "name", label: "Name", type: "text" }, { id: "kind", label: "Kind", type: "choice", choices: ["A"] }] };
const LAT = 7.77, M = 1 / 111320;                                       // about one metre of latitude
let n = 0;
const rec = (props: any, dy = 0, extra: any = {}) => ({ id: `r${String(n++).padStart(4, "0")}`, project_id: "p", form_id: "f", form_version: 1, version: 1, updated_at: "",
  status: "submitted", geometry: { type: "Point", coordinates: [4.55, LAT + dy * M] }, properties: props, ...extra });

const good = rec({ name: "Alpha", gps_hacc_m: 8, gps_src: "gps" }, 0);
const poor = rec({ name: "Beta", gps_hacc_m: 48, gps_src: "gps" }, 1000);
const hand = rec({ name: "Gamma", gps_src: "map" }, 2000);
const twinA = rec({ name: "Iwo Road Clinic" }, 3000);
const twinB = rec({ name: "iwo road clinic." }, 3030);                    // 30 m away, same name written differently
const spotA = rec({ name: "Well 1" }, 4000);
const spotB = rec({ name: "Well 2" }, 4003);                              // 3 m away, different names
const farTwin = rec({ name: "Alpha" }, 6000);                             // same name as `good`, 6 km away
const otherForm = rec({ name: "Well 1" }, 4001, { form_id: "g" });        // right next to spotA, but another form
const rejected = rec({ name: "Well 1" }, 4002, { status: "rejected" });

const flags = qualityFlags([good, poor, hand, twinA, twinB, spotA, spotB, farTwin, otherForm, rejected] as any, form);
const kinds = (r: any) => (flags.get(r.id) ?? []).map((f) => f.kind).sort().join(",");
ok(kinds(good) === "", "a good GPS reading with a unique name and place has no flags");
ok(kinds(poor) === "gps" && flags.get(poor.id)![0].label === "GPS ±48 m", "GPS worse than 30 m is flagged with its accuracy");
ok(kinds(hand) === "manual", "a point placed by hand on the map is noted");
ok(kinds(twinA) === "duplicate" && kinds(twinB) === "duplicate" && flags.get(twinA.id)![0].other === twinB.id && /30 m away \(same name\)/.test(flags.get(twinA.id)![0].detail), "the same name 30 m apart (ignoring case and punctuation) is a possible duplicate, both ways");
ok(kinds(spotA) === "duplicate" && kinds(spotB) === "duplicate" && /same spot/.test(flags.get(spotB.id)![0].detail), "two records 3 m apart are flagged whatever their names");
ok(kinds(farTwin) === "", "the same name 6 km away is not a duplicate");
ok(!(flags.get(spotA.id) ?? []).some((f) => f.other === otherForm.id || f.other === rejected.id), "other forms and rejected records are never matched");
ok(Math.abs(distanceM([4.55, LAT], [4.55, LAT + 30 * M]) - 30) < 0.1, "distances are right to within centimetres");

// speed: 5,000 records spread over a town
const many = Array.from({ length: 5000 }, (_, i) => rec({ name: `Place ${i}` }, (i % 100) * 37, { geometry: { type: "Point", coordinates: [4.5 + Math.floor(i / 100) * 0.0004, LAT + (i % 100) * 37 * M] } }));
const t0 = performance.now(); qualityFlags(many as any, form); const ms = performance.now() - t0;
ok(ms < 300, `5,000 records are checked in ${Math.round(ms)} ms`);
