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


def test_every_eligible_theme_can_fill_the_draw_it_qualified_for(conn):
    """Round 25 regression (25 Sep 2026): Germanic qualified for a 21-name
    draw on raw name count but only had 19 variant families, so the round was
    built with 28 names and set 5 could never be locked. Whatever `needed`
    is, a theme ELIGIBLE_THEMES_SQL returns must actually yield that many."""
    for needed in (6, 12, 21, 30):
        for t in conn.execute(rounds.ELIGIBLE_THEMES_SQL, {"previousThemeId": None, "needed": needed}).fetchall():
            got = conn.execute(rounds.THEMED_DRAW_SQL, {"themeId": t["id"], "needed": needed}).fetchall()
            assert len(got) == needed, f"{t['slug']} qualified for {needed} but drew {len(got)}"


def test_assembled_round_is_always_five_full_sets(conn):
    for _ in range(25):  # 25 x 30 < 846: stays clear of the deck running out
        row = rounds.get_current_round(conn)
        sizes = [r[0] for r in conn.execute(
            "SELECT COUNT(*) FROM round_names WHERE round_id = ? GROUP BY set_index ORDER BY set_index", (row["id"],))]
        assert sizes == [rounds.SET_SIZE] * rounds.SETS_PER_ROUND, sizes
        # seal it with nobody keeping anything so the next round draws fresh
        with immediate(conn):
            for r in conn.execute(rounds.NAMES_IN_ROUND_SQL, (row["id"],)).fetchall():
                conn.execute(rounds.UPSERT_NAME_STATE_SQL, (r["id"], 0, row["number"]))
            conn.execute(rounds.SEAL_ROUND_SQL, (row["id"],))


# --- CO-1 endgame (round 43, 23 Oct 2026) ----------------------------------
# The deck ran out at round 43: 10 survivors + the last 17 unseen names made a
# 27-name round whose set 5 had 3 cards, and lock_set's "exactly 6" check
# stranded both parents on it. These cover the endgame that replaced it.


def _exhaust_deck(conn, survivors, unseen):
    """Leaves exactly `survivors` names standing and `unseen` names in the
    deck; everything else is marked out in a (fictional) round 0. Picks one
    name per variant family so top_up can always deal the whole remainder."""
    rows = conn.execute("SELECT id, variant_family FROM names ORDER BY id").fetchall()
    fams, pick = set(), []
    for r in rows:
        if r["variant_family"] and r["variant_family"] in fams:
            continue
        if r["variant_family"]:
            fams.add(r["variant_family"])
        pick.append(r["id"])
        if len(pick) == survivors + unseen:
            break
    keep_in, keep_unseen = set(pick[:survivors]), set(pick[survivors:])
    with immediate(conn):
        for r in rows:
            if r["id"] in keep_in:
                conn.execute(rounds.UPSERT_NAME_STATE_SQL, (r["id"], 3, None))
            elif r["id"] not in keep_unseen:
                conn.execute(rounds.UPSERT_NAME_STATE_SQL, (r["id"], 0, 0))
    return keep_in, keep_unseen


def _set_sizes(conn, round_id):
    return [r["n"] for r in conn.execute(rounds.SET_SIZES_SQL, (round_id,)).fetchall()]


def _play_round(conn, keep_count=None):
    """Both parents keep the same names (the first `keep_count` of each set,
    default: the most allowed) in every set of the open round."""
    p = rounds.round_payload(conn, 1)
    round_id = p["roundId"]
    for set_index in range(p["setsTotal"]):
        ids = [r["id"] for r in conn.execute(rounds.NAMES_IN_SET_SQL, (round_id, set_index)).fetchall()]
        lo, hi = rounds.keep_bounds(len(ids), rounds.round_is_endgame(conn, round_id))
        n = hi if keep_count is None else max(lo, min(hi, keep_count))
        for user_id in (1, 2):
            rounds.lock_set(conn, user_id, round_id, set_index, ids[:n])
    for user_id in (1, 2):
        rounds.ack_round(conn, user_id, round_id)
    return round_id


def test_set_sizes_are_even_and_full_rounds_unchanged():
    assert rounds.set_sizes(30) == [6, 6, 6, 6, 6]
    assert rounds.set_sizes(27) == [6, 6, 5, 5, 5]
    assert rounds.set_sizes(13) == [5, 4, 4]
    assert rounds.set_sizes(7) == [4, 3]
    assert rounds.set_sizes(4) == [4]


