"""Shared maps: joining, roles, authorship, review, the contributors portal, campaign windows, and publishing the
approved features to the Data hub."""
import uuid
from datetime import datetime, timedelta, timezone

from conftest import pt


def new_map(owner, name="Mapathon", **patch):
    m = owner.post("/maps", json={"name": name}).json()
    if patch:
        r = owner.patch(f"/maps/{m['id']}", json=patch)
        assert r.status_code == 200, r.text
        m = r.json()
    return m


def join(owner, who, m):
    code = owner.patch(f"/maps/{m['id']}", json={"join_open": True}).json()["join_code"]
    assert code
    r = who.post(f"/join/{code}")
    assert r.status_code == 200, r.text
    return r.json()


def draw(who, m, x=3.0, props=None, geometry=None):
    fid = str(uuid.uuid4())
    r = who.post(f"/maps/{m['id']}/features", json={"id": fid, "geometry": geometry or pt(x, 6.0), "properties": props or {}})
    assert r.status_code == 201, r.text
    return r.json()


def area(x=3.0):
    return {"type": "Polygon", "coordinates": [[[x, 6], [x + 0.01, 6], [x + 0.01, 6.01], [x, 6]]]}


def test_joining_by_link_and_roles(actor):
    owner, ana, outsider = actor("Owner"), actor("Ana"), actor("Outsider")
    m = new_map(owner)
    assert m["role"] == "owner" and m["join_code"] is None and m["member_count"] == 1
    assert outsider.get(f"/maps/{m['id']}").status_code == 404                  # not a member: the map does not exist for you

    code = owner.patch(f"/maps/{m['id']}", json={"join_open": True}).json()["join_code"]
    preview = ana.get(f"/join/{code}").json()
    assert preview["name"] == "Mapathon" and preview["owner_name"] == "Owner" and preview["already_member"] is False
    joined = ana.post(f"/join/{code}").json()
    assert joined["role"] == "contributor" and joined["join_code"] is None       # only the owner sees the code
    assert ana.post(f"/join/{code}").status_code == 200                          # joining twice is harmless
    assert owner.get(f"/maps/{m['id']}").json()["member_count"] == 2
    assert [x["id"] for x in ana.get("/maps").json()] == [m["id"]]

    members = owner.get(f"/maps/{m['id']}/members").json()
    assert [x["role"] for x in members] == ["owner", "contributor"] and members[1]["email"] == ana.email
    assert ana.get(f"/maps/{m['id']}/members").json()[1]["email"] is None        # emails are for the owner only

    assert ana.patch(f"/maps/{m['id']}", json={"name": "Mine now"}).status_code == 403
    assert ana.delete(f"/maps/{m['id']}").status_code == 403
    assert owner.patch(f"/maps/{m['id']}", json={"join_open": False}).json()["join_code"] is None
    assert outsider.post(f"/join/{code}").status_code == 404                     # closed link

    assert owner.patch(f"/maps/{m['id']}/members/{ana.id}", json={"role": "reviewer"}).json()["role"] == "reviewer"
    assert ana.delete(f"/maps/{m['id']}/members/{ana.id}").status_code == 204    # leaving
    assert ana.get(f"/maps/{m['id']}").status_code == 404


