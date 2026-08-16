import datetime
import hashlib
import hmac
import json
import os
import urllib.error
import urllib.parse
import urllib.request


BUCKET = os.environ.get("BUCKET", "lunarreturns")
S3_HOST = os.environ.get("S3_HOST", "storage.yandexcloud.net")
REGION = os.environ.get("REGION", "ru-central1")
SERVICE = "s3"
EXPIRES = int(os.environ.get("EXPIRES", "600"))
ACCESS_KEY = os.environ.get("S3_ACCESS_KEY_ID", "")
SECRET_KEY = os.environ.get("S3_SECRET_ACCESS_KEY", "")
ALLOWED_UIDS = os.environ.get("ALLOWED_UIDS", "")

LOGIN_INFO_URL = "https://login.yandex.ru/info"


def _response(status, body, extra_headers=None):
    headers = {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
    }
    headers.update(extra_headers or {})
    return {
        "statusCode": status,
        "headers": headers,
        "body": json.dumps(body, ensure_ascii=False),
    }


def _verify_token(token):
    req = urllib.request.Request(
        LOGIN_INFO_URL,
        headers={"Authorization": "OAuth " + token},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            info = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, ValueError, OSError):
        return None
    uid = info.get("id")
    return str(uid) if uid else None


def _sign(key, msg):
    return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()


def _presign(method, key):
    now = datetime.datetime.now(datetime.timezone.utc)
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    date_stamp = now.strftime("%Y%m%d")
    scope = "/".join([date_stamp, REGION, SERVICE, "aws4_request"])

    canonical_uri = "/" + "/".join(
        urllib.parse.quote(p, safe="") for p in [BUCKET] + key.split("/")
    )
    query = {
        "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
        "X-Amz-Credential": ACCESS_KEY + "/" + scope,
        "X-Amz-Date": amz_date,
        "X-Amz-Expires": str(EXPIRES),
        "X-Amz-SignedHeaders": "host",
    }
    canonical_query = "&".join(
        urllib.parse.quote(k, safe="") + "=" + urllib.parse.quote(v, safe="")
        for k, v in sorted(query.items())
    )
    canonical_request = "\n".join([
        method,
        canonical_uri,
        canonical_query,
        "host:" + S3_HOST + "\n",
        "host",
        "UNSIGNED-PAYLOAD",
    ])
    string_to_sign = "\n".join([
        "AWS4-HMAC-SHA256",
        amz_date,
        scope,
        hashlib.sha256(canonical_request.encode("utf-8")).hexdigest(),
    ])
    date_key = _sign(("AWS4" + SECRET_KEY).encode("utf-8"), date_stamp)
    region_key = _sign(date_key, REGION)
    service_key = _sign(region_key, SERVICE)
    request_key = _sign(service_key, "aws4_request")
    signature = _sign(request_key, string_to_sign).hex()
    return "https://{host}{uri}?{query}&X-Amz-Signature={sig}".format(
        host=S3_HOST, uri=canonical_uri, query=canonical_query, sig=signature
    )


def handler(event, context):
    if event.get("httpMethod") == "OPTIONS":
        return _response(200, {})

    try:
        body = json.loads(event.get("body") or "{}")
    except ValueError:
        return _response(400, {"error": "bad json"})

    token = body.get("token", "")
    action = body.get("action", "")
    if action not in ("get", "put"):
        return _response(400, {"error": "action must be get or put"})

    uid = _verify_token(token)
    if not uid:
        return _response(401, {"error": "invalid token"})
    if ALLOWED_UIDS and uid not in ALLOWED_UIDS.split(","):
        return _response(403, {"error": "uid not allowed"})

    if not ACCESS_KEY or not SECRET_KEY:
        return _response(500, {"error": "S3 keys not configured"})

    method = "GET" if action == "get" else "PUT"
    url = _presign(method, "users/" + uid + "/db.json")
    return _response(200, {"url": url})