def test_keep_bounds():
    assert rounds.keep_bounds(6, False) == (3, 6)
    assert rounds.keep_bounds(6, True) == (3, 3)
    assert rounds.keep_bounds(4, True) == (3, 3)
    assert rounds.keep_bounds(3, True) == (2, 2)
    assert rounds.keep_bounds(2, True) == (1, 1)


def test_deck_running_out_deals_an_even_endgame_round(conn):
    _exhaust_deck(conn, survivors=10, unseen=17)
    p = rounds.round_payload(conn, 1)
    assert _set_sizes(conn, p["roundId"]) == [6, 6, 5, 5, 5]
    assert p["endgame"] is True
    assert p["setsTotal"] == 5
    assert (p["minKeep"], p["maxKeep"]) == (3, 3)


def test_round_43_shape_short_last_set_can_be_locked(conn):
    """The exact live state: sets of 6,6,6,6,3 dealt before the endgame
    existed, sets 1-4 already locked by both. Set 5 must now lock with 2."""
    _, unseen = _exhaust_deck(conn, survivors=10, unseen=17)
    ids = [r["id"] for r in conn.execute(rounds.SURVIVOR_IDS_SQL).fetchall()] + sorted(unseen)
    with immediate(conn):
        round_id = conn.execute(rounds.INSERT_ROUND_SQL, (43, None)).lastrowid
        for i, name_id in enumerate(ids):
            conn.execute(rounds.INSERT_ROUND_NAME_SQL, (round_id, i // 6, name_id))
    assert _set_sizes(conn, round_id) == [6, 6, 6, 6, 3]
    for set_index in range(4):
        set_ids = [r["id"] for r in conn.execute(rounds.NAMES_IN_SET_SQL, (round_id, set_index)).fetchall()]
        for user_id in (1, 2):
            rounds.lock_set(conn, user_id, round_id, set_index, set_ids[:3])

    p = rounds.round_payload(conn, 1)
    assert p["setIndex"] == 4 and len(p["names"]) == 3
    assert (p["minKeep"], p["maxKeep"]) == (2, 2)
    last = [n["id"] for n in p["names"]]
    with pytest.raises(rounds.ApiError):
        rounds.lock_set(conn, 1, round_id, 4, last)  # all 3: over the cap
    assert rounds.lock_set(conn, 1, round_id, 4, last[:2]) == {"sealed": True, "roundClosed": False, "number": 43}
    result = rounds.lock_set(conn, 2, round_id, 4, last[:2])
    assert result["roundClosed"] is True and result["throughCount"] == 14


def test_endgame_rejects_more_than_the_cap(conn):
    _exhaust_deck(conn, survivors=10, unseen=17)
    p = rounds.round_payload(conn, 1)
    with pytest.raises(rounds.ApiError) as exc_info:
        rounds.lock_set(conn, 1, p["roundId"], 0, [n["id"] for n in p["names"][:4]])
    assert exc_info.value.status == 400


def test_endgame_always_terminates_in_a_final_three(conn):
    """Two parents who keep the maximum every set and always agree -- the
    "generous parents could stall it" case CO-1 warns about."""
    _exhaust_deck(conn, survivors=10, unseen=17)
    for _ in range(10):
        p = rounds.round_payload(conn, 1)
        if p.get("final"):
            break
        _play_round(conn)
    else:
        pytest.fail("endgame never reached a final")
    assert 1 <= len(p["finalists"]) <= rounds.FINAL_SIZE
    assert rounds.round_payload(conn, 2).get("final") is True
    # no extra round was assembled once it was over
    assert conn.execute("SELECT COUNT(*) AS n FROM rounds WHERE sealed_at IS NULL").fetchone()["n"] == 0


def test_recap_flags_when_the_next_screen_is_the_final(conn):
    _exhaust_deck(conn, survivors=4, unseen=0)
    p = rounds.round_payload(conn, 1)
    assert _set_sizes(conn, p["roundId"]) == [4]
    round_id = p["roundId"]
    ids = [n["id"] for n in p["names"]]
    for user_id in (1, 2):
        rounds.lock_set(conn, user_id, round_id, 0, ids[:3])
    assert rounds.get_round_result(conn, 1, round_id)["finalNext"] is True


def test_adding_a_name_after_the_final_reopens_play(conn):
    import names
    _exhaust_deck(conn, survivors=3, unseen=0)
    assert rounds.round_payload(conn, 1).get("final") is True
    assert names.add_name(conn, 1, "Zebedee", "")["ok"]
    p = rounds.round_payload(conn, 1)
    assert not p.get("final")
    assert len(p["names"]) == 4 and p["endgame"] is True
