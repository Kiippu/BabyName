"""POST /api/gate -- replaces POST /api/me. CO-4 §1.1, §3.

The old route took a claim (`{userId}`) and no credential -- anyone who
could reach the URL could become either parent. This takes a credential and
mints the same kind of session (identity.start_session), so everything
downstream keeps working: sessionMiddleware's replacement in app.py, the
mePayload shape, the client's 401 handling and claim-screen fallback.
"""

import secrets
import time

from flask import Blueprint, jsonify, request
from werkzeug.security import check_password_hash, generate_password_hash

from db import get_db
from identity import SESSION_COOKIE, cookie_kwargs, start_session
from transaction import immediate

bp = Blueprint("gate", __name__)

# CO-4 §3 "Rules": 5 failures/IP/15min -> 15min lock; 30 failures globally in
# an hour -> 1hr lock (for a two-person app that many failures from anywhere
# is not a typo). Rows older than a day are pruned on write, same
# opportunistic pattern as sessions.
IP_WINDOW_MS = 15 * 60 * 1000
IP_LIMIT = 5
GLOBAL_WINDOW_MS = 60 * 60 * 1000
GLOBAL_LIMIT = 30
PRUNE_AGE_MS = 24 * 60 * 60 * 1000

# Used in place of a real pin_hash for a user who hasn't set a PIN yet, so
# check_password_hash still does the same shape of work for every user on
# every request -- comparing against BOTH users every time, even once one
# has matched, so response timing can't leak whose PIN it was (CO-4 §3).
_DUMMY_HASH = generate_password_hash(secrets.token_hex(16))


def _now_ms():
    return int(time.time() * 1000)


def _client_ip():
    # Behind PythonAnywhere's proxy, request.remote_addr is the proxy, not
    # the phone -- CO-4 §3. Read X-Forwarded-For, but its trustworthiness on
    # PythonAnywhere specifically hasn't been verified yet; if it turns out
    # to be unreliable, the global cap alone is sufficient for two users.
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.remote_addr or "unknown"


def _prune(conn, now):
    conn.execute("DELETE FROM gate_attempts WHERE at < ?", (now - PRUNE_AGE_MS,))


def _locked(conn, ip, now):
    ip_fails = conn.execute(
        "SELECT COUNT(*) AS n FROM gate_attempts WHERE ip = ? AND ok = 0 AND at > ?",
        (ip, now - IP_WINDOW_MS),
    ).fetchone()["n"]
    if ip_fails >= IP_LIMIT:
        return True
    global_fails = conn.execute(
        "SELECT COUNT(*) AS n FROM gate_attempts WHERE ok = 0 AND at > ?",
        (now - GLOBAL_WINDOW_MS,),
    ).fetchone()["n"]
    return global_fails >= GLOBAL_LIMIT


def _record(conn, ip, ok, now):
    with immediate(conn):
        conn.execute("INSERT INTO gate_attempts (ip, at, ok) VALUES (?, ?, ?)", (ip, now, 1 if ok else 0))


@bp.post("/api/gate")
def gate():
    conn = get_db()
    now = _now_ms()
    ip = _client_ip()

    with immediate(conn):
        _prune(conn, now)
    if _locked(conn, ip, now):
        return jsonify({"error": "That PIN isn't right."}), 429

    body = request.get_json(silent=True) or {}
    pin = body.get("pin")
    pin = pin if isinstance(pin, str) else ""

    users = conn.execute("SELECT id, name, surname, pin_hash FROM users ORDER BY id").fetchall()
    matched = None
    for u in users:
        stored = u["pin_hash"] or _DUMMY_HASH
        is_match = check_password_hash(stored, pin)
        if is_match and u["pin_hash"]:
            matched = u

    _record(conn, ip, matched is not None, now)

    if not matched:
        return jsonify({"error": "That PIN isn't right."}), 401

    token = start_session(conn, matched["id"])
    resp = jsonify({"userId": matched["id"], "label": matched["name"], "surname": matched["surname"]})
    resp.set_cookie(SESSION_COOKIE, token, **cookie_kwargs())
    return resp
