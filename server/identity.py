"""Session cookie handling, ported from server/src/identity.js.

CO-4 §3's "session TTL has to change" section: with PINs replacing the old
claim-by-tap model, the reason for a short session (a shared phone stuck as
the wrong person, with no self-service fix) is gone -- you just re-enter your
own PIN. Recommendation taken: 30-day sliding, `secure` on the cookie now
that the site is HTTPS. If this household ever goes back to one shared
phone instead of one-per-parent, shorten SESSION_TTL_MS back down toward 15
minutes so the idle timeout becomes the blind-reveal defence again -- see the
long comment in server/src/identity.js this replaces.

CO-4 §5 drops `candidates` from mePayload -- there is nothing to pick from
any more, the PIN itself is the claim.
"""

import secrets
import time

from transaction import immediate

SESSION_COOKIE = "nameplate_session"
SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000  # 30 days, sliding. See module docstring.


def _now_ms():
    return int(time.time() * 1000)


def cookie_kwargs():
    return dict(httponly=True, samesite="Lax", secure=True, max_age=SESSION_TTL_MS // 1000)


def resolve_session(conn, token):
    """Returns {"userId": ...} for a still-valid token, else None -- and
    deletes the row if it was present but expired, same opportunistic
    cleanup identity.js did inline."""
    if not token:
        return None
    row = conn.execute(
        "SELECT user_id AS userId, expires_at AS expiresAt FROM sessions WHERE token = ?", (token,)
    ).fetchone()
    if row and row["expiresAt"] > _now_ms():
        return {"userId": row["userId"]}
    if row:
        with immediate(conn):
            conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
    return None


def touch_session(conn, token):
    """Slides the expiry forward. Called once per request that carried a
    valid session, mirroring identity.js's sessionMiddleware."""
    expires_at = _now_ms() + SESSION_TTL_MS
    with immediate(conn):
        conn.execute("UPDATE sessions SET expires_at = ? WHERE token = ?", (expires_at, token))
    return expires_at


def start_session(conn, user_id):
    """Mints a fresh session for a user who just passed the PIN gate
    (gate.py). Ports selectProfile's opportunistic sweep of expired rows."""
    now = _now_ms()
    token = secrets.token_hex(32)
    with immediate(conn):
        conn.execute("DELETE FROM sessions WHERE expires_at < ?", (now,))
        conn.execute(
            "INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)",
            (token, user_id, now + SESSION_TTL_MS),
        )
    return token


def me_payload(conn, user_id):
    user = None
    if user_id is not None:
        user = conn.execute("SELECT id, name, surname FROM users WHERE id = ?", (user_id,)).fetchone()
    return {
        "userId": user_id,
        "label": user["name"] if user else None,
        "surname": user["surname"] if user else None,
        "claimed": user_id is not None,
    }
