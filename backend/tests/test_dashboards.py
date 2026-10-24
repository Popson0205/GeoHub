"""Dashboards: saved pages of charts. Who may see and change them, and what a layout may contain."""
import pytest
from pydantic import ValidationError

from app.schemas import DashboardConfig

W = {"id": "w1", "type": "bar", "title": "By type", "field": "type"}
PAGE = {"id": "army", "title": "Army", "widgets": [W]}


# ---- the layout itself (no database needed) ----
def test_layout_defaults_and_limits():
    c = DashboardConfig(pages=[PAGE])
    w = c.pages[0].widgets[0]
    assert w.wide is False and w.metric == "count" and w.limit == 8 and w.form_id is None
    assert len(DashboardConfig().pages) == 1                         # a dashboard always has a page


def test_old_dashboards_become_one_page():
    old = DashboardConfig(form_id="11111111-1111-1111-1111-111111111111", widgets=[{**W, "width": 3}, {**W, "id": "w2", "width": 1}])
    assert len(old.pages) == 1 and old.pages[0].title == "Overview"
    assert str(old.pages[0].form_id) == "11111111-1111-1111-1111-111111111111"
    assert [w.wide for w in old.pages[0].widgets] == [True, False]   # only "full width" still means anything
    assert len(DashboardConfig(**{}).pages) == 1


@pytest.mark.parametrize("bad", [
    {"pages": []},                                                           # a dashboard needs a page
    {"pages": [PAGE, PAGE]},                                                 # same page id twice
    {"pages": [{**PAGE, "id": f"p{i}"} for i in range(13)]},                 # too many pages
    {"pages": [{**PAGE, "title": ""}]},
    {"pages": [{**PAGE, "id": "has space"}]},
    {"pages": [{**PAGE, "widgets": [W, W]}]},                                # same chart id twice on a page
    {"pages": [{**PAGE, "widgets": [{**W, "type": "radar"}]}]},              # unknown chart type
    {"pages": [{**PAGE, "widgets": [{**W, "width": 4}]}]},                   # not a width the old layout had
    {"pages": [{**PAGE, "widgets": [{**W, "id": "has space"}]}]},
    {"pages": [{**PAGE, "widgets": [{**W, "script": "x"}]}]},                # unknown key
    {"pages": [{**PAGE, "widgets": [{**W, "id": f"w{i}"} for i in range(31)]}]},   # too many on one page
    {"pages": [PAGE], "widgets": [W]},                                       # old and new shape mixed
])
def test_bad_layouts_are_refused(bad):
    with pytest.raises(ValidationError):
        DashboardConfig(**bad)


# ---- through the API ----
def _form(o, project, name="Water point"):
    return o.post(f"/projects/{project.id}/forms", json={"name": name, "geometry_type": "point"}).json()["id"]


def test_admins_build_and_viewers_read(project):
    o = project.owner
    viewer, collector = project.add("viewer"), project.add("collector")
    form_id = _form(o, project)
    r = o.post(f"/projects/{project.id}/dashboards", json={"name": "Overview", "config": {"pages": [{**PAGE, "form_id": form_id}]}})
    assert r.status_code == 201
    d = r.json()
    assert d["config"]["pages"][0]["widgets"][0]["field"] == "type"

    assert viewer.get(f"/projects/{project.id}/dashboards").json()["items"][0]["id"] == d["id"]
    assert viewer.get(f"/dashboards/{d['id']}").status_code == 200
    assert viewer.post(f"/projects/{project.id}/dashboards", json={"name": "x"}).status_code == 403
    assert viewer.patch(f"/dashboards/{d['id']}", json={"name": "x"}).status_code == 403
    assert viewer.delete(f"/dashboards/{d['id']}").status_code == 403
    # collectors only collect: they do not get to read collected data back
    assert collector.get(f"/projects/{project.id}/dashboards").status_code == 403
    assert collector.get(f"/dashboards/{d['id']}").status_code == 403


def test_one_dashboard_many_departments(project):
    """A joint dashboard: an overview page drawing on every form, then one page per form (Army, Air Force, Navy)."""
    o = project.owner
    forms = {n: _form(o, project, n) for n in ("Army", "Air Force", "Navy")}
    overview = {"id": "overview", "title": "Overview", "widgets": [
        {"id": f"k{i}", "type": "kpi", "title": n, "form_id": f} for i, (n, f) in enumerate(forms.items())]}
    pages = [overview] + [{"id": n.lower().replace(" ", "-"), "title": n, "form_id": f, "widgets": [W]} for n, f in forms.items()]
    r = o.post(f"/projects/{project.id}/dashboards", json={"name": "Ministry of Defence", "config": {"description": "Joint reporting", "pages": pages}})
    assert r.status_code == 201
    got = o.get(f"/dashboards/{r.json()['id']}").json()["config"]
    assert [p["title"] for p in got["pages"]] == ["Overview", "Army", "Air Force", "Navy"]    # order is kept
    assert got["pages"][0]["widgets"][1]["form_id"] == forms["Air Force"] and got["description"] == "Joint reporting"


def test_edit_and_delete(project):
    o = project.owner
    d = o.post(f"/projects/{project.id}/dashboards", json={"name": "One"}).json()
    assert len(d["config"]["pages"]) == 1                                    # created empty, still has a page
    r = o.patch(f"/dashboards/{d['id']}", json={"name": "Two", "config": {"pages": [PAGE]}})
    assert r.json()["name"] == "Two" and len(r.json()["config"]["pages"][0]["widgets"]) == 1
    assert o.patch(f"/dashboards/{d['id']}", json={"name": "Three"}).json()["config"]["pages"][0]["widgets"]   # layout kept
    assert o.delete(f"/dashboards/{d['id']}").status_code == 204
    assert o.get(f"/dashboards/{d['id']}").status_code == 404


def test_old_saved_dashboards_still_open(project):
    """The old shape is accepted when saving too, and always comes back as pages."""
    o = project.owner
    form_id = _form(o, project)
    r = o.post(f"/projects/{project.id}/dashboards", json={"name": "Old", "config": {"form_id": form_id, "widgets": [{**W, "width": 3}]}})
    assert r.status_code == 201
    page = r.json()["config"]["pages"][0]
    assert page["title"] == "Overview" and page["form_id"] == form_id and page["widgets"][0]["wide"] is True


def test_strangers_cannot_see_them_and_forms_must_belong_to_the_project(project, actor):
    o = project.owner
    d = o.post(f"/projects/{project.id}/dashboards", json={"name": "Private"}).json()
    stranger = actor("Stranger")
    assert stranger.get(f"/dashboards/{d['id']}").status_code == 404
    assert stranger.get(f"/projects/{project.id}/dashboards").status_code == 404
    other_form = "00000000-0000-0000-0000-000000000000"
    r = o.post(f"/projects/{project.id}/dashboards", json={"name": "Bad", "config": {"pages": [{**PAGE, "form_id": other_form}]}})
    assert r.status_code == 422
    # a form slipped into a single chart is checked too, not just the page's own form
    r = o.post(f"/projects/{project.id}/dashboards", json={"name": "Bad", "config": {"pages": [{**PAGE, "widgets": [{**W, "form_id": other_form}]}]}})
    assert r.status_code == 422
