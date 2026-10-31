import json
import re
from datetime import date, datetime
from typing import Annotated, Any, Literal
from urllib.parse import urlsplit
from uuid import UUID

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator, model_validator

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
    """One element of a form. Which optional properties apply to which type is checked by services/forms.py
    (check_field_defs), so older forms that only use id, label, type, required, choices and max_items stay valid."""
    id: str = Field(pattern=r"^[a-z][a-z0-9_]{0,39}$")
    label: str = Field(min_length=1, max_length=200)
    type: Literal["text", "number", "date", "time", "datetime", "choice", "multi_choice", "boolean", "ranking", "barcode",
                  "photo", "audio", "video", "file", "signature", "note", "calculation", "group", "repeat"]
    appearance: str | None = Field(None, max_length=30)
    hint: str | None = Field(None, max_length=500)
    placeholder: str | None = Field(None, max_length=200)
    required: bool = False
    required_if: dict[str, Any] | None = None
    visible: dict[str, Any] | None = None
    readonly: bool | None = None
    default: str | float | int | bool | list[str] | None = None
    min: float | int | str | None = None
    max: float | int | str | None = None
    min_length: int | None = Field(None, ge=0, le=5000)
    max_length: int | None = Field(None, ge=1, le=5000)
    min_items: int | None = Field(None, ge=0, le=50)
    max_items: int | None = Field(None, ge=1, le=50)
    pattern: str | None = Field(None, max_length=200)
    pattern_message: str | None = Field(None, max_length=200)
    choices: list[str] = Field(default=[], max_length=200)
    integer: bool | None = None
    decimals: int | None = Field(None, ge=0, le=10)
    unit: str | None = Field(None, max_length=20)
    must_be_true: bool | None = None
    true_label: str | None = Field(None, max_length=40)
    false_label: str | None = Field(None, max_length=40)
    text: str | None = Field(None, max_length=2000)
    calc: dict[str, Any] | None = None
    store: bool | None = None
    children: list["FieldDef"] | None = None


FieldDef.model_rebuild()


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
    content_type: Literal["image/jpeg", "image/png", "image/webp", "audio/mpeg", "audio/mp4", "audio/webm", "audio/ogg", "audio/wav",
                          "video/mp4", "video/webm", "video/quicktime", "application/pdf", "text/plain", "text/csv"] = "image/jpeg"
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


# ---------- sharing a form by link ----------
class SharingOut(BaseModel):
    share_mode: Literal["collaborators", "public"]
    share_token: str
    published: bool


class SharingPatch(BaseModel):
    share_mode: Literal["collaborators", "public"] | None = None
    regenerate_link: bool = Field(False, description="Issue a new link; the old one stops working")


class PublicFormOut(BaseModel):
    token: str
    form_id: UUID
    project_id: UUID
    project_name: str
    name: str
    geometry_type: GeometryType
    version: int
    fields: list[FieldDef]
    access: Literal["public", "member"] = Field(description="member = the caller is a collaborator and should use the collector")


class PublicSubmit(BaseModel):
    id: UUID = Field(description="Generated on the client; makes a retry safe")
    geometry: Geometry
    properties: dict[str, Any] = {}


class PublicMediaIn(BaseModel):
    id: UUID = Field(description="Generated on the client")
    content_type: str
    size: int = Field(ge=1)


# ---------- dashboards ----------
MAX_DASHBOARD_PAGES = 12
MAX_WIDGETS_PER_PAGE = 30
MAX_PAGE_FILTERS = 6


class WidgetStyle(BaseModel):
    """Font and style for one element. Same choices as DashboardStyle, limited to what an element can set for itself; it wins over the dashboard's."""
    model_config = ConfigDict(extra="forbid")
    font: Literal["system", "humanist", "rounded", "serif", "slab", "mono"] | None = None
    textSize: int | None = Field(None, ge=80, le=150)
    headingSize: int | None = Field(None, ge=10, le=24)
    headingWeight: Literal[400, 500, 600, 700, 800] | None = None
    headingCaps: bool | None = None
    numberSize: int | None = Field(None, ge=70, le=200)
    numberColor: str | None = Field(None, pattern=r"^#[0-9a-fA-F]{6}$")
    radius: int | None = Field(None, ge=0, le=28)
    border: Literal["none", "thin", "thick"] | None = None
    borderColor: str | None = Field(None, pattern=r"^#[0-9a-fA-F]{6}$")


