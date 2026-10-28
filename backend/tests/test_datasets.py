import csv
import io
import subprocess
import zipfile

import httpx

from conftest import change, pt

LONG_FORM_FIELDS = [
    {"id": "water_source_type", "label": "Water source type", "type": "choice", "choices": ["Borehole", "Well"]},
    {"id": "water_source_depth", "label": "Depth (m)", "type": "number"},
    {"id": "services", "label": "Services", "type": "multi_choice", "choices": ["Pump", "Tank", "Filter"]},
]


def setup_dataset_project(project, n_approved=2, n_submitted=1):
    o = project.owner
    form = o.post(f"/projects/{project.id}/forms", json={"name": "Water", "geometry_type": "point",
                                                          "fields": LONG_FORM_FIELDS}).json()
    o.post(f"/forms/{form['id']}/publish")
    ids = []
    for i in range(n_approved + n_submitted):
        c = change(project, form_id=form["id"], geometry=pt(3.0 + i * 0.1, 6.0),
                   properties={"water_source_type": "Borehole", "water_source_depth": 10.5 + i,
                               "services": ["Pump", "Tank"]})
        o.post("/sync/push", json={"project_id": project.id, "changes": [c]})
        if i < n_approved:
            o.post(f"/features/{c['id']}/review", json={"decision": "approved"})
        ids.append(c["id"])
    return form["id"], ids


def publish(project, form_id, slug="water-points", **kw):
    body = {"form_id": form_id, "slug": slug, "title": "Water points", "description": "Boreholes in the north",
            "license": "CC-BY-4.0", "tags": ["Water", "Health"], "visibility": "public", **kw}
    return project.owner.post(f"/projects/{project.id}/datasets", json=body)


def export(client, slug, fmt, who=None, **kw):
    r = (who.post if who else client.post)(f"/datasets/{slug}/exports", json={"format": fmt, **kw}) if who else \
        client.post(f"/datasets/{slug}/exports", json={"format": fmt, **kw})
    assert r.status_code == 202, r.text
    job = (who.get if who else client.get)(f"/jobs/{r.json()['id']}") if who else client.get(f"/jobs/{r.json()['id']}")
    assert job.status_code == 200 and job.json()["status"] == "done", job.text
    return job.json()


def download(job) -> bytes:
    r = httpx.get(job["result"]["download_url"])
    assert r.status_code == 200
    return r.content


def test_publish_snapshot_and_public_catalogue(project, client):
    form_id, _ = setup_dataset_project(project)
    r = publish(project, form_id, slug=f"water-{project.id[:6]}")
    assert r.status_code == 202, r.text
    slug = r.json()["dataset"]["slug"]
    assert r.json()["job"]["status"] == "done" and r.json()["job"]["result"]["feature_count"] == 2   # approved only

    # anonymous visitors: catalogue, metadata, features
    cat = client.get("/datasets", params={"q": "boreholes", "type": "point", "license": "CC-BY-4.0"}).json()
    assert slug in [d["slug"] for d in cat["items"]]
    d = client.get(f"/datasets/{slug}").json()
    assert d["latest_version"] == 1 and d["feature_count"] == 2 and d["license"] == "CC-BY-4.0"
    assert d["tags"] == ["water", "health"] and d["project_id"] is None            # project id hidden from the public
    assert [round(x, 1) for x in d["bbox"]] == [3.0, 6.0, 3.1, 6.0] and d["formats"] == ["geojson", "gpkg", "shp", "csv"]
    fc = client.get(f"/datasets/{slug}/features", params={"limit": 1}).json()
    assert fc["type"] == "FeatureCollection" and len(fc["features"]) == 1 and fc["next_cursor"]
    fc2 = client.get(f"/datasets/{slug}/features", params={"limit": 5, "cursor": fc["next_cursor"]}).json()
    assert len(fc2["features"]) == 1 and fc2["next_cursor"] is None
    assert len(client.get(f"/datasets/{slug}/features", params={"bbox": "2.9,5.9,3.05,6.1"}).json()["features"]) == 1
    sort = client.get("/datasets", params={"sort": "downloads"})
    assert sort.status_code == 200


