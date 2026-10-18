import { loadApi } from "./api";
import { db, type LocalFeature, type QueuedChange } from "./db";
import { uuid } from "./forms";
import type { Feature, Form, Geometry, Props } from "./types";

/**
 * Offline-first sync, following the contract's "Offline sync rules":
 *  - each change carries a change_id (idempotent) and the base_version it was made against
 *  - push in batches of <= 200; one bad change never fails the batch
 *  - conflicts are kept for the user to resolve, never silently overwritten
 *  - pull by per-project cursor; photos upload separately after their feature has synced
 */
const BATCH = 200;
const cursorKey = (projectId: string) => `cursor:${projectId}`;

export async function loadBundle(projectId: string): Promise<{ forms: Form[]; fromCache: boolean }> {
  try {
    const api = await loadApi();
    const bundle = await api.bundle(projectId);
    await db.transaction("rw", db.forms, db.features, db.meta, async () => {
      await db.forms.where("project_id").equals(projectId).delete();
      await db.forms.bulkPut(bundle.forms);
      // Keep local unsynced work; replace everything that is already on the server.
      const pending = new Set((await db.features.where("project_id").equals(projectId).toArray()).filter((f) => f.sync !== "synced").map((f) => f.id));
      await db.features.bulkPut(bundle.features.filter((f) => !pending.has(f.id)).map((f) => ({ ...f, sync: "synced" as const })));
      await db.meta.put({ key: cursorKey(projectId), value: bundle.cursor });
    });
    return { forms: bundle.forms, fromCache: false };
  } catch (e) {
    const cached = await db.forms.where("project_id").equals(projectId).toArray();
    if (cached.length) return { forms: cached, fromCache: true };
    throw e;
  }
}

export interface SaveInput {
  id?: string;
  project_id: string;
  form: Form;
  geometry: Geometry;
  properties: Props;
}

/** Save a feature locally and queue the change. Works with no connection. */
export async function saveFeatureLocal(input: SaveInput): Promise<LocalFeature> {
  const now = new Date().toISOString();
  const existing = input.id ? await db.features.get(input.id) : undefined;
  const feature: LocalFeature = {
    id: input.id ?? uuid(),
    project_id: input.project_id,
    form_id: input.form.id,
    form_version: input.form.version,
    geometry: input.geometry,
    properties: input.properties,
    status: existing?.status ?? "submitted",
    version: existing?.version ?? 0,
    updated_at: now,
    sync: "pending",
  };
  await db.transaction("rw", db.features, db.queue, async () => {
    await db.features.put(feature);
    const queued = await db.queue.where("id").equals(feature.id).first();
    const payload = { geometry: feature.geometry, properties: feature.properties, client_updated_at: now };
    if (queued && queued.op !== "delete") {
      await db.queue.update(queued.seq!, { ...payload, change_id: uuid() });
    } else {
      const isCreate = !existing || feature.version === 0;
      await db.queue.add({
        change_id: uuid(),
        id: feature.id,
        project_id: feature.project_id,
        op: isCreate ? "create" : "update",
        base_version: feature.version,
        form_id: feature.form_id,
        form_version: feature.form_version,
        ...payload,
      });
    }
  });
  return feature;
}

export async function deleteFeatureLocal(id: string): Promise<void> {
  const f = await db.features.get(id);
  if (!f) return;
  await db.transaction("rw", db.features, db.queue, db.media, async () => {
    const queued = await db.queue.where("id").equals(id).first();
    const neverSynced = f.version === 0;
    if (queued) await db.queue.delete(queued.seq!);
    await db.media.where("feature_id").equals(id).delete();
    if (neverSynced) {
      await db.features.delete(id);
    } else {
      await db.features.update(id, { sync: "pending", deleted: true });
      await db.queue.add({
        change_id: uuid(), id, project_id: f.project_id, op: "delete", base_version: f.version,
        client_updated_at: new Date().toISOString(),
      });
    }
  });
}

export async function pendingCount(projectId: string): Promise<number> {
  return db.queue.where("project_id").equals(projectId).count();
}

export interface SyncReport { pushed: number; conflicts: number; rejected: number; pulled: number; photos: number }

export async function syncProject(projectId: string): Promise<SyncReport> {
  const api = await loadApi();
  const report: SyncReport = { pushed: 0, conflicts: 0, rejected: 0, pulled: 0, photos: 0 };

  // 1. push
  for (;;) {
    const batch: QueuedChange[] = await db.queue.where("project_id").equals(projectId).limit(BATCH).toArray();
    if (!batch.length) break;
    const results = await api.syncPush(projectId, batch.map(({ seq: _s, project_id: _p, ...c }) => c));
    for (const r of results) {
      const q = batch.find((b) => b.change_id === r.change_id);
      if (!q) continue;
      if (r.status === "applied") {
        if (q.op === "delete") await db.features.delete(r.id);
        else await db.features.update(r.id, { version: r.version, sync: "synced", errors: undefined });
        await db.queue.delete(q.seq!);
        report.pushed++;
      } else if (r.status === "conflict") {
        const mine = await db.features.get(r.id);
        if (mine) await db.conflicts.put({ id: r.id, project_id: projectId, server: r.server, mine });
        await db.features.update(r.id, { sync: "conflict" });
        await db.queue.delete(q.seq!);
        report.conflicts++;
      } else {
        await db.features.update(r.id, { sync: "rejected", errors: r.errors });
        await db.queue.delete(q.seq!);
        report.rejected++;
      }
    }
    if (results.length < batch.length) break; // server answered fewer than sent: stop, retry next sync
  }

  // 2. photos (only for features the server knows about)
  const media = await db.media.where("uploaded").equals(0).toArray();
  for (const m of media) {
    const f = await db.features.get(m.feature_id);
    if (!f || f.project_id !== projectId || f.sync !== "synced") continue;
    try {
      await api.uploadMedia(projectId, m.feature_id, m.id, m.blob, m.field_id);
      await db.media.update(m.id, { uploaded: 1 });
      report.photos++;
    } catch { /* stays pending; retried next sync */ }
  }

  // 3. pull
  let cursor = (await db.meta.get(cursorKey(projectId)))?.value ?? "";
  for (;;) {
    const page = await api.syncPull(projectId, cursor);
    for (const c of page.changes) {
      const local = await db.features.get(c.id);
      if (local && local.sync !== "synced") continue; // never overwrite unsynced local work
      if (c.deleted) await db.features.delete(c.id);
      else await db.features.put({ ...c, sync: "synced" });
      report.pulled++;
    }
    cursor = page.cursor;
    await db.meta.put({ key: cursorKey(projectId), value: cursor });
    if (!page.has_more) break;
  }
  return report;
}

/** Resolve a conflict: keep the server's copy, or re-apply mine on top of it. */
export async function resolveConflict(id: string, choice: "server" | "mine"): Promise<void> {
  const row = await db.conflicts.get(id);
  if (!row) return;
  await db.transaction("rw", db.features, db.queue, db.conflicts, async () => {
    if (choice === "server") {
      await db.features.put({ ...row.server, sync: "synced" });
    } else {
      const f: LocalFeature = { ...row.mine, version: row.server.version, sync: "pending" };
      await db.features.put(f);
      await db.queue.add({
        change_id: uuid(), id, project_id: row.project_id, op: "update", base_version: row.server.version,
        form_id: f.form_id, form_version: f.form_version, geometry: f.geometry, properties: f.properties,
        client_updated_at: new Date().toISOString(),
      });
    }
    await db.conflicts.delete(id);
  });
}

export type { Feature };
