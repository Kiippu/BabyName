"""Integration coverage for the routes wired up in CO-4 §5 step 4 (everything
besides gate/health/me/round, which have their own test files). Runs the
real Flask app against a throwaway database seeded from the real
seed/packs/*.json, never data/nameplate.db.
"""

import pytest
from werkzeug.security import generate_password_hash

import db as db_module
from app import create_app
from init_db import create_schema, ensure_settings, ensure_users
from packs import load_packs
from transaction import immediate


@pytest.fixture
def client(tmp_path, monkeypatch):
    db_path = tmp_path / "routes-test.db"
    monkeypatch.setenv("NAMEPLATE_DB_PATH", str(db_path))

    conn = db_module.connect()
    create_schema(conn)
    with immediate(conn):
        ensure_users(conn)
        ensure_settings(conn)
        conn.execute("UPDATE users SET pin_hash = ? WHERE id = 1", (generate_password_hash("111111"),))
        conn.execute("UPDATE users SET pin_hash = ? WHERE id = 2", (generate_password_hash("222222"),))
    with immediate(conn):
        load_packs(conn)
    conn.close()

    app = create_app()
    app.config.update(TESTING=True)
    with app.test_client() as c:
        c.post("/api/gate", json={"pin": "111111"})
        yield c


def test_settings_roundtrip(client):
    res = client.get("/api/settings")
    assert res.status_code == 200
    assert res.get_json()["setupDone"] is False

    put = client.put(
        "/api/settings",
        json={"father": {"name": "Alex", "surname": "Smith"}, "mother": {"name": "Sam", "surname": "Jones"}, "babySurname": "both"},
    )
    assert put.status_code == 200
    body = put.get_json()
    assert body["setupDone"] is True
    assert body["father"] == {"name": "Alex", "surname": "Smith"}
    assert body["babySurname"] == "both"


def test_settings_rejects_bad_baby_surname_mode(client):
    res = client.put(
        "/api/settings",
        json={"father": {"name": "A", "surname": "S"}, "mother": {"name": "B", "surname": "J"}, "babySurname": "nonsense"},
    )
    assert res.status_code == 400


def test_stats_starts_at_zero_rounds(client):
    res = client.get("/api/stats")
    assert res.status_code == 200
    body = res.get_json()
    assert body["rounds"] == 0
    assert body["totalNames"] == 846
    assert body["stillIn"] == 846


def test_themes_tree_nests_regions_and_cultures(client):
    res = client.get("/api/themes")
    assert res.status_code == 200
    packs = res.get_json()
    assert len(packs) == 3
    all_theme_ids = set()

    def collect(themes):
        for t in themes:
            all_theme_ids.add(t["id"])
            collect(t["children"])

    for p in packs:
        collect(p["themes"])
    assert len(all_theme_ids) == 61


def test_toggle_theme_enabled(client):
    themes_before = client.get("/api/themes").get_json()
    first_theme_id = themes_before[0]["themes"][0]["id"]

    res = client.put(f"/api/themes/{first_theme_id}", json={"enabled": False})
    assert res.status_code == 200

    def find(themes, theme_id):
        for t in themes:
            if t["id"] == theme_id:
                return t
            found = find(t["children"], theme_id)
            if found:
                return found
        return None

    updated = None
    for p in res.get_json():
        updated = find(p["themes"], first_theme_id)
        if updated:
            break
    assert updated["enabled"] is False


def test_toggle_unknown_theme_404s(client):
    res = client.put("/api/themes/999999", json={"enabled": True})
    assert res.status_code == 404


def test_add_name_then_reject_duplicate_case_insensitive(client):
    res = client.post("/api/names", json={"name": "Zzyzx", "note": "a test name"})
    assert res.status_code == 200
    row = res.get_json()
    assert row["name"] == "Zzyzx"
    assert row["meaning"] == "a test name"

    dupe = client.post("/api/names", json={"name": "zzyzx"})
    assert dupe.status_code == 400


def test_add_name_requires_nonempty_name(client):
    res = client.post("/api/names", json={"name": "   "})
    assert res.status_code == 400


def test_name_detail_for_unknown_id_404s(client):
    res = client.get("/api/names/999999")
    assert res.status_code == 404


def test_name_detail_shape(client):
    added = client.post("/api/names", json={"name": "Zzyzx"}).get_json()
    res = client.get(f"/api/names/{added['id']}")
    assert res.status_code == 200
    body = res.get_json()
    assert body["name"] == "Zzyzx"
    assert body["roundsSurvived"] == 0
    assert body["youKeptCount"] == 0
    assert body["partnerLabel"] == "Mum"


def test_list_defaults_to_in_tab(client):
    res = client.get("/api/list")
    assert res.status_code == 200
    body = res.get_json()
    assert len(body) == 846  # all seeded names, none eliminated yet
    assert all(row["eliminatedIn"] is None for row in body)


def test_list_out_tab_is_empty_before_any_round_seals(client):
    res = client.get("/api/list?tab=out")
    assert res.status_code == 200
    assert res.get_json() == []


def test_round_and_names_routes_are_gated(client):
    # A client with no session at all -- everything except gate/health/me is closed.
    anon = create_app().test_client()
    for method, path in [
        ("get", "/api/round"),
        ("get", "/api/settings"),
        ("get", "/api/stats"),
        ("get", "/api/themes"),
        ("get", "/api/list"),
        ("get", "/api/names/1"),
        ("post", "/api/names"),
    ]:
        res = getattr(anon, method)(path)
        assert res.status_code == 401, f"{method.upper()} {path} should be gated"
