import uuid

from conftest import pt


def create(p, who=None, **kw):
    body = {"id": str(uuid.uuid4()), "form_id": p.form_id, "geometry": pt(),
            "properties": {"type": "Clinic", "beds": 5, "services": ["ER"]}}
    body.update(kw)
    r = (who or p.owner).post(f"/projects/{p.id}/features", json=body)
    return r, body["id"]


def test_create_validates_against_form(project):
    r, fid = create(project)
    assert r.status_code == 201 and r.json()["version"] == 1 and r.json()["form_version"] == 1
    assert r.json()["status"] == "submitted" and r.json()["geometry"] == pt()

    r, _ = create(project, properties={"type": "Zoo", "beds": "many", "nope": 1, "services": ["ER", "ER"]})
    assert r.status_code == 422
    f = r.json()["fields"]
    assert {"type", "beds", "nope", "services"} <= f.keys()
    r, _ = create(project, properties={"beds": 3})                    # required field missing
    assert r.json()["fields"]["type"] == ["required"]
    r, _ = create(project, properties={"beds": 3}, status="draft")    # drafts may be incomplete
    assert r.status_code == 201
    r, _ = create(project, geometry={"type": "Polygon", "coordinates": []})
    assert r.status_code == 422 and "geometry" in r.json()["fields"]
    r, _ = create(project, geometry={"type": "Point", "coordinates": [500, 6]})
    assert r.status_code == 422
    # a line geometry on a point form is rejected
    r = project.owner.post(f"/projects/{project.id}/features", json={"id": str(uuid.uuid4()), "form_id": project.form_id,
                           "geometry": {"type": "LineString", "coordinates": [[0, 0], [1, 1]]},
                           "properties": {"type": "Clinic"}})
    assert r.status_code == 422


def test_unpublished_form_cannot_collect(project):
    f = project.owner.post(f"/projects/{project.id}/forms", json={"name": "Wip", "geometry_type": "point"}).json()
    r, _ = create(project, form_id=f["id"], properties={})
    assert r.status_code == 409 and r.json()["code"] == "form_not_published"


def test_duplicate_id_and_list_filters(project):
    r, fid = create(project)
    r2 = project.owner.post(f"/projects/{project.id}/features", json={"id": fid, "form_id": project.form_id,
                            "geometry": pt(), "properties": {"type": "Clinic"}})
    assert r2.status_code == 409
    create(project, geometry=pt(10, 10))
    o = project.owner
    assert len(o.get(f"/projects/{project.id}/features").json()["items"]) == 2
    assert len(o.get(f"/projects/{project.id}/features", params={"bbox": "3,6,4,7"}).json()["items"]) == 1
    assert len(o.get(f"/projects/{project.id}/features", params={"status": "approved"}).json()["items"]) == 0
    page = o.get(f"/projects/{project.id}/features", params={"limit": 1}).json()
    assert len(page["items"]) == 1 and page["next_cursor"]
    page2 = o.get(f"/projects/{project.id}/features", params={"limit": 1, "cursor": page["next_cursor"]}).json()
    assert page2["items"][0]["id"] != page["items"][0]["id"] and page2["next_cursor"] is None


def test_patch_history_and_status_rules(project):
    o = project.owner
    r, fid = create(project)
    r = o.patch(f"/features/{fid}", json={"base_version": 1, "properties": {"type": "Hospital", "beds": 40}})
    assert r.status_code == 200 and r.json()["version"] == 2
    # same content again is a no-op: no new version
    assert o.patch(f"/features/{fid}", json={"base_version": 2, "properties": {"type": "Hospital", "beds": 40}}).json()["version"] == 2
    o.post(f"/features/{fid}/review", json={"decision": "approved", "note": "checked on site"})
    f = o.get(f"/features/{fid}").json()
    assert f["status"] == "approved" and f["version"] == 3
    # editing an approved feature sends it back for review
    f = o.patch(f"/features/{fid}", json={"base_version": 3, "properties": {"type": "Hospital", "beds": 41}}).json()
    assert f["status"] == "submitted"
    hist = o.get(f"/features/{fid}/history").json()["items"]
    assert [h["action"] for h in hist] == ["update", "review", "update", "create"]
    assert hist[-1]["properties"]["type"] == "Clinic" and hist[0]["changed_by_name"] == "Owner"


def test_review_permissions(project):
    col = project.add("collector")
    r, fid = create(project, who=col)
    assert col.post(f"/features/{fid}/review", json={"decision": "approved"}).status_code == 403
    r, draft = create(project, who=col, status="draft", properties={})
    assert project.owner.post(f"/features/{draft}/review", json={"decision": "approved"}).status_code == 409


def test_collectors_edit_only_own_but_read_all(project):
    a, b = project.add("collector", "A"), project.add("collector", "B")
    r, fid = create(project, who=a)
    assert b.get(f"/features/{fid}").status_code == 200
    r = b.patch(f"/features/{fid}", json={"base_version": 1, "properties": {"type": "Hospital"}})
    assert r.status_code == 403
    assert b.delete(f"/features/{fid}").status_code == 403
    assert a.patch(f"/features/{fid}", json={"base_version": 1, "properties": {"type": "Hospital"}}).status_code == 200


def test_viewer_cannot_write(project):
    v = project.add("viewer")
    r, _ = create(project, who=v)
    assert r.status_code == 403


