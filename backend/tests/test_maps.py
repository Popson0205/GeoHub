"""Standalone mapping workspaces: independent of projects and forms."""
import uuid

import httpx

from conftest import pt
from test_media_imagery_tiles import make_tif

XYZ = "https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}"


def new_map(owner, name="Survey"):
    r = owner.post("/maps", json={"name": name})
    assert r.status_code == 201, r.text
    return r.json()


def test_map_crud_and_privacy(actor):
    a, b = actor("A"), actor("B")
    m = new_map(a)
    assert m["feature_count"] == 0 and m["sources"] == []
    assert [x["id"] for x in a.get("/maps").json()] == [m["id"]]
    assert b.get("/maps").json() == []
    for call in (b.get, b.delete):                           # someone else's map does not exist for you
        assert call(f"/maps/{m['id']}").status_code == 404
    assert b.post(f"/maps/{m['id']}/features", json={"geometry": pt()}).status_code == 404
    r = a.patch(f"/maps/{m['id']}", json={"name": "Renamed", "description": "x"})
    assert r.status_code == 200 and r.json()["name"] == "Renamed"
    assert a.delete(f"/maps/{m['id']}").status_code == 204
    assert a.get(f"/maps/{m['id']}").status_code == 404


def test_xyz_sources_are_validated_and_stored(actor):
    a = actor()
    m = new_map(a)
    good = {"name": "Google satellite", "url": XYZ, "maxzoom": 20}
    r = a.patch(f"/maps/{m['id']}", json={"sources": [good]})
    assert r.status_code == 200, r.text
    s = r.json()["sources"][0]
    assert s["id"] and s["url"] == XYZ and s["type"] == "xyz" and s["maxzoom"] == 20
    for bad in ("ftp://x/{z}/{x}/{y}", "https://example.com/tiles.png", "https://example.com/{z}/{x}.png"):
        r = a.patch(f"/maps/{m['id']}", json={"sources": [{"name": "Bad", "url": bad}]})
        assert r.status_code == 422, bad
    assert a.get(f"/maps/{m['id']}/layers").json()["sources"][0]["url"] == XYZ


def test_features_need_no_project_or_form(actor):
    a = actor()
    m = new_map(a)
    fid = str(uuid.uuid4())
    line = {"type": "LineString", "coordinates": [[3.0, 6.0], [3.1, 6.1]]}
    r = a.post(f"/maps/{m['id']}/features", json={"id": fid, "geometry": line, "properties": {"highway": "residential", "lanes": 2}})
    assert r.status_code == 201, r.text
    f = r.json()
    assert f["id"] == fid and f["version"] == 1 and f["geometry"]["type"] == "LineString"
    assert a.post(f"/maps/{m['id']}/features", json={"id": fid, "geometry": pt()}).status_code == 409   # idempotent id
    # free-form tags, any geometry type
    area = {"type": "Polygon", "coordinates": [[[3, 6], [3.1, 6], [3.1, 6.1], [3, 6]]]}
    assert a.post(f"/maps/{m['id']}/features", json={"geometry": area, "properties": {"building": "yes"}}).status_code == 201
    assert a.post(f"/maps/{m['id']}/features", json={"geometry": pt(), "properties": {"name": "Well"}}).status_code == 201
    assert len(a.get(f"/maps/{m['id']}/features").json()) == 3
    assert len(a.get(f"/maps/{m['id']}/features", params={"bbox": "2.9,5.9,3.2,6.2"}).json()) == 2   # point at 3.39 is outside
    assert a.get(f"/maps/{m['id']}").json()["feature_count"] == 3
    # update: tags and geometry, with optimistic locking
    r = a.patch(f"/maps/{m['id']}/features/{fid}", json={"properties": {"highway": "primary"}, "base_version": 1})
    assert r.status_code == 200 and r.json()["version"] == 2 and r.json()["properties"] == {"highway": "primary"}
    assert a.patch(f"/maps/{m['id']}/features/{fid}", json={"properties": {}, "base_version": 1}).status_code == 409
    moved = {"type": "LineString", "coordinates": [[3.0, 6.0], [3.2, 6.2], [3.3, 6.3]]}
    assert len(a.patch(f"/maps/{m['id']}/features/{fid}", json={"geometry": moved}).json()["geometry"]["coordinates"]) == 3
    # validation
    assert a.post(f"/maps/{m['id']}/features", json={"geometry": {"type": "Point", "coordinates": [200, 0]}}).status_code == 422
    assert a.post(f"/maps/{m['id']}/features", json={"geometry": pt(), "properties": {"x": {"nested": 1}}}).status_code == 422
    assert a.delete(f"/maps/{m['id']}/features/{fid}").status_code == 204
    assert a.delete(f"/maps/{m['id']}/features/{fid}").status_code == 404


