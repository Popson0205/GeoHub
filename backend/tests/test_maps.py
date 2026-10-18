"""Maps workspace: independent of collection projects and forms."""
import uuid

from .conftest import pt


def new_map(owner, name="Survey base"):
    r = owner.post("/maps", json={"name": name})
    assert r.status_code == 201, r.text
    return r.json()["id"]


def new_layer(owner, mid, **kw):
    r = owner.post(f"/maps/{mid}/layers", json={"name": "Buildings", **kw})
    assert r.status_code == 201, r.text
    return r.json()["id"]


def feat(owner, mid, lid, geometry=None, **props):
    fid = str(uuid.uuid4())
    r = owner.post(f"/maps/{mid}/features", json={"id": fid, "layer_id": lid, "geometry": geometry or pt(),
                                                  "properties": props})
    return fid, r


def test_new_map_is_ready_to_draw_with_free_tags(actor):
    """Create a map and draw straight away: no layer setup, no form, no declared fields."""
    o = actor("Owner")
    mid = new_map(o)
    layers = o.get(f"/maps/{mid}/layers").json()
    assert len(layers) == 1 and layers[0]["geometry_type"] == "any" and layers[0]["fields"] == []
    fid, r = feat(o, mid, layers[0]["id"], building="yes", name="Clinic", levels=2, open=True)
    assert r.status_code == 201, r.text
    assert r.json()["properties"] == {"building": "yes", "name": "Clinic", "levels": 2, "open": True}
    for geom in ({"type": "LineString", "coordinates": [[3.0, 6.0], [3.1, 6.1]]},
                 {"type": "Polygon", "coordinates": [[[3.0, 6.0], [3.1, 6.0], [3.1, 6.1], [3.0, 6.0]]]}):
        assert feat(o, mid, layers[0]["id"], geometry=geom, highway="path")[1].status_code == 201
    m = o.get(f"/maps/{mid}").json()
    assert m["role"] == "owner" and m["layer_count"] == 1 and m["feature_count"] == 3
    assert o.get("/projects").json()["items"] == []          # nothing leaked into collection projects


def test_tag_validation(actor):
    o = actor()
    mid = new_map(o)
    lid = o.get(f"/maps/{mid}/layers").json()[0]["id"]
    assert feat(o, mid, lid, **{"": "x"})[1].status_code == 422                  # empty tag name
    assert feat(o, mid, lid, nested={"a": 1})[1].status_code == 422              # values are scalars
    assert feat(o, mid, lid, **{f"k{i}": "v" for i in range(101)})[1].status_code == 422
    assert o.get("/projects").json()["items"] == []          # nothing leaked into collection projects


def test_optional_layer_restrictions(actor):
    """Layers are optional organisation. A layer may restrict its shape and declare typed fields, but need not."""
    o = actor()
    mid = new_map(o)
    lid = new_layer(o, mid, geometry_type="area", fields=[{"id": "floors", "label": "Floors", "type": "number"}])
    _, r = feat(o, mid, lid, geometry=pt())
    assert r.status_code == 422 and r.json()["fields"]["geometry"]
    square = {"type": "Polygon", "coordinates": [[[3.0, 6.0], [3.1, 6.0], [3.1, 6.1], [3.0, 6.0]]]}
    _, r = feat(o, mid, lid, geometry=square, floors="two")
    assert r.status_code == 422 and "floors" in r.json()["fields"]
    _, r = feat(o, mid, lid, geometry=square, floors=2, extra="kept")        # unknown keys are allowed
    assert r.status_code == 201


def test_feature_update_conflict_and_delete(actor):
    o = actor()
    mid = new_map(o)
    lid = new_layer(o, mid)
    fid, _ = feat(o, mid, lid, note="a")
    r = o.patch(f"/map-features/{fid}", json={"base_version": 1, "properties": {"note": "b"}})
    assert r.status_code == 200 and r.json()["version"] == 2
    r = o.patch(f"/map-features/{fid}", json={"base_version": 1, "properties": {"note": "c"}})
    assert r.status_code == 409 and r.json()["server"]["properties"] == {"note": "b"}
    assert o.delete(f"/map-features/{fid}").status_code == 204
    assert o.get(f"/maps/{mid}/features").json()["items"] == []


def test_bbox_and_layer_filters(actor):
    o = actor()
    mid = new_map(o)
    a, b = new_layer(o, mid), new_layer(o, mid, name="Roads")
    feat(o, mid, a, pt(3.0, 6.0)); feat(o, mid, b, pt(8.0, 9.0))
    assert len(o.get(f"/maps/{mid}/features").json()["items"]) == 2
    assert len(o.get(f"/maps/{mid}/features", params={"layer_id": a}).json()["items"]) == 1
    assert len(o.get(f"/maps/{mid}/features", params={"bbox": "7,8,9,10"}).json()["items"]) == 1


def test_roles_and_hidden_existence(actor):
    o, ed, viewer, stranger = actor("O"), actor("E"), actor("V"), actor("S")
    mid = new_map(o)
    lid = new_layer(o, mid)
    assert o.post(f"/maps/{mid}/members", json={"email": ed.email, "role": "editor"}).status_code == 201
    assert o.post(f"/maps/{mid}/members", json={"email": viewer.email, "role": "viewer"}).status_code == 201
    assert stranger.get(f"/maps/{mid}").status_code == 404
    assert viewer.get(f"/maps/{mid}/features").status_code == 200
    assert feat(viewer, mid, lid)[1].status_code == 403
    assert feat(ed, mid, lid)[1].status_code == 201
    assert ed.delete(f"/maps/{mid}").status_code == 403
    assert o.post(f"/maps/{mid}/members", json={"email": "nobody@example.com"}).status_code == 404
    assert o.delete(f"/maps/{mid}").status_code == 204


def test_imagery_source_url_template(actor):
    o = actor()
    mid = new_map(o)
    ok = {"name": "Satellite", "url_template": "https://tiles.example.com/{z}/{x}/{y}.jpg", "max_zoom": 20}
    r = o.post(f"/maps/{mid}/imagery-sources", json=ok)
    assert r.status_code == 201 and r.json()["kind"] == "xyz"
    for bad in ("tiles.example.com/{z}/{x}/{y}", "https://tiles.example.com/tile.png",
                "javascript:alert(1)//{z}/{x}/{y}"):
        r = o.post(f"/maps/{mid}/imagery-sources", json={**ok, "url_template": bad})
        assert r.status_code == 422, bad
    assert o.post(f"/maps/{mid}/imagery-sources", json={**ok, "min_zoom": 12, "max_zoom": 3}).status_code == 422
    assert len(o.get(f"/maps/{mid}/imagery-sources").json()) == 1
    sid = r = o.get(f"/maps/{mid}/imagery-sources").json()[0]["id"]
    assert o.delete(f"/imagery-sources/{sid}").status_code == 204
