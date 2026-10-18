from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, EmailStr, Field

Role = Literal["owner", "admin", "collector", "viewer"]
GeometryType = Literal["point", "line", "area"]
FeatureStatus = Literal["draft", "submitted", "approved", "rejected"]
Geometry = dict[str, Any]
LICENSES = ("ODbL-1.0", "CC-BY-4.0", "CC0-1.0", "Private")


# ---------- auth ----------
class RegisterIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=200)
    name: str = Field(min_length=1, max_length=120)


class LoginIn(BaseModel):
    email: EmailStr
    password: str


class RefreshIn(BaseModel):
    refresh_token: str


class UserOut(BaseModel):
    id: UUID
    email: EmailStr
    name: str


class AuthOut(BaseModel):
    access_token: str
    refresh_token: str
    token_type: Literal["bearer"] = "bearer"
    expires_in: int = Field(description="Access token lifetime in seconds")
    user: UserOut


# ---------- projects and members ----------
class ProjectIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = Field("", max_length=2000)


class ProjectPatch(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=200)
    description: str | None = Field(None, max_length=2000)


class ProjectOut(BaseModel):
    id: UUID
    name: str
    description: str
    role: Role = Field(description="The caller's role in this project")
    feature_count: int
    collector_count: int
    last_update: datetime
    created_at: datetime


class MemberIn(BaseModel):
    email: EmailStr
    role: Literal["admin", "collector", "viewer"] = "collector"
    assigned_area: Geometry | None = Field(None, description="GeoJSON Polygon/MultiPolygon limiting the offline bundle")


class MemberPatch(BaseModel):
    role: Literal["owner", "admin", "collector", "viewer"] | None = None
    assigned_area: Geometry | None = None
    clear_assigned_area: bool = False


class MemberOut(BaseModel):
    id: UUID = Field(description="user id for active members, invitation id for pending invites")
    user_id: UUID | None
    email: EmailStr
    name: str | None
    role: Role
    status: Literal["active", "invited"]
    assigned_area: Geometry | None = None


# ---------- forms ----------
class FieldDef(BaseModel):
    id: str = Field(pattern=r"^[a-z][a-z0-9_]{0,39}$")
    label: str = Field(min_length=1, max_length=200)
    type: Literal["text", "number", "choice", "multi_choice", "date", "photo"]
    required: bool = False
    choices: list[str] = []
    max_items: int | None = Field(None, ge=1, le=50)


class FormIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    geometry_type: GeometryType
    fields: list[FieldDef] = []


class FormPatch(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=200)
    geometry_type: GeometryType | None = None
    fields: list[FieldDef] | None = None


class FormOut(BaseModel):
    id: UUID
    project_id: UUID
    name: str
    geometry_type: GeometryType
    version: int = Field(description="Latest published version, 0 if never published")
    status: Literal["draft", "published"]
    has_unpublished_changes: bool
    fields: list[FieldDef]
    updated_at: datetime


class FormVersionOut(BaseModel):
    form_id: UUID
    version: int
    name: str
    geometry_type: GeometryType
    fields: list[FieldDef]
    published_at: datetime


# ---------- features ----------
class MediaOut(BaseModel):
    id: UUID
    feature_id: UUID | None
    field_id: str | None
    kind: str
    status: str
    width: int | None
    height: int | None
    size: int | None
    url: str | None = Field(None, description="Web-size image once processed, otherwise the original")
    original_url: str | None = None


class FeatureOut(BaseModel):
    id: UUID
    project_id: UUID
    form_id: UUID
    form_version: int
    geometry: Geometry
    properties: dict[str, Any]
    status: FeatureStatus
    version: int
    seq: int
    review_note: str | None = None
    created_by: UUID | None
    updated_by: UUID | None
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None = None
    media: list[MediaOut] | None = None


