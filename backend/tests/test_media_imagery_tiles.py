import io
import subprocess
import uuid

import httpx
from PIL import Image

from conftest import change


def jpeg(w=3000, h=2000) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (200, 30, 30)).save(buf, "JPEG")
    return buf.getvalue()


def make_feature(project, who=None):
    c = change(project)
    (who or project.owner).post("/sync/push", json={"project_id": project.id, "changes": [c]})
    return c["id"]


# ---------------------------------------------------------------- photos
def test_photo_upload_resize_and_attach(project):
    col = project.add("collector")
    fid = make_feature(project, col)
    mid, data = str(uuid.uuid4()), jpeg()
    r = col.post("/media/upload-url", json={"id": mid, "project_id": project.id, "size": len(data)})
    assert r.status_code == 200, r.text
    up = r.json()
    assert httpx.put(up["upload_url"], content=data, headers=up["headers"]).status_code == 200
    r = col.post(f"/media/{mid}/complete", json={"feature_id": fid, "field_id": "photos"})
    assert r.status_code == 200, r.text
    m = r.json()
    assert (m["width"], m["height"]) == (3000, 2000)                       # original dimensions recorded
    assert m["status"] == "ready" and m["url"] != m["original_url"]
    web = Image.open(io.BytesIO(httpx.get(m["url"]).content))
    assert max(web.size) == 2048                                           # resized copy
    assert Image.open(io.BytesIO(httpx.get(m["original_url"]).content)).size == (3000, 2000)  # original kept
    assert [x["id"] for x in col.get(f"/features/{fid}").json()["media"]] == [mid]


def test_photo_limits_and_ordering_rules(project):
    col = project.add("collector")
    r = col.post("/media/upload-url", json={"id": str(uuid.uuid4()), "project_id": project.id, "size": 11 * 1024 * 1024})
    assert r.status_code == 413
    mid = str(uuid.uuid4())
    up = col.post("/media/upload-url", json={"id": mid, "project_id": project.id, "size": 10}).json()
    fid = make_feature(project, col)
    # completing before the bytes arrive is refused; asking again for a URL is allowed (resume)
    assert col.post(f"/media/{mid}/complete", json={"feature_id": fid}).json()["code"] == "upload_missing"
    assert col.post("/media/upload-url", json={"id": mid, "project_id": project.id, "size": 10}).status_code == 200
    # a feature that has not synced yet cannot receive the photo, but the upload itself works
    httpx.put(up["upload_url"], content=jpeg(50, 50), headers=up["headers"])
    assert col.post(f"/media/{mid}/complete", json={"feature_id": str(uuid.uuid4())}).json()["code"] == "feature_not_synced"
    # someone else cannot claim the id, and non-members cannot upload
    other = project.add("collector", "Other")
    assert other.post("/media/upload-url", json={"id": mid, "project_id": project.id, "size": 10}).status_code == 409
    assert project.add("viewer").post("/media/upload-url", json={"id": str(uuid.uuid4()), "project_id": project.id, "size": 1}).status_code == 403


# ---------------------------------------------------------------- imagery
def make_tif(path, georef=True):
    cmd = ["gdal_create", "-of", "GTiff", "-outsize", "64", "64", "-bands", "3", "-ot", "Byte", "-burn", "120"]
    if georef:
        cmd += ["-a_srs", "EPSG:4326", "-a_ullr", "3.3", "6.6", "3.4", "6.5"]
    subprocess.run(cmd + [str(path)], check=True, capture_output=True)
    return path.read_bytes()


def upload_imagery(admin, project, tif: bytes, name="Drone survey", filename="survey.tif"):
    r = admin.post(f"/projects/{project.id}/imagery", json={"name": name, "filename": filename, "size": len(tif)})
    assert r.status_code == 201, r.text
    up = r.json()
    assert up["part_size"] >= 64 * 1024 * 1024 and len(up["parts"]) == 1
    put = httpx.put(up["parts"][0]["url"], content=tif)
    assert put.status_code == 200
    return up, admin.post(f"/imagery/{up['id']}/complete",
                          json={"parts": [{"part_number": 1, "etag": put.headers["etag"]}]})


