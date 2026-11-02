import { combineFixes, gpsProps, withoutGps, type Fix } from "../src/lib/gps";
import { pruneProperties } from "../src/lib/forms";

const ok = (c: boolean, m: string) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };
const fx = (lon: number, lat: number, acc: number, alt: number | null = null, altAcc: number | null = null): Fix => ({ lon, lat, acc, alt, altAcc });

// a poor early reading must not drag the result away from the good ones
const r = combineFixes([fx(4.5, 7.8, 40, 300, 50), fx(4.55, 7.79, 4, 310, 8), fx(4.55001, 7.79001, 5, 312, 9)]);
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

// zooming to a position
import { viewAround } from "../src/lib/gps";
{
  const [w, s, e, n] = viewAround(7.5, 9, 5);
  const metresN = (n - s) / 2 * 111320, metresE = (e - w) / 2 * 111320 * Math.cos((9 * Math.PI) / 180);
  ok(w < 7.5 && e > 7.5 && s < 9 && n > 9 && Math.abs((w + e) / 2 - 7.5) < 1e-9 && Math.abs((s + n) / 2 - 9) < 1e-9, "the box is centred on the position");
  ok(Math.abs(metresN - 30) < 0.01 && Math.abs(metresE - 30) < 0.01, "a very good reading still shows at least 30 m around it");
  const mid = viewAround(7.5, 9, 40); ok(Math.abs((mid[3] - mid[1]) / 2 * 111320 - 60) < 0.01, "otherwise about 1.5 times the accuracy");
  const poor = viewAround(7.5, 9, 50000); ok(Math.abs((poor[3] - poor[1]) / 2 * 111320 - 2000) < 0.01, "a very poor reading is capped at 2 km so the map still zooms in");
  const polar = viewAround(10, 89.9, 30); ok(polar.every(Number.isFinite), "near the poles the box stays finite");
  ok(viewAround(1, 1, NaN).every(Number.isFinite), "an unknown accuracy still gives a box");
}

// sharper readings: outliers, honest accuracy, movement
import { dropOutliers, isMoving, metresBetween, quality } from "../src/lib/gps";
{
  const m = (dx: number, dy: number, acc = 4, speed: number | null = null): Fix => ({ lon: 4.55 + dx / 110000, lat: 7.79 + dy / 110000, acc, alt: null, altAcc: null, speed });
  const steady = [m(0, 0), m(1, 0), m(0, 1), m(-1, 0), m(0, -1)];
  const jump = [...steady, m(40, 0, 5)];
  ok(dropOutliers(jump).length === 5, "a reading that jumps 40 m away from the rest is dropped");
  const c = combineFixes(jump);
  ok(metresBetween(c, { lon: 4.55, lat: 7.79 }) < 1.5, "so the result stays where the steady readings are");
  ok(c.dropped === 1, "and the dropped reading is counted");
  ok(dropOutliers([m(0, 0, 20), m(15, 0, 20), m(-12, 5, 20), m(3, -14, 20)]).length === 4, "a noisy receiver is not left with nothing");
  const scattered = combineFixes([m(0, 0, 3), m(12, 0, 3), m(-12, 0, 3), m(0, 12, 3)]);
  ok(scattered.hacc > 7, `readings that disagree by more than they claim report the wider figure (±${scattered.hacc.toFixed(1)} m, not ±3)`);
  ok(combineFixes(steady).hacc === 4, "readings that agree keep the device's own figure");
  ok(!isMoving(steady), "standing still is not moving");
  ok(!isMoving([...steady, m(30, 0, 4)]), "one reading 30 m away is a jump, not walking");
  ok(isMoving([...steady, m(30, 0, 4), m(31, 1, 4)]), "two readings agreeing on a place 30 m away mean the person walked");
  ok(isMoving([...steady, m(0.5, 0, 4, 1.6)]), "the device's own speed counts too");
  ok(quality(4) === "good" && quality(9) === "fair" && quality(25) === "poor", "readings are labelled good, fair or poor");
}
