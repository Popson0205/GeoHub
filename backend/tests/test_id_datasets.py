"""Publishing to the Data hub from another GeoEstate app (PolyGIS layers): a dataset like any other in the catalogue,
owned by the person who published it, with later versions sent by the app."""
import uuid

from conftest import Actor
from test_geoestate_id import CALLBACK, apps, code_for  # noqa: F401  (fixtures)
from test_staff_console import boss, outbox, sql  # noqa: F401  (fixtures)


def sq(lon, lat, d=0.0003):
    return {"type": "Polygon", "coordinates": [[[lon, lat], [lon + d, lat], [lon + d, lat + d], [lon, lat + d], [lon, lat]]]}


def _token(apps, person):
    v = apps.new_verifier()
    return {"Authorization": f"Bearer {apps.exchange(code_for(person, v), CALLBACK, v)['access_token']}"}


BODY = {"title": "Bosso Estate parcels", "description": "From the 2026 survey.", "license": "CC-BY-4.0", "tags": ["Minna", "parcels"],
        "visibility": "private", "ref": "layer-123", "label": "Bosso Estate › parcels", "geometry_type": "area",
        "fields": [{"name": "Plot no", "type": "string"}, {"name": "Area (ha)", "type": "number"}, {"name": "use", "type": "string"}],
        "features": [{"geometry": sq(6.53 + i * 0.0004, 9.65), "properties": {"Plot no": f"B{i}", "Area (ha)": 0.09 + i / 100, "use": "Residential",
                                                                          "not a field": "dropped"}} for i in range(4)]}


def test_an_app_publishes_a_layer_and_its_next_version(client, boss, outbox, apps):
    owner = Actor(client, "Amina Publisher")
    boss.put(f"/admin/orgs/{owner.org_id}/products/land", json={"plan": "advanced", "licence_kind": "paid"})
    h = _token(apps, owner)
    r = client.post("/id/data/datasets", headers=h, json=BODY)
    assert r.status_code == 201, r.text
    out = r.json()
    d = out["dataset"]
    assert out["version"] == 1 and out["feature_count"] == 4 and d["geometry_type"] == "area" and d["source"]["ref"] == "layer-123"
    assert d["source"]["name"] == "Land Registry" and d["slug"].startswith("bosso-estate-parcels-")
    slug = d["slug"]

    # in Geohub it is like any dataset: the publisher sees it (private), its fields have safe ids and their names as labels
    got = owner.get(f"/datasets/{slug}").json()
    assert [f["id"] for f in got["fields"]] == ["plot_no", "area_ha", "use"] and got["fields"][1]["label"] == "Area (ha)"
    feats = owner.get(f"/datasets/{slug}/features").json()["features"]
    assert len(feats) == 4 and feats[0]["properties"].keys() == {"plot_no", "area_ha", "use"}
    assert any(x["slug"] == slug for x in owner.get("/datasets").json()["items"])
    stranger = Actor(client, "Nosy Neighbour")
    assert stranger.get(f"/datasets/{slug}").status_code == 404
    assert client.get(f"/datasets/{slug}").status_code == 404

    # the next version comes from the app; Geohub itself won't snapshot it
    r = client.post(f"/id/data/datasets/{slug}/versions", headers=h, json={"geometry_type": "area", "fields": BODY["fields"], "features": BODY["features"][:2]})
    assert r.status_code == 201 and r.json()["version"] == 2 and r.json()["feature_count"] == 2
    assert owner.post(f"/datasets/{slug}/versions").status_code == 409
    assert [v["version"] for v in owner.get(f"/datasets/{slug}").json()["versions"]] == [2, 1]
    mine = client.get("/id/data/datasets", headers=h, params={"ref": "layer-123"}).json()
    assert [x["slug"] for x in mine] == [slug] and mine[0]["latest_version"] == 2

    # made public, anyone finds it; someone else's app token can't add versions
    assert owner.patch(f"/datasets/{slug}", json={"visibility": "public"}).status_code == 200
    assert client.get(f"/datasets/{slug}").status_code == 200
    boss.put(f"/admin/orgs/{stranger.org_id}/products/land", json={"plan": "standard", "licence_kind": "demo"})
    h2 = _token(apps, stranger)
    assert client.post(f"/id/data/datasets/{slug}/versions", headers=h2, json={"geometry_type": "area", "features": BODY["features"][:1]}).status_code == 404
    assert client.get("/id/data/datasets", headers=h2).json() == []


def test_what_an_app_may_publish(client, boss, outbox, apps):
    owner = Actor(client, "Careful Publisher")
    boss.put(f"/admin/orgs/{owner.org_id}/products/land", json={"plan": "advanced", "licence_kind": "paid"})
    h = _token(apps, owner)
    r = client.post("/id/data/datasets", headers=h, json={**BODY, "geometry_type": "point"})
    assert r.status_code == 422 and "not points" in r.json()["detail"]
    r = client.post("/id/data/datasets", headers=h, json={**BODY, "license": "Private", "visibility": "public"})
    assert r.status_code == 422
    r = client.post("/id/data/datasets", headers=h, json={**BODY, "features": [{"geometry": {"type": "Polygon", "coordinates": [[[1, 2]]]}}]})
    assert r.status_code == 422
    slug = f"bosso-{uuid.uuid4().hex[:8]}"
    r = client.post("/id/data/datasets", headers=h, json={**BODY, "slug": slug})
    assert r.status_code == 201 and r.json()["dataset"]["slug"] == slug
    assert client.post("/id/data/datasets", headers=h, json={**BODY, "slug": slug}).status_code == 409
    assert client.post("/id/data/datasets", headers=owner.h, json=BODY).status_code == 401     # a Geohub session is not an app's token
