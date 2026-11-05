# GeoEstate UI kit

What every GeoEstate app shares so they look and behave as one family: the logo's navy and green, the type, buttons,
fields, cards, badges and tables, and a top bar with the app switcher and the licence notice.

| File | What |
| --- | --- |
| `geoestate.css` | The look. Classes start with `ge-` (`ge-btn ge-btn-primary`, `ge-card`, `ge-badge-ok`…); colours are `--ge-*` variables |
| `geoestate-logo.png` | The GeoEstate logo |
| `react/GeoEstateBar.tsx` | The top bar: logo, app name, app switcher, who is signed in, sign out; and the licence notice under it. `licenceNotice()` gives the notice's words on their own |

Copy the folder into a new app (or point a build at it), import `geoestate.css` once, and put
`<body class="ge-page">` and `<main class="ge-main">` around the page. The bar takes the signed-in person from their
GeoEstate ID access token and the apps from `GET /api/id/apps` (`gid.apps(token)` in the Python kit, `id.apps(token)`
in the TypeScript one). See `../python/example_app.py` for a whole app using both.
