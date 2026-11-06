"""Location quality recorded by the collector (elevation, accuracy) is accepted, checked, and nothing else slips through."""
from app.services.forms import SYSTEM_IDS, check_properties

FIELDS = [{"id": "name", "type": "text", "label": "Name"}]


def test_device_values_are_accepted_with_a_form_answer():
    props = {"name": "Well", "gps_elev_m": 312.4, "gps_hacc_m": 4.2, "gps_vacc_m": 9.0, "gps_src": "gps"}
    assert check_properties(FIELDS, props) == {}


def test_map_placed_points_say_so():
    assert check_properties(FIELDS, {"name": "Well", "gps_src": "map"}) == {}


def test_bad_device_values_are_rejected():
    errs = check_properties(FIELDS, {"name": "Well", "gps_elev_m": "high", "gps_hacc_m": -1, "gps_src": "guess"})
    assert set(errs) == {"gps_elev_m", "gps_hacc_m", "gps_src"}
    assert check_properties(FIELDS, {"name": "W", "gps_elev_m": 99999})["gps_elev_m"]


def test_other_unknown_keys_are_still_rejected():
    assert "mystery" in check_properties(FIELDS, {"name": "Well", "mystery": 1})


def test_keys_fit_a_shapefile():
    assert all(len(k) <= 10 for k in SYSTEM_IDS)


def test_an_area_plotted_from_its_survey_plan_keeps_the_plan():
    import json
    plan = {"v": 1, "grid": 26332, "method": "traverse", "start": [331600, 993000], "legs": [[90, 0, 0, 30], [180, 0, 0, 20], [270, 0, 0, 30], [0, 0, 0, 20]],
            "ratio": None, "misclosure_m": 0, "area_m2": 600, "perimeter_m": 100}
    assert check_properties(FIELDS, {"name": "Plot 1", "gps_src": "plan", "plan_json": json.dumps(plan)}) == {}
    assert "plan_json" in check_properties(FIELDS, {"name": "P", "plan_json": "not json"})
    assert "plan_json" in check_properties(FIELDS, {"name": "P", "plan_json": json.dumps({**plan, "grid": 4326})})
    assert "plan_json" in check_properties(FIELDS, {"name": "P", "plan_json": json.dumps({**plan, "legs": None})})
