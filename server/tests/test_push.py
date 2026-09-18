"""CO-4 §12: the subscribe/unsubscribe routes are gated like everything
else, and send_push must be provably incapable of raising into a caller --
a push provider hiccup can never be allowed to turn a successful set lock
into a 500. Runs against a throwaway database, never data/nameplate.db.
"""

import pytest
from pywebpush import WebPushException
from werkzeug.security import generate_password_hash

import db as db_module
import push
from app import create_app
from init_db import create_schema, ensure_settings, ensure_users
from transaction import immediate


@pytest.fixture
def client(tmp_path, monkeypatch):
    db_path = tmp_path / "push-test.db"
    monkeypatch.setenv("NAMEPLATE_DB_PATH", str(db_path))

    conn = db_module.connect()
    create_schema(conn)
    with immediate(conn):
        ensure_users(conn)
        ensure_settings(conn)
        conn.execute("UPDATE users SET pin_hash = ? WHERE id = 1", (generate_password_hash("111111"),))
        conn.execute("UPDATE users SET pin_hash = ? WHERE id = 2", (generate_password_hash("222222"),))
    conn.close()

    app = create_app()
    app.config.update(TESTING=True)
    with app.test_client() as c:
        yield c


def _sign_in(client, pin="111111"):
    res = client.post("/api/gate", json={"pin": pin})
    assert res.status_code == 200


def test_subscribe_requires_session(client):
    res = client.post("/api/push/subscribe", json={"endpoint": "https://fcm.googleapis.com/x", "keys": {"p256dh": "a", "auth": "b"}})
    assert res.status_code == 401


def test_subscribe_then_unsubscribe_roundtrip(client):
    _sign_in(client)
    res = client.post(
        "/api/push/subscribe",
        json={"endpoint": "https://fcm.googleapis.com/x", "keys": {"p256dh": "a", "auth": "b"}},
    )
    assert res.status_code == 200

    res = client.delete("/api/push/subscribe", json={"endpoint": "https://fcm.googleapis.com/x"})
    assert res.status_code == 200


def test_subscribe_rejects_missing_keys(client):
    _sign_in(client)
    res = client.post("/api/push/subscribe", json={"endpoint": "https://fcm.googleapis.com/x"})
    assert res.status_code == 400


def test_resubscribing_same_endpoint_upserts_not_duplicates(client):
    _sign_in(client, "111111")
    endpoint = "https://fcm.googleapis.com/x"
    client.post("/api/push/subscribe", json={"endpoint": endpoint, "keys": {"p256dh": "a", "auth": "b"}})
    # Same endpoint, different keys -- simulates the browser re-registering.
    res = client.post("/api/push/subscribe", json={"endpoint": endpoint, "keys": {"p256dh": "c", "auth": "d"}})
    assert res.status_code == 200

    conn = db_module.connect()
    rows = conn.execute("SELECT p256dh, auth FROM push_subscriptions WHERE endpoint = ?", (endpoint,)).fetchall()
    conn.close()
    assert len(rows) == 1
    assert rows[0]["p256dh"] == "c"


def test_send_push_is_a_noop_without_vapid_config(client, monkeypatch):
    monkeypatch.delenv("NAMEPLATE_VAPID_PRIVATE", raising=False)
    monkeypatch.delenv("NAMEPLATE_VAPID_SUB", raising=False)
    # Must not raise, even though nothing is configured.
    push.send_push(1, "Nameplate", "Round 1 is in — 6 names got through.")


def test_send_push_never_raises_on_webpush_failure(client, monkeypatch):
    _sign_in(client)
    client.post("/api/push/subscribe", json={"endpoint": "https://fcm.googleapis.com/x", "keys": {"p256dh": "a", "auth": "b"}})

    monkeypatch.setenv("NAMEPLATE_VAPID_PRIVATE", "not-a-real-key")
    monkeypatch.setenv("NAMEPLATE_VAPID_SUB", "mailto:test@example.com")

    def boom(*args, **kwargs):
        raise WebPushException("network exploded")

    monkeypatch.setattr(push, "webpush", boom)
    # The whole point: this must not propagate.
    push.send_push(1, "Nameplate", "Round 1 is in — 6 names got through.")


def test_send_push_deletes_subscription_on_410(client, monkeypatch):
    _sign_in(client)
    client.post("/api/push/subscribe", json={"endpoint": "https://fcm.googleapis.com/x", "keys": {"p256dh": "a", "auth": "b"}})

    monkeypatch.setenv("NAMEPLATE_VAPID_PRIVATE", "not-a-real-key")
    monkeypatch.setenv("NAMEPLATE_VAPID_SUB", "mailto:test@example.com")

    class FakeResponse:
        status_code = 410

    def gone(*args, **kwargs):
        raise WebPushException("gone", response=FakeResponse())

    monkeypatch.setattr(push, "webpush", gone)
    push.send_push(1, "Nameplate", "Round 1 is in — 6 names got through.")

    conn = db_module.connect()
    rows = conn.execute("SELECT * FROM push_subscriptions WHERE user_id = 1").fetchall()
    conn.close()
    assert rows == []