class SymbolSpec(BaseModel):
    """A symbol: a library icon or the author's own SVG, with colour, shape and animation. The SVG is stored as written and rebuilt from
    an allow-list by every client before it is drawn, so what is stored is never trusted as markup."""
    model_config = ConfigDict(extra="forbid")
    icon: str | None = Field(None, max_length=40, pattern=r"^[a-z0-9-]+$")
    svg: str | None = Field(None, max_length=6000)
    color: str | None = Field(None, pattern=r"^#[0-9a-fA-F]{6}$")
    shape: Literal["plain", "circle", "ring", "square"] | None = None
    motion: Literal["none", "pulse", "spin", "bounce", "float", "glow", "shake", "ripple", "blink"] | None = None


class WidgetActions(BaseModel):
    """What clicking a record or a chart group does: filter the other elements, and/or zoom map elements to it."""
    model_config = ConfigDict(extra="forbid")
    filter: bool | None = None
    zoom: list[Annotated[str, Field(min_length=1, max_length=40, pattern=r"^[A-Za-z0-9_-]+$")]] = Field(default_factory=list, max_length=20)


class DashboardWidget(BaseModel):
    """One chart, number, table or map on a dashboard page. Mirrors `Widget` in frontend/src/lib/types.ts.
    Size and position are optional: without col/row/cols/rows the layout is worked out from the chart types (see autoLayout in lib/dashboard.ts)."""
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1, max_length=40, pattern=r"^[A-Za-z0-9_-]+$")
    type: Literal["kpi", "bar", "pie", "line", "table", "map", "gauge", "list", "details", "rich_text", "embedded"]
    title: str = Field("", max_length=120)
    wide: bool = Field(False, description="Always take a full row")
    form_id: UUID | None = Field(None, description="Draw on this form instead of the page's form")
    metric: Literal["count", "sum", "avg", "min", "max"] = "count"
    metric_field: str | None = Field(None, max_length=80, description="Number field the metric is taken from")
    field: str | None = Field(None, max_length=80, description="Field to group by (bar, pie) or the date to plot (line)")
    bucket: Literal["day", "week", "month"] = "month"
    limit: int = Field(8, ge=1, le=50)
    columns: list[str] = Field(default_factory=list, max_length=12, description="Table columns (field ids), or the fields a details element shows")
    region: Literal["sidebar"] | None = Field(None, description="sidebar = shown in the side column instead of on the grid")
    target: float | None = Field(None, gt=0, description="Gauge: the full-scale value")
    target_field: str | None = Field(None, max_length=80, description="Gauge: use the total of this number field as the full-scale value")
    title_field: str | None = Field(None, max_length=80, description="List: the field used as each row's heading")
    subtitle_fields: list[str] = Field(default_factory=list, max_length=60, description="List: every field shown under the heading, in order")
    show_labels: bool = Field(False, description="List: write the field name before each value")
    all_rows: bool = Field(False, description="Table: show every record instead of `limit`")
    actions: WidgetActions | None = Field(None, description="What a click on a record or a chart group does")
    symbol: SymbolSpec | None = Field(None, description="Beside the number (kpi, gauge), before each row (list), or in the title bar")
    content: str | None = Field(None, max_length=4000, description="Rich text: **bold**, *italic* and line breaks. Never treated as HTML")
    url: str | None = Field(None, max_length=500, description="Embedded content: an https:// address shown in a sandboxed frame")
    style: WidgetStyle | None = Field(None, description="Font and style for this element only; overrides the dashboard-wide style")
    map_style: dict[str, Any] | None = Field(None, description="Map element: basemap and how its layer is drawn (colours, symbols). Checked again by the client before use")

    @field_validator("map_style")
    @classmethod
    def _map_style_is_small(cls, v: dict[str, Any] | None) -> dict[str, Any] | None:
        if v is not None and len(json.dumps(v)) > 20000:
            raise ValueError("map_style is too large")
        return v

    # Manual placement on the 12-column grid, set by dragging or resizing in the editor. All four or none; none = automatic layout.
    col: int | None = Field(None, ge=0, le=11, description="Left edge, in columns from 0")
    row: int | None = Field(None, ge=0, le=200, description="Top edge, in rows from 0")
    cols: int | None = Field(None, ge=1, le=12, description="Width in columns")
    rows: int | None = Field(None, ge=1, le=40, description="Height in rows")

    @field_validator("url")
    @classmethod
    def _https_only(cls, v):
        # Embedded content is shown in a frame, so only plain https addresses are accepted: no javascript:, data: or http:.
        if v in (None, ""):
            return None
        parts = urlsplit(v)
        if parts.scheme != "https" or not parts.hostname or "." not in parts.hostname or parts.username or parts.password:
            raise ValueError("the address must start with https://")
        return v

    @model_validator(mode="after")
    def _rect_complete(self):
        given = [v is not None for v in (self.col, self.row, self.cols, self.rows)]
        if any(given) and not all(given):
            raise ValueError("col, row, cols and rows must be given together")
        if self.col is not None and self.col + self.cols > 12:
            raise ValueError("the chart runs past the right edge of the 12 columns")
        return self

    @model_validator(mode="before")
    @classmethod
    def _old_width(cls, data):
        # Charts saved before the automatic layout carried a width of 1 to 3. Only "full width" still means something.
        if isinstance(data, dict) and "width" in data:
            data = dict(data)
            width = data.pop("width")
            if width not in (1, 2, 3):
                raise ValueError("width must be 1, 2 or 3")
            data.setdefault("wide", width == 3)
        return data


