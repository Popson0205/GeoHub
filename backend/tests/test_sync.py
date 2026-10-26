import uuid

from conftest import change, pt


def push(who, p, *changes):
    r = who.post("/sync/push", json={"project_id": p.id, "changes": list(changes)})
    assert r.status_code == 200, r.text
    return r.json()["results"]


def test_batch_one_bad_change_does_not_fail_the_rest(project):
    col = project.add("collector")
    good1, good2 = change(project), change(project)
    bad = change(project, properties={"type": "Zoo"})
    res = push(col, project, good1, bad, good2)
    assert [r["status"] for r in res] == ["applied", "rejected", "applied"]
    assert res[1]["code"] == "VALIDATION" and "type" in res[1]["fields"]
    assert res[0]["version"] == 1


def test_push_limit_is_200(project):
    r = project.owner.post("/sync/push", json={"project_id": project.id,
                           "changes": [change(project) for _ in range(201)]})
    assert r.status_code == 422


def test_idempotent_replay_creates_no_duplicates_or_versions(project):
    col = project.add("collector")
    c = change(project)
    first = push(col, project, c)[0]
    again = push(col, project, c)[0]
    assert first["status"] == again["status"] == "applied" and first["version"] == again["version"] == 1
    assert len(col.get(f"/features/{c['id']}/history").json()["items"]) == 1
    u = change(project, "update", fid=c["id"], base_version=1, properties={"type": "Hospital"})
    v1, v2 = push(col, project, u)[0], push(col, project, u)[0]
    assert v1["version"] == v2["version"] == 2
    assert len(col.get(f"/features/{c['id']}/history").json()["items"]) == 2


def test_merge_when_different_properties_changed(project):
    a = project.add("collector", "A")
    admin = project.owner
    c = change(project)
    push(a, project, c)
    # admin changes `beds` (server version 2); collector A, still at version 1, changes `type`
    admin.patch(f"/features/{c['id']}", json={"base_version": 1, "properties": {"type": "Clinic", "beds": 99}})
    res = push(a, project, change(project, "update", fid=c["id"], base_version=1,
                                  properties={"type": "Hospital", "beds": 5}))[0]
    assert res["status"] == "applied" and res["merged"] is True and res["version"] == 3
    f = admin.get(f"/features/{c['id']}").json()
    assert f["properties"] == {"type": "Hospital", "beds": 99}                       # both edits kept


def test_conflict_when_same_property_or_geometry_changed(project):
    a = project.add("collector")
    admin = project.owner
    c = change(project)
    push(a, project, c)
    admin.patch(f"/features/{c['id']}", json={"base_version": 1, "properties": {"type": "Pharmacy", "beds": 5}})
    res = push(a, project, change(project, "update", fid=c["id"], base_version=1,
                                  properties={"type": "Hospital", "beds": 5}))[0]
    assert res["status"] == "conflict" and res["server"]["properties"]["type"] == "Pharmacy"
    assert res["client"]["properties"]["type"] == "Hospital"

    # geometry changed on the server -> a property-only edit from a stale client still conflicts
    c2 = change(project)
    push(a, project, c2)
    admin.patch(f"/features/{c2['id']}", json={"base_version": 1, "geometry": pt(3.5, 6.6)})
    res = push(a, project, change(project, "update", fid=c2["id"], base_version=1,
                                  properties={"type": "Clinic", "beds": 7}))[0]
    assert res["status"] == "conflict"
    # and resolving = resubmitting on top of the server's version
    res = push(a, project, change(project, "update", fid=c2["id"], base_version=2,
                                  properties={"type": "Clinic", "beds": 7}))[0]
    assert res["status"] == "applied" and res["version"] == 3


