"""Daily database backup to object storage.   python -m app.ops.backup

Writes backups/hub-<UTC timestamp>.dump (pg_dump custom format) and deletes backups older than
BACKUP_RETENTION_DAYS. Run it on a schedule (see docker-compose `backup` service or a Railway cron job)."""
import logging
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .. import logging_setup, storage
from ..config import settings

log = logging.getLogger("backup")
PREFIX = "backups/"


def run() -> str:
    key = f"{PREFIX}hub-{datetime.now(timezone.utc):%Y%m%dT%H%M%SZ}.dump"
    with tempfile.TemporaryDirectory() as d:
        dump = Path(d) / "hub.dump"
        subprocess.run(["pg_dump", "--format=custom", "--no-owner", "--dbname", settings.database_url,
                        "--file", str(dump)], check=True)
        storage.internal.upload_file(str(dump), settings.s3_bucket, key)
        log.info("backup written", extra={"ctx": {"key": key, "bytes": dump.stat().st_size}})
    cutoff = datetime.now(timezone.utc) - timedelta(days=settings.backup_retention_days)
    old = []
    for page in storage.internal.get_paginator("list_objects_v2").paginate(Bucket=settings.s3_bucket, Prefix=PREFIX):
        old += [o["Key"] for o in page.get("Contents", []) if o["LastModified"] < cutoff]
    storage.delete_keys(*old)
    if old:
        log.info("old backups removed", extra={"ctx": {"count": len(old)}})
    return key


if __name__ == "__main__":
    logging_setup.setup()
    try:
        run()
    except Exception:  # noqa: BLE001
        log.exception("backup failed")
        sys.exit(1)
