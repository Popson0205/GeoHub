import "fake-indexeddb/auto";
const store = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
Object.defineProperty(globalThis, "navigator", { value: { onLine: true }, configurable: true });
import { loadApi } from "../src/lib/api";
import { db } from "../src/lib/db";
import { loadBundle, saveFeatureLocal, syncProject, deleteFeatureLocal, resolveConflict } from "../src/lib/sync";

const ok = (c: boolean, m: string) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };
(async () => {
  const api: any = await loadApi();
  await api.login("demo@geohub.test", "demo");
  const { forms } = await loadBundle("p1");
  ok(forms.length === 2, "bundle loads published forms");
  const form = forms.find((f) => f.id === "f1")!;

  // 1. create offline, then sync
  const f = await saveFeatureLocal({ project_id: "p1", form, geometry: { type: "Point", coordinates: [4.55, 7.79] }, properties: { name: "Test Clinic", type: "Clinic" } });
  ok((await db.queue.count()) === 1, "create is queued");
  let r = await syncProject("p1");
  ok(r.pushed === 1 && (await db.queue.count()) === 0, "create pushed and queue cleared");
  ok((await db.features.get(f.id))?.sync === "synced" && (await db.features.get(f.id))?.version === 1, "feature marked synced v1");

  // 2. idempotent re-push of a create
  const res = await api.syncPush("p1", [{ change_id: "x", id: f.id, op: "create", base_version: 0, form_id: "f1", geometry: f.geometry, properties: f.properties, client_updated_at: "" }]);
  ok(res[0].status === "applied" && res[0].version === 1, "re-sending a create is idempotent");

  // 3. validation rejection
  const bad = await saveFeatureLocal({ project_id: "p1", form, geometry: { type: "Point", coordinates: [4.5, 7.8] }, properties: { name: "" } });
  r = await syncProject("p1");
  ok(r.rejected === 1 && (await db.features.get(bad.id))?.sync === "rejected", "invalid record is rejected, not lost");

  // 4. conflict: someone else moves the point, I edit props from stale version
  await api.updateFeature(f.id, { geometry: { type: "Point", coordinates: [4.6, 7.9] }, base_version: 1 });
  await saveFeatureLocal({ id: f.id, project_id: "p1", form, geometry: { type: "Point", coordinates: [4.5501, 7.7901] }, properties: { name: "Test Clinic", type: "Hospital" } });
  r = await syncProject("p1");
  ok(r.conflicts === 1 && (await db.conflicts.count()) === 1, "geometry conflict is kept for the user");
  await resolveConflict(f.id, "mine");
  r = await syncProject("p1");
  ok(r.pushed === 1 && (await db.features.get(f.id))?.sync === "synced", "keep-mine re-applies on the new server version");

  // 5. delete of a never-synced feature leaves no trace
  const tmp = await saveFeatureLocal({ project_id: "p1", form, geometry: { type: "Point", coordinates: [4.5, 7.8] }, properties: { name: "Temp", type: "Clinic" } });
  await deleteFeatureLocal(tmp.id);
  ok(!(await db.features.get(tmp.id)) && (await db.queue.count()) === 0, "deleting an unsynced record cancels it");

  // 6. delete of a synced feature syncs as a delete
  await deleteFeatureLocal(f.id);
  r = await syncProject("p1");
  ok(r.pushed === 1 && !(await db.features.get(f.id)), "synced record delete is pushed");

  // 7. pull brings server-side changes
  await api.createFeature({ id: "srv-1", project_id: "p1", form_id: "f1", form_version: 1, geometry: { type: "Point", coordinates: [4.5, 7.8] }, properties: { name: "Server Side", type: "Clinic" } });
  r = await syncProject("p1");
  ok(!!(await db.features.get("srv-1")), "pull receives records created elsewhere");
})();
