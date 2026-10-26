import { combineFixes, gpsProps, withoutGps, type Fix } from "../src/lib/gps";
import { pruneProperties } from "../src/lib/forms";

const ok = (c: boolean, m: string) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };
const fx = (lon: number, lat: number, acc: number, alt: number | null = null, altAcc: number | null = null): Fix => ({ lon, lat, acc, alt, altAcc });

// a poor early reading must not drag the result away from the good ones
const r = combineFixes([fx(4.5, 7.8, 40, 300, 50), fx(4.55, 7.79, 4, 310, 8), fx(4.5501, 7.7901, 5, 312, 9)]);
ok(Math.abs(r.lon - 4.55) < 0.0005 && Math.abs(r.lat - 7.79) < 0.0005, "poor readings are dropped from the average");
ok(r.hacc === 4, "reported accuracy is the best single reading, not an invented improvement");
ok(r.elev != null && r.elev > 309 && r.elev < 313, "elevation is averaged from the good readings");
ok(r.vacc === 8, "vertical accuracy is reported");
ok(combineFixes([fx(1, 2, 6)]).elev === null, "no elevation when the device gives none");

const p = gpsProps(r);
ok(p.gps_src === "gps" && p.gps_hacc_m === 4 && typeof p.gps_elev_m === "number", "values to save are built");
ok(!("gps_elev_m" in gpsProps(combineFixes([fx(1, 2, 6)]))), "elevation key is left out when unknown");
ok(Object.keys(withoutGps({ name: "x", ...p })).join() === "name", "device values can be stripped (when a point is moved by hand)");

const form = { fields: [{ id: "name", type: "text", label: "Name" }] } as any;
const saved = pruneProperties(form, { name: "Well", ...p });
ok(saved.name === "Well" && saved.gps_elev_m === p.gps_elev_m && saved.gps_src === "gps", "device values survive saving a record");
