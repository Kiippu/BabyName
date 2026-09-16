"""CO-4 §5's required gate test: wrong PIN x5 -> locked; correct PIN during
lockout -> still locked. Runs against a throwaway database created fresh by
each test, never data/nameplate.db.
"""

import pytest
from werkzeug.security import generate_password_hash

import db as db_module
from app import create_app
from init_db import create_schema, ensure_settings, ensure_users
from transaction import immediate


@pytest.fixture
def client(tmp_path, monkeypatch):
    db_path = tmp_path / "gate-test.db"
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


def test_correct_pin_signs_in(client):
    res = client.post("/api/gate", json={"pin": "111111"})
    assert res.status_code == 200
    body = res.get_json()
    assert body == {"userId": 1, "label": "Dad", "surname": ""}
    assert "nameplate_session" in res.headers.get("Set-Cookie", "")


def test_wrong_pin_does_not_reveal_which_pin(client):
    res = client.post("/api/gate", json={"pin": "000000"})
    assert res.status_code == 401
    assert res.get_json() == {"error": "That PIN isn't right."}


def test_five_failures_from_one_ip_locks_it(client):
    for _ in range(5):
        res = client.post("/api/gate", json={"pin": "000000"})
        assert res.status_code == 401

    locked = client.post("/api/gate", json={"pin": "000000"})
    assert locked.status_code == 429


def test_correct_pin_during_lockout_is_still_locked(client):
    for _ in range(5):
        client.post("/api/gate", json={"pin": "000000"})

    # The right PIN, mid-lockout, must not sign anyone in.
    res = client.post("/api/gate", json={"pin": "111111"})
    assert res.status_code == 429
    assert "Set-Cookie" not in res.headers


def test_gate_is_not_itself_gated(client):
    # No session cookie sent at all -- this must never 401 as "not signed in".
    res = client.post("/api/gate", json={"pin": "111111"})
    assert res.status_code == 200


def test_health_is_ungated(client):
    res = client.get("/api/health")
    assert res.status_code == 200
    assert res.get_json() == {"ok": True}


def test_protected_route_requires_session(client):
    res = client.get("/api/settings")
    assert res.status_code == 401


def test_me_without_session_returns_unclaimed_not_401(client):
    res = client.get("/api/me")
    assert res.status_code == 200
    assert res.get_json()["claimed"] is False


def test_session_from_gate_authorizes_later_requests(client):
    gate_res = client.post("/api/gate", json={"pin": "222222"})
    assert gate_res.status_code == 200

    me_res = client.get("/api/me")
    assert me_res.status_code == 200
    body = me_res.get_json()
    assert body["userId"] == 2
    assert body["claimed"] is True
