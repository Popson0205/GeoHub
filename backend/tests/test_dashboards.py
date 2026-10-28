"""Dashboards: saved pages of charts. Who may see and change them, and what a layout may contain."""
import uuid

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


def test_a_manual_placement_is_kept_and_none_means_automatic():
    placed = DashboardConfig(pages=[{**PAGE, "widgets": [{**W, "col": 6, "row": 2, "cols": 6, "rows": 4}]}]).pages[0].widgets[0]
    assert (placed.col, placed.row, placed.cols, placed.rows) == (6, 2, 6, 4)
    auto = DashboardConfig(pages=[PAGE]).pages[0].widgets[0]
    assert (auto.col, auto.row, auto.cols, auto.rows) == (None, None, None, None)


@pytest.mark.parametrize("bad", [
    {"col": 0, "row": 0},                                    # a placement needs all four numbers
    {"col": 8, "row": 0, "cols": 6, "rows": 3},              # runs past the 12th column
    {"col": 0, "row": 0, "cols": 0, "rows": 3},              # no width
    {"col": 0, "row": 0, "cols": 4, "rows": 41},             # too tall
    {"col": -1, "row": 0, "cols": 4, "rows": 3},             # off the left edge
])
def test_bad_placements_are_refused(bad):
    with pytest.raises(ValidationError):
        DashboardConfig(pages=[{**PAGE, "widgets": [{**W, **bad}]}])


# ---- the Dashboard app: more elements, a look, a date range, a side column ----
def test_the_new_elements_and_the_side_column_are_kept():
    c = DashboardConfig(pages=[{**PAGE, "widgets": [
        {"id": "g", "type": "gauge", "metric": "sum", "metric_field": "depth", "target": 500, "region": "sidebar"},
        {"id": "l", "type": "list", "title_field": "village", "subtitle_fields": ["type", "depth"], "limit": 10},
        {"id": "d", "type": "details", "columns": ["village"]},
        {"id": "t", "type": "rich_text", "content": "**Read me**"},
        {"id": "e", "type": "embedded", "url": "https://example.com/map"},
    ]}])
    g, lst, _, note, emb = c.pages[0].widgets
    assert g.target == 500 and g.region == "sidebar" and lst.subtitle_fields == ["type", "depth"]
    assert note.content == "**Read me**" and emb.url == "https://example.com/map"
    assert DashboardConfig(pages=[PAGE]).pages[0].widgets[0].region is None      # nothing is in the side column unless put there


def test_an_element_keeps_its_own_font_and_style():
    c = DashboardConfig(pages=[{**PAGE, "widgets": [
        {"id": "k", "type": "kpi", "style": {"font": "serif", "headingSize": 18, "headingWeight": 700, "numberColor": "#aa0000", "radius": 4, "border": "thin"}},
        {"id": "b", "type": "bar"},
    ]}])
    k, b = c.pages[0].widgets
    assert k.style.font == "serif" and k.style.headingSize == 18 and k.style.numberColor == "#aa0000" and k.style.border == "thin"
    assert b.style is None                                                       # an element with no style follows the dashboard's
    assert k.model_dump(exclude_none=True)["style"]["font"] == "serif"


@pytest.mark.parametrize("bad", [{"font": "comic"}, {"headingSize": 99}, {"radius": -1}, {"numberColor": "red"}, {"border": "dashed"},
                                 {"gap": 10}, {"titleSize": 30}, {"evil": 1}])
def test_bad_element_styles_are_refused(bad):
    # Dashboard-only choices (gap, page title size) are not an element's to set, and unknown keys never get stored.
    with pytest.raises(ValidationError):
        DashboardConfig(pages=[{**PAGE, "widgets": [{"id": "k", "type": "kpi", "style": bad}]}])


@pytest.mark.parametrize("url", ["javascript:alert(1)", "http://example.com", "data:text/html,hi", "https://user:pw@example.com", "https://localhost/x", "//example.com"])
def test_only_plain_https_pages_can_be_embedded(url):
    with pytest.raises(ValidationError):
        DashboardConfig(pages=[{**PAGE, "widgets": [{"id": "e", "type": "embedded", "url": url}]}])


@pytest.mark.parametrize("bad", [{"target": 0}, {"target": -5}, {"region": "footer"}, {"content": "x" * 4001}, {"subtitle_fields": ["a"] * 7}])
def test_bad_element_settings_are_refused(bad):
    with pytest.raises(ValidationError):
        DashboardConfig(pages=[{**PAGE, "widgets": [{"id": "g", "type": "gauge", **bad}]}])


