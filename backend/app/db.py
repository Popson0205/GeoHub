import logging
from contextlib import asynccontextmanager
from pathlib import Path

import psycopg
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from .config import settings

log = logging.getLogger("db")
MIGRATIONS = Path(__file__).resolve().parent.parent / "migrations"

# prepare_threshold=None: no server-side prepared statements, so a connection pooler (Supabase's Supavisor) can
# hand the same connection to different clients safely.
pool = AsyncConnectionPool(
    settings.database_url, open=False, min_size=1, max_size=settings.db_pool_max,
    kwargs={"row_factory": dict_row, "options": "-c statement_timeout=60000", "prepare_threshold": None})


def connect_sync() -> psycopg.Connection:
    """Plain connection for workers and scripts."""
    return psycopg.connect(settings.database_url, row_factory=dict_row, prepare_threshold=None)


def migrate() -> list[str]:
    """Apply any migrations/*.sql not yet recorded. Safe to run from several processes at once."""
    applied: list[str] = []
    with psycopg.connect(settings.database_url, autocommit=True) as conn:
        conn.execute("SELECT pg_advisory_lock(727274)")
        try:
            conn.execute("CREATE TABLE IF NOT EXISTS schema_migrations "
                         "(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())")
            done = {r[0] for r in conn.execute("SELECT name FROM schema_migrations")}
            for f in sorted(MIGRATIONS.glob("*.sql")):
                if f.name in done:
                    continue
                with conn.transaction():
                    conn.execute(f.read_text())
                    conn.execute("INSERT INTO schema_migrations (name) VALUES (%s)", (f.name,))
                applied.append(f.name)
                log.info("applied migration %s", f.name)
            conn.execute("SELECT hub_lockdown()")        # keeps new tables closed to Supabase's Data API (003)
        finally:
            conn.execute("SELECT pg_advisory_unlock(727274)")
    return applied


@asynccontextmanager
async def lifespan(app):
    import anyio
    await anyio.to_thread.run_sync(migrate)
    await pool.open()
    yield
    await pool.close()


async def get_conn():
    """One transaction per request: commits on success, rolls back on any error."""
    async with pool.connection() as conn:
        yield conn


async def reserve_seq(conn, project_id, n: int = 1) -> int:
    """Reserve n sequence numbers for a project; returns the first. Holds the project row lock
    until commit, which serialises writers so pull cursors never skip a change."""
    cur = await conn.execute(
        "UPDATE projects SET seq_counter = seq_counter + %s, last_activity_at = now() "
        "WHERE id = %s RETURNING seq_counter", (n, project_id))
    return (await cur.fetchone())["seq_counter"] - n + 1