def test_imagery_upload_converts_to_cog(project, tmp_path):
    up, r = upload_imagery(project.owner, project, make_tif(tmp_path / "a.tif"))
    assert r.status_code == 202, r.text
    a = project.owner.get(f"/imagery/{up['id']}").json()
    assert a["status"] == "ready" and a["crs"] == "EPSG:4326" and a["bands"] == 3
    assert [round(x, 2) for x in a["bounds"]] == [3.3, 6.5, 3.4, 6.6]
    assert a["resolution"] == 0.1 / 64 and a["tiles_url"].endswith("/{z}/{x}/{y}.png")
    job = project.owner.get(f"/jobs/{r.json()['job_id']}").json()
    assert job["status"] == "done" and job["progress"] == 100
    assert len(project.owner.get(f"/projects/{project.id}/imagery").json()["items"]) == 1


def test_imagery_without_georeference_fails_clearly(project, tmp_path):
    up, r = upload_imagery(project.owner, project, make_tif(tmp_path / "b.tif", georef=False))
    a = project.owner.get(f"/imagery/{up['id']}").json()
    assert a["status"] == "failed" and a["error_code"] == "no_georeference" and "no georeference" in a["error"]
    job = project.owner.get(f"/jobs/{r.json()['job_id']}").json()
    assert job["status"] == "failed" and "georeference" in job["error"]


def test_imagery_limits_roles_and_delete(project, tmp_path):
    o = project.owner
    assert o.post(f"/projects/{project.id}/imagery", json={"name": "x", "filename": "x.exe", "size": 10}).status_code == 422
    big = o.post(f"/projects/{project.id}/imagery", json={"name": "x", "filename": "x.tif", "size": 6 * 1024**3})
    assert big.status_code == 413
    huge_ok = o.post(f"/projects/{project.id}/imagery", json={"name": "x", "filename": "x.tif", "size": 5 * 1024**3})
    assert huge_ok.status_code == 201 and len(huge_ok.json()["parts"]) == 80      # 5 GB in 64 MB parts
    assert project.add("collector").post(f"/projects/{project.id}/imagery",
                                         json={"name": "x", "filename": "x.tif", "size": 10}).status_code == 403
    up, _ = upload_imagery(o, project, make_tif(tmp_path / "c.tif"))
    assert o.delete(f"/imagery/{up['id']}").status_code == 204
    assert o.get(f"/imagery/{up['id']}").status_code == 404


# ---------------------------------------------------------------- tiles
def test_tiles_require_project_access(project, actor, client, tile_calls, tmp_path):
    o, stranger = project.owner, actor("Stranger")
    url = f"/tiles/features/{project.id}/{project.form_id}/5/16/15.pbf"
    assert client.get(url).status_code == 401
    assert stranger.get(url).status_code == 404
    tile_calls.clear()
    r = o.get(url)
    assert r.status_code == 200 and r.content == b"MVT-BYTES" and r.headers["content-type"] == "application/x-protobuf"
    up = tile_calls[-1].url
    assert up.path == "/feature_tiles/5/16/15" and up.params["project_id"] == project.id   # Martin is called internally
    # query-string token works too, for map libraries that cannot set headers
    tok = o.h["Authorization"].split()[1]
    assert client.get(url, params={"access_token": tok}).status_code == 200


