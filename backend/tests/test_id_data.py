import uuid


from conftest import Actor
from test_geoestate_id import CALLBACK, apps, code_for  # noqa: F401  (fixtures)
from test_staff_console import boss, outbox, sql  # noqa: F401  (fixtures)

PLOT_FIELDS = [
    {"id": "plot_no", "label": "Plot number", "type": "text", "required": True},
    {"id": "occupant", "label": "Occupant's name", "type": "text"},
    {"id": "use", "label": "Land use", "type": "choice", "choices": ["Residential", "Commercial", "Farm"]},
    {"id": "intro", "label": "Read this to the occupant", "type": "note", "text": "Ask for the occupant's papers."},
]


def square(lon, lat, d=0.0003):
    return {"type": "Polygon", "coordinates": [[[lon, lat], [lon + d, lat], [lon + d, lat + d], [lon, lat + d], [lon, lat]]]}


def test_apps_read_field_data_as_the_person(client, boss, outbox, apps):
    owner = Actor(client, "Hauwa Bureau")
    boss.put(f"/admin/orgs/{owner.org_id}/products/land", json={"plan": "advanced", "licence_kind": "paid"})
    r = owner.post("/projects", json={"name": "Kabusa enumeration"})
    assert r.status_code == 201, r.text
    pid = r.json()["id"]
    form = owner.post(f"/projects/{pid}/forms", json={"name": "Plots", "geometry_type": "area", "fields": PLOT_FIELDS}).json()
    assert owner.post(f"/forms/{form['id']}/publish").status_code == 200
    ids = []
    for i in range(3):
        fid = str(uuid.uuid4())
        r = owner.post(f"/projects/{pid}/features", json={"id": fid, "form_id": form["id"], "geometry": square(7.45 + i * 0.0003, 8.98),
                                                          "properties": {"plot_no": f"P{i + 1}", "occupant": f"Person {i + 1}", "use": "Residential"}})
        assert r.status_code == 201, r.text
        ids.append(fid)
    owner.post(f"/features/{ids[0]}/review", json={"decision": "approved"})
    owner.post(f"/features/{ids[2]}/review", json={"decision": "approved"})
    other = owner.post("/projects", json={"name": "Private"}).json()["id"]

    v = apps.new_verifier()
    at = apps.exchange(code_for(owner, v), CALLBACK, v)["access_token"]
    h = {"Authorization": f"Bearer {at}"}
    projects = client.get("/id/data/projects", headers=h).json()
    p = next(x for x in projects if x["id"] == pid)
    assert {x["id"] for x in projects} >= {pid, other}
    f = p["forms"][0]
    assert f["name"] == "Plots" and f["geometry_type"] == "area" and f["features"] == 3 and f["approved"] == 2
    assert [x["id"] for x in f["fields"]] == ["plot_no", "occupant", "use"] and f["fields"][2]["choices"][0] == "Residential"

    page = client.get(f"/id/data/forms/{form['id']}/features", headers=h, params={"status": "approved", "shape": "area", "limit": 1}).json()
    assert [x["id"] for x in page["features"]] == [ids[0]] and page["next"]
    rest = client.get(f"/id/data/forms/{form['id']}/features", headers=h, params={"status": "approved", "after": page["next"]}).json()
    assert [x["id"] for x in rest["features"]] == [ids[2]] and rest["next"] is None
    one = rest["features"][0]
    assert one["geometry"]["type"] == "Polygon" and one["properties"]["plot_no"] == "P3" and one["created_by_name"] == "Hauwa Bureau"
    assert client.get(f"/id/data/features/{ids[1]}", headers=h).json()["status"] == "submitted"
    assert client.get(f"/id/data/forms/{form['id']}/features", headers=h, params={"shape": "point"}).json()["features"] == []

    # only what the person could open in Geohub
    stranger = Actor(client, "Someone Else")
    boss.put(f"/admin/orgs/{stranger.org_id}/products/land", json={"plan": "standard", "licence_kind": "demo"})
    v2 = apps.new_verifier()
    h2 = {"Authorization": f"Bearer {apps.exchange(code_for(stranger, v2), CALLBACK, v2)['access_token']}"}
    assert client.get(f"/id/data/forms/{form['id']}/features", headers=h2).status_code == 404
    assert client.get(f"/id/data/features/{ids[0]}", headers=h2).status_code == 404
    assert all(x["id"] != pid for x in client.get("/id/data/projects", headers=h2).json())
    # a Geohub session token or no token is not enough
    assert client.get("/id/data/projects", headers=owner.h).status_code == 401
    assert client.get("/id/data/projects").status_code == 401


