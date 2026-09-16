"""CO-4 §5's must-survive tests for rounds.py: the recursive-CTE draw that
CO-3 measured a naive query getting wrong 21.6% of the time (variant-family
clashes), and the region-draw trap ("a plain theme_id match returns zero
rows for every region theme"). Run before anything else reads these queries,
per CO-4 §10 step 3. Fresh database per test, seeded from the real
seed/packs/*.json -- never data/nameplate.db.
"""

import pytest

import db as db_module
import rounds
from init_db import create_schema, ensure_settings, ensure_users, load_packs
from transaction import immediate


@pytest.fixture
def conn(tmp_path, monkeypatch):
    db_path = tmp_path / "rounds-test.db"
    monkeypatch.setenv("NAMEPLATE_DB_PATH", str(db_path))
    c = db_module.connect()
    create_schema(c)
    with immediate(c):
        ensure_users(c)
        ensure_settings(c)
    with immediate(c):
        load_packs(c)
    yield c
    c.close()


def _theme_id(conn, slug):
    row = conn.execute("SELECT id FROM themes WHERE slug = ?", (slug,)).fetchone()
    assert row is not None, f"seed pack missing theme {slug!r}"
    return row["id"]


def test_themed_draw_never_clashes_variant_family_over_1000_draws(conn):
    """"classical" is a region (europe.json), so this also exercises the
    recursive walk into its child cultures, not just the GROUP BY. No rounds
    have been played, so every draw pulls fresh from the same unseen pool --
    1,000 independent draws, each checked against the names table directly
    rather than trusting the query's own GROUP BY, since the point is to
    catch a future rewrite that drops or weakens it."""
    theme_id = _theme_id(conn, "classical")
    for i in range(1000):
        rows = conn.execute(rounds.THEMED_DRAW_SQL, {"themeId": theme_id, "needed": rounds.ROUND_SIZE}).fetchall()
        assert rows, f"draw {i}: themed draw returned nothing for classical"
        seen = set()
        for row in rows:
            name = conn.execute("SELECT variant_family, id FROM names WHERE id = ?", (row["id"],)).fetchone()
            key = name["variant_family"] or f"id:{name['id']}"
            assert key not in seen, f"draw {i}: variant-family clash on {key!r}"
            seen.add(key)


def test_region_draw_walks_into_child_cultures(conn):
    """CO-3's "single easiest thing to get wrong": names never link to a
    region directly, only to the cultures under it, so a plain
    `theme_id = :theme` on a region returns zero rows. This is the
    regression test CO-4 §11 point 5 asks for."""
    theme_id = _theme_id(conn, "africa")
    rows = conn.execute(rounds.THEMED_DRAW_SQL, {"themeId": theme_id, "needed": 6}).fetchall()
    assert len(rows) > 0, "africa is a region -- got zero rows, exactly the bug CO-3/CO-4 warn about"


def test_eligible_themes_also_walks_region_inheritance(conn):
    """Same trap, other query: eligible_themes_sql counts unseen names by
    walking the region -> culture CTE too. A region like africa should show
    up as eligible (assuming it has enough unseen names) even though no name
    links to it directly."""
    theme_id = _theme_id(conn, "africa")
    rows = conn.execute(rounds.ELIGIBLE_THEMES_SQL, {"previousThemeId": None, "needed": 1}).fetchall()
    ids = {r["id"] for r in rows}
    assert theme_id in ids, "africa never appeared as eligible -- region inheritance isn't being counted"


def test_round_result_403s_until_both_parents_seal(conn):
    with immediate(conn):
        conn.execute(rounds.INSERT_ROUND_SQL, (1, None))
    round_id = conn.execute("SELECT id FROM rounds WHERE number = 1").fetchone()["id"]

    with pytest.raises(rounds.ApiError) as exc_info:
        rounds.get_round_result(conn, 1, round_id)
    assert exc_info.value.status == 403


def test_round_result_404s_for_unknown_round(conn):
    with pytest.raises(rounds.ApiError) as exc_info:
        rounds.get_round_result(conn, 1, 999999)
    assert exc_info.value.status == 404


def test_full_round_lifecycle_seals_and_produces_a_result(conn):
    """End-to-end confidence beyond the isolated SQL checks above: assemble a
    round, have both parents keep the exact same names in every set, and
    confirm it seals and the recap is readable by both."""
    payload = rounds.round_payload(conn, 1)
    round_id = payload["roundId"]
    assert payload["waiting"] is False
    assert payload["names"] is not None

    # round_payload reshuffles display order on every call, so pick the kept
    # ids from the canonical (unshuffled) set contents instead -- otherwise
    # "both parents kept the same 3" isn't actually guaranteed here.
    for set_index in range(rounds.SETS_PER_ROUND):
        set_rows = conn.execute(rounds.NAMES_IN_SET_SQL, (round_id, set_index)).fetchall()
        keep_ids = [r["id"] for r in set_rows[: rounds.MIN_KEEP]]
        for user_id in (1, 2):
            p = rounds.round_payload(conn, user_id)
            assert p["roundId"] == round_id
            assert p["setIndex"] == set_index
            # "sealed" here means "this person has now finished all 5 of
            # their own sets" -- not "the round is sealed" (that only
            # happens once both have), matching rounds.js's lockSet.
            result = rounds.lock_set(conn, user_id, round_id, set_index, keep_ids)
            expect_sealed = set_index == rounds.SETS_PER_ROUND - 1
            assert result["sealed"] is expect_sealed

    sealed_row = conn.execute("SELECT sealed_at FROM rounds WHERE id = ?", (round_id,)).fetchone()
    assert sealed_row["sealed_at"] is not None

    recap = rounds.get_round_result(conn, 1, round_id)
    assert recap["roundId"] == round_id
    assert len(recap["through"]) == rounds.MIN_KEEP * rounds.SETS_PER_ROUND


def test_lock_set_rejects_fewer_than_min_keep(conn):
    payload = rounds.round_payload(conn, 1)
    keep_ids = [n["id"] for n in payload["names"][: rounds.MIN_KEEP - 1]]
    with pytest.raises(rounds.ApiError) as exc_info:
        rounds.lock_set(conn, 1, payload["roundId"], payload["setIndex"], keep_ids)
    assert exc_info.value.status == 400


def test_lock_set_rejects_resubmitting_a_set(conn):
    payload = rounds.round_payload(conn, 1)
    keep_ids = [n["id"] for n in payload["names"][: rounds.MIN_KEEP]]
    rounds.lock_set(conn, 1, payload["roundId"], payload["setIndex"], keep_ids)
    with pytest.raises(rounds.ApiError) as exc_info:
        rounds.lock_set(conn, 1, payload["roundId"], payload["setIndex"], keep_ids)
    assert exc_info.value.status == 409
