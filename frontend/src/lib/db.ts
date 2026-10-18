import Dexie, { type Table } from "dexie";
import type { Change, Feature, Form } from "./types";

export type SyncState = "synced" | "pending" | "conflict" | "rejected";
export interface LocalFeature extends Feature {
  sync: SyncState;
  errors?: Record<string, string>;
}
export interface QueuedChange extends Change {
  seq?: number;
  project_id: string;
}
export interface LocalMedia {
  id: string;
  feature_id: string;
  name: string;
  field_id?: string;
  blob: Blob;
  uploaded: 0 | 1;
}
export interface ConflictRow {
  id: string; // feature id
  project_id: string;
  server: Feature;
  mine: LocalFeature;
}

class LocalDB extends Dexie {
  features!: Table<LocalFeature, string>;
  queue!: Table<QueuedChange, number>;
  forms!: Table<Form, string>;
  media!: Table<LocalMedia, string>;
  meta!: Table<{ key: string; value: string }, string>;
  conflicts!: Table<ConflictRow, string>;

  constructor() {
    super("geohub");
    this.version(1).stores({
      features: "id, project_id, form_id, sync",
      queue: "++seq, id, project_id",
      forms: "id, project_id",
      media: "id, feature_id, uploaded",
      meta: "key",
      conflicts: "id, project_id",
    });
  }
}

export const db = new LocalDB();