def test_form_from_the_land_template(client, boss, outbox, apps):
    owner = Actor(client, "Template User")
    boss.put(f"/admin/orgs/{owner.org_id}/products/land", json={"plan": "standard", "licence_kind": "demo"})
    ts = owner.get("/form-templates").json()
    land = next(t for t in ts if t["id"] == "land_enumeration")
    assert land["product"] == "land" and land["geometry_type"] == "area" and land["questions"] >= 15
    pid = owner.post("/projects", json={"name": "Bwari plots"}).json()["id"]
    r = owner.post(f"/projects/{pid}/forms", json={"name": "Bwari plot enumeration", "template": "land_enumeration"})
    assert r.status_code == 201, r.text
    f = r.json()
    assert f["template"] == "land_enumeration" and f["geometry_type"] == "area" and f["name"] == "Bwari plot enumeration"
    assert owner.post(f"/forms/{f['id']}/publish").status_code == 200
    assert owner.post(f"/projects/{pid}/forms", json={"name": "X", "template": "nope"}).status_code == 422
    assert owner.post(f"/projects/{pid}/forms", json={"name": "X"}).status_code == 422
    # a person's answers are checked like any form's: a NIN has 11 digits, a dispute needs its note
    good = {"plot_no": "12", "land_use": "Residential", "occupant_kind": "Person", "occupant_name": "Aisha Bako", "occupant_nin": "11112222333",
            "dispute": False}
    sq = {"type": "Polygon", "coordinates": [[[7.4, 9.2], [7.4003, 9.2], [7.4003, 9.2003], [7.4, 9.2003], [7.4, 9.2]]]}
    add = lambda props: owner.post(f"/projects/{pid}/features", json={"id": str(uuid.uuid4()), "form_id": f["id"], "geometry": sq, "properties": props})  # noqa: E731
    assert add(good).status_code == 201
    assert add({**good, "occupant_nin": "123"}).status_code == 422
    assert add({**good, "dispute": True}).status_code == 422
    assert add({**good, "dispute": True, "dispute_note": "A cousin claims it"}).status_code == 201
    # apps see which template the form came from
    v = apps.new_verifier()
    h = {"Authorization": f"Bearer {apps.exchange(code_for(owner, v), CALLBACK, v)['access_token']}"}
    form = next(x for p in client.get("/id/data/projects", headers=h).json() if p["id"] == pid for x in p["forms"])
    assert form["template"] == "land_enumeration" and {"plot_no", "occupant_name", "dispute_note"} <= {q["id"] for q in form["fields"]}


def test_forms_from_the_farm_templates(client, boss, outbox):
    owner = Actor(client, "Farm Template User")
    ts = {t["id"]: t for t in owner.get("/form-templates").json()}
    assert ts["farm_enumeration"]["product"] == "farm" and ts["farm_enumeration"]["geometry_type"] == "area"
    assert ts["farm_scouting"]["product"] == "farm" and ts["farm_scouting"]["geometry_type"] == "point"
    pid = owner.post("/projects", json={"name": "Coop farms"}).json()["id"]
    enum = owner.post(f"/projects/{pid}/forms", json={"name": "Farms", "template": "farm_enumeration"}).json()
    scout = owner.post(f"/projects/{pid}/forms", json={"name": "Scouting", "template": "farm_scouting"}).json()
    for f in (enum, scout):
        assert owner.post(f"/forms/{f['id']}/publish").status_code == 200
    sq = {"type": "Polygon", "coordinates": [[[7.4, 9.2], [7.401, 9.2], [7.401, 9.201], [7.4, 9.201], [7.4, 9.2]]]}
    add = lambda form, geom, props: owner.post(f"/projects/{pid}/features", json={"id": str(uuid.uuid4()), "form_id": form["id"], "geometry": geom, "properties": props})  # noqa: E731
    farm = {"farmer_name": "Hauwa Musa", "community": "Kuje", "crops": ["Maize", "Soybean"], "water": "Rainfed"}
    assert add(enum, sq, farm).status_code == 201
    assert add(enum, sq, {**farm, "crops": []}).status_code == 422                         # crops are required
    pt = {"type": "Point", "coordinates": [7.4005, 9.2005]}
    task = {"farm": "Hauwa's farm", "task_ref": "FS-1", "seen": "NDVI low"}
    assert add(scout, pt, {**task, "visited": "Yes"}).status_code == 422                     # what is wrong, when reached
    assert add(scout, pt, {**task, "visited": "Yes", "causes": ["Weeds"], "severity": "Moderate"}).status_code == 201
    assert add(scout, pt, {**task, "visited": "Could not reach it"}).status_code == 201
