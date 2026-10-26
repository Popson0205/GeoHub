# Design QA

Checks run for the redesign (all from the `frontend` folder):

- `npx tsc --noEmit` and `npm run build`
- `npm run test:sync`, `test:digitize`, `test:forms`, `test:ui` (146 checks)
- An automated axe-core scan (WCAG 2.0/2.1 A and AA plus best practice) of home, sign in, web mapping list, editor, portal tabs,
  data collection list, forms, builder, review, data hub, dataset and the phone collector at 1440px and 390px wide: zero violations,
  including colour contrast.

To repeat the scan: run `npm run dev` in mock mode, open a page, and run axe-core in the browser console
(`axe.run().then(r => console.table(r.violations))`) or with the axe browser extension.
