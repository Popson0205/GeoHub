// Card thumbnails line shapes up with the real basemap tiles: same Web Mercator maths as every slippy map.
import { fitView, mercator, tilesFor } from "../src/components/FootprintThumb";
const ok = (c: boolean, m: string) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };

// The standard tile formula (OpenStreetMap wiki), to check against.
function slippy(lon: number, lat: number, z: number) {
  const n = 2 ** z, r = lat * Math.PI / 180;
  return [(lon + 180) / 360 * n, (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n];
}
const osogbo: [number, number] = [4.5624, 7.7827];
const [mx, my] = mercator(osogbo);
const [sx, sy] = slippy(osogbo[0], osogbo[1], 0);
ok(Math.abs(mx / 256 - sx) < 1e-9 && Math.abs(my / 256 - sy) < 1e-9, "the projection matches the standard tile formula");

const pts = [[4.55, 7.77], [4.58, 7.80], [4.57, 7.76]].map((c) => ({ type: "Point", coordinates: c })) as any[];
const W = 270, H = 104;
const v = fitView(pts, W, H);
const inside = pts.every((g) => { const [x, y] = v.to(g.coordinates); return x >= 13 && x <= W - 13 && y >= 13 && y <= H - 13; });
ok(inside, `every point sits inside the card with room around it (zoom ${v.zoom})`);
const tighter = fitView(pts, W * 2, H * 2);
ok(tighter.zoom - v.zoom > 0.9 && tighter.zoom - v.zoom < 1.3, "a card twice the size shows about one zoom level closer");
const spread = (vv: typeof v, w: number, h: number) => { const xy = pts.map((g) => vv.to(g.coordinates)); const xs = xy.map((p) => p[0]), ys = xy.map((p) => p[1]);
  return Math.max((Math.max(...xs) - Math.min(...xs)) / (w - 28), (Math.max(...ys) - Math.min(...ys)) / (h - 28)); };
ok(spread(v, W, H) > 0.99, "the shapes fill the card (one side touches the margin)");

for (const retina of [false, true]) {
  const tiles = tilesFor(v, W, H, retina, "https://t/{z}/{x}/{y}.png");
  const covered = (x: number, y: number) => tiles.some((t) => x >= t.x && x < t.x + t.size && y >= t.y && y < t.y + t.size);
  ok(tiles.every((t) => t.size <= 256 && t.size > (retina ? 64 : 128)), "tiles are drawn at or below their real size, never stretched");
  ok([[0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1], [W / 2, H / 2]].every(([x, y]) => covered(x, y)), `tiles cover the whole card${retina ? " (sharp screens)" : ""}`);
  // the tile under a point is the one the standard formula names, and the point falls at the same spot in it
  const g = pts[1]; const [px, py] = v.to(g.coordinates);
  const t = tiles.find((t) => px >= t.x && px < t.x + t.size && py >= t.y && py < t.y + t.size)!;
  const [z, tx, ty] = t.src.match(/(\d+)\/(\d+)\/(\d+)/)!.slice(1).map(Number);
  const [fx, fy] = slippy(g.coordinates[0], g.coordinates[1], z);
  ok(tx === Math.floor(fx) && ty === Math.floor(fy) && Math.abs((px - t.x) / t.size - (fx - tx)) < 0.01 && Math.abs((py - t.y) / t.size - (fy - ty)) < 0.01,
    `a point lands on the right tile at the right spot (z${z}/${tx}/${ty})`);
}
const single = fitView([pts[0]], W, H);
ok(single.zoom === 16, "a single place shows its street, not the whole world or one building");
const world = fitView([{ type: "Point", coordinates: [179.9, 0] }, { type: "Point", coordinates: [-179.9, 0] }] as any, W, H);
ok(tilesFor(world, W, H, false, "https://t/{z}/{x}/{y}.png").every((t) => !/\/-/.test(t.src)), "tile numbers wrap across the date line");
