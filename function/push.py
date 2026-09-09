import base64
import datetime
import hashlib
import hmac
import json
import os
import random
import re
import time
import urllib.error
import urllib.parse
import urllib.request

try:
    from zoneinfo import ZoneInfo
    _MSK = ZoneInfo("Europe/Moscow")
except Exception:  # нет tzdata — прежнее поведение
    _MSK = datetime.timezone(datetime.timedelta(hours=3))

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

# SSRF-гигиена: подписка принимает endpoint только у публичных push-сервисов
# (иначе кто угодно может заставить сервер ежедневно ходить по произвольному
# URL с VAPID-JWT в заголовке). Переопределяется переменной окружения.
PUSH_HOSTS = {h.strip() for h in os.environ.get(
    "PUSH_HOSTS",
    "fcm.googleapis.com,updates.push.services.mozilla.com,web.push.apple.com",
).split(",") if h.strip()}

# ВК-мини-апп (app_id 54746591): подписки и ежедневная отправка.
VK_APP_SECRET = os.environ.get("VK_APP_SECRET", "")
VK_SERVICE_TOKEN = os.environ.get("VK_SERVICE_TOKEN", "")
VK_SUBS_KEY = "push/vk_subs.json"
# VK-хостинг отдаёт мини-апп с *.pages.vk-apps.ru, прод может жить на
# *.pages-ac.vk-apps.ru — допускаем оба домена (ru/com).
VK_ORIGIN_RE = re.compile(
    r"^https://(prod|stage)-app54746591-[a-z0-9]+\.pages(-ac)?\.vk-apps\.(ru|com)\Z")
# Общий текст без ПДн: сервер знает только обезличенные MM-DD.
VK_PUSH_TEXT = "Сегодня есть поводы — откройте «Лунно-солнечные юбилеи»"
VK_API_URL = "https://api.vk.com/method/notifications.sendMessage"
VK_API_V = "5.199"
VK_SEND_PERIOD = 0.34  # пауза между чанками, ~3 rps
VK_CHUNK = 100  # максимум user_ids в одном notifications.sendMessage (дока)
VK_MAX_FAILS = 7  # подряд неудачных отправок до удаления подписки
# Защита от replay launch-параметров. Щедрое окно по умолчанию: фронт берёт
# location.search на момент действия, приложение может быть открыто давно.
VK_TS_MAX_AGE = int(os.environ.get("VK_TS_MAX_AGE", "86400"))
# Бюджеты времени таймерных веток (сек). Платформа допускает таймаут
# функции до 600 c и тарифицирует фактическое время — берём 120 c
# (см. deploy.sh) с запасом ~15 c на финальные _save_subs. Недоставленное
# НЕ переносится на завтра (механики pending нет): бюджеты определяют,
# сколько «сегодняшних» напоминаний реально уйдёт.
WEB_BUDGET = int(os.environ.get("PUSH_WEB_BUDGET", "45"))
VK_BUDGET = int(os.environ.get("PUSH_VK_BUDGET", "60"))


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
    host = urllib.parse.urlparse(endpoint).hostname or ""
    if host not in PUSH_HOSTS:
        return None
    if not isinstance(keys, dict) or not keys.get("p256dh") or not keys.get("auth"):
        return None
    return {"endpoint": endpoint, "p256dh": keys["p256dh"], "auth": keys["auth"]}


def _today_md():
    now = datetime.datetime.now(_MSK)
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