def test_publish_rules(project):
    form_id, _ = setup_dataset_project(project)
    col = project.add("collector")
    admin = project.add("admin")
    body = {"form_id": form_id, "slug": "x-slug", "title": "T"}
    assert col.post(f"/projects/{project.id}/datasets", json=body).status_code == 403
    assert admin.post(f"/projects/{project.id}/datasets", json=body).status_code == 403      # owner-only
    assert publish(project, form_id, slug="private-lic", license="Private", visibility="public").status_code == 422
    assert publish(project, form_id, slug=f"ok-{project.id[:6]}").status_code == 202
    assert publish(project, form_id, slug=f"ok-{project.id[:6]}").json()["code"] == "slug_taken"
    # a form nobody has approved anything in cannot be published
    f2 = project.owner.post(f"/projects/{project.id}/forms", json={"name": "Empty", "geometry_type": "point"}).json()
    project.owner.post(f"/forms/{f2['id']}/publish")
    r = publish(project, f2["id"], slug=f"empty-{project.id[:6]}")
    assert r.json()["job"]["status"] == "failed" and "No features to publish" in r.json()["job"]["error"]


def test_versions_are_immutable_snapshots(project, client):
    form_id, ids = setup_dataset_project(project)
    slug = publish(project, form_id, slug=f"v-{project.id[:8]}").json()["dataset"]["slug"]
    o = project.owner
    # approve the third feature and change the first, then publish v2
    o.post(f"/features/{ids[2]}/review", json={"decision": "approved"})
    o.patch(f"/features/{ids[0]}", json={"base_version": 2, "properties": {"water_source_type": "Well"}})
    o.post(f"/features/{ids[0]}/review", json={"decision": "approved"})
    job = o.post(f"/datasets/{slug}/versions").json()
    assert job["status"] == "done" and job["result"]["version"] == 2 and job["result"]["feature_count"] == 3
    d = client.get(f"/datasets/{slug}").json()
    assert [v["version"] for v in d["versions"]] == [2, 1] and d["latest_version"] == 2
    v1 = client.get(f"/datasets/{slug}/features", params={"version": 1}).json()["features"]
    v2 = client.get(f"/datasets/{slug}/features", params={"version": 2}).json()["features"]
    assert len(v1) == 2 and len(v2) == 3
    first = ids[0]
    assert next(f for f in v1 if f["id"] == first)["properties"]["water_source_type"] == "Borehole"   # unchanged
    assert next(f for f in v2 if f["id"] == first)["properties"]["water_source_type"] == "Well"
    assert project.add("collector").post(f"/datasets/{slug}/versions").status_code == 403


def test_exports_all_formats(project, client):
    form_id, _ = setup_dataset_project(project)
    slug = publish(project, form_id, slug=f"ex-{project.id[:8]}").json()["dataset"]["slug"]

    # CSV: points get longitude and latitude columns
    job = export(client, slug, "csv")
    assert job["result"]["filename"] == f"{slug}-v1.csv"
    rows = list(csv.DictReader(io.StringIO(download(job).decode())))
    assert len(rows) == 2 and list(rows[0])[:3] == ["feature_id", "longitude", "latitude"]
    assert rows[0]["services"] == "Pump; Tank" and rows[0]["water_source_depth"] in ("10.5", "11.5")

    # GeoJSON
    gj = httpx.get(export(client, slug, "geojson")["result"]["download_url"]).json()
    assert len(gj["features"]) == 2 and gj["features"][0]["properties"]["water_source_type"] == "Borehole"

    # GeoPackage opens in GDAL and has the features, with full field names
    job = export(client, slug, "gpkg")
    path = f"/tmp/{slug}.gpkg"
    open(path, "wb").write(download(job))
    info = subprocess.run(["ogrinfo", "-so", "-al", path], capture_output=True, text=True).stdout
    assert "Feature Count: 2" in info and "water_source_type" in info

    # Shapefile: zip with mapping file; 10-character names are unique and mapped
    job = export(client, slug, "shp")
    z = zipfile.ZipFile(io.BytesIO(download(job)))
    names = z.namelist()
    assert {f"{slug}-v1.{e}" for e in ("shp", "shx", "dbf", "prj")} <= set(names)
    assert "field_mapping.csv" in names and "README.txt" in names
    mapping = {r["field_id"]: r["shapefile_name"] for r in csv.DictReader(io.StringIO(z.read("field_mapping.csv").decode()))}
    assert mapping["water_source_type"] == "water_sour" and mapping["water_source_depth"] == "water_so_1"
    assert len(set(mapping.values())) == len(mapping) and all(len(v) <= 10 for v in mapping.values())
    z.extract(f"{slug}-v1.dbf", "/tmp")
    dbf = subprocess.run(["ogrinfo", "-so", "-al", f"/tmp/{slug}-v1.dbf"], capture_output=True, text=True).stdout
    assert "water_sour" in dbf and "water_so_1" in dbf


