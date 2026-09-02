import base64
import datetime
import hashlib
import hmac
import json
import os
import re
import time
import urllib.error
import urllib.parse
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

# ВК-мини-апп (app_id 54746591): подписки и ежедневная отправка.
VK_APP_SECRET = os.environ.get("VK_APP_SECRET", "")
VK_SERVICE_TOKEN = os.environ.get("VK_SERVICE_TOKEN", "")
VK_SUBS_KEY = "push/vk_subs.json"
VK_ORIGIN_RE = re.compile(
    r"^https://(prod|stage)-app54746591-[a-z0-9]+\.pages\.vk-apps\.(ru|com)$")
# Общий текст без ПДн: сервер знает только обезличенные MM-DD.
VK_PUSH_TEXT = "Сегодня есть поводы — откройте «Лунно-солнечные юбилеи»"
VK_API_URL = "https://api.vk.com/method/execute.push"
VK_API_V = "5.199"
VK_SEND_PERIOD = 0.34  # ~3 rps
VK_SEND_CAP = 60  # уложиться в таймаут функции 30s
VK_MAX_FAILS = 7  # подряд неудачных отправок до удаления подписки


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


def _load_subs(key=SUBS_KEY):
    status, text = _s3_request("GET", key)
    if status == 404:
        return []
    if status != 200:
        raise RuntimeError("S3 GET subs: " + str(status))
    try:
        subs = json.loads(text)
    except ValueError:
        return []
    return subs if isinstance(subs, list) else []


def _save_subs(subs, key=SUBS_KEY):
    status, text = _s3_request("PUT", key, json.dumps(subs))
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
    if not origin:
        # Небраузерный вызов (вебвью мобильного клиента, curl, таймер).
        # Веб-действия и так не аутентифицируются, vk_-действия защищены sign.
        return True
    return origin == ALLOWED_ORIGIN or bool(VK_ORIGIN_RE.match(origin))


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


# ---- ВК-мини-апп: подписки и отправка уведомлений ----

def _vk_sign_ok(params):
    """Проверка sign launch-параметров VK Mini App: md5 по отсортированным
    по ключу парам key=value всех параметров vk_* (без разделителей) +
    защищённый ключ приложения. Формулу сверять с dev.vk.com
    («Проверка подписи launch-параметров»)."""
    sign = str(params.get("sign", "")).lower()
    if not sign or not VK_APP_SECRET:
        return False
    plain = "".join(
        k + "=" + str(params[k]) for k in sorted(params) if k.startswith("vk_")
    ) + VK_APP_SECRET
    expected = hashlib.md5(plain.encode("utf-8")).hexdigest()
    return hmac.compare_digest(expected, sign)


def _vk_clean_dates(body):
    dates = body.get("dates")
    if not isinstance(dates, list) or len(dates) > MAX_DATES \
            or not all(isinstance(d, str) and DATE_RE.match(d) for d in dates):
        return None
    return dates


def _vk_subscribe(body):
    if not VK_APP_SECRET:
        return _response(500, {"error": "VK_APP_SECRET not configured"})
    params = body.get("launch_params")
    if not isinstance(params, dict) or not _vk_sign_ok(params):
        return _response(403, {"error": "bad sign"})
    uid = str(params.get("vk_user_id", ""))
    if not uid.isdigit() or len(uid) > 20:
        return _response(400, {"error": "bad vk_user_id"})
    dates = _vk_clean_dates(body)
    if dates is None:
        return _response(400, {"error": "bad dates"})
    subs = [s for s in _load_subs(VK_SUBS_KEY) if s.get("vk_user_id") != uid]
    subs.append({"vk_user_id": uid, "dates": dates})
    _save_subs(subs, VK_SUBS_KEY)
    return _response(200, {"ok": True})


def _vk_unsubscribe(body):
    if not VK_APP_SECRET:
        return _response(500, {"error": "VK_APP_SECRET not configured"})
    params = body.get("launch_params")
    if not isinstance(params, dict) or not _vk_sign_ok(params):
        return _response(403, {"error": "bad sign"})
    uid = str(params.get("vk_user_id", ""))
    if not uid.isdigit() or len(uid) > 20:
        return _response(400, {"error": "bad vk_user_id"})
    subs = _load_subs(VK_SUBS_KEY)
    kept = [s for s in subs if s.get("vk_user_id") != uid]
    if len(kept) != len(subs):
        _save_subs(kept, VK_SUBS_KEY)
    return _response(200, {"ok": True})


def _vk_send(user_id):
    """Отправка уведомления мини-аппа (метод execute.push; при смене метода
    по доке правится только здесь; кандидат-фолбэк — secure.sendNotification).
    Возвращает "ok" | "disabled" | "error: ...". VK API отвечает HTTP 200
    c {"error": {...}} при неудаче."""
    data = urllib.parse.urlencode({
        "user_ids": str(user_id),
        "message": VK_PUSH_TEXT,
        "access_token": VK_SERVICE_TOKEN,
        "v": VK_API_V,
    }).encode("utf-8")
    req = urllib.request.Request(VK_API_URL, data=data, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, ValueError, OSError) as e:
        return "error: " + str(e)
    err = body.get("error") or {}
    if err:
        msg = str(err.get("error_msg", ""))
        low = msg.lower()
        if any(w in low for w in ("отключ", "disabled", "не разреш", "not allowed", "запрещ")):
            return "disabled"
        return "error: " + str(err.get("error_code", msg[:80]))
    return "ok"


def _run_daily_vk():
    if not VK_SERVICE_TOKEN:
        return {"vk_error": "VK_SERVICE_TOKEN not configured"}
    subs = _load_subs(VK_SUBS_KEY)
    today = _today_md()
    due = [s for s in subs
           if any(d in today for d in (s.get("dates") or []) if isinstance(d, str))]
    if not due:
        return {"vk_sent": 0}
    skipped = max(0, len(due) - VK_SEND_CAP)
    if skipped:
        print("VK: due %d, sending first %d (cap)" % (len(due), VK_SEND_CAP))
    changed = False
    sent = failed = 0
    for sub in due[:VK_SEND_CAP]:
        res = _vk_send(sub.get("vk_user_id", ""))
        if res == "ok":
            sent += 1
            if sub.get("fails"):
                sub["fails"] = 0
                changed = True
        elif res == "disabled":
            # Пользователь отозвал разрешение — подписка больше не нужна.
            subs = [s for s in subs if s is not sub]
            changed = True
            failed += 1
        else:
            failed += 1
            fails = int(sub.get("fails", 0)) + 1
            if fails >= VK_MAX_FAILS:
                subs = [s for s in subs if s is not sub]
            else:
                sub["fails"] = fails
            changed = True
        time.sleep(VK_SEND_PERIOD)
    if changed:
        _save_subs(subs, VK_SUBS_KEY)
    return {"vk_sent": sent, "vk_failed": failed, "vk_skipped": skipped}


def handler(event, context):
    if event.get("httpMethod") == "OPTIONS":
        return _response(200, {})
    if "httpMethod" not in event:
        result = _run_daily()
        result.update(_run_daily_vk())
        return _response(200, result)
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
    if action == "vk_subscribe":
        return _vk_subscribe(body)
    if action == "vk_unsubscribe":
        return _vk_unsubscribe(body)
    return _response(400, {"error": "action must be subscribe, unsubscribe,"
                                   " vk_subscribe or vk_unsubscribe"})
