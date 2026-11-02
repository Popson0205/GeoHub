# Geohub

A spatial data platform made of three separate tools that share one login:

| Tool | What it is | Routes |
|---|---|---|
| **Web mapping** | A standalone mapping tool, like OpenStreetMap's editors. Draw points, lines and areas with free-form tags over imagery you add by tile URL (`https://host/{z}/{x}/{y}.png`) or by uploading a GeoTIFF/JPEG/PNG. Import GeoJSON, KML or GPX, export GeoJSON. Needs no forms and no projects. | `/maps`, `/maps/:id` |
| **Data collection** | Projects with a form builder, offline mobile collector (GPS, photos), review of collected data and publishing. | `/collect`, `/collect/:project`, `/collect/:project/forms`, `/collect/:project/review` |
| **Dashboards** | Its own app over the data a project has collected. A gallery of dashboards and a Reports page, and each dashboard opens in a full-screen workspace: a left toolbar (Add element, View, Data sources, Theme, Time and region, Save) and a canvas. Eleven kinds of element, pages, a side column, themes, a date range and click-to-filter. Reports are printable snapshots. A dashboard can be shared by a public link (`/d/:token`): read-only, approved records only, and only the fields the dashboard draws. | `/dashboards`, `/dashboards/reports`, `/dashboards/:id` |
| **Data hub** | Public catalogue where anyone can preview and download published datasets. | `/hub`, `/hub/:slug` |

| Folder | What | Stack |
|---|---|---|
| [`frontend/`](frontend) | Web editor, mobile collector (Android via Capacitor) and public data hub | React, TypeScript, Vite, MapLibre GL |
| [`backend/`](backend) | REST API, background jobs, tiles, exports | FastAPI, Supabase (PostgreSQL + PostGIS), Redis + RQ, S3-compatible storage, Martin, TiTiler |

## Run everything locally

