# Design QA

Checks run for the redesign (all from the `frontend` folder):

- `npx tsc --noEmit` and `npm run build`
- `npm run test:sync`, `test:digitize`, `test:forms`, `test:ui` (146 checks)
- An automated axe-core scan (WCAG 2.0/2.1 A and AA plus best practice) of home, sign in, web mapping list, editor, portal tabs,
  data collection list, forms, builder, review, data hub, dataset and the phone collector at 1440px and 390px wide: zero violations,
  including colour contrast.

To repeat the scan: run `npm run dev` in mock mode, open a page, and run axe-core in the browser console
(`axe.run().then(r => console.table(r.violations))`) or with the axe browser extension.

## UX improvements pass

- `npm test` runs every test file (sync, digitize, forms, symbology, drag and drop, form import, CSV, dashboards, collect-only, dashboard controls, GPS, symbols, service worker and all UI tests): 988 checks.
- axe-core 4.10 (WCAG 2.0/2.1 A and AA plus best practice) on 19 screens, in light and dark, at 1440px and 390px: zero violations. Screens: visitor home, sign in, data hub, dataset, home, about, maps, map editor, map portal, projects, collected data, review mode, map viewer, forms, form builder, share form, collector, dashboards, reports.
- To repeat: run `npm run dev`, open a page, set the system or app theme, and run axe in the console (`axe.run().then(r => console.table(r.violations))`).

## Field and review pass

- `npm test`: 1072 checks, including new UI tests for review photos, sharing, sync conflicts, map filters, downloads, quick search, activity and the error screen, plus i18n, quality-flag and returned-record tests. Backend: 170 pytest tests against PostGIS, Redis and S3 (moto); both run in GitHub Actions on every push.
- axe-core on 21 screens (the 19 above plus project activity and quick search open), light and dark, 1440px and 390px: zero violations.
- The share QR code was checked by decoding it; map clustering was checked in a browser (a cluster of 164 splits when clicked).