def test_line_and_area_csv_use_wkt(project, client):
    o = project.owner
    form = o.post(f"/projects/{project.id}/forms", json={"name": "Roads", "geometry_type": "line",
                                                          "fields": [{"id": "name", "label": "Name", "type": "text"}]}).json()
    o.post(f"/forms/{form['id']}/publish")
    c = change(project, form_id=form["id"], geometry={"type": "LineString", "coordinates": [[3, 6], [3.1, 6.1]]},
               properties={"name": "Main St"})
    o.post("/sync/push", json={"project_id": project.id, "changes": [c]})
    o.post(f"/features/{c['id']}/review", json={"decision": "approved"})
    slug = publish(project, form["id"], slug=f"roads-{project.id[:6]}").json()["dataset"]["slug"]
    rows = list(csv.DictReader(io.StringIO(download(export(client, slug, "csv")).decode())))
    assert list(rows[0]) == ["feature_id", "wkt", "name"] and rows[0]["wkt"].startswith("LINESTRING")


def test_export_cache_and_download_counts(project, client):
    form_id, _ = setup_dataset_project(project)
    slug = publish(project, form_id, slug=f"c-{project.id[:8]}").json()["dataset"]["slug"]
    j1 = export(client, slug, "csv")
    r2 = client.post(f"/datasets/{slug}/exports", json={"format": "csv"})
    assert r2.json()["status"] == "done"                                   # served from the cache, instantly
    assert r2.json()["result"]["filename"] == j1["result"]["filename"]
    d = client.get(f"/datasets/{slug}").json()
    assert d["versions"][0]["download_count"] == 2 and d["download_count"] == 2
    assert client.post(f"/datasets/{slug}/exports", json={"format": "csv", "version": 9}).status_code == 404
    assert client.post(f"/datasets/{slug}/exports", json={"format": "kml"}).status_code == 422


def test_private_datasets_are_invisible_to_the_public(project, client, actor):
    form_id, _ = setup_dataset_project(project)
    slug = publish(project, form_id, slug=f"p-{project.id[:8]}", visibility="private").json()["dataset"]["slug"]
    assert client.get(f"/datasets/{slug}").status_code == 404
    assert slug not in [d["slug"] for d in client.get("/datasets").json()["items"]]
    assert client.post(f"/datasets/{slug}/exports", json={"format": "csv"}).status_code == 404
    viewer = project.add("viewer")
    assert viewer.get(f"/datasets/{slug}").json()["project_id"] == project.id      # members see it
    job = export(client, slug, "csv", who=viewer)                                  # members can export, signed in
    assert job["status"] == "done"
    assert actor("Stranger").get(f"/datasets/{slug}").status_code == 404
    # job ids of private exports are not readable anonymously
    jid = viewer.post(f"/datasets/{slug}/exports", json={"format": "gpkg"}).json()["id"]
    assert client.get(f"/jobs/{jid}").status_code == 401
    # flipping visibility is owner-only and audited
    assert viewer.patch(f"/datasets/{slug}", json={"visibility": "public"}).status_code == 403
    assert project.owner.patch(f"/datasets/{slug}", json={"visibility": "public"}).status_code == 200
    assert client.get(f"/datasets/{slug}").status_code == 200
    actions = [a["action"] for a in project.owner.get(f"/projects/{project.id}/audit").json()["items"]]
    assert "dataset.visibility" in actions and "export.request" in actions and "dataset.publish" in actions


def test_anonymous_export_rate_limit(project, client, monkeypatch):
    from app.config import settings
    form_id, _ = setup_dataset_project(project)
    slug = publish(project, form_id, slug=f"rl-{project.id[:8]}").json()["dataset"]["slug"]
    monkeypatch.setattr(settings, "rate_anon_export_per_hour", 2)
    codes = [client.post(f"/datasets/{slug}/exports", json={"format": "csv"}).status_code for _ in range(3)]
    assert codes == [202, 202, 429]
