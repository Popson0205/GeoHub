import shutil

import pytest

pytestmark = pytest.mark.skipif(not shutil.which("pg_dump"), reason="needs PostgreSQL client tools")


def test_backup_and_verified_restore(project):
    from app.ops import backup, restore_test
    key = backup.run()
    assert key.startswith("backups/hub-") and key.endswith(".dump")
    out = restore_test.run()
    assert out["backup"].startswith("backups/hub-")
    assert out["counts"]["projects"] >= 1 and out["counts"]["users"] >= 1
