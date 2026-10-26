"""What a public dashboard link may show. Pure rules: no database, so these run anywhere."""
import uuid

from app.schemas import DashboardConfig
from app.services.dashboard_share import MEDIA_TYPES, public_fields, shape_public_dashboard, used_fields

F1, F2 = uuid.uuid4(), uuid.uuid4()
FIELDS = [
    {"id": "type", "label": "Type", "type": "choice", "choices": ["Well", "Tap"], "required": True, "hint": "internal", "default": "Well"},
    {"id": "depth", "label": "Depth", "type": "number", "unit": "m"},
    {"id": "village", "label": "Village", "type": "text"},
    {"id": "phone", "label": "Owner phone", "type": "text"},
    {"id": "photo", "label": "Photo", "type": "photo"},
    {"id": "sig", "label": "Signature", "type": "signature"},
    {"id": "sec", "label": "Section", "type": "group", "children": [{"id": "inner", "label": "Inner", "type": "number"}]},
    {"id": "rows", "label": "Rows", "type": "repeat", "children": [{"id": "r1", "label": "R1", "type": "text"}]},
]


def cfg(*widgets, form=F1, **page):
    return DashboardConfig.model_validate({"pages": [{"id": "p", "title": "P", "form_id": str(form) if form else None, "widgets": list(widgets), **page}]})


def rec(props, form=F1, geometry=None):
    return {"id": uuid.uuid4(), "form_id": form, "geometry": geometry or {"type": "Point", "coordinates": [3.4, 6.5]}, "properties": props, "updated_at": "2026-03-01T00:00:00Z"}


def shape(config, features, forms=None):
    forms = forms or [{"id": F1, "name": "Water", "geometry_type": "point", "version": 2, "fields": FIELDS}]
    return shape_public_dashboard(token="t", name="D", project_name="P", config=config, updated_at="2026-03-01T00:00:00Z", forms=forms, features=features, truncated=False)


ALL = {"type": "Well", "depth": 10, "village": "Aba", "phone": "0803", "photo": "media-id", "sig": "media-id2", "inner": 3, "rows": [{"r1": "x"}], "secret_extra": 1}


def test_only_the_fields_a_dashboard_uses_are_sent():
    c = cfg({"id": "w", "type": "bar", "field": "type"}, {"id": "k", "type": "kpi", "metric": "sum", "metric_field": "depth"})
    out = shape(c, [rec(ALL)])
    assert out["features"][0]["properties"] == {"type": "Well", "depth": 10}
    assert [f["id"] for f in out["forms"][0]["fields"]] == ["type", "depth"]
    assert "phone" not in str(out) and "0803" not in str(out)                      # an unused field never leaves the project


def test_field_definitions_are_trimmed_to_what_a_chart_needs():
    f = public_fields(FIELDS, {"type"})[0]
    assert set(f) == {"id", "label", "type", "choices"} and "hint" not in f and "default" not in f and "required" not in f


def test_media_and_repeat_sections_are_never_sent_even_when_asked_for():
    c = cfg({"id": "t", "type": "table", "columns": ["photo", "sig", "rows", "village"]})
    out = shape(c, [rec(ALL)])
    assert out["features"][0]["properties"] == {"village": "Aba"}
    assert not any(f["type"] in MEDIA_TYPES for f in out["forms"][0]["fields"])
    # and a details card with no fields chosen (= everything) still excludes them
    out = shape(cfg({"id": "d", "type": "details"}), [rec(ALL)])
    p = out["features"][0]["properties"]
    assert set(p) == {"type", "depth", "village", "phone", "inner"} and "secret_extra" not in p


def test_groups_are_flattened_and_gps_values_follow_what_is_used():
    out = shape(cfg({"id": "k", "type": "kpi", "metric": "avg", "metric_field": "inner"}), [rec({**ALL, "gps_hacc_m": 4.0, "gps_elev_m": 90})])
    assert out["features"][0]["properties"] == {"inner": 3}
    out = shape(cfg({"id": "k", "type": "kpi", "metric": "avg", "metric_field": "gps_hacc_m"}), [rec({**ALL, "gps_hacc_m": 4.0, "gps_elev_m": 90})])
    assert out["features"][0]["properties"] == {"gps_hacc_m": 4.0}


def test_locations_are_only_sent_for_forms_shown_on_a_map():
    no_map = shape(cfg({"id": "w", "type": "bar", "field": "type"}), [rec(ALL)])
    assert no_map["features"][0]["geometry"] is None
    with_map = shape(cfg({"id": "m", "type": "map"}), [rec(ALL)])
    assert with_map["features"][0]["geometry"]["coordinates"] == [3.4, 6.5]


def test_only_forms_the_dashboard_uses_are_sent():
    other = {"id": F2, "name": "Secret survey", "geometry_type": "point", "version": 1, "fields": FIELDS}
    base = {"id": F1, "name": "Water", "geometry_type": "point", "version": 2, "fields": FIELDS}
    out = shape(cfg({"id": "w", "type": "bar", "field": "type"}), [rec(ALL), rec(ALL, form=F2)], forms=[base, other])
    assert [f["name"] for f in out["forms"]] == ["Water"] and len(out["features"]) == 1
    assert "Secret survey" not in str(out)


def test_an_element_can_draw_on_a_different_form_than_its_page():
    c = cfg({"id": "k", "type": "kpi", "form_id": str(F2)}, form=F1)
    assert set(used_fields(c)) == {F1, F2}


def test_static_elements_pull_in_no_data():
    c = cfg({"id": "n", "type": "rich_text", "content": "hi"}, {"id": "e", "type": "embedded", "url": "https://example.com"}, form=None)
    assert used_fields(c) == {} and shape(c, [rec(ALL)])["features"] == []


def test_the_saved_layout_is_returned_so_the_page_looks_the_same():
    c = cfg({"id": "w", "type": "bar", "field": "type", "title": "By type"})
    out = shape(c, [])
    assert out["config"]["pages"][0]["widgets"][0]["title"] == "By type" and out["name"] == "D" and out["truncated"] is False


def test_a_header_filter_sends_its_field_even_when_no_chart_draws_it():
    c = cfg({"id": "w", "type": "bar", "field": "type"}, filters=["village"])
    out = shape(c, [rec(ALL)])
    assert out["features"][0]["properties"] == {"type": "Well", "village": "Aba"}
    assert "0803" not in str(out)                                                  # only the chosen filter field is added


def test_page_filters_are_limited_and_unique():
    import pytest
    with pytest.raises(ValueError):
        cfg(filters=["a", "a"])
    with pytest.raises(ValueError):
        cfg(filters=[f"f{i}" for i in range(7)])
    assert cfg(filters=["type"]).pages[0].filters == ["type"] and cfg().pages[0].filters == []
