"""Rasters in the Data hub, published from another GeoEstate app (PolyGIS): uploaded in parts straight to storage, made a
Cloud-Optimised GeoTIFF by the worker, drawn as map tiles behind the dataset's own visibility, downloaded as a GeoTIFF."""
import io
import math
import subprocess
import uuid

import httpx
import pytest
from PIL import Image

from conftest import Actor
from test_geoestate_id import CALLBACK, apps, code_for  # noqa: F401  (fixtures)
from test_id_datasets import BODY
from test_staff_console import boss, outbox, sql  # noqa: F401  (fixtures)


def dem(tmp_path, name="dem.tif", georef=True, value=lambda r, c: 250 + r * 13 + c):
    """A small elevation model (UTM zone 32N, 10 m cells over Minna), values 250 to 516 m (or as `value` says)."""
    asc = tmp_path / f"{name}.asc"
    rows = [" ".join(str(value(r, c)) for c in range(20)) for r in range(20)]
    asc.write_text("ncols 20\nnrows 20\nxllcorner 230000\nyllcorner 1058000\ncellsize 10\nNODATA_value -9999\n" + "\n".join(rows) + "\n")
    if not georef:
        return asc
    out = tmp_path / name
    subprocess.run(["gdal_translate", "-q", "-a_srs", "EPSG:32632", "-ot", "Float32", str(asc), str(out)], check=True)
    return out


def tile_of(d: dict, z: int = 17) -> str:
    """The z/x/y of the tile at the middle of a dataset's bounds."""
    b = d["bbox"]
    lon, lat = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
    n = 2 ** z
    x = int((lon + 180) / 360 * n)
    y = int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)
    return f"{z}/{x}/{y}"


def pixels(png: bytes):
    """The colours a tile draws (RGBA, the clear ones left out), and how many of its pixels are drawn."""
    px = list(Image.open(io.BytesIO(png)).convert("RGBA").getdata())
    drawn = [p for p in px if p[3] > 0]
    return set(drawn), len(drawn)


def photo(tmp_path):
    out = tmp_path / "ortho.tif"
    subprocess.run(["gdal_create", "-of", "GTiff", "-outsize", "32", "32", "-bands", "3", "-ot", "Byte", "-burn", "90",
                    "-a_srs", "EPSG:4326", "-a_ullr", "6.53", "9.66", "6.54", "9.65", str(out)], check=True, capture_output=True)
    return out


@pytest.fixture
def publisher(client, boss):
    p = Actor(client, f"Raster Publisher {uuid.uuid4().hex[:6]}")
    boss.put(f"/admin/orgs/{p.org_id}/products/land", json={"plan": "advanced", "licence_kind": "paid"})
    return p


def token(apps, person):
    v = apps.new_verifier()
    return apps.exchange(code_for(person, v), CALLBACK, v)["access_token"]


NEW = {"title": "Minna elevation", "description": "10 m DEM.", "license": "CC-BY-4.0", "tags": ["dem"], "visibility": "private",
       "ref": "layer-dem", "label": "Bosso Estate › minna_dem", "render": {"colormap": "terrain"}}


