import base64
import datetime
import json
import os
import re
import time
import urllib.error
import urllib.request

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import (
    decode_dss_signature,
)

from handler import _presign, _response


BUCKET = os.environ.get("BUCKET", "lunarreturns")
VAPID_PRIVATE = os.environ.get("VAPID_PRIVATE", "")
VAPID_PUBLIC = os.environ.get("VAPID_PUBLIC", "")
VAPID_SUBJECT = os.environ.get("VAPID_SUBJECT", "mailto:abakum@users.noreply.github.com")
ALLOWED_ORIGIN = os.environ.get("ALLOWED_ORIGIN", "https://abakum.github.io")
SUBS_KEY = "push/subscriptions.json"
MAX_DATES = 200
DATE_RE = re.compile(r"^\d{2}-\d{2}$")
TTL = 86400


def _b64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(s):
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)


def _vapid_keys():
    raw = _b64url_decode(VAPID_PRIVATE)
    if len(raw) != 32:
        raise ValueError("VAPID_PRIVATE must be a base64url-encoded 32-byte key")
    priv = ec.derive_private_key(int.from_bytes(raw, "big"), ec.SECP256R1())
    pub = priv.public_key().public_numbers()
    pub_raw = b"\x04" + pub.x.to_bytes(32, "big") + pub.y.to_bytes(32, "big")
    return priv, _b64url(pub_raw)


def _vapid_auth(endpoint):
    priv, pub_b64 = _vapid_keys()
    header = _b64url(json.dumps({"typ": "JWT", "alg": "ES256"}).encode())
    claims = _b64url(json.dumps({
        "aud": "/".join(endpoint.split("/")[:3]),
        "exp": int(time.time()) + 12 * 3600,
        "sub": VAPID_SUBJECT,
    }).encode())
    signing_input = (header + "." + claims).encode("ascii")
    der_sig = priv.sign(signing_input, ec.ECDSA(hashes.SHA256()))
    r, s = decode_dss_signature(der_sig)
    sig = r.to_bytes(32, "big") + s.to_bytes(32, "big")
    return "vapid t=" + header + "." + claims + "." + _b64url(sig) + ", k=" + pub_b64


def _s3_request(method, key, body=None):
    url = _presign(method, key)
    data = body.encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status, resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")


def _load_subs():
    status, text = _s3_request("GET", SUBS_KEY)
    if status == 404:
        return []
    if status != 200:
        raise RuntimeError("S3 GET subs: " + str(status))
    try:
        subs = json.loads(text)
    except ValueError:
        return []
    return subs if isinstance(subs, list) else []


def _save_subs(subs):
    status, text = _s3_request("PUT", SUBS_KEY, json.dumps(subs))
    if status != 200:
        raise RuntimeError("S3 PUT subs: " + str(status) + " " + text[:200])


def _clean_sub(sub):
    keys = sub.get("keys", {})
    endpoint = sub.get("endpoint", "")
    if not isinstance(endpoint, str) or not endpoint.startswith("https://"):
        return None
    if not isinstance(keys, dict) or not keys.get("p256dh") or not keys.get("auth"):
        return None
    return {"endpoint": endpoint, "p256dh": keys["p256dh"], "auth": keys["auth"]}


def _today_md():
    now = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=3)))
    md = now.strftime("%m-%d")
    leap = now.year % 4 == 0 and (now.year % 100 != 0 or now.year % 400 == 0)
    if md == "02-28" and not leap:
        return (md, "02-29")
    return (md,)


def _origin_allowed(event):
    headers = {k.lower(): v for k, v in (event.get("headers") or {}).items()}
    origin = headers.get("origin", "")
    return origin == ALLOWED_ORIGIN


def _send_push(sub, auth):
    req = urllib.request.Request(
        sub["endpoint"],
        data=b"",
        method="POST",
        headers={
            "Authorization": auth,
            "TTL": str(TTL),
            "Content-Length": "0",
            "Urgency": "normal",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status
    except urllib.error.HTTPError as e:
        return e.code


def _run_daily():
    if not VAPID_PRIVATE:
        return {"error": "VAPID_PRIVATE not configured"}
    subs = _load_subs()
    if not subs:
        return {"sent": 0}
    today = _today_md()
    changed = False
    sent = failed = 0
    for sub in subs:
        dates = sub.get("dates") or []
        if not any(d in today for d in dates if isinstance(d, str)):
            continue
        try:
            auth = _vapid_auth(sub["endpoint"])
        except ValueError as e:
            failed += 1
            changed = True
            continue
        code = _send_push(sub, auth)
        if code in (404, 410):
            subs = [s for s in subs if s is not sub]
            changed = True
            failed += 1
        elif 200 <= code < 300:
            sent += 1
        else:
            failed += 1
    if changed:
        _save_subs(subs)
    return {"date": today[0], "sent": sent, "failed": failed}


def _subscribe(body):
    sub = _clean_sub(body.get("subscription") or {})
    if not sub:
        return _response(400, {"error": "bad subscription"})
    dates = body.get("dates")
    if not isinstance(dates, list) or len(dates) > MAX_DATES \
            or not all(isinstance(d, str) and DATE_RE.match(d) for d in dates):
        return _response(400, {"error": "bad dates"})
    sub["dates"] = dates
    subs = [s for s in _load_subs() if s.get("endpoint") != sub["endpoint"]]
    subs.append(sub)
    _save_subs(subs)
    return _response(200, {"ok": True})


def _unsubscribe(body):
    endpoint = body.get("endpoint", "")
    if not isinstance(endpoint, str) or not endpoint:
        return _response(400, {"error": "bad endpoint"})
    subs = _load_subs()
    kept = [s for s in subs if s.get("endpoint") != endpoint]
    if len(kept) != len(subs):
        _save_subs(kept)
    return _response(200, {"ok": True})


def handler(event, context):
    if event.get("httpMethod") == "OPTIONS":
        return _response(200, {})
    if "httpMethod" not in event:
        return _response(200, _run_daily())
    if not _origin_allowed(event):
        return _response(403, {"error": "origin not allowed"})
    try:
        body = json.loads(event.get("body") or "{}")
    except ValueError:
        return _response(400, {"error": "bad json"})
    action = body.get("action", "")
    if action == "subscribe":
        return _subscribe(body)
    if action == "unsubscribe":
        return _unsubscribe(body)
    return _response(400, {"error": "action must be subscribe or unsubscribe"})