def test_a_dashboards_look_and_date_range():
    c = DashboardConfig(pages=[PAGE], theme={"preset": "dark", "overrides": {"accent": "#17634c"}},
                        time_filter={"preset": "custom", "start": "2026-01-01", "end": "2026-02-01"})
    assert c.theme.preset == "dark" and str(c.time_filter.end) == "2026-02-01"
    assert DashboardConfig(pages=[PAGE]).theme is None and DashboardConfig(pages=[PAGE]).time_filter is None
    assert DashboardConfig(pages=[PAGE], time_filter={"preset": "last_30_days"}).time_filter.start is None


@pytest.mark.parametrize("bad", [
    {"theme": {"preset": "dark", "overrides": {"accent": "red"}}},                  # not #rrggbb
    {"theme": {"preset": "dark", "overrides": {"accent": "#12345"}}},
    {"theme": {"preset": "dark", "overrides": {"nope": "#112233"}}},                # not a colour the dashboard has
    {"theme": {"preset": "Dark Mode!"}},
    {"time_filter": {"preset": "custom"}},                                          # a custom range needs both dates
    {"time_filter": {"preset": "custom", "start": "2026-03-01", "end": "2026-02-01"}},
    {"time_filter": {"preset": "last_century"}},
])
def test_bad_looks_and_ranges_are_refused(bad):
    with pytest.raises(ValidationError):
        DashboardConfig(pages=[PAGE], **bad)


def test_look_elements_and_range_survive_saving(project):
    o = project.owner
    cfg = {"theme": {"preset": "ocean", "overrides": {"accent": "#1f6fb2"}}, "time_filter": {"preset": "last_90_days"},
           "pages": [{**PAGE, "widgets": [{"id": "n", "type": "rich_text", "content": "Hello", "region": "sidebar"}]}]}
    d = o.post(f"/projects/{project.id}/dashboards", json={"name": "Look", "config": cfg}).json()
    got = o.get(f"/dashboards/{d['id']}").json()["config"]
    assert got["theme"]["preset"] == "ocean" and got["time_filter"]["preset"] == "last_90_days"
    assert got["pages"][0]["widgets"][0]["region"] == "sidebar"
    bad = o.patch(f"/dashboards/{d['id']}", json={"config": {**cfg, "pages": [{**PAGE, "widgets": [{"id": "e", "type": "embedded", "url": "javascript:alert(1)"}]}]}})
    assert bad.status_code == 422                                                   # the server refuses it too, not just the form


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


# ---- share by link ----
def _record(project, props, decision="approved", geometry=None):
    fid = str(uuid.uuid4())
    r = project.owner.post(f"/projects/{project.id}/features", json={
        "id": fid, "form_id": project.form_id, "geometry": geometry or {"type": "Point", "coordinates": [3.39, 6.52]}, "properties": props})
    assert r.status_code == 201, r.text
    if decision:
        assert project.owner.post(f"/features/{fid}/review", json={"decision": decision}).status_code == 200
    return fid


def _shared_dashboard(project, widgets=None):
    o = project.owner
    widgets = widgets or [{"id": "w1", "type": "bar", "field": "type"}]
    d = o.post(f"/projects/{project.id}/dashboards", json={"name": "Public one", "config": {"pages": [
        {"id": "p", "title": "Overview", "form_id": project.form_id, "widgets": widgets}]}}).json()
    link = o.patch(f"/dashboards/{d['id']}/sharing", json={"public": True}).json()
    return d, link["share_token"]


def test_a_dashboard_is_private_until_shared(project):
    o = project.owner
    d = o.post(f"/projects/{project.id}/dashboards", json={"name": "Mine"}).json()
    assert d["shared"] is False
    assert o.get(f"/dashboards/{d['id']}/sharing").json() == {"public": False, "share_token": None}
    assert o.c.get("/public/dashboards/not-a-real-token").status_code == 404


def test_the_public_link_shows_only_approved_records_and_only_the_fields_used(project):
    o = project.owner
    _record(project, {"type": "Clinic", "beds": 5, "services": ["ER"]})
    _record(project, {"type": "Hospital", "beds": 90}, decision=None)                  # still waiting for review
    _record(project, {"type": "Pharmacy", "beds": 2}, decision="rejected")
    d, token = _shared_dashboard(project)
    r = o.c.get(f"/public/dashboards/{token}")                                         # no sign-in
    assert r.status_code == 200, r.text
    body = r.json()
    assert r.headers["cache-control"] == "no-store" and "noindex" in r.headers["x-robots-tag"]
    assert [f["properties"] for f in body["features"]] == [{"type": "Clinic"}]       # approved only; beds and services were not used
    assert [f["id"] for f in body["forms"][0]["fields"]] == ["type"]
    assert body["features"][0]["geometry"] is None                                    # no map on this dashboard: no locations
    assert body["name"] == "Public one" and body["project_name"] == "Health map"
    assert "project_id" not in str(body["features"]) and "created_by" not in str(body)