def test_deletes_win_over_later_edits_until_restored(project):
    col = project.add("collector")
    c = change(project)
    push(col, project, c)
    assert push(col, project, change(project, "delete", fid=c["id"], base_version=1))[0]["status"] == "applied"
    late = push(col, project, change(project, "update", fid=c["id"], base_version=1, properties={"type": "Hospital"}))[0]
    assert late["status"] == "rejected" and late["code"] == "FEATURE_DELETED"
    # deleting again is harmless
    assert push(col, project, change(project, "delete", fid=c["id"], base_version=1))[0]["status"] == "applied"
    project.owner.post(f"/features/{c['id']}/restore")
    ok = push(col, project, change(project, "update", fid=c["id"], base_version=3, properties={"type": "Hospital"}))[0]
    assert ok["status"] == "applied"


def test_sync_permissions(project):
    a, b, viewer = project.add("collector", "A"), project.add("collector", "B"), project.add("viewer")
    c = change(project)
    push(a, project, c)
    assert push(b, project, change(project, "update", fid=c["id"], base_version=1,
                                   properties={"type": "Hospital"}))[0]["code"] == "FORBIDDEN"
    assert push(viewer, project, change(project))[0]["code"] == "FORBIDDEN"
    r = a.post("/sync/push", json={"project_id": str(uuid.uuid4()), "changes": [change(project)]})
    assert r.status_code == 404


def test_pull_is_ordered_by_server_sequence_and_resumable(project):
    a, b = project.add("collector", "A"), project.add("collector", "B")
    ids = []
    for who in (a, b, a):                 # interleaved writers
        c = change(project)
        ids.append(c["id"])
        push(who, project, c)
    # client timestamps are ignored for ordering: send one with a date far in the past
    push(b, project, change(project, "update", fid=ids[1], base_version=1, properties={"type": "Hospital"},
                            client_updated_at="2001-01-01T00:00:00Z"))
    p1 = a.get("/sync/pull", params={"project_id": project.id, "limit": 2}).json()
    assert [i["feature"]["id"] for i in p1["items"]] == [ids[0], ids[2]] and p1["has_more"] is True
    assert p1["items"][0]["seq"] < p1["items"][1]["seq"]
    p2 = a.get("/sync/pull", params={"project_id": project.id, "cursor": p1["next_cursor"]}).json()
    assert [i["feature"]["id"] for i in p2["items"]] == [ids[1]] and p2["has_more"] is False
    assert p2["items"][0]["feature"]["version"] == 2
    # caught up: the cursor is stable and returns nothing new
    p3 = a.get("/sync/pull", params={"project_id": project.id, "cursor": p2["next_cursor"]}).json()
    assert p3["items"] == [] and p3["next_cursor"] == p2["next_cursor"]
    # a delete shows up as a tombstone
    push(a, project, change(project, "delete", fid=ids[0], base_version=1))
    p4 = b.get("/sync/pull", params={"project_id": project.id, "cursor": p3["next_cursor"]}).json()
    assert p4["items"][0]["op"] == "delete" and p4["items"][0]["feature"]["id"] == ids[0]


def test_bundle_contains_published_forms_and_features_in_assigned_area(project):
    o = project.owner
    col = project.add("collector")
    inside, outside = change(project, geometry=pt(3.4, 6.5)), change(project, geometry=pt(30, 30))
    push(o, project, inside, outside)
    b = col.get(f"/projects/{project.id}/bundle").json()
    assert len(b["features"]) == 2 and b["forms"][0]["version"] == 1 and b["role"] == "collector"
    assert b["truncated"] is False and b["limits"]["max_sync_changes"] == 200
    area = {"type": "Polygon", "coordinates": [[[3, 6], [4, 6], [4, 7], [3, 7], [3, 6]]]}
    assert o.patch(f"/projects/{project.id}/members/{col.id}", json={"assigned_area": area}).status_code == 200
    b = col.get(f"/projects/{project.id}/bundle").json()
    assert [f["id"] for f in b["features"]] == [inside["id"]]
    assert b["project"]["assigned_area"]["type"] == "Polygon"
    # the cursor from the bundle picks up anything changed afterwards
    push(o, project, change(project, geometry=pt(3.5, 6.5)))
    pulled = col.get("/sync/pull", params={"project_id": project.id, "cursor": b["cursor"]}).json()
    assert len(pulled["items"]) == 1
