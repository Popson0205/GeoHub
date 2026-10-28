# How the frontend talks to the backend

`src/lib/api.ts` defines the `Api` interface every screen uses. `HttpApi` implements it against the backend in
`../backend` (see `backend/openapi.json`, the source of truth) and translates the wire format into the UI types in
`src/lib/types.ts`. If the backend changes, this is the only file that needs to change.

| UI expects | Backend sends | Handled in `HttpApi` |
|---|---|---|
| Geometry types `Point` / `LineString` / `Polygon` on forms | `point` / `line` / `area` | mapped both ways |
| Project `updated_at` | `last_update` | renamed |
| Licence labels `ODbL`, `CC BY 4.0`, `CC0` | `ODbL-1.0`, `CC-BY-4.0`, `CC0-1.0` | `LICENSE_TO_API` / `LICENSE_FROM_API` in `types.ts` |
| Feature `deleted: true` | `deleted_at` timestamp | converted |
| Dataset `updated_at`, `kind` | `published_at`, (vector only) | converted |
| Bundle forms with `id` | `form_id` (published form versions) | converted |
| Pull `{ changes, cursor }` | `{ items: [{seq, op, feature}], next_cursor, has_more }` | `op: "delete"` becomes `deleted: true` |
| Push rejection `errors: {field: message}` | `code`, `detail`, `fields: {field: [messages]}` | flattened |
| Error `fields: {field: message}` | `fields: {field: [messages]}` | flattened |
| Photo upload with `feature_id` | `{id, project_id, content_type, size}` then `PUT` with returned headers, then `complete {feature_id, field_id}` | the photo's local id is used as the media id |
| Imagery accepted: GeoTIFF only | any raster (`tif tiff jpg jpeg png webp gif bmp jp2 j2k img asc`); `bounds` + `crs` for pictures with no coordinates | `lib/fileTypes.ts` classifies the file; the editor sends optional bounds |
| GeoJSON / JSON as "imagery" | not imagery: `POST /projects/{id}/import` (multipart) turns `.geojson .json .csv .kml .gpx .gpkg .gml .zip` into features of a form; job `result` has `imported`, `rejected`, row `errors` | `importFeatures()`; the editor picks the active form and polls the job |
| Imagery single `PUT` | multipart: one presigned URL per part, `complete {parts: [{part_number, etag}]}` | slices the file; needs bucket CORS to expose `ETag` |
| Imagery tiles `?token=` | `?sig=` from `GET /projects/{id}/layers` (or `?access_token=`) | signed URLs cached by `listImagery` |
| Publish dataset `{title, description, license}` | needs `form_id` and `slug`, `visibility`, `statuses` | the publish panel picks a published form; slug is generated from the title |
| Dataset features in one request | max 1000 per page with `next_cursor` | paged until done |
| Account creation | `POST /auth/register` | "Create an account" link on the sign-in screen (real backend only) |

## Things to know

- **Published datasets include `submitted` features.** The backend's default is `approved` only, but the web app has no
  review screen yet, so every collected feature would be filtered out. `publishDataset` sends
  `statuses: ["submitted", "approved"]`. Change that once a review screen exists.
- Private-licence datasets are published with `visibility: "private"`; everything else is `public`.
- CORS: the backend `CORS_ORIGINS` must list the web origin and, for the Android app, `capacitor://localhost` and
  `http://localhost`. The defaults in `backend/.env.example` already do.
