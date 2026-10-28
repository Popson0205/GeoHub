"""The form field model: design checks, answer checks, visibility, calculations. Pure logic, no database."""
import re
from pathlib import Path

import pytest

from app.services.forms import (TYPE_SPECS, check_field_defs, check_properties, column_fields, eval_calc, eval_condition,
                                non_column_ids, resolve, top_level_fields)

UID = "6f1c2f0e-5b1a-4a63-9d5b-0a8f6c6b9a11"
FIELDS = [
    {"id": "type", "label": "Type", "type": "choice", "required": True, "choices": ["Clinic", "Hospital"]},
    {"id": "has_power", "label": "Power", "type": "boolean"},
    {"id": "power_source", "label": "Source", "type": "choice", "choices": ["Grid", "Solar"], "required": True,
     "visible": {"field": "has_power", "op": "eq", "value": True}},
    {"id": "w", "label": "W", "type": "number", "min": 0, "max": 100},
    {"id": "h", "label": "H", "type": "number"},
    {"id": "area", "label": "Area", "type": "calculation", "calc": {"fn": "product", "args": [{"field": "w"}, {"field": "h"}]}},
    {"id": "note1", "label": "Note", "type": "note", "text": "Read me"},
    {"id": "site", "label": "Site", "type": "group", "visible": {"field": "type", "op": "eq", "value": "Hospital"},
     "children": [{"id": "beds", "label": "Beds", "type": "number", "integer": True, "required": True}]},
    {"id": "ack", "label": "Agree", "type": "boolean", "must_be_true": True, "required": True},
    {"id": "photos", "label": "Photos", "type": "photo", "max_items": 2},
    {"id": "rooms", "label": "Rooms", "type": "repeat", "min_items": 1, "children": [
        {"id": "room", "label": "Room", "type": "text", "required": True},
        {"id": "kind", "label": "Kind", "type": "choice", "choices": ["Ward", "Office"]},
        {"id": "ward_beds", "label": "Ward beds", "type": "number", "required": True, "visible": {"field": "kind", "op": "eq", "value": "Ward"}},
    ]},
]
GOOD = {"type": "Clinic", "ack": True, "rooms": [{"room": "A"}]}


def test_sample_form_is_a_valid_design():
    assert check_field_defs(FIELDS) == {}


def test_legacy_fields_still_validate():
    legacy = [{"id": "type", "label": "Type", "type": "choice", "required": True, "choices": ["A", "B"]},
              {"id": "n", "label": "N", "type": "number", "required": False, "choices": []},
              {"id": "ph", "label": "P", "type": "photo", "max_items": 3, "choices": []},
              {"id": "s", "label": "S", "type": "multi_choice", "choices": ["x"], "max_items": 1}]
    assert check_field_defs(legacy) == {}
    assert check_properties(legacy, {"type": "A", "s": ["x"]}) == {}
    assert check_properties(legacy, {}) == {"type": ["required"]}


def test_design_problems_are_reported_by_path():
    bad = check_field_defs([
        {"id": "a", "label": "A", "type": "choice"},
        {"id": "a", "label": "dup", "type": "text"},
        {"id": "wkt", "label": "reserved", "type": "text"},
        {"id": "x", "label": "X", "type": "number", "min_length": 3},
        {"id": "g", "label": "G", "type": "group", "children": [{"id": "inner", "label": "I", "type": "text", "visible": {"field": "nope", "op": "filled"}}]},
        {"id": "r", "label": "R", "type": "repeat", "children": [{"id": "r2", "label": "R2", "type": "repeat", "children": []}]},
    ])
    assert set(bad) >= {"fields.0", "fields.1", "fields.2", "fields.3", "fields.4.children.0", "fields.5.children.0"}


def test_calculation_cycle_and_bad_rules_are_rejected():
    cyc = check_field_defs([
        {"id": "c1", "label": "1", "type": "calculation", "calc": {"fn": "sum", "args": [{"field": "c2"}]}},
        {"id": "c2", "label": "2", "type": "calculation", "calc": {"fn": "sum", "args": [{"field": "c1"}]}}])
    assert "fields" in cyc
    assert check_field_defs([{"id": "n", "label": "N", "type": "note", "text": "x", "visible": {"field": "n", "op": "boom"}}])
    assert check_field_defs([{"id": "t", "label": "T", "type": "text", "pattern": "(a+)+$"}])      # catastrophic backtracking
    assert check_field_defs([{"id": "t", "label": "T", "type": "text", "pattern": "["}])
    assert check_field_defs([{"id": "d", "label": "D", "type": "date", "default": "$today"}]) == {}
    assert check_field_defs([{"id": "n", "label": "N", "type": "number", "default": "x"}])
    deep = {"id": "g0", "label": "g", "type": "group", "children": []}
    cur = deep
    for i in range(1, 5):
        nxt = {"id": f"g{i}", "label": "g", "type": "group", "children": []}
        cur["children"].append(nxt)
        cur = nxt
    assert check_field_defs([deep])


def test_good_answers_pass_and_hidden_fields_are_not_required():
    assert check_properties(FIELDS, GOOD) == {}
    assert check_properties(FIELDS, {**GOOD, "power_source": "Grid"}) == {}        # hidden answer is ignored, not an error


def test_required_inside_visible_group_and_acknowledgement():
    e = check_properties(FIELDS, {**GOOD, "type": "Hospital"})
    assert e == {"beds": ["required"]}
    assert "ack" in check_properties(FIELDS, {**GOOD, "ack": False})
    assert check_properties(FIELDS, {k: v for k, v in GOOD.items() if k != "ack"}) == {"ack": ["required"]}