def test_an_app_publishes_a_raster_and_its_next_version(client, publisher, apps, tile_calls, tmp_path):
    at = token(apps, publisher)
    out = apps.upload(at, "rasters", NEW, str(dem(tmp_path)))
    assert out["status"] == "ready" and out["version"] == 1, out
    d = out["dataset"]
    assert d["geometry_type"] == "raster" and d["latest_version"] == 1 and d["feature_count"] == 0 and d["source"]["kind"] == "raster"
    slug = d["slug"]
    assert apps.data(at, f"rasters/{out['id']}")["status"] == "ready"

    # in Geohub: what the raster holds, how it is drawn, and its tiles behind a short token (it is private)
    got = publisher.get(f"/datasets/{slug}").json()
    r = got["raster"]
    assert got["formats"] == ["tif"] and r["width"] == 20 and r["height"] == 20 and r["crs"] == "EPSG:32632" and r["resolution"] == 10
    assert r["bands"][0]["min"] == 250 and r["bands"][0]["max"] == 516 and r["data_type"] == "Float32"
    assert r["render"] == {"kind": "single", "band": 1, "colormap": "terrain", "rescale": [250, 516]}
    b = got["bbox"]                                                              # 200 m of Minna, in degrees
    assert 6.4 < b[0] < b[2] < 6.7 and 9.4 < b[1] < b[3] < 9.7 and abs((b[2] - b[0]) - 200 / 109800) < 2e-4
    assert "?sig=" in got["tiles_url"]
    # the footprint is the version's one feature: search by place and the catalogue's thumbnails use it
    fp = publisher.get(f"/datasets/{slug}/features").json()["features"]
    assert len(fp) == 1 and fp[0]["geometry"]["type"] == "Polygon" and fp[0]["properties"]["footprint"] is True

    url = got["tiles_url"].replace("{z}/{x}/{y}", tile_of(got))
    url = url[url.index("/tiles/"):]
    t = client.get(url)                                                          # drawn by Geohub itself, no TiTiler
    assert t.status_code == 200 and t.headers["content-type"] == "image/png", t.text
    colours, drawn = pixels(t.content)
    assert len(colours) > 10 and drawn > 1000 and "private" in t.headers["cache-control"]     # a ramp of elevations
    assert client.get(url.replace(tile_of(got), "17/0/0")).status_code == 204         # nowhere near the raster: nothing to draw
    assert client.get(url.split("?")[0]).status_code == 401                       # private: no token, no tiles
    stranger = Actor(client, "Raster Stranger")
    assert stranger.get(f"/datasets/{slug}").status_code == 404

    # a GeoTIFF download, and only that
    job = publisher.post(f"/datasets/{slug}/exports", json={"format": "tif"}).json()
    assert job["status"] == "done"
    tif = httpx.get(job["result"]["download_url"])
    assert tif.status_code == 200 and tif.content[:4] in (b"II*\x00", b"II+\x00")
    assert publisher.post(f"/datasets/{slug}/exports", json={"format": "geojson"}).status_code == 422

    # the next version, from the app; made public, the tiles need no token and may be cached
    nxt = apps.upload(at, "rasters", {"dataset": slug}, str(dem(tmp_path, "dem2.tif")))
    assert nxt["status"] == "ready" and nxt["version"] == 2 and nxt["dataset"]["slug"] == slug
    assert publisher.patch(f"/datasets/{slug}", json={"visibility": "public"}).status_code == 200
    pub = client.get(f"/datasets/{slug}").json()
    assert "sig=" not in pub["tiles_url"] and "/2/" in pub["tiles_url"] and [v["version"] for v in pub["versions"]] == [2, 1]
    t = client.get(f"/tiles/datasets/{slug}/2/{tile_of(pub)}.png")
    assert t.status_code == 200 and "public" in t.headers["cache-control"]
    assert any(x["slug"] == slug for x in client.get("/datasets", params={"type": "raster"}).json()["items"])
    assert all(x["geometry_type"] == "raster" for x in client.get("/datasets", params={"type": "raster"}).json()["items"])


def test_the_apps_own_ramp_is_drawn_exactly(client, publisher, apps, tmp_path):
    from app.raster_tiles import ramp as lut
    at = token(apps, publisher)
    ramp = ["#33a02c", "#ffffbf", "#ffffff"]
    table = lut(ramp)
    assert len(table) == 256 and table[0] == (51, 160, 44, 255) and table[255] == (255, 255, 255, 255) and abs(table[128][0] - 255) <= 1
    for value, colour in ((260, (51, 160, 44, 255)), (500, (255, 255, 255, 255))):     # the ends of the range get the ends of the ramp
        out = apps.upload(at, "rasters", {**NEW, "title": f"DEM at {value}", "ref": f"layer-flat-{value}", "render": {"colors": ramp, "rescale": [260, 500]}},
                          str(dem(tmp_path, f"flat{value}.tif", value=lambda r, c, v=value: v)))
        got = publisher.get(f"/datasets/{out['dataset']['slug']}").json()
        assert got["raster"]["render"]["colors"] == ramp and got["raster"]["render"]["rescale"] == [260, 500]
        url = got["tiles_url"].replace("{z}/{x}/{y}", tile_of(got))
        colours, drawn = pixels(client.get(url[url.index("/tiles/"):]).content)
        assert colours == {colour} and drawn > 100, (value, colours)
    h = {"Authorization": f"Bearer {at}"}
    bad = client.post("/id/data/rasters", headers=h, json={"filename": "d.tif", "size": 10, **NEW, "render": {"colors": ["green", "#fff"]}})
    assert bad.status_code == 422


def test_a_photo_is_drawn_in_colour(client, publisher, apps, tmp_path):
    at = token(apps, publisher)
    out = apps.upload(at, "rasters", {**NEW, "title": "Drone orthophoto", "ref": "layer-ortho", "render": None}, str(photo(tmp_path)))
    got = publisher.get(f"/datasets/{out['dataset']['slug']}").json()
    assert got["raster"]["render"] == {"kind": "rgb", "bands": [1, 2, 3]} and len(got["raster"]["bands"]) == 3
    url = got["tiles_url"].replace("{z}/{x}/{y}", tile_of(got, 15))
    colours, drawn = pixels(client.get(url[url.index("/tiles/"):]).content)
    assert colours == {(90, 90, 90, 255)} and drawn > 100