def test_import_and_export_geojson(actor):
    a = actor()
    m = new_map(a, "My map / test")
    feats = [{"geometry": pt(3.1, 6.1), "properties": {"name": "A"}},
             {"geometry": {"type": "Point", "coordinates": [999, 0]}, "properties": {}},
             {"geometry": {"type": "LineString", "coordinates": [[3, 6], [3.1, 6.1]]}, "properties": {"k": None}}]
    r = a.post(f"/maps/{m['id']}/features/import", json={"features": feats})
    assert r.status_code == 200, r.text
    out = r.json()
    assert (out["imported"], out["rejected"]) == (2, 1) and out["errors"][0]["row"] == 2
    ex = a.get(f"/maps/{m['id']}/export.geojson")
    assert ex.status_code == 200 and 'filename="My-map-test.geojson"' in ex.headers["content-disposition"]
    fc = ex.json()
    assert fc["type"] == "FeatureCollection" and len(fc["features"]) == 2
    assert fc["features"][0]["properties"] == {"name": "A"}


def test_uploaded_imagery_belongs_to_the_map(actor, tmp_path, tile_calls):
    a, b = actor("A"), actor("B")
    m = new_map(a)
    tif = make_tif(tmp_path / "s.tif")
    r = a.post(f"/maps/{m['id']}/imagery", json={"name": "Drone", "filename": "s.tif", "size": len(tif)})
    assert r.status_code == 201, r.text
    up = r.json()
    assert b.post(f"/maps/{m['id']}/imagery", json={"name": "x", "filename": "s.tif", "size": 5}).status_code == 404
    put = httpx.put(up["parts"][0]["url"], content=tif)
    r = a.post(f"/imagery/{up['id']}/complete", json={"parts": [{"part_number": 1, "etag": put.headers["etag"]}]})
    assert r.status_code == 202, r.text
    assert b.get(f"/imagery/{up['id']}").status_code == 404                     # private to the map's owner
    assert b.post(f"/imagery/{up['id']}/complete", json={"parts": [{"part_number": 1, "etag": "x"}]}).status_code == 404
    got = a.get(f"/imagery/{up['id']}").json()
    assert got["status"] == "ready" and got["map_id"] == m["id"] and got["project_id"] is None
    assert [i["id"] for i in a.get(f"/maps/{m['id']}/imagery").json()["items"]] == [up["id"]]
    layers = a.get(f"/maps/{m['id']}/layers").json()
    assert len(layers["imagery"]) == 1
    url = layers["imagery"][0]["tiles_url"].replace("{z}", "3").replace("{x}", "4").replace("{y}", "5")
    tile = a.c.get(url.replace("http://testserver", ""))                         # the signed URL works without a header
    assert tile.status_code == 200
    bad = a.c.get(f"/tiles/imagery/{up['id']}/3/4/5.png")                        # but never anonymously
    assert bad.status_code == 401
    assert b.get(f"/tiles/imagery/{up['id']}/3/4/5.png").status_code == 404
    assert a.delete(f"/imagery/{up['id']}").status_code == 204
    assert a.get(f"/maps/{m['id']}/imagery").json()["items"] == []


def test_vector_files_are_not_imagery(actor):
    a = actor()
    m = new_map(a)
    r = a.post(f"/maps/{m['id']}/imagery", json={"name": "x", "filename": "points.geojson", "size": 10})
    assert r.status_code == 422 and r.json()["code"] == "use_import"
