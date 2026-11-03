"""GeoEstate staff and what each role may do in the staff console.

The emails in PLATFORM_ADMINS are always super admins (so the first one can sign in before anyone is added). Super
admins add and remove other staff from the console, with one of four roles. Staff must use two-step sign-in."""
from fastapi import Depends

from .config import settings
from .deps import current_user, platform_admin_emails
from .errors import Problem

ROLES = ("super_admin", "account_manager", "support", "finance")
ROLE_NAMES = {"super_admin": "Super admin", "account_manager": "Account manager", "support": "Support", "finance": "Finance"}

# What each role can do. Viewing customers, licences and the staff activity log is open to every role.
PERMS = {
    "customers.view": ROLES,
    "audit.view": ROLES,
    "customers.support": ("super_admin", "account_manager", "support"),     # resend links, reset 2-step, notes
    "licences.edit": ("super_admin", "account_manager"),                    # set up, renew, change, suspend
    "requests.edit": ("super_admin", "account_manager"),
    "staff.manage": ("super_admin",),
}


async def role_of(conn, user: dict | None) -> str | None:
    if not user:
        return None
    if user["email"].lower() in platform_admin_emails():
        return "super_admin"
    cur = await conn.execute("SELECT role FROM platform_staff WHERE user_id = %s", (user["id"],))
    row = await cur.fetchone()
    return row["role"] if row else None


def can(role: str | None, perm: str) -> bool:
    return bool(role) and role in PERMS[perm]


def perms_of(role: str | None) -> list[str]:
    return [p for p in PERMS if can(role, p)]


async def emails(conn, roles=("super_admin", "account_manager")) -> set[str]:
    """Who hears about new requests and renewals: the PLATFORM_ADMINS plus staff with these roles."""
    cur = await conn.execute("SELECT lower(u.email) AS email FROM platform_staff s JOIN users u ON u.id = s.user_id "
                             "WHERE s.role = ANY(%s)", (list(roles),))
    return platform_admin_emails() | {r["email"] for r in await cur.fetchall()}


def staff(perm: str = "customers.view"):
    """Dependency: a staff member allowed `perm`. Everyone else gets 404, so the console is not revealed."""
    from .db import get_conn

    async def dep(user=Depends(current_user), conn=Depends(get_conn)) -> dict:
        role = await role_of(conn, user)
        if not role:
            raise Problem(404, "Not found.", code="not_found")
        if settings.staff_require_mfa and not user["mfa_enabled"]:
            raise Problem(403, "Staff must use two-step sign-in. Turn it on under Account security, then come back.",
                          code="staff_mfa_required")
        if not can(role, perm):
            raise Problem(403, f"Your staff role ({ROLE_NAMES[role]}) cannot do this.", code="forbidden")
        return {**user, "staff_role": role}
    return dep