def _send_push(endpoint, auth):
    req = urllib.request.Request(
        endpoint,
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
    except (urllib.error.URLError, OSError) as e:
        # Сеть/DNS/таймаут — не признак мёртвой подписки: считаем failed,
        # но исключение не роняет всю рассылку.
        print("_send_push network error:", e)
        return -1


def _run_daily(deadline=None):
    if not VAPID_PRIVATE:
        return {"error": "VAPID_PRIVATE not configured"}
    subs = _load_subs()
    if not subs:
        return {"sent": 0}
    today = _today_md()
    # due — ТОЛЬКО дата «сегодня»: недоставленное не переносится на завтра
    # (напоминание «про сегодня» завтра бессмысленно — решение автора).
    # Дедлайн ограничивает ветку целиком: каждая отправка до 15 c таймаута.
    sent = failed = lost = 0
    changed = False
    drop_ids = set()
    due_idx = [i for i, s in enumerate(subs)
               if any(d in today for d in (s.get("dates") or []) if isinstance(d, str))]
    for n, i in enumerate(due_idx):
        sub = subs[i]
        if deadline is not None and time.monotonic() > deadline:
            # Не успели — сегодняшний остаток теряется (не «завтра»).
            lost = len(due_idx) - n
            print("web-push: deadline after %d, lost %d" % (n, lost))
            break
        endpoint = sub.get("endpoint")
        if not isinstance(endpoint, str) or not endpoint.startswith("https://"):
            # Битая запись (ручная правка JSON в S3) — выбрасываем без
            # AttributeError в _vapid_auth.
            failed += 1
            drop_ids.add(id(sub))
            changed = True
            continue
        try:
            auth = _vapid_auth(endpoint)
        except ValueError:
            # Битый VAPID-ключ — системная ошибка, не проблема подписки:
            # список не трогаем, считаем failed без изменений записи.
            failed += 1
            continue
        code = _send_push(endpoint, auth)
        if code in (404, 410):
            failed += 1  # подписка мертва — удаляем
            drop_ids.add(id(sub))
            changed = True
        elif 200 <= code < 300:
            sent += 1
        else:
            failed += 1  # сеть/персистентная ошибка — потеря, без переноса
    if drop_ids:
        subs = [s for s in subs if id(s) not in drop_ids]
    if changed:
        _save_subs(subs)
    return {"date": today[0], "sent": sent, "failed": failed, "lost": lost}


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
    """Проверка sign launch-параметров VK Mini App. Актуальный алгоритм
    (2023+) — HMAC-SHA256 по всем параметрам, кроме sign, отсортированным
    по ключу; секрет — защищённый ключ приложения. Легаси (старые приложения)
    — MD5 только по vk_*-параметрам + секрет в конце. Алгоритм различаем по
    длине подписи: 64 hex — HMAC-SHA256, иначе MD5. Формулы сверять с
    dev.vk.com («Проверка подписи launch-параметров»). Дополнительно
    проверяем свежесть vk_ts (защита от replay)."""
    sign = str(params.get("sign", "")).lower()
    if not sign or not VK_APP_SECRET:
        return False
    plain = "".join(
        k + "=" + str(params[k]) for k in sorted(params) if k != "sign"
    )
    if len(sign) == 64:  # актуальный алгоритм — HMAC-SHA256
        expected = hmac.new(
            VK_APP_SECRET.encode("utf-8"), plain.encode("utf-8"), hashlib.sha256
        ).hexdigest()
    else:  # легаси MD5
        legacy = "".join(
            k + "=" + str(params[k]) for k in sorted(params) if k.startswith("vk_")
        ) + VK_APP_SECRET
        expected = hashlib.md5(legacy.encode("utf-8")).hexdigest()
    if not hmac.compare_digest(expected, sign):
        return False
    if VK_TS_MAX_AGE > 0:
        try:
            ts = int(str(params.get("vk_ts", "")))
        except ValueError:
            return False
        if abs(time.time() - ts) > VK_TS_MAX_AGE:
            return False
    return True


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
    # lr_stage_probe — тест-байпас stage (разрешение до модерации
    # недоступно): храним запись с ПУСТЫМИ датами — пустой список
    # естественно исключает её из ежедневной рассылки, флаг в записи не
    # нужен. Проверку s.get("lr_stage_probe") в _run_daily_vk оставляем
    # для старых записей.
    rec = {"vk_user_id": uid, "dates": [] if body.get("lr_stage_probe") else dates}
    subs.append(rec)
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


def _vk_send_chunk(user_ids):
    """Батч-отправка уведомлений мини-аппа: один вызов
    notifications.sendMessage на ≤100 uid (документированный максимум
    user_ids; при смене метода по доке правится только здесь;
    кандидат-фолбэк — secure.sendNotification). Ответ — массив
    пер-пользовательских статусов {user_id, status, error:{code,...}}.
    Коды: 1 — уведомления отключены, 2/3 — часовой/суточный лимит,
    4 — приложение не установлено.
    Возвращает {"ok": [uid], "disabled": [uid], "limit": [uid],
    "failed": [uid], "fatal": str|None}."""
    data = urllib.parse.urlencode({
        "user_ids": ",".join(str(u) for u in user_ids),
        "message": VK_PUSH_TEXT,
        # random_id: дедуп одинакового уведомления в течение часа.
        "random_id": random.randint(0, 2 ** 31 - 1),
        "access_token": VK_SERVICE_TOKEN,
        "v": VK_API_V,
    }).encode("utf-8")
    req = urllib.request.Request(VK_API_URL, data=data, method="POST")
    res = {"ok": [], "disabled": [], "limit": [], "failed": [], "fatal": None}
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, ValueError, OSError) as e:
        # Сеть/битый JSON — не вина подписок: весь чанк failed без fails.
        print("_vk_send_chunk network error:", e)
        res["failed"] = [str(u) for u in user_ids]
        return res
    err = body.get("error")
    if err:
        # Топ-уровневая ошибка API — системная (токен/права/метод): не
        # считать фейлом подписок, иначе битый токен за VK_MAX_FAILS дней
        # вычистит всю базу.
        res["fatal"] = str(err.get("error_code",
                                   str(err.get("error_msg", ""))[:80]))
        return res
    by_uid = {str(r.get("user_id")): r for r in (body.get("response") or [])}
    for uid in user_ids:
        entry = by_uid.get(str(uid))
        if entry is None:
            res["failed"].append(str(uid))
            continue
        if entry.get("status"):
            res["ok"].append(str(uid))
            continue
        code = (entry.get("error") or {}).get("code")
        if code in (1, 4):
            # Уведомления отключены / приложение не установлено.
            res["disabled"].append(str(uid))
        elif code in (2, 3):
            res["limit"].append(str(uid))
        else:
            res["failed"].append(str(uid))
    return res