def test_authorship_review_and_locks(actor):
    owner, ana, bob = actor("Owner"), actor("Ana"), actor("Bob")
    m = new_map(owner)
    join(owner, ana, m)
    join(owner, bob, m)

    mine = draw(owner, m)
    assert mine["status"] == "approved" and mine["author"] == "Owner"            # the owner's own work needs no review
    f = draw(ana, m, props={"building": "yes"})
    assert f["status"] == "submitted" and f["author"] == "Ana" and f["created_by"] == ana.id
    assert {x["id"] for x in bob.get(f"/maps/{m['id']}/features").json()} == {mine["id"], f["id"]}   # everyone sees the map
    assert [x["id"] for x in owner.get(f"/maps/{m['id']}/features", params={"author": ana.id}).json()] == [f["id"]]

    # contributors change only their own features
    assert bob.patch(f"/maps/{m['id']}/features/{f['id']}", json={"properties": {"x": 1}}).status_code == 403
    assert bob.delete(f"/maps/{m['id']}/features/{f['id']}").status_code == 403
    assert ana.patch(f"/maps/{m['id']}/features/{mine['id']}", json={"properties": {"x": 1}}).status_code == 403
    assert ana.patch(f"/maps/{m['id']}/features/{f['id']}", json={"properties": {"building": "house"}}).status_code == 200

    # review: contributors cannot, the owner can; rejected can be fixed and resubmitted
    assert ana.post(f"/maps/{m['id']}/features/review", json={"ids": [f["id"]], "status": "approved"}).status_code == 403
    r = owner.post(f"/maps/{m['id']}/features/review", json={"ids": [f["id"]], "status": "rejected", "note": "Too rough"})
    assert r.json() == {"updated": 1}
    seen = ana.get(f"/maps/{m['id']}/features", params={"status": "rejected"}).json()[0]
    assert seen["review_note"] == "Too rough"
    fixed = ana.patch(f"/maps/{m['id']}/features/{f['id']}", json={"geometry": pt(3.5, 6.0)}).json()
    assert fixed["status"] == "submitted" and fixed["review_note"] == ""
    owner.post(f"/maps/{m['id']}/features/review", json={"ids": [f["id"]], "status": "approved"})

    # approved features are locked for their author
    assert ana.patch(f"/maps/{m['id']}/features/{f['id']}", json={"properties": {"x": 2}}).status_code == 403
    assert ana.delete(f"/maps/{m['id']}/features/{f['id']}").status_code == 403
    # a reviewer can fix anything and the status stays
    assert owner.patch(f"/maps/{m['id']}/features/{f['id']}", json={"properties": {"building": "school"}}).json()["status"] == "approved"
    assert owner.delete(f"/maps/{m['id']}/features/{f['id']}").status_code == 204


def test_campaign_window_and_leaderboard(actor):
    owner, ana, bob = actor("Owner"), actor("Ana"), actor("Bob")
    now = datetime.now(timezone.utc)
    m = new_map(owner, is_campaign=True, competition=True, goal="Map every school",
                starts_at=(now - timedelta(days=1)).isoformat(), ends_at=(now + timedelta(days=1)).isoformat())
    assert m["campaign_status"] == "open" and m["goal"] == "Map every school"
    join(owner, ana, m)
    join(owner, bob, m)
    assert owner.patch(f"/maps/{m['id']}", json={"starts_at": now.isoformat(), "ends_at": (now - timedelta(days=1)).isoformat()}).status_code == 422

    for i in range(3):
        draw(ana, m, 3.0 + i / 10)
    b1 = draw(bob, m, 4.0)
    draw(bob, m, 4.1)
    owner.post(f"/maps/{m['id']}/features/review", json={"ids": [b1["id"]], "status": "rejected"})   # spam does not count
    owner_f = draw(owner, m, 5.0)
    assert ana.patch(f"/maps/{m['id']}/features/{owner_f['id']}", json={"properties": {}}).status_code == 403

    board = ana.get(f"/maps/{m['id']}/contributors").json()
    rows = {r["name"]: r for r in board["contributors"]}
    assert [r["name"] for r in board["contributors"]][0] == "Ana" and rows["Ana"]["rank"] == 1 and rows["Ana"]["added"] == 3
    assert rows["Bob"]["added"] == 1 and rows["Bob"]["rejected"] == 1 and rows["Bob"]["pending"] == 1 and rows["Bob"]["rank"] == 2
    assert rows["Owner"]["added"] == 1 and rows["Owner"]["approved"] == 1 and rows["Owner"]["role"] == "owner"
    assert board["totals"]["added"] == 5 and board["totals"]["rejected"] == 1 and sum(d["count"] for d in board["daily"]) == 7
    acts = owner.get(f"/maps/{m['id']}/activity").json()
    assert len(acts) == 7 and {a["name"] for a in acts} == {"Ana", "Bob", "Owner"}

    # the campaign ends: contributors are locked out, the owner is not
    owner.patch(f"/maps/{m['id']}", json={"starts_at": (now - timedelta(days=3)).isoformat(), "ends_at": (now - timedelta(days=1)).isoformat()})
    assert owner.get(f"/maps/{m['id']}").json()["campaign_status"] == "ended"
    r = ana.post(f"/maps/{m['id']}/features", json={"geometry": pt()})
    assert r.status_code == 409 and r.json()["code"] == "campaign_closed"
    assert owner.post(f"/maps/{m['id']}/features", json={"geometry": pt()}).status_code == 201
    code = owner.patch(f"/maps/{m['id']}", json={"join_open": True}).json()["join_code"]
    assert actor("Late").post(f"/join/{code}").status_code == 409
    # features drawn before the window opened do not count
    owner.patch(f"/maps/{m['id']}", json={"starts_at": (now + timedelta(days=5)).isoformat(), "ends_at": None})
    assert owner.get(f"/maps/{m['id']}/contributors").json()["totals"]["added"] == 0