class DashboardControlSource(BaseModel):
    """Where a category selector gets its values when not from the page's own records: a field of another form, or an https list."""
    model_config = ConfigDict(extra="forbid")
    type: Literal["form", "url"]
    form_id: UUID | None = None
    field: str | None = Field(None, max_length=80)
    url: str | None = Field(None, max_length=500)
    column: str | None = Field(None, max_length=80)

    @model_validator(mode="after")
    def _complete(self):
        if self.type == "form" and (self.form_id is None or not self.field):
            raise ValueError("a form source needs a form and a field")
        if self.type == "url" and not (self.url or "").startswith("https://"):
            raise ValueError("a web address must start with https://")
        return self


class DashboardControl(BaseModel):
    """A filter in the bar under the title: a category selector, or the date filter (Today / Last N days)."""
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1, max_length=40, pattern=r"^[A-Za-z0-9_-]+$")
    kind: Literal["category", "date"]
    label: str = Field("", max_length=60)
    field: str | None = Field(None, max_length=80)
    source: DashboardControlSource | None = None
    multi: bool = True
    symbol: SymbolSpec | None = None


class DashboardPage(BaseModel):
    """One page of a dashboard, for example "Army". Its records come from `form_id` unless a chart picks another form."""
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1, max_length=40, pattern=r"^[A-Za-z0-9_-]+$")
    title: str = Field(min_length=1, max_length=60)
    form_id: UUID | None = Field(None, description="The form whose records this page shows")
    widgets: list[DashboardWidget] = Field(default_factory=list, max_length=MAX_WIDGETS_PER_PAGE)
    filters: list[Annotated[str, Field(min_length=1, max_length=80)]] = Field(default_factory=list, max_length=MAX_PAGE_FILTERS, description="Older dashboards: field ids offered as dropdowns. The app turns them into `controls`")
    controls: list[DashboardControl] = Field(default_factory=list, max_length=MAX_PAGE_FILTERS, description="The filters in the bar under the title")
    exclude: dict[Annotated[str, Field(pattern=r"^[A-Za-z0-9_-]{1,40}$")], list[Annotated[str, Field(pattern=r"^[A-Za-z0-9_-]{1,40}$")]]] = Field(
        default_factory=dict, max_length=40, description="Per filter (a control, or a clicked chart): the element ids it leaves alone. Missing = it changes every element")

    @model_validator(mode="after")
    def _unique_ids(self):
        if len(self.filters) != len(set(self.filters)):
            raise ValueError("filters must be unique")
        cids = [c.id for c in self.controls]
        if len(cids) != len(set(cids)):
            raise ValueError("filter ids must be unique")
        if sum(c.kind == "date" for c in self.controls) > 1:
            raise ValueError("a page can have one date filter")
        if any(len(v) > 60 for v in self.exclude.values()):
            raise ValueError("too many elements listed for one filter")
        ids = [w.id for w in self.widgets]
        if len(ids) != len(set(ids)):
            raise ValueError("widget ids must be unique")
        return self


THEME_COLOR_KEYS = ("background", "foreground", "accent", "cardBackground", "cardForeground", "headerBackground", "headerForeground")
TIME_PRESETS = ("all_time", "last_7_days", "last_30_days", "last_90_days", "last_year", "custom")


class DashboardStyle(BaseModel):
    """Fonts and shapes for a dashboard. Everything is optional; what is not set keeps the normal look."""
    model_config = ConfigDict(extra="forbid")
    font: Literal["system", "humanist", "rounded", "serif", "slab", "mono"] | None = None
    textSize: int | None = Field(None, ge=80, le=150)
    titleSize: int | None = Field(None, ge=16, le=48)
    headingSize: int | None = Field(None, ge=10, le=24)
    headingWeight: Literal[400, 500, 600, 700, 800] | None = None
    headingCaps: bool | None = None
    titleAlign: Literal["left", "center"] | None = None
    numberSize: int | None = Field(None, ge=70, le=200)
    numberColor: str | None = Field(None, pattern=r"^#[0-9a-fA-F]{6}$")
    radius: int | None = Field(None, ge=0, le=28)
    border: Literal["none", "thin", "thick"] | None = None
    borderColor: str | None = Field(None, pattern=r"^#[0-9a-fA-F]{6}$")
    shadow: Literal["none", "soft", "strong"] | None = None
    gap: int | None = Field(None, ge=4, le=28)