You need Docker, Node 20+ and a [Supabase](https://supabase.com) project (the database).

```bash
# 1. backend (API on http://localhost:8000, docs at /docs)
cd backend
cp .env.example .env
# edit .env: paste your Supabase "Session pooler" connection string into DATABASE_URL
# (backend/README.md, "Database: Supabase", has the 5 setup steps)
docker compose up --build

# 2. frontend (http://localhost:5173), in a second terminal
cd frontend
npm install
cp .env.example .env
# edit .env: VITE_USE_MOCK=false
npm run dev
```

Open http://localhost:5173, choose **Create an account**, then create a project, a form, and start collecting.
With `VITE_USE_MOCK=true` (the default) the frontend runs alone against an in-browser mock, no backend needed.

## How the two halves fit together

- The frontend only talks to the backend through `frontend/src/lib/api.ts`. The mapping between the UI's types and the
  API's responses is documented in [`frontend/docs/api-expectations.md`](frontend/docs/api-expectations.md).
- `backend/openapi.json` is the API's source of truth. Regenerate it after changing routes (command in `backend/README.md`).
- Backend `CORS_ORIGINS` must include wherever the frontend is served from (already set for local development and
  the Android app).

## Deploying

**One service (Railway or any Docker host):** the `Dockerfile` in the repo root builds the frontend and the API into a single
image. The API is served under `/api` and the web app at `/`. Set `API_PREFIX=/api` and `WEB_DIR` (already set in that
Dockerfile) and `PUBLIC_BASE_URL=https://your-domain/api`.

Web app settings such as `VITE_BASEMAP_URL`, `VITE_BASEMAP_LIGHT_URL` and `VITE_RELEASE` are built into the image, so set
them as Railway service variables and redeploy; the Dockerfile passes them to the build. `VITE_API_URL` and `VITE_USE_MOCK`
are already set by the Dockerfile. `VITE_RELEASE` defaults to the commit Railway builds.

**Separately:**

- **Database**: Supabase. **Backend**: any Docker host (Railway, Render, Fly). See "Deploy" in [`backend/README.md`](backend/README.md).
- **Frontend**: Cloudflare Pages (or any static host). Root directory `frontend`, build command `npm run build`,
  output directory `dist`, and set `VITE_USE_MOCK=false` and `VITE_API_URL=https://your-api`.

## GPS accuracy

A phone's own GPS manages about 3 to 5 m in open sky. The collector gets as close to that as it can:

- it keeps the GPS warm while a record is about to be captured, so the first readings are already good;
- it averages readings until five agree within ±5 m (up to 45 seconds), and drops readings that jump away;
- it restarts if the collector walks off, and gives tips when a reading is poor.

The accuracy saved with each record (`gps_hacc_m`) is never better than the readings really were. Reviewers see
records worse than 30 m flagged.

For better than a metre, pair the phone with an external GNSS receiver (for example Emlid Reach, Garmin GLO 2 or
Bad Elf). On Android, use the receiver's app or "Bluetooth GNSS" and turn on its mock-location option. On iPhone,
pair an MFi receiver. The browser then reports the receiver's position, so Geohub needs no change.
## Organizations

Every account belongs to exactly one organization, and projects and maps belong to one. Its owners are owners of
every project in it and its administrators are administrators of every one, so work is never stranded when someone
leaves. Organization admins invite people by email (Account menu → Organization); people with no account get an
email and join when they sign up with that address. Someone who signs up without an invitation gets a new
organization of their own, and can later be added to a colleague's (an empty one-person organization is merged).

**Two ways to run it for clients:**

- **One shared deployment** (the default): many client organizations, each seeing only its own work.
- **A private copy for one client**: set `SINGLE_ORG=true` and `ORG_NAME=Client Name`. The first account to sign up
  creates the organization and owns it; after that, sign-up is by invitation only.

**Plans.** Anyone who signs up gets the free **Individual** plan. Organizations are set up by GeoEstate after a
yearly invoice. Plans differ only by how many people they hold; projects, forms, maps, dashboards and records are
unlimited:

| Plan | `plan` | Team seats | Field collectors | Viewers |
| --- | --- | --- | --- | --- |
| Individual (free) | `individual` | 1 | 5 | 5 |
| Organization Standard ($500/year) | `standard` | 10 | 50 | 50 |
| Organization Advanced ($1,000/year) | `advanced` | 30 | 300 | unlimited |
| Custom (quoted) | `custom` | set in `limits` | set in `limits` | set in `limits` |

Owners, admins and members use team seats; field collectors (collect only) and viewers (read only) have their own
counts. Adding a person beyond the plan is refused (HTTP 402, code `plan_limit`).

**Platform admin (GeoEstate staff).** Set `PLATFORM_ADMINS` to a comma-separated list of staff emails, e.g.
`PLATFORM_ADMINS=idrispopoola02@gmail.com`. Those accounts get **Platform admin** in the account menu (`/admin`):

- **Organizations:** set up a client organization once its invoice is paid (name, plan, subscription dates, the
  owner's name and email; the owner is emailed a link to choose a password and then adds their own team), change its
  plan, renew its dates, or give it its own people caps (empty = the plan's numbers). Renewals due within 60 days
  stand out.
- **Requests:** what people send from the public **Request an organization** page (`/request-organization`, linked
  from the sign-in page). Each request is emailed to every platform admin and acknowledged to the sender. Mark its
  progress, keep a note (invoice number…), and **Set up this organization** fills in the form from it.

Everyone else gets "not found" from the admin API, so it is not revealed.

**Renewal reminders.** The server checks every hour and emails an organization's owners and admins 60, 30 and 7 days
before its subscription ends and on the day itself, copying the platform admins. Each reminder goes once, even with
several servers. Nothing is blocked when a subscription ends; renewal is followed up by invoice. Turn the check off
with `REMINDERS_ENABLED=false`, or run it by hand: `python3 -m app.ops.renewal_reminders` (optionally with a date,
`2027-01-14`, to catch up a day the server was off).

**Accounts.** Admins create accounts on the Organization page: the person either gets an email with a one-time link to
set their password (72 hours), or a temporary password shown once, which they must change at first sign-in. Anyone
can reset a forgotten password from the sign-in page (2-hour link).

Upgrading an existing deployment puts every existing account and all existing work into one organization named
"My organization", owned by the earliest account and on the Advanced plan. Rename it and adjust roles on the
Organization page.

## Branding and private Data hub publishing (Organization plans)

**Branding.** Organization admins set a logo, a colour and the email sender on the Organization page.
- The **colour** replaces Geohub green for buttons, links and highlights, for everyone in the organization, in light
  and dark themes. It is darkened when needed so white text on it reads (WCAG AA, 4.5:1); success colours stay green.
- The **logo** (PNG, JPEG or WebP, up to 1 MB) is re-drawn as a PNG of at most 512 px, shown in the top bar and at the
  top of the organization's emails, and served at `/orgs/{id}/logo` (public, as emails need it).
- **Emails come from** sets the name people see in their inbox for the organization's emails (accounts, sign-in
  links, invitations, domain joining); the address stays `MAIL_FROM`, so delivery is unaffected. **Replies go to**
  sets their reply-to address.

**Who can see a dataset.** When publishing to the Data hub (from a project or a map): **Everyone** (public),
**Everyone in your organization** (Organization plans: listed, viewed and downloaded only by people signed in to
it), or **the project's / map's people only**. A Private licence can be shared with the organization but never made
public.

## Sign in with Google or Microsoft

Every plan can sign in with Google or Microsoft. Each button appears once its two variables are set on the server.
The **redirect URI** to register is your app's address, the API prefix (`/api` on the single Railway deployment),
then `/auth/sso/google/callback` or `/auth/sso/microsoft/callback`, e.g.
`https://your-app.up.railway.app/api/auth/sso/google/callback`. It must match `APP_URL` exactly.

**Google** (console.cloud.google.com → APIs & Services):
1. OAuth consent screen: External, app name "Geohub", your support email; scopes `openid`, `email`, `profile`.
   Publish it (Testing mode only lets listed test users in).
2. Credentials → Create credentials → OAuth client ID → Web application. Add the redirect URI above.
3. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

**Microsoft** (portal.azure.com → Microsoft Entra ID → App registrations → New registration):
1. Supported accounts: "Accounts in any organizational directory and personal Microsoft accounts". Redirect URI:
   platform Web, the address above.
2. Certificates & secrets → New client secret (note its expiry date and renew it before then).
3. Token configuration → Add optional claim → ID → `email` and `xms_edov`. Without `xms_edov`, work accounts are
   refused, because their email is only what their administrator typed; personal Microsoft accounts work either way.
4. Set `MICROSOFT_CLIENT_ID` (the Application ID) and `MICROSOFT_CLIENT_SECRET`. For one client's private copy, set
   `MICROSOFT_TENANT` to their tenant ID so only their accounts get in (default `common`).

People are matched by their Google or Microsoft account; the first time, by a confirmed email, so someone with a
password account can also use the button. Someone new gets an account as if they had signed up (joining the
organization that invited them, or that owns their email's domain).

**Company email domains** (Organization plans). Admins add their domain on the Organization page and prove it with a
DNS TXT record (`geohub-verification=…`, shown there; checked over DNS-over-HTTPS), or a platform admin adds it
already verified from the platform admin page. Then people with an email on it join when they sign up: at once with
Google or Microsoft, or, with a password, after clicking a "Join …" link emailed to them (an email is only trusted
once proven). Admins choose the role they join with (member, field collector or viewer) and can turn joining off.
They count against the plan; when it is full, the person gets a free account of their own instead. Public email
services (gmail.com and the like) cannot be added.

## Email (Brevo)

Geohub emails people when they are invited to an organization or a project. It sends through
[Brevo](https://www.brevo.com)'s HTTPS API, which works on any host (Railway blocks outgoing SMTP below its Pro plan).

1. In Brevo, add the sending address: **Senders, Domains & Dedicated IPs → Senders → Add a sender**, then click the
   link Brevo emails to it. To start, this can be your own Gmail address.
2. Create an API key: **SMTP & API → API Keys → Generate a new API key** (an API key, not the SMTP key).
3. Set on the server: `BREVO_API_KEY=xkeysib-…`, `MAIL_FROM=Geohub <the-address-you-verified>` and, optionally,
   `MAIL_REPLY_TO=…`. `APP_URL` must be the web app's address, since the links in emails use it.
4. Check it: on the Organization page (Account menu → Organization), press **Send me a test email**. It checks the
   settings, the Brevo key and sender, sends you an email and reports what Brevo did with it (delivered, blocked,
   bounced, and why). From a terminal on the server the same check is `python3 -m app.ops.check_email you@example.com`
   (on Railway: `railway ssh` into the service, then run it).

**Before inviting clients, use your own domain.** Gmail and Yahoo now filter mail sent *from* a Gmail address by
another service, so invitations from a Gmail sender often land in spam or are dropped. In Brevo, add your domain under
**Senders, Domains & Dedicated IPs → Domains**, add the DNS records it shows (Brevo code, DKIM, DMARC), then set
`MAIL_FROM=Geohub <no-reply@yourdomain.com>`.

If Brevo rejects the key with an "unrecognised IP address" message, allow the server's IP under **Security →
Authorised IPs**, or turn that check off (Railway's outgoing IP can change).

Other ways to send: `RESEND_API_KEY` (Resend) is used when `BREVO_API_KEY` is not set; SMTP when `SMTP_HOST` is set
(ports 587 or 465). With none of them, emails are only written to the log. A failed email is logged and never stops
the action that sent it.

## Error reporting

When a page fails, people see a recovery screen with a short reference (such as `GH-7Q2KX`) instead of a blank page.
The browser sends the error to `POST /client-errors`, which logs it with the request's other details and, when the
server has `SENTRY_DSN` set, passes it to Sentry tagged `source=browser`, together with server errors. Nothing extra is
needed in the frontend. Share tokens and query strings are removed from the address first. Set `VITE_RELEASE`
(for example to the commit) at build time so reports say which version failed. Demo mode only logs to the console.

## CI

`.github/workflows/ci.yml` runs the backend test suite and the frontend build plus offline-sync tests on every push.