class FeatureCreate(BaseModel):
    id: UUID = Field(description="Generated on the client")
    form_id: UUID
    form_version: int | None = Field(None, description="Defaults to the latest published version")
    geometry: Geometry
    properties: dict[str, Any] = {}
    status: Literal["draft", "submitted"] = "submitted"
    change_id: UUID | None = None


class FeaturePatch(BaseModel):
    base_version: int = Field(ge=1)
    geometry: Geometry | None = None
    properties: dict[str, Any] | None = Field(None, description="The complete new properties object")
    status: Literal["draft", "submitted"] | None = None
    form_version: int | None = None
    change_id: UUID | None = None


class ReviewIn(BaseModel):
    decision: Literal["approved", "rejected"]
    note: str | None = Field(None, max_length=2000)


class FeatureVersionOut(BaseModel):
    version: int
    geometry: Geometry | None
    properties: dict[str, Any] | None
    status: str | None
    deleted: bool
    action: str
    changed_by: UUID | None
    changed_by_name: str | None
    changed_at: datetime


# ---------- sync ----------
class SyncChange(BaseModel):
    change_id: UUID = Field(description="Client-generated per change; makes retries idempotent")
    id: UUID = Field(description="Feature id")
    op: Literal["create", "update", "delete"]
    form_id: UUID | None = Field(None, description="Required for create")
    form_version: int | None = None
    base_version: int = Field(0, ge=0, description="0 for create")
    geometry: Geometry | None = None
    properties: dict[str, Any] | None = None
    status: Literal["draft", "submitted"] | None = None
    client_updated_at: datetime | None = Field(None, description="Display only; never used for ordering")


class SyncPushIn(BaseModel):
    project_id: UUID
    changes: list[SyncChange] = Field(max_length=200)


class SyncResult(BaseModel):
    change_id: UUID
    id: UUID
    status: Literal["applied", "conflict", "rejected"]
    version: int | None = None
    merged: bool = False
    code: str | None = None
    detail: str | None = None
    fields: dict[str, list[str]] | None = None
    server: FeatureOut | None = Field(None, description="On conflict: the server's current feature")
    client: dict[str, Any] | None = Field(None, description="On conflict: what the client tried to write")


class SyncPushOut(BaseModel):
    results: list[SyncResult]


class SyncItem(BaseModel):
    seq: int
    op: Literal["upsert", "delete"]
    feature: FeatureOut


class SyncPullOut(BaseModel):
    items: list[SyncItem]
    next_cursor: str = Field(description="Always set: store it and pass it back as ?cursor=")
    has_more: bool


class BundleOut(BaseModel):
    project: dict[str, Any]
    role: Role
    forms: list[FormVersionOut]
    features: list[FeatureOut]
    cursor: str = Field(description="Start /sync/pull from here after loading the bundle")
    truncated: bool = Field(description="True if there were more features than the bundle limit; pull from cursor 0 instead")
    limits: dict[str, int]


# ---------- media ----------
class MediaUploadIn(BaseModel):
    id: UUID = Field(description="Generated on the client")
    project_id: UUID
    content_type: Literal["image/jpeg", "image/png", "image/webp"] = "image/jpeg"
    size: int = Field(gt=0)


class MediaUploadOut(BaseModel):
    id: UUID
    upload_url: str
    method: Literal["PUT"] = "PUT"
    headers: dict[str, str]
    max_bytes: int


class MediaCompleteIn(BaseModel):
    feature_id: UUID
    field_id: str | None = None
    width: int | None = Field(None, ge=1)
    height: int | None = Field(None, ge=1)


# ---------- imagery ----------
class ImageryIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    filename: str = Field(description="Any raster format GDAL reads: tif, tiff, jpg, jpeg, png, webp, gif, bmp, jp2, j2k, img, asc")
    size: int = Field(gt=0)
    bounds: list[float] | None = Field(
        None, min_length=4, max_length=4,
        description="[west, south, east, north] in `crs`. Only used when the file has no coordinates of its own "
                    "(typical for plain JPEG/PNG). Ignored for georeferenced files.")
    crs: str = Field("EPSG:4326", pattern=r"^EPSG:\d{4,6}$", description="Coordinate system of `bounds`")


