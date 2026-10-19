import anyio
import boto3
from botocore.client import Config

from .config import settings


def _region() -> str:
    """S3_REGION must be a region name ("auto" for Cloudflare R2). A URL pasted here crashes boto3 at import."""
    r = (settings.s3_region or "").strip()
    if not r or "://" in r or "/" in r or "." in r:
        return "auto" if "r2.cloudflarestorage.com" in (settings.s3_endpoint or "") else "us-east-1"
    return r


def _client(endpoint: str):
    return boto3.client(
        "s3", endpoint_url=endpoint, aws_access_key_id=settings.s3_access_key,
        aws_secret_access_key=settings.s3_secret_key, region_name=_region(),
        config=Config(signature_version="s3v4", s3={"addressing_style": "path"}))


internal = _client(settings.s3_endpoint)            # API and worker traffic
public = _client(settings.s3_public_endpoint)       # signs URLs that browsers and phones will call
B = settings.s3_bucket


async def run(fn, *a, **kw):
    return await anyio.to_thread.run_sync(lambda: fn(*a, **kw))


def presign_put(key: str, content_type: str, expires: int = 3600) -> str:
    return public.generate_presigned_url("put_object", ExpiresIn=expires,
                                         Params={"Bucket": B, "Key": key, "ContentType": content_type})


def presign_get(key: str, filename: str | None = None, expires: int = 3600) -> str:
    params = {"Bucket": B, "Key": key}
    if filename:
        params["ResponseContentDisposition"] = f'attachment; filename="{filename}"'
    return public.generate_presigned_url("get_object", Params=params, ExpiresIn=expires)


def presign_part(key: str, upload_id: str, part: int, expires: int = 6 * 3600) -> str:
    return public.generate_presigned_url(
        "upload_part", ExpiresIn=expires,
        Params={"Bucket": B, "Key": key, "UploadId": upload_id, "PartNumber": part})


def head(key: str) -> dict | None:
    try:
        return internal.head_object(Bucket=B, Key=key)
    except internal.exceptions.ClientError:
        return None


def delete_keys(*keys: str):
    keys = [k for k in keys if k]
    if keys:
        internal.delete_objects(Bucket=B, Delete={"Objects": [{"Key": k} for k in keys]})


def delete_prefix(prefix: str):
    pag = internal.get_paginator("list_objects_v2")
    for page in pag.paginate(Bucket=B, Prefix=prefix):
        delete_keys(*[o["Key"] for o in page.get("Contents", [])])