def test_publish_only_approved_features_to_the_hub(actor, client):
    owner, ana = actor("Owner"), actor("Ana")
    m = new_map(owner)
    join(owner, ana, m)
    ok1 = draw(ana, m, 3.0, {"Building": "yes", "addr:street": "Main St"}, area(3.0))
    ok2 = draw(ana, m, 3.1, {"building": "yes"}, area(3.1))
    waiting = draw(ana, m, 3.2, {"building": "yes"}, area(3.2))
    draw(ana, m, 3.3, {"name": "a well"})                                         # a point: a separate dataset
    owner.post(f"/maps/{m['id']}/features/review", json={"ids": [ok1["id"], ok2["id"]], "status": "approved"})

    body = {"slug": f"buildings-{uuid.uuid4().hex[:6]}", "title": "Buildings", "description": "Mapathon buildings",
            "license": "ODbL-1.0", "tags": ["Buildings"], "visibility": "public", "geometry_type": "area"}
    assert ana.post(f"/maps/{m['id']}/publish", json=body).status_code == 403    # only the owner publishes
    assert owner.post(f"/maps/{m['id']}/publish", json={**body, "geometry_type": "line"}).status_code == 409   # nothing approved
    r = owner.post(f"/maps/{m['id']}/publish", json=body)
    assert r.status_code == 202, r.text
    assert r.json()["job"]["status"] == "done" and r.json()["job"]["result"]["feature_count"] == 2   # approved areas only
    slug = body["slug"]
    assert owner.post(f"/maps/{m['id']}/publish", json=body).status_code == 409   # slug taken

    d = client.get(f"/datasets/{slug}").json()                                    # anonymous visitors can read it
    assert d["geometry_type"] == "area" and d["feature_count"] == 2 and d["map_id"] is None
    assert d["contributors"] == [{"name": "Ana", "features": 2}]
    field_ids = {f["id"] for f in d["fields"]}
    assert "addr_street" in field_ids and len(field_ids) == 3                      # "Building" and "building" stay separate columns
    feats = client.get(f"/datasets/{slug}/features").json()["features"]
    assert {f["id"] for f in feats} == {ok1["id"], ok2["id"]} and waiting["id"] not in {f["id"] for f in feats}
    assert client.get("/datasets", params={"q": "mapathon"}).json()["items"][0]["slug"] == slug
    assert owner.get(f"/datasets/{slug}").json()["map_id"] == m["id"]            # the owner is told where it came from
    assert [x["slug"] for x in ana.get(f"/maps/{m['id']}/datasets").json()] == [slug]

    # approve the waiting one and publish again as version 2; earlier versions stay as they were
    owner.post(f"/maps/{m['id']}/features/review", json={"ids": [waiting["id"]], "status": "approved"})
    assert ana.post(f"/datasets/{slug}/versions").status_code == 403
    job = owner.post(f"/datasets/{slug}/versions")
    assert job.status_code == 202 and job.json()["result"]["version"] == 2 and job.json()["result"]["feature_count"] == 3
    assert client.get(f"/datasets/{slug}/features", params={"version": 1}).json()["features"].__len__() == 2

    # privacy: a private dataset is visible to map members only; credits can be switched off
    p = owner.post(f"/maps/{m['id']}/publish", json={**body, "slug": f"points-{uuid.uuid4().hex[:6]}", "geometry_type": "point",
                                                      "visibility": "private", "credit_contributors": False})
    assert p.status_code == 202, p.text
    pslug = p.json()["dataset"]["slug"]
    assert client.get(f"/datasets/{pslug}").status_code == 404
    assert actor("Stranger").get(f"/datasets/{pslug}").status_code == 404
    assert ana.get(f"/datasets/{pslug}").status_code == 200
    assert owner.get(f"/datasets/{pslug}").json()["contributors"] == []
    # a Private licence cannot be public
    assert owner.post(f"/maps/{m['id']}/publish", json={**body, "slug": f"x-{uuid.uuid4().hex[:6]}", "license": "Private"}).status_code == 422
