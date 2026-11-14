# GeoEstate ID: signing in to every GeoEstate app with Geohub

Geohub is the sign-in for Land Registry, LandCheck and FarmScan. People have one account, one password and one
two-step sign-in; someone signed in to Geohub is signed in to every app their organization has.

## How it works

1. The app sends the person to `https://<geohub>/id/authorize?client_id=land&redirect_uri=…&state=…&code_challenge=…&code_challenge_method=S256`.
2. Not signed in to Geohub: they sign in there first (password, Google or Microsoft, and two-step sign-in).
3. Geohub checks that their organization has the app's product (GeoEstate staff may always enter), and sends them back
   to `redirect_uri?code=…&state=…`. Otherwise it says the organization does not have that product.
4. The app swaps the code at `POST /api/id/token` for an **access token** (15 minutes) and a **refresh token**
   (30 days, replaced each time it is used). Each refresh checks again that the person and the product are still there.
5. The app checks access tokens itself with Geohub's public key (`GET /api/id/jwks`, Ed25519, `EdDSA`). The token says:

```json
{ "sub": "…", "email": "musa@kanoland.gov.ng", "name": "Musa Bello", "mfa": true,
  "org": { "id": "…", "name": "Kano Land Agency", "slug": "kano-land-agency", "role": "owner" },
  "product": { "id": "land", "plan": "advanced", "plan_name": "Land Registry Advanced", "licence_kind": "paid",
               "status": "active", "subscription_ends": "2027-11-04", "grace_ends": "2027-11-18",
               "features": ["dxf_import", "parcels", "…"], "limits": { "parcels": 250000, "seats": 40 } },
  "staff_role": null, "aud": "land", "iss": "https://<geohub>", "exp": 1793898000 }
```

The app applies the licence the same way Geohub does: `demo`, `active` and `grace` may change things; `expired` is
read-only; `suspended` shows only a notice.

## Registering an app

In Geohub's variables:

| Variable | Value |
| --- | --- |
| `ID_CLIENTS` | `[{"id":"land","redirect_uris":["https://land.<domain>/auth/callback"],"secret":"<32+ random characters>"}]`, one entry per app. `id` is the product (`land`, `check`, `farm`). Leave `secret` out for an app with no server: it then must use PKCE |
| `ID_SIGNING_KEY` | optional: an Ed25519 private key (PEM). Without it the key is derived from `JWT_SECRET` |
| `CORS_ORIGINS` | add the app's address when its web page calls `/api/id/token` itself (an app without a secret) |
| `PRODUCT_URLS` | `land=https://land.<domain>,…`, for the app switcher |

## Plugging an app in

- **Python server (FastAPI or other):** copy `clients/python/geoestate_id.py`. `clients/python/example_app.py` is a
  whole working app: sign in, show the person and their licence, refresh, sign out.
- **Web page:** `clients/js/geoestate-id.ts` sends people to Geohub and, for apps without a secret, swaps the code.

## The look and the app switcher

`clients/ui/` is the GeoEstate UI kit: `geoestate.css` (the navy-and-green look, `ge-` classes) and
`react/GeoEstateBar.tsx` (logo, app name, the app switcher, who is signed in, and the licence notice in Geohub's
words). The switcher lists the organization's apps from `GET /api/id/apps`; each app's address comes from Geohub's
`PRODUCT_URLS`, and one without an address yet is shown but not opened. Geohub's own top bar has the same switcher.

## Reading Geohub's field data

An app can read the field data the signed-in person could open in Geohub, with the same access token
(`gid.data(token, "projects")` in the Python kit):

- `GET /id/data/projects`: their projects in the organization, each with its published forms (name, shape, fields,
  how many features and how many approved).
- `GET /id/data/forms/{id}/features?status=approved&shape=area&after=<seq>&limit=200`: a form's features, oldest first,
  with geometry, answers, who collected and who reviewed them; `next` is the cursor for the following page.
- `GET /id/data/features/{id}`: one feature as it is now.

Land Registry uses this to register the parcels a field team enumerated with a Geohub form.

## One app reading another (token exchange)

An app can read another GeoEstate app's data for the same person, e.g. PolyGIS showing Land Registry's parcels as a
layer. It swaps the person's access token for itself for a short access token for the other app (RFC 8693), with its
own client secret:

    POST /api/id/token  grant_type=urn:ietf:params:oauth:grant-type:token-exchange
                        subject_token=<the person's access token for this app>  audience=land

Geohub answers with an access token for `land` (no refresh token) only if the person's organization has Land Registry;
otherwise `403 no_product`. The token carries `act: {"sub": "gis"}`, the app acting for the person. The other app
checks it like any of its own access tokens (as a Bearer token) and shows only what the person may see there. In the
kit: `gid.token_for(access_token, "land")`.

Publishing works the other way: `gid.send(access_token, "datasets", {...})` puts a layer in Geohub's Data hub.

A raster (an elevation model, an orthophoto, an analysis result) can be gigabytes, so it does not pass through
Geohub's API: `gid.upload(access_token, "rasters", {"title", "ref", "visibility", …}, "/path/to/raster.tif")` asks
for upload addresses, sends the file in parts straight to storage, and says when it is done. Geohub's worker makes it a
Cloud-Optimised GeoTIFF with its statistics; ask how it is going with `gid.data(access_token, f"rasters/{id}")`
(`processing`, then `ready` or `failed` with the reason). `{"dataset": "<slug>"}` instead of a title publishes the next
version of a raster dataset the app published before. `render` says how a single band is drawn on the Data hub's
map: the values at either end (`"rescale": [250, 520]`), and the app's own ramp as `#rrggbb` stops (`"colors"`, drawn
exactly) or a named one (`"colormap": "terrain"`, or `"spectral_r"` reversed). A raster of classes (land cover) sends
`"classes": [{"value": 10, "color": "#006400", "label": "Tree cover"}, …]`: each value in its colour, the others left
clear, and a legend of the names. Three bands of bytes are drawn as a photo. Geohub draws these tiles itself (rio-tiler),
so the Data hub needs no TiTiler service. In the Data hub
the dataset shows on a map (tiles behind the dataset's own visibility) and downloads as a GeoTIFF.

## Endpoints

| | |
| --- | --- |
| `GET /api/id/configuration` | issuer and endpoints |
| `GET /api/id/jwks` | the public key |
| `GET /id/authorize` (web page) | sign in and go back with a code |
| `POST /api/id/token` | `grant_type=authorization_code`, `refresh_token` or token exchange (above); client secret in the form or HTTP Basic |
| `GET /api/id/userinfo` | the person as of now (Bearer access token) |
| `GET /api/id/apps` | the organization's apps, for the app switcher (Bearer access token) |
| `POST /api/id/revoke` | sign out of the app (`token` = the refresh token) |

A code works once, within 2 minutes, only at the address it was asked for, and only with its PKCE verifier. A code
or refresh token used twice ends the sessions it started, in case it was copied.
