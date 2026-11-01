// A reviewer's note reaches the collector, who fixes the record and sends it back for review.
import "fake-indexeddb/auto";
const store = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
Object.defineProperty(globalThis, "navigator", { value: { onLine: true }, configurable: true });
import { loadApi } from "../src/lib/api";
import { db } from "../src/lib/db";
import { loadBundle, saveFeatureLocal, syncProject } from "../src/lib/sync";

const ok = (c: boolean, m: string) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };
(async () => {
  const api: any = await loadApi();
  await api.login("demo@geohub.test", "demo");
  const { forms } = await loadBundle("p1", true);
  const form = forms.find((f) => f.id === "f1")!;
  const pt = { type: "Point" as const, coordinates: [4.55, 7.79] };

  // ---- a collect-only phone: it keeps nothing it has sent, except what comes back ----
  const a = await saveFeatureLocal({ project_id: "p1", form, geometry: pt, properties: { name: "Blurry Clinic", type: "Clinic" } });
  await syncProject("p1", { collectOnly: true });
  ok((await db.features.get(a.id)) === undefined, "once sent, the record leaves the collect-only phone");
  await api.reviewFeature(a.id, "rejected", "The photo is blurry, please retake it");
  await syncProject("p1", { collectOnly: true });
  const back = await db.features.get(a.id);
  ok(back?.status === "rejected" && back.review_note === "The photo is blurry, please retake it", "after a rejection, the next sync brings it back to the phone with the reviewer's note");
  ok((await db.features.count()) === 1, "and only that record: other people's work still stays off the phone");

  const fixed = await saveFeatureLocal({ id: a.id, project_id: "p1", form, geometry: pt, properties: { name: "Clear Clinic", type: "Clinic" } });
  ok(fixed.status === "submitted" && !fixed.review_note && fixed.sync === "pending", "fixing it marks it as sent back for review (and clears the old note)");
  await syncProject("p1", { collectOnly: true });
  const server = (await api.listFeatures("p1")).find((x: any) => x.id === a.id);
  ok(server?.properties.name === "Clear Clinic" && (await db.features.get(a.id)) === undefined, "the fix reaches the server and the phone is clear again");

  // ---- a normal phone: the note arrives with the regular sync ----
  await db.features.clear(); await db.meta.clear();
  await syncProject("p1");
  const seeded = (await db.features.toArray()).find((f) => f.properties.name === "Alpha Clinic")!;
  await api.reviewFeature(seeded.id, "rejected", "Wrong building");
  await syncProject("p1");
  ok((await db.features.get(seeded.id))?.review_note === "Wrong building", "on a phone that keeps records, the note arrives with the normal sync");
})();
