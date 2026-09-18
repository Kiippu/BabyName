"""POST/DELETE /api/push/subscribe and send_push. CO-4 §12.

Both routes are gated normally (not in app.py's ALLOWLIST) -- a subscription
belongs to a signed-in parent, bound via g.user_id the same way every other
write in this app is. send_push is the other half: called from app.py's
POST /api/set handler, after lock_set's own transaction has already
committed, so a push failure can never roll back or block a seal.
"""

import json
import os

from flask import Blueprint, g, jsonify, request
from pywebpush import WebPushException, webpush

from db import get_db
from transaction import immediate

bp = Blueprint("push", __name__)

UPSERT_SQL = """
    INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth
"""
DELETE_BY_ENDPOINT_SQL = "DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?"
SUBS_FOR_USER_SQL = "SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?"
DELETE_BY_ID_SQL = "DELETE FROM push_subscriptions WHERE id = ?"


@bp.post("/api/push/subscribe")
def subscribe():
    body = request.get_json(silent=True) or {}
    endpoint = body.get("endpoint")
    keys = body.get("keys") if isinstance(body.get("keys"), dict) else {}
    p256dh, auth = keys.get("p256dh"), keys.get("auth")
    if not all(isinstance(v, str) and v for v in (endpoint, p256dh, auth)):
        return jsonify({"error": "endpoint and keys.p256dh/auth are required"}), 400
    conn = get_db()
    with immediate(conn):
        conn.execute(UPSERT_SQL, (g.user_id, endpoint, p256dh, auth))
    return jsonify({"ok": True})


@bp.delete("/api/push/subscribe")
def unsubscribe():
    body = request.get_json(silent=True) or {}
    endpoint = body.get("endpoint")
    if not isinstance(endpoint, str) or not endpoint:
        return jsonify({"error": "endpoint is required"}), 400
    conn = get_db()
    with immediate(conn):
        conn.execute(DELETE_BY_ENDPOINT_SQL, (endpoint, g.user_id))
    return jsonify({"ok": True})


def send_push(user_id, title, body):
    """Best-effort notify of one user's subscriptions. Must NEVER raise into
    the caller -- POST /api/set's seal has already committed by the time this
    runs, and a push provider hiccup can't be allowed to turn into a 500 on a
    successful set lock. Every failure mode (missing VAPID config, network
    error, timeout, a bad subscription) is swallowed here."""
    try:
        _send_push(user_id, title, body)
    except Exception:
        pass


def _send_push(user_id, title, body):
    private_key = os.environ.get("NAMEPLATE_VAPID_PRIVATE")
    sub = os.environ.get("NAMEPLATE_VAPID_SUB")
    if not private_key or not sub:
        return  # not configured (local dev) -- silently a no-op, not an error

    conn = get_db()
    rows = conn.execute(SUBS_FOR_USER_SQL, (user_id,)).fetchall()
    expired_ids = []
    for row in rows:
        subscription_info = {
            "endpoint": row["endpoint"],
            "keys": {"p256dh": row["p256dh"], "auth": row["auth"]},
        }
        try:
            webpush(
                subscription_info=subscription_info,
                data=json.dumps({"title": title, "body": body}),
                vapid_private_key=private_key,
                vapid_claims={"sub": sub},
                timeout=3,
            )
        except WebPushException as exc:
            # Expired subscriptions are the usual cause of "push quietly
            # stopped working" months later -- CO-4 §12. Anything else (a
            # transient 5xx, a timeout) is left alone; only a definitive
            # "this endpoint is gone" response prunes the row.
            status = exc.response.status_code if exc.response is not None else None
            if status in (404, 410):
                expired_ids.append(row["id"])
        except Exception:
            continue

    if expired_ids:
        with immediate(conn):
            for sub_id in expired_ids:
                conn.execute(DELETE_BY_ID_SQL, (sub_id,))