def test_land_cover_is_drawn_class_by_class(client, publisher, apps, tmp_path):
    """A raster of classes: each value in its own colour; a value with no class (here: shrubland, hidden) is left clear."""
    at = token(apps, publisher)
    classes = [{"value": 10, "color": "#006400", "label": "Tree cover"}, {"value": 40, "color": "#f096ff", "label": "Cropland"}]
    out = apps.upload(at, "rasters", {**NEW, "title": "Land cover", "ref": "layer-lc", "render": {"classes": classes}},
                      str(dem(tmp_path, "lc.tif", value=lambda r, c: 10 if c < 10 else 20)))
    got = publisher.get(f"/datasets/{out['dataset']['slug']}").json()
    assert got["raster"]["render"] == {"kind": "classes", "band": 1, "classes": classes}
    url = got["tiles_url"].replace("{z}/{x}/{y}", tile_of(got, 18))
    im = Image.open(io.BytesIO(client.get(url[url.index("/tiles/"):]).content)).convert("RGBA")
    colours = {p for p in im.getdata() if p[3] > 0}
    assert colours == {(0, 100, 0, 255)}, colours                   # tree cover drawn; the unlisted class 20 left clear
    assert sum(1 for p in im.getdata() if p[3] == 0) > 1000


def test_raster_publishing_is_checked(client, boss, publisher, apps, tmp_path):
    at = token(apps, publisher)
    h = {"Authorization": f"Bearer {at}"}
    start = lambda **kw: client.post("/id/data/rasters", headers=h, json={"filename": "dem.tif", "size": 1000, **NEW, **kw})  # noqa: E731
    assert start(filename="parcels.geojson").json()["code"] == "unsupported_format"
    assert start(size=6 * 1024**3).status_code == 413
    assert start(title=None).status_code == 422
    assert start(license="Private", visibility="public").status_code == 422
    assert start(render={"colormap": "rainbow-unicorn"}).status_code == 422
    assert start(render={"colormap": "unicorn_r"}).status_code == 422
    assert start(render={"colormap": "spectral_r", "rescale": [250, 520]}).status_code == 201       # a ramp the other way round
    # a vector dataset does not take a raster version, and someone else's dataset is not there at all
    vec = client.post("/id/data/datasets", headers=h, json={**BODY, "ref": "layer-vec"}).json()["dataset"]["slug"]
    assert start(dataset=vec).status_code == 422
    other = Actor(client, "Other Raster Person")
    boss.put(f"/admin/orgs/{other.org_id}/products/land", json={"plan": "standard", "licence_kind": "demo"})
    oh = {"Authorization": f"Bearer {token(apps, other)}"}
    assert client.post("/id/data/rasters", headers=h, json={"filename": "d.tif", "size": 10, "dataset": "not-there"}).status_code == 404

    # a raster without coordinates fails clearly, and its new dataset is not left behind
    bad = apps.upload(at, "rasters", {**NEW, "title": "No coordinates", "ref": "layer-x", "slug": f"no-coords-{uuid.uuid4().hex[:6]}"},
                      str(dem(tmp_path, georef=False)))
    assert bad["status"] == "failed" and bad["error_code"] == "no_georeference" and "coordinate system" in bad["error"] and bad["dataset"] is None
    # the upload is the person's own
    assert client.get(f"/id/data/rasters/{bad['id']}", headers=h).status_code == 200
    assert client.get(f"/id/data/rasters/{bad['id']}", headers=oh).status_code == 404
    assert client.post(f"/id/data/rasters/{bad['id']}/complete", headers=h, json={"parts": [{"part_number": 1, "etag": "x"}]}).status_code == 409


def test_a_storage_that_will_not_delete_does_not_fail_a_published_raster(client, publisher, apps, tmp_path, monkeypatch):
    """Deleting the uploaded original is tidying up: when the storage service refuses it, the raster is still ready."""
    from app import storage

    def refuse(**kw):
        raise RuntimeError("NotImplemented: DeleteObject")
    monkeypatch.setattr(storage.internal, "delete_object", refuse)
    at = token(apps, publisher)
    out = apps.upload(at, "rasters", {**NEW, "title": "Kept anyway", "ref": "layer-keep"}, str(dem(tmp_path, "keep.tif")))
    assert out["status"] == "ready" and out["version"] == 1 and out["error"] is None, out