def _run_daily_vk(deadline=None):
    if not VK_SERVICE_TOKEN:
        return {"vk_error": "VK_SERVICE_TOKEN not configured"}
    subs = _load_subs(VK_SUBS_KEY)
    today = _today_md()
    # due — ТОЛЬКО дата «сегодня»: недоставленное не переносится на завтра
    # (напоминание «про сегодня» завтра бессмысленно — решение автора).
    # Пробные записи stage хранятся с пустыми dates — сюда не попадают.
    due = [s for s in subs
           if any(d in today for d in (s.get("dates") or []) if isinstance(d, str))]
    if not due:
        return {"vk_sent": 0}
    by_uid = {str(s.get("vk_user_id", "")): s for s in due}
    uids = [u for u in by_uid if u]
    sent = failed = lost = 0
    changed = False
    for i in range(0, len(uids), VK_CHUNK):
        chunk = uids[i:i + VK_CHUNK]
        if deadline is not None and time.monotonic() > deadline:
            # Не успели — сегодняшний остаток теряется (не «завтра»).
            lost += len(uids) - i
            print("VK: deadline, %d lost" % lost)
            break
        res = _vk_send_chunk(chunk)
        if res["fatal"]:
            # Системная ошибка: стоп без счётчика fails у подписок;
            # невыполненный остаток — потерян (не переносится).
            lost += len(uids) - i
            print("VK systemic error, aborting:", res["fatal"])
            break
        for uid in res["ok"]:
            sub = by_uid.get(uid)
            if sub and sub.get("fails"):
                sub["fails"] = 0
                changed = True
            sent += 1
        for uid in res["disabled"]:
            # Пользователь отозвал разрешение / снёс приложение.
            subs = [s for s in subs if str(s.get("vk_user_id")) != uid]
            failed += 1
            changed = True
        for uid in res["limit"]:
            # Часовой/суточный лимит VK: доставки нет, подписка жива —
            # fails не растит, повторять завтра нечего (дата уйдёт).
            failed += 1
        for uid in res["failed"]:
            sub = by_uid.get(uid)
            failed += 1
            if not sub:
                continue
            fails = int(sub.get("fails", 0)) + 1
            if fails >= VK_MAX_FAILS:
                subs = [s for s in subs if s is not sub]
            else:
                sub["fails"] = fails
            changed = True
        if i + VK_CHUNK < len(uids):
            time.sleep(VK_SEND_PERIOD)
    if changed:
        _save_subs(subs, VK_SUBS_KEY)
    return {"vk_sent": sent, "vk_failed": failed, "vk_lost": lost}


def handler(event, context):
    if event.get("httpMethod") == "OPTIONS":
        return _response(200, {})
    if "httpMethod" not in event:
        # Ветки независимы и ограничены бюджетами времени (сумма 105 c ≤
        # таймаута функции 120 c, запас ~15 c на финальные _save_subs):
        # web-рассылка не должна съесть время VK-ветки. VK отправляется
        # чанками по VK_CHUNK uid — бюджет почти не тратится.
        result = {}
        try:
            result.update(_run_daily(deadline=time.monotonic() + WEB_BUDGET))
        except Exception as e:
            print("_run_daily failed:", e)
        try:
            result.update(_run_daily_vk(deadline=time.monotonic() + VK_BUDGET))
        except Exception as e:
            print("_run_daily_vk failed:", e)
        return _response(200, result)
    if not _origin_allowed(event):
        return _response(403, {"error": "origin not allowed"})
    raw = event.get("body") or "{}"
    if event.get("isBase64Encoded"):
        try:
            raw = base64.b64decode(raw).decode("utf-8")
        except Exception:
            return _response(400, {"error": "bad body encoding"})
    try:
        body = json.loads(raw)
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
