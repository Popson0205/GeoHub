"""GeoEstate's products and what an organization has of each.

Geohub ('hub') is the platform itself: its licence is the organization's own plan, dates and caps. Every other product
(Land Registry, LandCheck, FarmScan, PolyGIS) is licensed separately in org_products, with the same states as Geohub's licence
(demo, active, grace, expired; suspended when the organization is). Each product checks only its own licence.

Plans set default caps and feature switches; an organization's `limits` and `features` change them one by one.
The defaults below are a starting point for products still being built: change them here as each one is priced."""
from datetime import date

from psycopg.types.json import Jsonb

from . import licences, orgs
from .config import settings
from .errors import Problem

PRODUCTS = {"hub": "Geohub", "land": "Land Registry", "check": "LandCheck", "farm": "FarmScan", "gis": "PolyGIS"}
OTHER = ("land", "check", "farm", "gis")                     # licensed in org_products
PLANS = ("standard", "advanced", "custom")
PLAN_WORDS = {"standard": "Standard", "advanced": "Advanced", "custom": "Custom"}

# What each plan switches on. Custom = everything; anything else is set per organization.
FEATURES = {
    "land": {"standard": ("parcels", "titles", "transactions", "public_lookup"),
             "advanced": ("parcels", "titles", "transactions", "public_lookup", "dxf_import", "ai_georeference",
                          "workflows", "valuations", "disputes")},
    "check": {"standard": ("reports",), "advanced": ("reports", "batch", "ai_briefing", "title_status")},
    "farm": {"standard": ("monitoring", "zones", "suitability", "alerts"),
             "advanced": ("monitoring", "zones", "suitability", "alerts", "prescriptions", "verification")},
    "gis": {"standard": ("maps", "editing", "export"),
            "advanced": ("maps", "editing", "export", "geoprocessing", "raster", "layouts")},
}
FEATURE_NAMES = {
    "parcels": "Parcels", "titles": "Titles and owners", "transactions": "Transfers and transactions",
    "public_lookup": "Public parcel lookup", "dxf_import": "Survey plan (DXF) import", "ai_georeference": "AI georeferencing",
    "workflows": "Approval workflows", "valuations": "Valuations", "disputes": "Disputes",
    "reports": "Location reports", "batch": "Batch checks", "ai_briefing": "AI briefing", "title_status": "Title status",
    "monitoring": "Satellite monitoring", "zones": "Management zones", "suitability": "Crop suitability",
    "drone": "Drone imagery", "plant_count": "Plant counts", "prescriptions": "Variable-rate prescriptions",
    "alerts": "Weekly farm alerts", "verification": "Farm verification reports",
    "maps": "Maps and layers", "editing": "Editing", "export": "Export", "geoprocessing": "Geoprocessing tools",
    "raster": "Raster analysis", "layouts": "Print layouts",
}
# Default caps per plan (None = unlimited); an organization's `limits` change them.
LIMITS = {
    "land": {"standard": {"parcels": 20000, "seats": 10}, "advanced": {"parcels": 250000, "seats": 40}, "custom": {}},
    "check": {"standard": {"reports_per_month": 50}, "advanced": {"reports_per_month": 300}, "custom": {}},
    "farm": {"standard": {"hectares": 500}, "advanced": {"hectares": 5000}, "custom": {}},
    "gis": {"standard": {"seats": 5}, "advanced": {"seats": 25}, "custom": {}},
}


def plan_name(product: str, plan: str) -> str:
    if product == "hub":
        return orgs.PLAN_NAMES.get(plan, plan)
    return f"{PRODUCTS[product]} {PLAN_WORDS.get(plan, plan)}"


def urls() -> dict[str, str]:
    out = {"hub": settings.app_url}
    for part in settings.product_urls.split(","):
        k, _, v = part.partition("=")
        if k.strip() in OTHER and v.strip():
            out[k.strip()] = v.strip().rstrip("/")
    return out


def features(product: str, plan: str, overrides: dict | None) -> list[str]:
    if product == "hub":
        return []
    on = set(FEATURE_NAMES) & {f for fs in FEATURES[product].values() for f in fs} if plan == "custom" \
        else set(FEATURES[product].get(plan, ()))
    for k, v in (overrides or {}).items():
        (on.add if v else on.discard)(k)
    return sorted(on)


def limits(product: str, plan: str, overrides: dict | None) -> dict:
    out = dict(LIMITS[product].get(plan, {}))
    for k, v in (overrides or {}).items():
        out[k] = None if v is None else int(v)
    return out