class DashboardTheme(BaseModel):
    """A dashboard's look: a named preset (the frontend owns the list) plus colours the author changed."""
    model_config = ConfigDict(extra="forbid")
    preset: str = Field("light", min_length=1, max_length=24, pattern=r"^[a-z0-9_-]+$")
    overrides: dict[str, str] = Field(default_factory=dict, max_length=len(THEME_COLOR_KEYS))
    style: DashboardStyle | None = None

    @field_validator("overrides")
    @classmethod
    def _colours(cls, v):
        for key, colour in v.items():
            if key not in THEME_COLOR_KEYS:
                raise ValueError(f"unknown colour '{key}'")
            if not re.fullmatch(r"#[0-9a-fA-F]{6}", colour):
                raise ValueError(f"'{key}' must be a colour like #17634c")
        return v


class DashboardTimeFilter(BaseModel):
    """Limits every element to records changed within a date range, on top of the viewer's own filters."""
    model_config = ConfigDict(extra="forbid")
    preset: Literal["all_time", "last_7_days", "last_30_days", "last_90_days", "last_year", "custom"] = "all_time"
    start: date | None = None
    end: date | None = None

    @model_validator(mode="after")
    def _custom_range(self):
        if self.preset == "custom":
            if self.start is None or self.end is None:
                raise ValueError("a custom range needs a start and an end date")
            if self.start > self.end:
                raise ValueError("the start date is after the end date")
        return self


class DashboardConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    description: str | None = Field(None, max_length=300)
    theme: DashboardTheme | None = None
    time_filter: DashboardTimeFilter | None = None
    pages: list[DashboardPage] = Field(min_length=1, max_length=MAX_DASHBOARD_PAGES)

    @model_validator(mode="before")
    @classmethod
    def _old_single_page(cls, data):
        # A dashboard saved before pages existed ({form_id, widgets}) becomes one page named Overview.
        if isinstance(data, dict) and "pages" not in data:
            data = dict(data)
            page = {"id": "main", "title": "Overview", "form_id": data.pop("form_id", None), "widgets": data.pop("widgets", [])}
            data["pages"] = [page]
        return data

    @model_validator(mode="after")
    def _unique_pages(self):
        ids = [p.id for p in self.pages]
        if len(ids) != len(set(ids)):
            raise ValueError("page ids must be unique")
        return self

    def form_ids(self) -> set[UUID]:
        """Every form the dashboard draws on, on any page."""
        lookups = (c.source.form_id for p in self.pages for c in p.controls if c.source is not None and c.source.type == "form")
        return {f for p in self.pages for f in [p.form_id, *(w.form_id for w in p.widgets)] if f is not None} | {f for f in lookups if f is not None}


class DashboardIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    config: DashboardConfig = Field(default_factory=DashboardConfig)


class DashboardPatch(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=120)
    config: DashboardConfig | None = None


class DashboardOut(BaseModel):
    id: UUID
    project_id: UUID
    name: str
    config: DashboardConfig
    updated_at: datetime
    shared: bool = Field(False, description="Anyone with the link can view it. The link itself is only given to administrators")


class DashboardSharingOut(BaseModel):
    public: bool
    share_token: str | None = None


class DashboardSharingPatch(BaseModel):
    public: bool | None = Field(None, description="true issues a link, false deletes it")
    regenerate_link: bool = Field(False, description="Issue a new link; the old one stops working")


class PublicDashboardForm(BaseModel):
    id: UUID
    name: str
    geometry_type: GeometryType
    version: int
    fields: list[dict[str, Any]] = Field(description="Only the fields the dashboard uses, and never photos or files")


class PublicDashboardFeature(BaseModel):
    id: UUID
    form_id: UUID
    geometry: Geometry | None = Field(None, description="Only for forms the dashboard shows on a map")
    properties: dict[str, Any]
    updated_at: datetime


class PublicDashboardOut(BaseModel):
    """A dashboard seen through its public link: its saved layout and the approved records it draws, nothing else."""
    token: str
    name: str
    project_name: str
    config: DashboardConfig
    updated_at: datetime
    truncated: bool = Field(False, description="There were more records than a public link carries; the newest are shown")
    forms: list[PublicDashboardForm]
    features: list[PublicDashboardFeature]
