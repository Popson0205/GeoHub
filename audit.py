from psycopg.types.json import Jsonb


async def audit(conn, action: str, *, actor_id=None, project_id=None, target_type=None, target_id=None,
                ip: str | None = None, **details):
    await conn.execute(
        "INSERT INTO audit_log (actor_id, actor_ip, project_id, action, target_type, target_id, details) "
        "VALUES (%s, %s, %s, %s, %s, %s, %s)",
        (actor_id, ip, project_id, action, target_type, str(target_id) if target_id else None, Jsonb(details)))
