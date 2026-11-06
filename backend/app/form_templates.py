"""Ready-made forms. Start a form from one and every question is already there, with ids the other GeoEstate apps know:
Land Registry connects a form made from "land_enumeration" without asking which question holds what. The form can
still be changed in the builder like any other (new questions are fine; keep the template's ids to keep the link)."""
from copy import deepcopy

from .errors import Problem

LAND_USES = ["Residential", "Commercial", "Mixed use", "Industrial", "Agricultural", "Institutional", "Recreational", "Vacant"]
OCCUPANT_KINDS = ["Person", "Company", "Community or family", "Government", "Trustees"]
when = lambda field, value: {"field": field, "op": "eq", "value": value}  # noqa: E731

TEMPLATES: dict[str, dict] = {
    "land_enumeration": {
        "name": "Plot enumeration",
        "product": "land",
        "description": "Map each plot's boundary and record who occupies it, how they hold it and the papers they have. "
                       "Connects to Land Registry as it is, to register the plots and lodge each occupant's claim.",
        "geometry_type": "area",
        "fields": [
            {"id": "plot", "label": "The plot", "type": "group", "appearance": "section", "children": [
                {"id": "plot_no", "label": "Plot number", "type": "text", "required": True, "placeholder": "e.g. 12 or B/14",
                 "hint": "As on the layout or the beacon, if there is one."},
                {"id": "address", "label": "Address or description", "type": "text", "placeholder": "e.g. 4 Agonbako Street"},
                {"id": "locality", "label": "Locality, village or estate", "type": "text"},
                {"id": "land_use", "label": "Land use", "type": "choice", "required": True, "choices": LAND_USES},
                {"id": "building", "label": "Building on the plot", "type": "choice",
                 "choices": ["No building", "Under construction", "Completed building"]},
            ]},
            {"id": "occupant", "label": "The occupant", "type": "group", "appearance": "section", "children": [
                {"id": "occupant_kind", "label": "The occupant is", "type": "choice", "required": True, "choices": OCCUPANT_KINDS,
                 "default": "Person", "appearance": "buttons"},
                {"id": "occupant_name", "label": "Full name", "type": "text", "required": True,
                 "hint": "Of the person, company, family or community, as they want it on a title."},
                {"id": "occupant_phone", "label": "Phone number", "type": "text", "placeholder": "e.g. 0803 123 4567"},
                {"id": "occupant_nin", "label": "NIN", "type": "text", "pattern": r"^\d{11}$", "pattern_message": "A NIN has 11 digits.",
                 "visible": when("occupant_kind", "Person")},
                {"id": "occupant_rc", "label": "CAC RC number", "type": "text", "visible": when("occupant_kind", "Company")},
            ]},
            {"id": "tenure", "label": "How the land is held", "type": "group", "appearance": "section", "children": [
                {"id": "acquired", "label": "How it was acquired", "type": "choice",
                 "choices": ["Inheritance", "Purchase", "Government allocation", "Customary grant", "Gift", "Other"]},
                {"id": "acquired_year", "label": "Year acquired", "type": "number", "integer": True, "min": 1900, "max": 2100},
                {"id": "documents", "label": "Documents held", "type": "multi_choice",
                 "choices": ["C of O", "Customary right of occupancy", "Letter of allocation", "Survey plan", "Deed of assignment",
                             "Purchase receipt or agreement", "None"]},
                {"id": "dispute", "label": "Is anyone disputing this plot?", "type": "boolean", "default": False},
                {"id": "dispute_note", "label": "Who disputes it, and why", "type": "text", "appearance": "multiline",
                 "visible": when("dispute", True), "required_if": when("dispute", True)},
            ]},
            {"id": "evidence", "label": "Evidence", "type": "group", "appearance": "section", "children": [
                {"id": "photos", "label": "Photos of the plot", "type": "photo", "max_items": 4},
                {"id": "document_photos", "label": "Photos of the documents", "type": "photo", "max_items": 6,
                 "hint": "One photo per page, flat and readable."},
                {"id": "occupant_signature", "label": "Occupant's signature", "type": "signature",
                 "hint": "The occupant confirms the boundary and the answers."},
                {"id": "remarks", "label": "Remarks", "type": "text", "appearance": "multiline"},
            ]},
        ],
    },
}


def listing() -> list[dict]:
    def count(fs):
        return sum(count(f.get("children") or []) if f["type"] == "group" else 1 for f in fs)
    return [{"id": k, "name": t["name"], "product": t["product"], "description": t["description"], "geometry_type": t["geometry_type"],
             "questions": count(t["fields"])} for k, t in TEMPLATES.items()]


def get(template_id: str) -> dict:
    t = TEMPLATES.get(template_id)
    if not t:
        raise Problem(422, f"There is no form template \"{template_id}\".", code="validation", fields={"template": ["unknown"]})
    return deepcopy(t)