def test_repeat_rows_are_keyed_and_validated():
    e = check_properties(FIELDS, {**GOOD, "rooms": [{"room": "A", "kind": "Ward"}, {"kind": "Office", "bogus": 1}]})
    assert set(e) == {"rooms.0.ward_beds", "rooms.1.room", "rooms.1.bogus"}


def test_repeat_min_items_and_draft_mode():
    no_rooms = {k: v for k, v in GOOD.items() if k != "rooms"}
    assert check_properties(FIELDS, no_rooms) == {"rooms": ["at least 1 entries"]}
    assert check_properties(FIELDS, no_rooms, enforce_required=False) == {}


def test_value_rules():
    assert "w" in check_properties(FIELDS, {**GOOD, "w": 500})
    assert "photos" in check_properties(FIELDS, {**GOOD, "photos": [UID, UID, UID]})
    assert "photos" in check_properties(FIELDS, {**GOOD, "photos": ["nope"]})
    assert "stray" in check_properties(FIELDS, {**GOOD, "stray": 1})
    assert "note1" in check_properties(FIELDS, {**GOOD, "note1": "x"})                # notes store nothing
    other = [{"id": "d", "label": "D", "type": "date", "min": "2026-01-01"}, {"id": "t", "label": "T", "type": "time"},
             {"id": "k", "label": "K", "type": "ranking", "choices": ["a", "b"]}, {"id": "b", "label": "B", "type": "barcode", "pattern": r"^\d{3}$"}]
    assert check_properties(other, {"d": "2026-02-01", "t": "14:30", "k": ["b", "a"], "b": "123"}) == {}
    assert set(check_properties(other, {"d": "2025-02-01", "t": "25:00", "k": ["a"], "b": "12"})) == {"d", "t", "k", "b"}


def test_resolve_fills_calculations_and_hides():
    values, hidden, required = resolve(FIELDS, {"type": "Hospital", "has_power": True, "w": 3, "h": 4})
    assert values["area"] == 12 and "power_source" in required and "site" not in hidden
    _, hidden, _ = resolve(FIELDS, {"type": "Clinic"})
    assert {"power_source", "site", "beds"} <= hidden


def test_conditions_and_calcs():
    g = lambda m: (lambda k: m.get(k))  # noqa: E731
    assert eval_condition({"all": [{"field": "a", "op": "gt", "value": 2}, {"not": {"field": "b", "op": "filled"}}]}, g({"a": 5}))
    assert eval_condition({"field": "s", "op": "contains", "value": ["x"]}, g({"s": ["x", "y"]}))
    assert eval_condition({"field": "d", "op": "lt", "value": "2026-02-01"}, g({"d": "2026-01-15"}))
    assert eval_condition({"field": "n", "op": "eq", "value": 3}, g({"n": 3.0}))
    assert eval_calc({"fn": "ratio", "args": [{"field": "a"}, {"const": 0}]}, g({"a": 4})) is None
    assert eval_calc({"fn": "sum", "args": [{"const": 0.1}, {"const": 0.2}]}, g({})) == 0.3
    assert eval_calc({"fn": "concat", "args": [{"field": "a"}, {"field": "b"}], "sep": "-"}, g({"a": "x"})) == "x"


def test_publishing_helpers_flatten_groups_and_drop_media_and_repeats():
    assert [f["id"] for f in top_level_fields(FIELDS)][:8] == ["type", "has_power", "power_source", "w", "h", "area", "note1", "beds"]
    assert [f["id"] for f in column_fields(FIELDS)] == ["type", "has_power", "power_source", "w", "h", "area", "beds", "ack"]
    assert set(non_column_ids(FIELDS)) == {"note1", "photos", "rooms"}


def test_type_table_matches_the_frontend():
    ts = Path(__file__).resolve().parents[2] / "frontend/src/lib/fieldSpec.ts"
    if not ts.exists():
        pytest.skip("frontend sources not present")
    src = ts.read_text()
    rows = re.findall(r"^  (\w+):\s+\{ label: \"[^\"]+\", category: \"\w+\", stores: \"(\w+)\", answers: (true|false), appearances: \[([^\]]*)\]", src, re.M)
    assert {r[0] for r in rows} == set(TYPE_SPECS)
    for name, stores, answers, apps in rows:
        assert TYPE_SPECS[name]["stores"] == stores, name
        assert TYPE_SPECS[name]["answers"] == (answers == "true"), name
        assert TYPE_SPECS[name]["appearances"] == re.findall(r'"(\w+)"', apps), name


def test_generated_ids_are_made_once_and_kept():
    fields = [{"id": "rid", "label": "ID", "type": "calculation", "calc": {"fn": "short_id", "prefix": "WP-"}},
              {"id": "u", "label": "U", "type": "calculation", "calc": {"fn": "uuid"}}]
    assert check_field_defs(fields) == {}
    values, _, _ = resolve(fields, {})
    assert re.fullmatch(r"WP-[A-HJKMNP-Z2-9]{8}", values["rid"]) and len(values["u"]) == 36
    again, _, _ = resolve(fields, dict(values))
    assert again["rid"] == values["rid"] and again["u"] == values["u"]
    assert eval_calc({"fn": "short_id"}, lambda i: None) != eval_calc({"fn": "short_id"}, lambda i: None)


def test_generated_id_rules_are_checked():
    bad = check_field_defs([{"id": "a", "label": "A", "type": "calculation", "calc": {"fn": "short_id", "prefix": "no spaces!"}}])
    assert "a" in bad or bad
    bad2 = check_field_defs([{"id": "a", "label": "A", "type": "calculation", "calc": {"fn": "uuid", "prefix": "X"}}])
    assert bad2
    bad3 = check_field_defs([{"id": "a", "label": "A", "type": "calculation", "calc": {"fn": "uuid", "args": [{"const": 1}]}}])
    assert bad3
