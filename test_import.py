import json

from conftest import pt

CSV = """Name,lat,lon,Facility type,beds,Services,notes
Alpha,6.5,3.4,clinic,10,ER;Lab,ignored column
Beta,6.6,3.5,Hospital,200,Maternity|ER,
Gamma,abc,3.5,Clinic,5,,bad coordinates
Delta,6.7,3.6,Zoo,5,,bad choice
Epsilon,6.8,3.7,Pharmacy,not-a-number,,bad number
"""
MAPPING = {"Facility type": "type", "beds": "beds", "Services": "services"}


def run_import(o, p, filename, data, **form):
    r = o.post(f"/projects/{p.id}/import", files={"file": (filename, data)},
               data={"form_id": p.form_id, **form})
    assert r.status_code == 202, r.text
    return o.get(f"/jobs/{r.json()['id']}").json()


def test_csv_import_maps_columns_and_reports_bad_rows(project):
    o = project.owner
    job = run_import(o, project, "kobo.csv", CSV, lon_column="lon", lat_column="lat", mapping=json.dumps(MAPPING))
    res = job["result"]
    assert job["status"] == "done" and res["imported"] == 2 and res["rejected"] == 3
    assert sorted(res["dropped_columns"]) == ["Name", "notes"]
    errs = {e["row"]: e["message"] for e in res["errors"]}
    assert set(errs) == {4, 5, 6} and "geometry" in errs[4] and "type" in errs[5] and "beds" in errs[6]
    feats = o.get(f"/projects/{project.id}/features").json()["items"]
    assert len(feats) == 2 and {f["properties"]["type"] for f in feats} == {"Clinic", "Hospital"}  # 'clinic' normalised
    assert sorted(feats[0]["properties"]["services"]) in (["ER", "Lab"], ["ER", "Maternity"])
    # imported features have history and show up for sync
    assert len(o.get(f"/features/{feats[0]['id']}/history").json()["items"]) == 1
    pulled = o.get("/sync/pull", params={"project_id": project.id}).json()
    assert len(pulled["items"]) == 2


def test_geojson_import_and_wkt_csv(project):
    o = project.owner
    fc = {"type": "FeatureCollection", "features": [
        {"type": "Feature", "geometry": pt(3.1, 6.1), "properties": {"type": "Clinic", "beds": 3}},
        {"type": "Feature", "geometry": {"type": "LineString", "coordinates": [[0, 0], [1, 1]]}, "properties": {"type": "Clinic"}},
        {"type": "Feature", "geometry": pt(3.2, 6.2), "properties": {"type": "Hospital", "extra": "dropped"}}]}
    job = run_import(o, project, "x.geojson", json.dumps(fc), status="approved")
    assert job["result"]["imported"] == 2 and job["result"]["rejected"] == 1 and job["result"]["dropped_columns"] == ["extra"]
    assert all(f["status"] == "approved" for f in o.get(f"/projects/{project.id}/features").json()["items"])
    wkt = "wkt,type\nPOINT(3.3 6.3),Clinic\nPOINT(500 6.3),Clinic\n"
    job = run_import(o, project, "w.csv", wkt, wkt_column="wkt")
    assert job["result"]["imported"] == 1 and job["result"]["rejected"] == 1


def test_import_guards(project):
    o, col = project.owner, project.add("collector")
    r = col.post(f"/projects/{project.id}/import", files={"file": ("a.csv", "x")}, data={"form_id": project.form_id})
    assert r.status_code == 403
    r = o.post(f"/projects/{project.id}/import", files={"file": ("a.csv", CSV)}, data={"form_id": project.form_id})
    assert r.status_code == 422 and "lon_column" in r.json()["fields"]
    r = o.post(f"/projects/{project.id}/import", files={"file": ("a.xlsx", "x")}, data={"form_id": project.form_id})
    assert r.json()["code"] == "unsupported_format"
    job = run_import(o, project, "bad.csv", "lon,lat,type\nx,y,Zoo\n", lon_column="lon", lat_column="lat")
    assert job["status"] == "failed" and job["result"]["rejected"] == 1


KML = """<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
<Placemark><name>Clinic</name><Point><coordinates>3.1,6.1,0</coordinates></Point></Placemark>
<Placemark><name>Hospital</name><Point><coordinates>3.2,6.2,0</coordinates></Point></Placemark>
</Document></kml>"""


def test_kml_import_is_converted_with_ogr(project):
    job = run_import(project.owner, project, "places.kml", KML, mapping=json.dumps({"Name": "type"}))
    assert job["status"] == "done" and job["result"]["imported"] == 2, job
    types = {f["properties"]["type"] for f in project.owner.get(f"/projects/{project.id}/features").json()["items"]}
    assert types == {"Clinic", "Hospital"}


def test_unreadable_vector_file_fails_with_a_plain_message(project):
    job = run_import(project.owner, project, "broken.gpkg", "not a geopackage")
    assert job["status"] == "failed" and "could not be read as map data" in job["error"]


def test_images_sent_to_import_are_pointed_at_imagery(project):
    r = project.owner.post(f"/projects/{project.id}/import", files={"file": ("a.jpg", "x")}, data={"form_id": project.form_id})
    assert r.status_code == 422 and r.json()["code"] == "unsupported_format" and "imagery" in r.json()["detail"]
