// Basemap addresses: never show CARTO's "API KEY REQUIRED" stamp, and credit whichever provider is used.
import { basemapCredit, isPlainOsm, OSM_TILES, shortCredit, usableTiles } from "../src/lib/basemap";
const ok = (c: boolean, m: string) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };

ok(usableTiles(undefined) === OSM_TILES && usableTiles("") === OSM_TILES && usableTiles("  ") === OSM_TILES, "unset or blank uses free OpenStreetMap tiles");
ok(usableTiles("https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png") === OSM_TILES, "CARTO without a key falls back instead of showing the stamp");
ok(usableTiles("https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png?api_key=abc").includes("cartocdn"), "CARTO with a key is kept");
const mt = "https://api.maptiler.com/maps/dataviz/256/{z}/{x}/{y}.png?key=K";
ok(usableTiles(mt) === mt, "other providers are used as given");
ok(basemapCredit(mt) === "© MapTiler © OpenStreetMap contributors" && shortCredit(mt) === "© MapTiler © OpenStreetMap", "MapTiler is credited");
ok(basemapCredit(OSM_TILES) === "© OpenStreetMap contributors" && !basemapCredit(OSM_TILES).includes("CARTO"), "plain OpenStreetMap does not claim CARTO");
ok(isPlainOsm(OSM_TILES) && !isPlainOsm(mt), "the plain street map is recognised, so the light map can soften it");