def test_signed_layer_urls_and_imagery_tiles(project, actor, client, tile_calls, tmp_path):
    o = project.owner
    up, _ = upload_imagery(o, project, make_tif(tmp_path / "d.tif"))
    layers = o.get(f"/projects/{project.id}/layers").json()
    assert layers["expires_in"] == 3600 and layers["vector"][0]["form_id"] == project.form_id
    vurl = layers["vector"][0]["tiles_url"].replace("http://testserver", "").replace("{z}", "3").replace("{x}", "4").replace("{y}", "5")
    iurl = layers["imagery"][0]["tiles_url"].replace("http://testserver", "").replace("{z}", "3").replace("{x}", "4").replace("{y}", "5")
    assert "sig=" in vurl and client.get(vurl).status_code == 200            # no Authorization header needed
    tile_calls.clear()
    r = client.get(iurl + "&rescale=0,255&evil=1")
    assert r.status_code == 200 and r.content.startswith(b"\x89PNG")
    q = tile_calls[-1].url
    assert q.path == "/cog/tiles/WebMercatorQuad/3/4/5.png" and q.params["url"].startswith("s3://hub-test/imagery/")
    assert q.params["rescale"] == "0,255" and "evil" not in q.params         # only whitelisted options pass through
    # a signature minted for another project is refused for this one
    other = actor("Other")
    p2 = other.post("/projects", json={"name": "Other"}).json()["id"]
    from app.security import make_tile_token
    tok2 = make_tile_token(p2, other.id)
    r = client.get(f"/tiles/features/{project.id}/{project.form_id}/1/0/0.pbf", params={"sig": tok2})
    assert r.status_code == 403
    # a valid signature stops working once the person loses access to the project
    viewer = project.add("viewer")
    vsig = viewer.get(f"/projects/{project.id}/layers").json()["vector"][0]["tiles_url"].split("sig=")[1]
    ok = f"/tiles/features/{project.id}/{project.form_id}/1/0/0.pbf"
    assert client.get(ok, params={"sig": vsig}).status_code == 200
    o.delete(f"/projects/{project.id}/members/{viewer.id}")
    assert client.get(ok, params={"sig": vsig}).status_code == 404


# ---------------------------------------------------------------- other image formats
def make_plain(path, driver="JPEG"):
    """A picture with no coordinates at all, as a camera or an export from a design tool would make."""
    tif = path.with_suffix(".src.tif")
    subprocess.run(["gdal_create", "-of", "GTiff", "-outsize", "64", "64", "-bands", "3", "-ot", "Byte", "-burn", "90", str(tif)],
                   check=True, capture_output=True)
    subprocess.run(["gdal_translate", "-of", driver, str(tif), str(path)], check=True, capture_output=True)
    return path.read_bytes()


def test_jpeg_png_without_coordinates_need_bounds(project, tmp_path):
    o = project.owner
    for name, driver in (("a.jpg", "JPEG"), ("b.png", "PNG")):
        up, r = upload_imagery(o, project, make_plain(tmp_path / name, driver), filename=name)
        a = o.get(f"/imagery/{up['id']}").json()
        assert a["status"] == "failed" and a["error_code"] == "no_georeference" and "bounds" in a["error"]


def test_jpeg_with_bounds_is_placed_on_the_map(project, tmp_path):
    o = project.owner
    data = make_plain(tmp_path / "c.jpeg")
    r = o.post(f"/projects/{project.id}/imagery", json={"name": "Plan", "filename": "c.jpeg", "size": len(data),
                                                         "bounds": [3.3, 6.5, 3.4, 6.6]})
    assert r.status_code == 201, r.text
    up = r.json()
    etag = httpx.put(up["parts"][0]["url"], content=data).headers["ETag"]
    assert o.post(f"/imagery/{up['id']}/complete", json={"parts": [{"part_number": 1, "etag": etag}]}).status_code == 202
    a = o.get(f"/imagery/{up['id']}").json()
    assert a["status"] == "ready" and [round(x, 2) for x in a["bounds"]] == [3.3, 6.5, 3.4, 6.6]


def test_imagery_accepts_many_extensions_and_points_vectors_to_import(project):
    o = project.owner
    for name in ("a.tif", "a.TIFF", "a.jpg", "a.JPEG", "a.png", "a.webp", "a.gif", "a.bmp", "a.jp2", "a.img", "a.asc"):
        r = o.post(f"/projects/{project.id}/imagery", json={"name": "x", "filename": name, "size": 10})
        assert r.status_code == 201, (name, r.text)
    for name in ("a.geojson", "a.json", "a.kml", "a.gpkg", "a.zip", "a.csv"):
        r = o.post(f"/projects/{project.id}/imagery", json={"name": "x", "filename": name, "size": 10})
        assert r.status_code == 422 and r.json()["code"] == "use_import", name
    for name in ("a.exe", "a.vrt", "noextension"):
        r = o.post(f"/projects/{project.id}/imagery", json={"name": "x", "filename": name, "size": 10})
        assert r.status_code == 422 and r.json()["code"] == "unsupported_format", name
    bad = o.post(f"/projects/{project.id}/imagery", json={"name": "x", "filename": "a.jpg", "size": 10, "bounds": [5, 1, 4, 2]})
    assert bad.status_code == 422 and "bounds" in bad.json()["fields"]
