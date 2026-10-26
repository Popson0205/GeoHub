"""Prove the latest backup restores.   python -m app.ops.restore_test

Downloads the newest backup, restores it into a scratch database, checks the core tables are present and
readable, then drops the scratch database. Exits non-zero on any problem so a scheduler can alert.
Set RESTORE_TEST_DATABASE_URL if the app's database user cannot CREATE DATABASE."""
import logging
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import psycopg
from psycopg.conninfo import make_conninfo

from .. import logging_setup, storage
from ..config import settings
from .backup import PREFIX

log = logging.getLogger("restore-test")


def latest_backup() -> str:
    keys = []
    for page in storage.internal.get_paginator("list_objects_v2").paginate(Bucket=settings.s3_bucket, Prefix=PREFIX):
        keys += [o["Key"] for o in page.get("Contents", [])]
    if not keys:
        raise RuntimeError("no backups found")
    return sorted(keys)[-1]


def run() -> dict:
    admin_url = os.environ.get("RESTORE_TEST_DATABASE_URL") or settings.database_url
    scratch = f"hub_restore_test_{datetime.now(timezone.utc):%Y%m%d%H%M%S}"
    scratch_url = make_conninfo(admin_url, dbname=scratch)
    key = latest_backup()
    with psycopg.connect(admin_url, autocommit=True) as admin:
        admin.execute(f'CREATE DATABASE "{scratch}"')
    try:
        with tempfile.TemporaryDirectory() as d:
            dump = Path(d) / "restore.dump"
            storage.internal.download_file(settings.s3_bucket, key, str(dump))
            subprocess.run(["pg_restore", "--no-owner", "--exit-on-error", "--dbname", scratch_url, str(dump)], check=True)
        counts = {}
        with psycopg.connect(scratch_url) as c:
            for t in ("users", "projects", "forms", "features", "datasets", "audit_log"):
                counts[t] = c.execute(f"SELECT count(*) FROM {t}").fetchone()[0]
            c.execute("SELECT PostGIS_Version()")
        log.info("restore verified", extra={"ctx": {"backup": key, "counts": counts}})
        return {"backup": key, "counts": counts}
    finally:
        with psycopg.connect(admin_url, autocommit=True) as admin:
            admin.execute(f'DROP DATABASE IF EXISTS "{scratch}" WITH (FORCE)')


if __name__ == "__main__":
    logging_setup.setup()
    try:
        run()
    except Exception:  # noqa: BLE001
        log.exception("restore test FAILED")
        sys.exit(1)
