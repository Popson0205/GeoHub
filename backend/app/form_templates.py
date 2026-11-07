"""Ready-made forms. Start a form from one and every question is already there, with ids the other GeoEstate apps know:
Land Registry connects a form made from "land_enumeration" without asking which question holds what. The form can
still be changed in the builder like any other (new questions are fine; keep the template's ids to keep the link)."""
from copy import deepcopy

from .errors import Problem

LAND_USES = ["Residential", "Commercial", "Mixed use", "Industrial", "Agricultural", "Institutional", "Recreational", "Vacant"]
OCCUPANT_KINDS = ["Person", "Company", "Community or family", "Government", "Trustees"]
FARM_CROPS = ["Maize", "Rice", "Cassava", "Yam", "Sorghum", "Millet", "Soybean", "Groundnut", "Cowpea", "Sesame", "Cocoa",
              "Oil palm", "Cashew", "Plantain or banana", "Tomato", "Pepper", "Leafy vegetables", "Other"]
SCOUT_CAUSES = ["Pests", "Disease", "Weeds", "Waterlogging", "Drought or water stress", "Nutrient deficiency", "Poor emergence or gaps",
                "Lodging", "Animals or grazing", "Fire", "Already harvested", "Other", "Nothing wrong found"]
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
    "farm_enumeration": {
        "name": "Farm enumeration",
        "product": "farm",
        "description": "Walk each farm's boundary and record the farmer, the crop and how the land is farmed. Connects to "
                       "FarmScan as it is: every farm is added for satellite monitoring, with its farmer's details.",
        "geometry_type": "area",
        "fields": [
            {"id": "farmer", "label": "The farmer", "type": "group", "appearance": "section", "children": [
                {"id": "farmer_name", "label": "Farmer's full name", "type": "text", "required": True},
                {"id": "farmer_phone", "label": "Phone number", "type": "text", "placeholder": "e.g. 0803 123 4567"},
                {"id": "farmer_gender", "label": "Gender", "type": "choice", "choices": ["Female", "Male"], "appearance": "buttons"},
                {"id": "farmer_group", "label": "Cooperative or farmer group", "type": "text"},
                {"id": "farmer_nin", "label": "NIN", "type": "text", "pattern": r"^\d{11}$", "pattern_message": "A NIN has 11 digits."},
            ]},
            {"id": "farm", "label": "The farm", "type": "group", "appearance": "section", "children": [
                {"id": "farm_name", "label": "Name of the farm", "type": "text", "placeholder": "e.g. Behind the river",
                 "hint": "How the farmer calls it, to tell their farms apart."},
                {"id": "community", "label": "Community or village", "type": "text", "required": True},
                {"id": "lga", "label": "LGA", "type": "text"},
                {"id": "state", "label": "State", "type": "text"},
                {"id": "crops", "label": "Crops on the farm this season", "type": "multi_choice", "required": True,
                 "choices": FARM_CROPS},
                {"id": "planting_date", "label": "Planting date", "type": "date",
                 "hint": "Of the main crop this season, if it is planted."},
                {"id": "declared_ha", "label": "Size the farmer gives", "type": "number", "unit": "ha", "min": 0, "max": 100000,
                 "hint": "FarmScan measures the walked boundary; this is to compare."},
                {"id": "tenure", "label": "How the land is farmed", "type": "choice",
                 "choices": ["Owned", "Family land", "Rented or leased", "Sharecropping", "Community land", "Other"]},
                {"id": "water", "label": "Water", "type": "choice", "choices": ["Rainfed", "Irrigated", "Both"], "default": "Rainfed",
                 "appearance": "buttons"},
            ]},
            {"id": "evidence", "label": "Evidence", "type": "group", "appearance": "section", "children": [
                {"id": "photos", "label": "Photos of the farm", "type": "photo", "max_items": 4},
                {"id": "remarks", "label": "Remarks", "type": "text", "appearance": "multiline"},
            ]},
        ],
    },
    "farm_scouting": {
        "name": "Farm scouting",
        "product": "farm",
        "description": "What a scout finds at a problem area FarmScan saw from the satellite. FarmScan sends each task as a "
                       "link that opens this form filled in; the scout records the cause, and FarmScan reads it back.",
        "geometry_type": "point",
        "fields": [
            {"id": "task", "label": "The task", "type": "group", "appearance": "section", "children": [
                {"id": "farm", "label": "Farm", "type": "text", "readonly": True},
                {"id": "task_ref", "label": "Task", "type": "text", "readonly": True, "hint": "Filled in by FarmScan."},
                {"id": "seen", "label": "What FarmScan saw", "type": "text", "appearance": "multiline", "readonly": True},
            ]},
            {"id": "findings", "label": "What you found", "type": "group", "appearance": "section", "children": [
                {"id": "visited", "label": "Did you reach the place?", "type": "choice", "required": True,
                 "choices": ["Yes", "Could not reach it"], "appearance": "buttons"},
                {"id": "causes", "label": "What is wrong there", "type": "multi_choice", "visible": when("visited", "Yes"),
                 "required_if": when("visited", "Yes"), "choices": SCOUT_CAUSES},
                {"id": "severity", "label": "How bad", "type": "choice", "visible": when("visited", "Yes"),
                 "choices": ["Low", "Moderate", "High"], "appearance": "buttons"},
                {"id": "affected_pct", "label": "Share of the patch affected", "type": "number", "unit": "%", "min": 0, "max": 100,
                 "integer": True, "visible": when("visited", "Yes")},
                {"id": "photos", "label": "Photos", "type": "photo", "max_items": 4},
                {"id": "notes", "label": "Notes and what to do", "type": "text", "appearance": "multiline"},
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
