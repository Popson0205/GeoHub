"""Reading a spreadsheet of people to add: a CSV file or an Excel workbook (.xlsx, its first sheet).

The first row names the columns. Only email and name are needed; role, team and projects (separated by ;) are
optional:

    email, name, role, team, projects
    ada@lagossurvey.com, Ada Obi, field collector, North team, Ikeja survey; Lekki survey
"""
import csv
import io
import zipfile

from .errors import Problem

MAX_BYTES = 1_000_000
MAX_ROWS = 500
COLUMNS = {
    "email": ("email", "e-mail", "email address", "mail"),
    "name": ("name", "full name", "full_name", "fullname", "person"),
    "role": ("role", "kind", "access"),
    "team": ("team", "department", "unit"),
    "projects": ("projects", "project"),
}
ROLES = {"admin": "admin", "administrator": "admin", "member": "member", "team member": "member",
         "collector": "collector", "field collector": "collector", "field_collector": "collector", "enumerator": "collector",
         "viewer": "viewer", "read only": "viewer", "read-only": "viewer"}


def _bad(msg: str) -> Problem:
    return Problem(422, msg, code="bad_spreadsheet", fields={"file": [msg]})


def _table(filename: str, data: bytes) -> list[list[str]]:
    name = (filename or "").lower()
    if name.endswith(".xlsx") or data[:2] == b"PK":
        try:
            from openpyxl import load_workbook
            wb = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
        except (zipfile.BadZipFile, KeyError, ValueError, OSError):
            raise _bad("That file could not be read as an Excel workbook. Save it as .xlsx or CSV and try again.")
        ws = wb.worksheets[0]
        rows = []
        for r in ws.iter_rows(values_only=True):
            rows.append(["" if v is None else str(v).strip() for v in r])
            if len(rows) > MAX_ROWS + 1:
                break
        wb.close()
        return rows
    if name.endswith((".xls", ".ods", ".numbers")):
        raise _bad("Save the spreadsheet as Excel (.xlsx) or CSV, then choose that file.")
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = data.decode("latin-1")
    try:
        dialect = csv.Sniffer().sniff(text[:4096], delimiters=",;\t|")
        delim = dialect.delimiter
    except csv.Error:
        delim = ","
    return [[c.strip() for c in r] for r in csv.reader(io.StringIO(text), delimiter=delim)]


def read(filename: str, data: bytes) -> list[dict]:
    """[{row, email, name, role, team, projects}] with the spreadsheet's own row numbers (the header is row 1)."""
    if len(data) > MAX_BYTES:
        raise _bad("The file is over 1 MB. Split it into smaller files.")
    rows = _table(filename, data)
    while rows and not any(rows[0]):
        rows.pop(0)
    if not rows:
        raise _bad("The file is empty.")
    head = [h.strip().lower().replace("*", "") for h in rows[0]]
    where = {}
    for key, names in COLUMNS.items():
        for i, h in enumerate(head):
            if h in names and key not in where:
                where[key] = i
    missing = [k for k in ("email", "name") if k not in where]
    if missing:
        raise _bad(f"The first row must name the columns, with at least “email” and “name”. Missing: {', '.join(missing)}.")
    out = []
    for n, r in enumerate(rows[1:], start=2):
        if not any(c.strip() for c in r):
            continue
        cell = lambda k: (r[where[k]].strip() if k in where and where[k] < len(r) else "")   # noqa: E731
        out.append({"row": n, "email": cell("email").lower(), "name": " ".join(cell("name").split()), "role": cell("role"),
                    "team": cell("team") or None,
                    "projects": [p.strip() for p in cell("projects").split(";") if p.strip()]})
    if not out:
        raise _bad("The file has a header row but no people.")
    if len(out) > MAX_ROWS:
        raise _bad(f"Up to {MAX_ROWS} people at a time. Split the file.")
    return out


def role_of(raw: str, default: str) -> str | None:
    return default if not raw.strip() else ROLES.get(" ".join(raw.strip().lower().split()))