def test_rest_conflict_carries_both_versions(project):
    o, col = project.owner, project.add("collector")
    r, fid = create(project, who=col)
    col.patch(f"/features/{fid}", json={"base_version": 1, "properties": {"type": "Hospital"}})
    o.patch(f"/features/{fid}", json={"base_version": 2, "properties": {"type": "Pharmacy"}})  # admin edits (version 3)
    r = col.patch(f"/features/{fid}", json={"base_version": 2, "properties": {"type": "Clinic"}})
    assert r.status_code == 409 and r.json()["code"] == "conflict"
    assert r.json()["server"]["properties"]["type"] == "Pharmacy" and r.json()["client"]["properties"]["type"] == "Clinic"
    # the user picks: resubmit against the server's version
    assert col.patch(f"/features/{fid}", json={"base_version": 3, "properties": {"type": "Clinic"}}).status_code == 200


def test_delete_restore_and_visibility(project):
    o = project.owner
    col = project.add("collector")
    r, fid = create(project, who=col)
    assert col.delete(f"/features/{fid}").status_code == 204
    assert col.get(f"/features/{fid}").status_code == 404                          # hidden from collectors
    assert o.get(f"/features/{fid}").json()["deleted_at"]                           # admins can still see it
    assert len(col.get(f"/projects/{project.id}/features").json()["items"]) == 0
    assert len(o.get(f"/projects/{project.id}/features", params={"include_deleted": True}).json()["items"]) == 1
    assert col.post(f"/features/{fid}/restore").status_code == 403
    assert o.post(f"/features/{fid}/restore").json()["deleted_at"] is None
    actions = {a["action"] for a in o.get(f"/projects/{project.id}/audit").json()["items"]}
    assert {"feature.delete", "feature.restore"} <= actions


def test_media_listed_on_feature_detail(project):
    r, fid = create(project)
    assert project.owner.get(f"/features/{fid}").json()["media"] == []

def test_project_counts_records_waiting_for_review(project):
    # The Data collection pages show how many records still need a decision.
    _, a = create(project)
    _, b = create(project)
    create(project, properties={"beds": 1}, status="draft")       # a draft is not waiting for review
    o = project.owner
    p = o.get(f"/projects/{project.id}").json()
    assert p["feature_count"] == 3 and p["waiting_count"] == 2
    assert o.post(f"/features/{a}/review", json={"decision": "approved"}).status_code == 200
    assert o.get("/projects").json()["items"][0]["waiting_count"] == 1
    assert o.delete(f"/features/{b}").status_code in (200, 204)
    assert o.get(f"/projects/{project.id}").json()["waiting_count"] == 0


def test_a_collector_gets_back_their_returned_records_with_the_note(project):
    # A reviewer's note has to reach the collector, including on collect-only phones that never pull everything.
    col = project.add("collector")
    _, mine1 = create(project, who=col)
    _, mine2 = create(project, who=col)
    _, other = create(project)                                         # the owner's own record
    o = project.owner
    assert o.post(f"/features/{mine1}/review", json={"decision": "rejected", "note": "Photo is blurry, please retake"}).status_code == 200
    assert o.post(f"/features/{other}/review", json={"decision": "rejected", "note": "x"}).status_code == 200
    assert o.post(f"/features/{mine2}/review", json={"decision": "approved"}).status_code == 200
    items = col.get(f"/projects/{project.id}/features", params={"status": "rejected", "mine": True}).json()["items"]
    assert [i["id"] for i in items] == [mine1] and items[0]["review_note"] == "Photo is blurry, please retake"
    # fixing it sends it back for review
    r = col.patch(f"/features/{mine1}", json={"properties": {"type": "Clinic", "beds": 6, "services": ["ER"]}, "base_version": items[0]["version"]})
    assert r.status_code == 200 and r.json()["status"] == "submitted", r.text
    assert col.get(f"/projects/{project.id}/features", params={"status": "rejected", "mine": True}).json()["items"] == []


def test_collected_records_download_as_geopackage_shapefile_and_kml(project, client):
    # Collected data (not a published dataset) can be downloaded in GIS formats, all of it, by status, or picked records.
    import io, subprocess, zipfile
    import httpx
    o = project.owner
    _, a = create(project)
    _, b = create(project, properties={"type": "Hospital", "beds": 40, "services": ["ER", "Lab"]})
    assert o.post(f"/features/{a}/review", json={"decision": "approved"}).status_code == 200

    def export(**body):
        r = o.post(f"/projects/{project.id}/exports", json={"form_id": project.form_id, **body})
        assert r.status_code == 202, r.text
        job = o.get(f"/jobs/{r.json()['id']}").json()
        assert job["status"] == "done", job
        return job, httpx.get(job["result"]["download_url"]).content

    job, data = export(format="gpkg")
    path = f"/tmp/records-{project.id[:8]}.gpkg"
    open(path, "wb").write(data)
    info = subprocess.run(["ogrinfo", "-so", "-al", path], capture_output=True, text=True).stdout
    assert "Feature Count: 2" in info and "services" in info and "status" in info and job["result"]["filename"].endswith(".gpkg")

    _, data = export(format="shp", statuses=["approved"])
    z = zipfile.ZipFile(io.BytesIO(data))
    shp = [n for n in z.namelist() if n.endswith(".dbf")][0]
    z.extract(shp, "/tmp")
    assert "Feature Count: 1" in subprocess.run(["ogrinfo", "-so", "-al", f"/tmp/{shp}"], capture_output=True, text=True).stdout
    assert "field_mapping.csv" in z.namelist()

    _, data = export(format="kml", ids=[b])
    kml = data.decode()
    assert kml.count("<Placemark") == 1 and "Hospital" in kml and "Lab" in kml

    # a draft-only form, or someone outside the project, gets nothing
    assert o.post(f"/projects/{project.id}/exports", json={"form_id": str(uuid.uuid4()), "format": "kml"}).status_code == 404
