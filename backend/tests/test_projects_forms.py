def test_project_lifecycle_and_counts(project):
    o = project.owner
    p = o.get(f"/projects/{project.id}").json()
    assert p["role"] == "owner" and p["feature_count"] == 0 and p["collector_count"] == 0
    project.add("collector")
    assert o.get("/projects").json()["items"][0]["collector_count"] == 1
    assert o.patch(f"/projects/{project.id}", json={"name": "Renamed"}).json()["name"] == "Renamed"


def test_membership_and_roles(project, actor):
    o = project.owner
    col, viewer, admin = project.add("collector"), project.add("viewer"), project.add("admin")
    stranger = actor("Stranger")
    assert stranger.get(f"/projects/{project.id}").status_code == 404           # existence hidden
    assert viewer.post(f"/projects/{project.id}/forms", json={"name": "x", "geometry_type": "point"}).status_code == 403
    assert col.post(f"/projects/{project.id}/members", json={"email": "a@b.co"}).status_code == 403
    # admin can add collectors but not admins; only owners delete projects
    assert admin.post(f"/projects/{project.id}/members", json={"email": stranger.email, "role": "admin"}).status_code == 403
    assert admin.post(f"/projects/{project.id}/members", json={"email": stranger.email, "role": "collector"}).status_code == 201
    assert admin.delete(f"/projects/{project.id}").status_code == 403
    # the last owner cannot be demoted or removed
    assert o.patch(f"/projects/{project.id}/members/{o.id}", json={"role": "admin"}).status_code == 409
    assert o.delete(f"/projects/{project.id}/members/{o.id}").status_code == 409


def test_invite_by_email_for_new_user(project, client):
    o = project.owner
    email = "newcomer-" + o.email
    r = o.post(f"/projects/{project.id}/members", json={"email": email, "role": "collector"})
    assert r.status_code == 201 and r.json()["status"] == "invited"
    members = o.get(f"/projects/{project.id}/members").json()["items"]
    assert any(m["status"] == "invited" and m["email"] == email for m in members)
    # registering with that email accepts the invitation
    r = client.post("/auth/register", json={"email": email, "password": "long-enough-pass", "name": "New"})
    h = {"Authorization": f"Bearer {r.json()['access_token']}"}
    assert client.get(f"/projects/{project.id}", headers=h).json()["role"] == "collector"


def test_audit_log_records_sensitive_actions(project):
    o = project.owner
    c = project.add("collector")
    o.patch(f"/projects/{project.id}/members/{c.id}", json={"role": "viewer"})
    actions = [a["action"] for a in o.get(f"/projects/{project.id}/audit").json()["items"]]
    assert {"member.add", "member.role_change", "form.publish", "project.create"} <= set(actions)
    assert c.get(f"/projects/{project.id}/audit").status_code == 403


def test_form_validation_and_versions(project):
    o = project.owner
    bad = o.post(f"/projects/{project.id}/forms", json={"name": "Bad", "geometry_type": "point", "fields": [
        {"id": "a", "label": "A", "type": "choice"}, {"id": "a", "label": "dup", "type": "text"},
        {"id": "wkt", "label": "reserved", "type": "text"}]})
    assert bad.status_code == 422 and len(bad.json()["fields"]) == 3
    r = o.post(f"/projects/{project.id}/forms", json={"name": "Draft", "geometry_type": "area", "fields": []}).json()
    assert r["status"] == "draft" and r["version"] == 0
    assert o.post(f"/forms/{r['id']}/publish").json()["version"] == 1
    assert o.post(f"/forms/{r['id']}/publish").status_code == 409                  # nothing new
    # editing after publish creates an unpublished draft; published version is untouched
    f = o.patch(f"/forms/{r['id']}", json={"fields": [{"id": "n", "label": "N", "type": "text"}]}).json()
    assert f["version"] == 1 and f["has_unpublished_changes"] is True
    assert o.get(f"/forms/{r['id']}/versions/1").json()["fields"] == []
    assert o.post(f"/forms/{r['id']}/publish").json()["version"] == 2
    assert [v["version"] for v in o.get(f"/forms/{r['id']}/versions").json()] == [2, 1]
    assert o.patch(f"/forms/{r['id']}", json={"geometry_type": "point"}).status_code == 409


def test_delete_project_cascades(project, actor):
    o = project.owner
    assert o.delete(f"/projects/{project.id}").status_code == 204
    assert o.get(f"/projects/{project.id}").status_code == 404
