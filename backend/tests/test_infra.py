import psycopg
from redis import Redis
from rq import SimpleWorker, Queue

from app.config import settings
from conftest import change, pt
from test_datasets import publish, setup_dataset_project


def test_health(client):
    assert client.get("/health").json() == {"ok": True}
    r = client.get("/health/ready")
    assert r.status_code == 200 and r.json() == {"ok": True, "database": True, "redis": True, "storage": True}


def test_martin_tile_function_returns_mvt_for_the_right_project_only(project):
    o = project.owner
    o.post("/sync/push", json={"project_id": project.id, "changes": [change(project, geometry=pt(3.39, 6.52))]})
    q = "SELECT length(feature_tiles(%s, %s, %s, json_build_object('project_id', %s::text, 'form_id', %s::text)))"
    with psycopg.connect(settings.database_url) as c:
        # tile 0/0/0 covers the world; a different project's id must return an empty tile
        full = c.execute(q, (0, 0, 0, project.id, project.form_id)).fetchone()[0]
        other = c.execute(q, (0, 0, 0, "00000000-0000-0000-0000-000000000000", project.form_id)).fetchone()[0]
    assert full > 20 and other == 0


def test_jobs_run_through_the_real_queue_and_worker(project, client, monkeypatch):
    """Production path: API enqueues to Redis, a worker process picks the job up (here: in-process burst)."""
    form_id, _ = setup_dataset_project(project)
    slug = publish(project, form_id, slug=f"q-{project.id[:8]}").json()["dataset"]["slug"]
    monkeypatch.setattr(settings, "jobs_inline", False)
    r = client.post(f"/datasets/{slug}/exports", json={"format": "shp"})
    assert r.status_code == 202 and r.json()["status"] == "queued"
    assert client.get(f"/jobs/{r.json()['id']}").json()["status"] == "queued"
    redis = Redis.from_url(settings.redis_url)
    SimpleWorker([Queue("default", connection=redis)], connection=redis).work(burst=True)
    job = client.get(f"/jobs/{r.json()['id']}").json()
    assert job["status"] == "done" and job["progress"] == 100 and job["result"]["download_url"].startswith("http")
