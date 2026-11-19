# OSLIS Demo (desktop)

The **Osun State Land Information System** demo as an offline Windows app. It packages the Osun-branded Geohub
(Field Data) build — which runs on sample Osun data with no backend — and serves it from a tiny local server inside
the window. It needs no internet and no database: double-click and present.

## Build the installer

The **OSLIS Demo (Windows installer)** workflow builds it on a Windows runner (Actions tab → Run workflow, or push an
`osun-demo-v*` tag). It builds the Geohub frontend with `VITE_BRAND=osun`, copies it in, and packages the `.exe`.

### Locally (on any machine with Node, to produce the Windows installer on Windows)

```bash
# 1) build the Osun demo site
cd ../frontend && npm ci && VITE_BRAND=osun npm run build
# 2) bring it into the app and package
cd ../demo-desktop && mkdir -p app && cp -r ../frontend/dist/* app/ && npm ci && npm run dist
# -> release/Osun State Land Information System (Demo) Setup 1.0.0.exe
```

`npm start` (after steps 1–2) runs it without packaging.

## Notes
- Offline by design: the site is served from `127.0.0.1` inside the app, so routing, the service worker and the mock
  data all work with no network.
- The installer is unsigned for now, so Windows SmartScreen warns on first run (More info → Run anyway).
- This bundles the **Field Data** app. PolyGIS (cadastral mapping) and Land Registry need their backends, so they are
  a separate, heavier bundle.
