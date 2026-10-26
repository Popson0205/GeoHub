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