def test_locations_are_sent_only_when_the_dashboard_has_a_map(project):
    _record(project, {"type": "Clinic"})
    _, token = _shared_dashboard(project, [{"id": "m", "type": "map"}])
    f = project.owner.c.get(f"/public/dashboards/{token}").json()["features"][0]
    assert f["geometry"]["coordinates"] == [3.39, 6.52]


def test_photos_are_never_public_even_if_a_table_asks_for_them(project):
    _record(project, {"type": "Clinic", "photos": ["abc"]})
    _, token = _shared_dashboard(project, [{"id": "t", "type": "table", "columns": ["type", "photos"]}])
    body = project.owner.c.get(f"/public/dashboards/{token}").json()
    assert body["features"][0]["properties"] == {"type": "Clinic"}
    assert all(f["type"] != "photo" for f in body["forms"][0]["fields"])


def test_turning_it_off_or_replacing_the_link_kills_the_old_one(project):
    o = project.owner
    d, token = _shared_dashboard(project)
    assert o.c.get(f"/public/dashboards/{token}").status_code == 200
    new = o.patch(f"/dashboards/{d['id']}/sharing", json={"regenerate_link": True}).json()["share_token"]
    assert new != token and o.c.get(f"/public/dashboards/{token}").status_code == 404
    assert o.c.get(f"/public/dashboards/{new}").status_code == 200
    off = o.patch(f"/dashboards/{d['id']}/sharing", json={"public": False}).json()
    assert off == {"public": False, "share_token": None} and o.c.get(f"/public/dashboards/{new}").status_code == 404
    again = o.patch(f"/dashboards/{d['id']}/sharing", json={"public": True}).json()["share_token"]
    assert again not in (token, new)                                                 # an old link never comes back
    assert o.patch(f"/dashboards/{d['id']}/sharing", json={"public": False}).status_code == 200
    assert o.patch(f"/dashboards/{d['id']}/sharing", json={"regenerate_link": True}).status_code == 409


def test_only_administrators_manage_the_link_and_viewers_never_see_it(project, actor):
    o = project.owner
    viewer, collector, stranger = project.add("viewer"), project.add("collector"), actor("Stranger")
    d, token = _shared_dashboard(project)
    for who, status in ((viewer, 403), (collector, 403), (stranger, 404)):
        assert who.get(f"/dashboards/{d['id']}/sharing").status_code == status
        assert who.patch(f"/dashboards/{d['id']}/sharing", json={"public": False}).status_code == status
    assert o.c.get(f"/public/dashboards/{token}").status_code == 200                  # their attempts changed nothing
    seen = viewer.get(f"/dashboards/{d['id']}").json()
    assert seen["shared"] is True and token not in str(seen)                          # viewers can tell it is public, not get the key
    assert token not in str(viewer.get(f"/projects/{project.id}/dashboards").json())


def test_a_link_shows_nothing_from_other_forms_or_projects(project, actor):
    o = project.owner
    _record(project, {"type": "Clinic"})
    other_pid = o.post("/projects", json={"name": "Other"}).json()["id"]
    other = o.post(f"/projects/{other_pid}/forms", json={"name": "Secret", "geometry_type": "point", "fields": [{"id": "type", "label": "Type", "type": "text"}]}).json()
    o.post(f"/forms/{other['id']}/publish")
    fid = str(uuid.uuid4())
    o.post(f"/projects/{other_pid}/features", json={"id": fid, "form_id": other["id"], "geometry": {"type": "Point", "coordinates": [1, 1]}, "properties": {"type": "TOP SECRET"}})
    o.post(f"/features/{fid}/review", json={"decision": "approved"})
    _, token = _shared_dashboard(project)
    text = o.c.get(f"/public/dashboards/{token}").text
    assert "TOP SECRET" not in text and "Secret" not in text and other["id"] not in text


def test_deleting_the_dashboard_ends_the_link(project):
    d, token = _shared_dashboard(project)
    assert project.owner.delete(f"/dashboards/{d['id']}").status_code == 204
    assert project.owner.c.get(f"/public/dashboards/{token}").status_code == 404


def test_dashboard_style_is_validated():
    ok = DashboardConfig(pages=[PAGE], theme={"preset": "dark", "style": {"font": "serif", "textSize": 120, "border": "thin", "gap": 8}})
    assert ok.theme.style.font == "serif" and ok.theme.style.gap == 8
    for bad in ({"font": "comic"}, {"textSize": 300}, {"radius": -1}, {"numberColor": "red"}, {"nope": 1}):
        with pytest.raises(Exception):
            DashboardConfig(pages=[PAGE], theme={"preset": "dark", "style": bad})
