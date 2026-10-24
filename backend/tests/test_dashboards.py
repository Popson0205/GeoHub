"""Dashboards: saved chart layouts. Who may see and change them, and what a layout may contain."""
import pytest
from pydantic import ValidationError

from app.schemas import DashboardConfig

W = {"id": "w1", "type": "bar", "title": "By type", "field": "type"}


# ---- the layout itself (no database needed) ----
def test_layout_defaults_and_limits():
    c = DashboardConfig(widgets=[W])
    assert c.widgets[0].width == 1 and c.widgets[0].metric == "count" and c.widgets[0].limit == 8


@pytest.mark.parametrize("bad", [
    {"widgets": [W, W]},                                           # same id twice
    {"widgets": [{**W, "type": "radar"}]},                         # unknown chart type
    {"widgets": [{**W, "width": 4}]},                              # wider than the grid
    {"widgets": [{**W, "id": "has space"}]},
    {"widgets": [{**W, "script": "x"}]},                           # unknown key
    {"widgets": [{**W, "id": f"w{i}"} for i in range(41)]},        # too many
])
def test_bad_layouts_are_refused(bad):
    with pytest.raises(ValidationError):
        DashboardConfig(**bad)


# ---- through the API ----
def _form(o, project):
    return o.post(f"/projects/{project.id}/forms", json={"name": "Water point", "geometry_type": "point"}).json()["id"]


def test_admins_build_and_viewers_read(project):
    o = project.owner
    viewer, collector = project.add("viewer"), project.add("collector")
    form_id = _form(o, project)
    r = o.post(f"/projects/{project.id}/dashboards", json={"name": "Overview", "config": {"form_id": form_id, "widgets": [W]}})
    assert r.status_code == 201
    d = r.json()
    assert d["config"]["widgets"][0]["field"] == "type"

    assert viewer.get(f"/projects/{project.id}/dashboards").json()["items"][0]["id"] == d["id"]
    assert viewer.get(f"/dashboards/{d['id']}").status_code == 200
    assert viewer.post(f"/projects/{project.id}/dashboards", json={"name": "x"}).status_code == 403
    assert viewer.patch(f"/dashboards/{d['id']}", json={"name": "x"}).status_code == 403
    assert viewer.delete(f"/dashboards/{d['id']}").status_code == 403
    # collectors only collect: they do not get to read collected data back
    assert collector.get(f"/projects/{project.id}/dashboards").status_code == 403
    assert collector.get(f"/dashboards/{d['id']}").status_code == 403


def test_edit_and_delete(project):
    o = project.owner
    d = o.post(f"/projects/{project.id}/dashboards", json={"name": "One"}).json()
    r = o.patch(f"/dashboards/{d['id']}", json={"name": "Two", "config": {"widgets": [W]}})
    assert r.json()["name"] == "Two" and len(r.json()["config"]["widgets"]) == 1
    assert o.patch(f"/dashboards/{d['id']}", json={"name": "Three"}).json()["config"]["widgets"]   # layout kept
    assert o.delete(f"/dashboards/{d['id']}").status_code == 204
    assert o.get(f"/dashboards/{d['id']}").status_code == 404


def test_strangers_cannot_see_them_and_forms_must_belong_to_the_project(project, actor):
    o = project.owner
    d = o.post(f"/projects/{project.id}/dashboards", json={"name": "Private"}).json()
    stranger = actor("Stranger")
    assert stranger.get(f"/dashboards/{d['id']}").status_code == 404
    assert stranger.get(f"/projects/{project.id}/dashboards").status_code == 404
    other_form = "00000000-0000-0000-0000-000000000000"
    r = o.post(f"/projects/{project.id}/dashboards", json={"name": "Bad", "config": {"form_id": other_form}})
    assert r.status_code == 422