def _shape(product: str, row: dict, suspended_at, suspended_reason=None) -> dict:
    lic = {"plan": row["plan"], "subscription_ends": row["subscription_ends"], "licence_kind": row["licence_kind"],
           "suspended_at": suspended_at}
    st = licences.status(lic)
    return {"product": product, "name": PRODUCTS[product], "plan": row["plan"], "plan_name": plan_name(product, row["plan"]),
            "licence_kind": row["licence_kind"], "status": st, "status_name": licences.STATUS_NAMES[st],
            "subscription_starts": row["subscription_starts"], "subscription_ends": row["subscription_ends"],
            "grace_ends": licences.grace_ends(lic), "limits": limits(product, row["plan"], row.get("limits"))
            if product != "hub" else orgs.caps(row["plan"], row.get("limits")),
            "features": features(product, row["plan"], row.get("features")), "url": urls().get(product)}


async def of_org(conn, org_id) -> list[dict]:
    """Every product the organization has, Geohub first."""
    cur = await conn.execute("SELECT plan, licence_kind, subscription_starts, subscription_ends, limits, suspended_at, "
                             "suspended_reason FROM organizations WHERE id = %s", (org_id,))
    o = await cur.fetchone()
    if not o:
        return []
    out = [_shape("hub", o, o["suspended_at"])]
    cur = await conn.execute("SELECT * FROM org_products WHERE org_id = %s", (org_id,))
    rows = {r["product"]: r for r in await cur.fetchall()}
    out += [_shape(p, rows[p], o["suspended_at"]) for p in OTHER if p in rows]
    return out


async def record(conn, org_id, product: str, action: str, actor_id=None, invoice_ref: str | None = None,
                 note: str | None = None) -> None:
    """Add a product's licence as it now stands to the licence history (Geohub's own goes through licences.record)."""
    if product == "hub":
        await licences.record(conn, org_id, action, actor_id, invoice_ref, note)
        return
    cur = await conn.execute("SELECT plan, licence_kind, subscription_starts, subscription_ends, limits FROM org_products "
                             "WHERE org_id = %s AND product = %s", (org_id, product))
    r = await cur.fetchone()
    await conn.execute(
        "INSERT INTO licence_events (org_id, product, action, plan, kind, starts, ends, limits, invoice_ref, note, actor_id) "
        "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
        (org_id, product, action, r["plan"] if r else "none", r["licence_kind"] if r else "paid", r and r["subscription_starts"],
         r and r["subscription_ends"], Jsonb((r and r["limits"]) or {}), (invoice_ref or "").strip() or None,
         (note or "").strip() or None, actor_id))


async def put(conn, org_id, product: str, *, plan: str, kind: str = "paid", starts: date | None = None,
              ends: date | None = None, limits_: dict | None = None, features_: dict | None = None) -> str:
    """Give the organization a product, or change it. Returns the history action: create, demo, renew or change."""
    if product not in OTHER:
        raise Problem(422, "That product is licensed on the organization itself.", code="validation", fields={"product": ["not here"]})
    if kind == "demo":
        d0, d1 = licences.demo_dates()
        starts, ends = starts or d0, ends or d1
    if starts and ends and ends < starts:
        raise Problem(422, "The licence cannot end before it starts.", code="validation", fields={"subscription_ends": ["before start"]})
    unknown = set(features_ or {}) - set(FEATURE_NAMES)
    if unknown:
        raise Problem(422, f"Unknown feature: {', '.join(sorted(unknown))}.", code="validation", fields={"features": ["unknown"]})
    cur = await conn.execute("SELECT * FROM org_products WHERE org_id = %s AND product = %s FOR UPDATE", (org_id, product))
    now = await cur.fetchone()
    await conn.execute(
        "INSERT INTO org_products (org_id, product, plan, licence_kind, subscription_starts, subscription_ends, limits, features) "
        "VALUES (%s, %s, %s, %s, %s, %s, %s, %s) ON CONFLICT (org_id, product) DO UPDATE SET plan = EXCLUDED.plan, "
        "licence_kind = EXCLUDED.licence_kind, subscription_starts = EXCLUDED.subscription_starts, "
        "subscription_ends = EXCLUDED.subscription_ends, limits = EXCLUDED.limits, features = EXCLUDED.features, updated_at = now()",
        (org_id, product, plan, kind, starts, ends,
         Jsonb(limits_ if limits_ is not None else (now["limits"] if now else {})),
         Jsonb(features_ if features_ is not None else (now["features"] if now else {}))))
    if not now:
        return "demo" if kind == "demo" else "create"
    renewed = bool(ends and now["subscription_ends"] and ends > now["subscription_ends"]) or (now["licence_kind"] == "demo" and kind == "paid")
    return "renew" if renewed else "change"


async def remove(conn, org_id, product: str) -> bool:
    cur = await conn.execute("DELETE FROM org_products WHERE org_id = %s AND product = %s RETURNING product", (org_id, product))
    return bool(await cur.fetchone())