class UploadPart(BaseModel):
    part_number: int
    url: str


class ImageryUploadOut(BaseModel):
    id: UUID
    upload_id: str
    part_size: int
    parts: list[UploadPart]


class CompletedPart(BaseModel):
    part_number: int = Field(ge=1, le=10000)
    etag: str


class ImageryCompleteIn(BaseModel):
    parts: list[CompletedPart] = Field(min_length=1)


class ImageryOut(BaseModel):
    id: UUID
    project_id: UUID | None = None
    map_id: UUID | None = None
    name: str
    status: Literal["uploading", "processing", "ready", "failed"]
    bounds: list[float] | None
    crs: str | None
    resolution: float | None
    bands: int | None
    size: int | None
    error: str | None = None
    error_code: str | None = None
    tiles_url: str | None = None
    job_id: UUID | None = None
    created_at: datetime


class LayersOut(BaseModel):
    expires_in: int
    vector: list[dict[str, Any]]
    imagery: list[dict[str, Any]]


# ---------- jobs ----------
class JobOut(BaseModel):
    id: UUID
    kind: Literal["imagery_convert", "export", "snapshot", "import"]
    status: Literal["queued", "running", "done", "failed"]
    progress: int
    result: dict[str, Any] | None = Field(None, description="Exports include a signed download_url when done")
    error: str | None
    created_at: datetime
    updated_at: datetime


# ---------- datasets ----------
class DatasetIn(BaseModel):
    form_id: UUID
    slug: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{1,62}$")
    title: str = Field(min_length=1, max_length=200)
    description: str = Field("", max_length=5000)
    license: Literal["ODbL-1.0", "CC-BY-4.0", "CC0-1.0", "Private"] = "CC-BY-4.0"
    tags: list[str] = Field([], max_length=20)
    visibility: Literal["private", "public"] = "private"
    statuses: list[Literal["submitted", "approved"]] = Field(
        ["approved"], min_length=1, description="Feature statuses included in snapshots")


class DatasetPatch(BaseModel):
    title: str | None = Field(None, min_length=1, max_length=200)
    description: str | None = Field(None, max_length=5000)
    license: Literal["ODbL-1.0", "CC-BY-4.0", "CC0-1.0", "Private"] | None = None
    tags: list[str] | None = Field(None, max_length=20)
    visibility: Literal["private", "public"] | None = None


class NewVersionIn(BaseModel):
    statuses: list[Literal["submitted", "approved"]] | None = None


class DatasetVersionOut(BaseModel):
    version: int
    feature_count: int
    bbox: list[float] | None
    published_at: datetime
    download_count: int


class DatasetSummary(BaseModel):
    slug: str
    title: str
    description: str
    license: str
    tags: list[str]
    visibility: Literal["private", "public"]
    geometry_type: GeometryType
    latest_version: int
    feature_count: int
    bbox: list[float] | None
    published_at: datetime
    download_count: int


class ContributorCredit(BaseModel):
    name: str
    features: int


class DatasetOut(DatasetSummary):
    project_id: UUID | None = Field(None, description="Only shown to project members")
    map_id: UUID | None = Field(None, description="Only shown to members of the map the dataset was published from")
    contributors: list[ContributorCredit] = Field([], description="People credited for the latest version (map datasets)")
    fields: list[FieldDef]
    versions: list[DatasetVersionOut]
    formats: list[str]


class DatasetCreated(BaseModel):
    dataset: DatasetSummary
    job: JobOut


class ExportIn(BaseModel):
    format: Literal["geojson", "gpkg", "shp", "csv"]
    version: int | None = Field(None, ge=1, description="Defaults to the latest version")


class AuditOut(BaseModel):
    id: int
    at: datetime
    actor_id: UUID | None
    action: str
    target_type: str | None
    target_id: str | None
    details: dict[str, Any]
