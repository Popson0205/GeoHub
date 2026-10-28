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
  ok(forms.length > 0, "forms load for the collector");
  ok((await db.features.count()) === 0, "existing records are NOT stored on the device");
  const form = forms.find((f) => f.id === "f1")!;
  const f = await saveFeatureLocal({ project_id: "p1", form, geometry: { type: "Point", coordinates: [4.55, 7.79] }, properties: { name: "Collected", type: "Clinic" } });
  const r = await syncProject("p1", { collectOnly: true });
  ok(r.pushed === 1 && r.pulled === 0, "record is sent, nothing is pulled");
  ok((await db.features.get(f.id)) === undefined, "sent record is removed from the phone");
  ok((await db.features.count()) === 0, "no records remain on the device");
  ok((await api.listFeatures("p1")).some((x: any) => x.id === f.id), "record is on the server");
})();
