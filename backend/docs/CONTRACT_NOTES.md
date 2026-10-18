# Contract notes

How this backend implements *Mapping Hub: Backend API Contract and Data Model*. Everything in the contract is
built. This file lists where the contract left room, so the frontend session knows exactly what to expect.
`openapi.json` is authoritative.

## Interpretations
| Topic | What the backend does |
|---|---|
| Sync change shape | `{change_id, id, op, form_id (create), base_version, geometry, properties, status?, client_updated_at}`. `change_id` is required (the contract asks for idempotency on "feature id plus a client change id"). `form_id` is needed on create. Push body is `{project_id, changes[≤200]}`. |
| `properties` on update | The complete new properties object (not a patch). The merge rules rely on this. |
| Merge rule | Strict reading: merge only if neither side changed geometry and the changed property sets don't overlap. A client that changed nothing but `status` never conflicts. |
| Feature status | New features default to `submitted` (`draft` allowed, and drafts may be incomplete). Collectors can set `draft` or `submitted`; only admins/owners set `approved` or `rejected`, via `/features/{id}/review`. Editing an approved or rejected feature sends it back to `submitted`. |
| Pull response | `{items: [{seq, op: upsert|delete, feature}], next_cursor, has_more}`. `next_cursor` is always present (unchanged when there is nothing new). Omit `cursor` to start from the beginning. |
| Bundle | `{project, role, forms (published versions), features, cursor, truncated, limits}`. If `truncated`, pull from the start instead. `members.assigned_area` (GeoJSON polygon) limits bundle and pull; a user always receives their own features. |
| Photos | `POST /media/upload-url {id, project_id, content_type, size}` then `POST /media/{id}/complete {feature_id, field_id?}`. Photo field values are lists of media ids. |
| Tiles | The API authorises and proxies to Martin/TiTiler at the contract's paths. Auth by header, `?access_token=`, or a `?sig=` token from `GET /projects/{id}/layers`. |
| Imagery upload | `POST /projects/{id}/imagery {name, filename, size}` returns multipart part URLs (64 MB parts; a 5 GB file is 80 parts). `POST /imagery/{id}/complete {parts:[{part_number, etag}]}`. Max 5 GB, `.tif`/`.tiff` only. A file with no coordinate system fails with `error_code: "no_georeference"` and a plain-language message. |
| Dataset publishing | Owner-only (the contract gives Owner "publish"). Needs a `form_id`. Snapshot includes `approved` features by default. |
| Import | `POST /projects/{id}/import` is multipart: `file`, `form_id`, `mapping` (JSON column → field id), `lon_column`+`lat_column` or `wkt_column`, optional `status`. Admin-only. Bad rows are reported in the job result; good rows are kept. Limit 50 MB. |
| Job kinds | `imagery_convert`, `export`, `snapshot` as in the contract, plus `import`. |
| Pagination | `{items, next_cursor}` on every list endpoint. Cursors are opaque. |
| Errors | `application/problem+json` with `{type, title, status, detail, code, fields?}`. Conflicts add `server` and `client`. |

## Additions (not in the contract's endpoint tables)
`GET /projects/{id}/layers` (map layer list with tile URLs), `GET /projects/{id}/imagery`,
`GET /forms/{id}/versions` and `/versions/{n}`, `POST /features/{id}/restore` (admin restore after delete),
`GET /projects/{id}/audit`, `PATCH /datasets/{slug}`, `GET /health`, `GET /health/ready`.

## Open decisions: defaults chosen
| Decision | Default |
|---|---|
| Collector visibility | Collectors read all features in the project but edit only their own. |
| Licences | `ODbL-1.0`, `CC-BY-4.0`, `CC0-1.0`, `Private` (Private cannot be public). |
| Email | Optional SMTP; otherwise invitation emails are logged. Any provider with SMTP works. |
| Hosting region and storage | Not decided in code: choose when you deploy. Everything is configurable by env vars. |

## Non-functional requirements
| Requirement | Where |
|---|---|
| Photo resize, 10 MB cap | `worker/tasks.py: process_photo`; cap enforced at `upload-url` and re-checked at `complete` |
| Rate limits | `ratelimit.py`: per IP, per user, stricter on login/register and anonymous exports |
| Audit log | `audit_log` table; publish, delete, role changes, exports, imports. Read via `/projects/{id}/audit` |
| Backups, tested restore | `app/ops/backup.py`, `app/ops/restore_test.py` (covered by `tests/test_ops.py`) |
| Object storage versioning | Bucket setting; enabled in `docker-compose.yml`, required in the deploy checklist |
| Health, structured logs, error tracking | `/health`, `/health/ready`; JSON logs with request ids; optional Sentry |
| CORS | `CORS_ORIGINS` allow-list |
| Download counts | `dataset_versions.download_count`, shown in the catalogue and dataset detail |
