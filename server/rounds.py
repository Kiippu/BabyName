"""Ported from server/src/rounds.js. CO-4 §5: "Copy the CTEs verbatim" --
eligible_themes_sql and themed_draw_sql below are transcribed character for
character except for @name -> :name, which sqlite3's named-parameter syntax
requires. Everything else (constants, function shapes, comments explaining
the *why*) follows the original closely on purpose, since this file carries
CO-1/CO-2/CO-3's business rules, not just its own.
"""

import random

from transaction import immediate

# Change Order 1: a round is 5 sets of 6 names -- 30 names per round per
# person, each name appearing exactly once.
SETS_PER_ROUND = 5
SET_SIZE = 6
ROUND_SIZE = SETS_PER_ROUND * SET_SIZE
# Revision to the original change order (owner's live call, post-launch
# testing): keeps are no longer optional. A parent must keep at least this
# many of the 6 before a set can be locked in.
MIN_KEEP = 3


class ApiError(Exception):
    def __init__(self, message, status=500):
        super().__init__(message)
        self.status = status


OPEN_ROUND_SQL = """
    SELECT r.id, r.number, r.started_at, r.sealed_at, r.theme_id, t.title AS theme_title
    FROM rounds r
    LEFT JOIN themes t ON t.id = r.theme_id
    WHERE r.sealed_at IS NULL
    ORDER BY r.number DESC LIMIT 1
"""
MAX_ROUND_NUMBER_SQL = "SELECT MAX(number) AS n FROM rounds"
LAST_ROUND_THEME_SQL = "SELECT theme_id FROM rounds ORDER BY number DESC LIMIT 1"
ROUND_BY_NUMBER_SQL = """
    SELECT r.id, r.number, r.theme_id, t.title AS theme_title
    FROM rounds r
    LEFT JOIN themes t ON t.id = r.theme_id
    WHERE r.number = ?
"""
INSERT_ROUND_SQL = "INSERT INTO rounds (number, theme_id) VALUES (?, ?)"
INSERT_ROUND_NAME_SQL = "INSERT INTO round_names (round_id, set_index, name_id) VALUES (?, ?, ?)"
# A name that has survived at least one round and hasn't fallen out yet.
SURVIVOR_IDS_SQL = "SELECT name_id AS id FROM name_state WHERE eliminated_in IS NULL"
# A name that has never appeared in any round at all -- name_state rows are
# only written when a round is sealed (survived or eliminated), so "no row"
# means "still in the deck".
NEWCOMER_IDS_SQL = """
    SELECT id FROM names
    WHERE NOT EXISTS (SELECT 1 FROM name_state ns WHERE ns.name_id = names.id)
    ORDER BY RANDOM() LIMIT ?
"""
# Change Order 3 §3: which themes could supply this round's newcomers, walking
# region -> culture inheritance via the recursive CTE (a plain theme_id match
# returns zero rows for every region, since names never link to regions
# directly). Excludes whatever theme ran last round -- "never the same theme
# twice running" -- unless there wasn't one.
ELIGIBLE_THEMES_SQL = """
    WITH RECURSIVE sub(root, id) AS (
      SELECT id, id FROM themes
      UNION ALL
      SELECT s.root, t.id FROM themes t JOIN sub s ON t.parent_id = s.id
    )
    SELECT t.id, t.slug, t.title, t.kind, t.weight, COUNT(DISTINCT n.id) AS unseen
    FROM themes t
    JOIN packs p        ON p.id = t.pack_id
    JOIN sub            ON sub.root = t.id
    JOIN name_themes nt ON nt.theme_id = sub.id
    JOIN names n        ON n.id = nt.name_id
    LEFT JOIN name_state s ON s.name_id = n.id
    WHERE t.enabled = 1
      AND p.bundled = 1
      AND s.name_id IS NULL
      AND (:previousThemeId IS NULL OR t.id <> :previousThemeId)
    GROUP BY t.id
    HAVING unseen >= :needed
"""
# Clash-free draw from a theme (and, for a region, everything under it):
# GROUP BY the variant family allows at most one of Luca/Luka etc. per draw.
THEMED_DRAW_SQL = """
    WITH RECURSIVE sub(id) AS (
      SELECT :themeId
      UNION ALL
      SELECT t.id FROM themes t JOIN sub ON t.parent_id = sub.id
    )
    SELECT n.id FROM names n
    JOIN name_themes nt ON nt.name_id = n.id AND nt.theme_id IN (SELECT id FROM sub)
    LEFT JOIN name_state s ON s.name_id = n.id
    WHERE s.name_id IS NULL
    GROUP BY COALESCE(n.variant_family, n.id)
    ORDER BY RANDOM() LIMIT :needed
"""

# heldCount (name_state.rounds_survived BEFORE this round is decided) is
# fetched here but deliberately withheld from the live selection payload --
# see to_live_card below. The column stays in this query because lock_set
# (further down) reuses this same query for its own id/size checks.
NAMES_IN_SET_SQL = """
    SELECT n.id, n.name, n.origin, n.meaning, COALESCE(ns.rounds_survived, 0) AS heldCount
    FROM round_names rn
    JOIN names n ON n.id = rn.name_id
    LEFT JOIN name_state ns ON ns.name_id = n.id
    WHERE rn.round_id = ? AND rn.set_index = ?
"""
NAMES_IN_ROUND_SQL = "SELECT name_id AS id FROM round_names WHERE round_id = ?"
SET_INDEXES_DONE_SQL = "SELECT DISTINCT set_index FROM set_results WHERE round_id = ? AND user_id = ?"
ALREADY_SUBMITTED_SQL = "SELECT 1 FROM set_results WHERE round_id = ? AND set_index = ? AND user_id = ? LIMIT 1"
INSERT_SET_RESULT_SQL = """
    INSERT INTO set_results (round_id, set_index, user_id, name_id, kept, set_keeps)
    VALUES (?, ?, ?, ?, ?, ?)
"""
KEPT_BY_SQL = "SELECT name_id AS id FROM set_results WHERE round_id = ? AND user_id = ? AND kept = 1"
SEAL_ROUND_SQL = "UPDATE rounds SET sealed_at = datetime('now') WHERE id = ?"
NAME_STATE_SQL = "SELECT rounds_survived, eliminated_in FROM name_state WHERE name_id = ?"
UPSERT_NAME_STATE_SQL = """
    INSERT INTO name_state (name_id, rounds_survived, eliminated_in) VALUES (?, ?, ?)
    ON CONFLICT(name_id) DO UPDATE SET rounds_survived = excluded.rounds_survived, eliminated_in = excluded.eliminated_in
"""

# Change order, "Seal -> waiting -> round result" (build order step 4). A
# round is fully sealed once BOTH parents finish it (settle_round below), but
# each parent still needs to see their OWN full-screen recap of it exactly
# once, whenever they next open the app -- regardless of how far ahead their
# partner already is. round_acks tracks that per-person, independent of
# round progression itself.
PENDING_RESULT_ROUND_SQL = """
    SELECT id, number FROM rounds
    WHERE sealed_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM round_acks ra WHERE ra.round_id = rounds.id AND ra.user_id = ?)
    ORDER BY number ASC LIMIT 1
"""
ACK_ROUND_SQL = "INSERT OR IGNORE INTO round_acks (round_id, user_id) VALUES (?, ?)"
ROUND_BY_ID_SQL = """
    SELECT r.id, r.number, r.sealed_at, r.theme_id, t.title AS theme_title
    FROM rounds r
    LEFT JOIN themes t ON t.id = r.theme_id
    WHERE r.id = ?
"""
# Whole-round name list (all 5 sets), for the result screen -- NAMES_IN_SET_SQL
# above is scoped to one set at a time, which the set screen needs but the
# result screen doesn't.
NAMES_IN_ROUND_FULL_SQL = """
    SELECT n.id, n.name, n.origin, n.meaning, COALESCE(ns.rounds_survived, 0) AS heldCount
    FROM round_names rn
    JOIN names n ON n.id = rn.name_id
    LEFT JOIN name_state ns ON ns.name_id = n.id
    WHERE rn.round_id = ?
"""
USER_LABEL_SQL = "SELECT name FROM users WHERE id = ?"


def other_user_id(user_id):
    return 2 if user_id == 1 else 1


def shuffle(seq):
    a = list(seq)
    random.shuffle(a)
    return a


def to_card(row):
    # heldCount is intentionally never sent on the live selection payload --
    # see spec §10, no popularity anchor -- but IS included here for the
    # sealed-round recap (to_live_card strips it back out for live sets).
    return {"id": row["id"], "name": row["name"], "origin": row["origin"], "meaning": row["meaning"], "heldCount": row["heldCount"]}


def to_live_card(row):
    card = to_card(row)
    del card["heldCount"]
    return card


# Change Order 2 §2: one random theme supplies a round's newcomers, biased by
# t.weight. Plain linear-scan weighted pick -- 30-ish eligible themes, called
# once per round, no need for anything fancier.
def weighted_theme_pick(themes):
    total = sum(t["weight"] for t in themes)
    roll = random.random() * total
    for t in themes:
        roll -= t["weight"]
        if roll < 0:
            return t
    return themes[-1]


def _assemble_round(conn):
    """Rolls a fresh round: survivors of the last sealed round, topped up
    with newcomers from the deck, shuffled together -- never a "veterans
    round" or an "all-new round" -- and split into 5 sets of 6. The
    assignment is written to round_names once here, so both parents are
    served the identical sets regardless of who opens the app first.

    Change Order 2 §2: the newcomers come from a single randomly-chosen theme
    (never the same one two rounds running) instead of the whole pool. If no
    theme has enough unseen names left for this round's need, the deck is
    exhausted for a themed draw -- CO1's full endgame isn't built, so this
    falls back to the old unfiltered draw rather than stalling the round.
    """
    with immediate(conn):
        survivors = [r["id"] for r in conn.execute(SURVIVOR_IDS_SQL).fetchall()]
        need = max(0, ROUND_SIZE - len(survivors))

        theme_id = None
        newcomers = []
        if need > 0:
            prev_row = conn.execute(LAST_ROUND_THEME_SQL).fetchone()
            previous_theme_id = prev_row["theme_id"] if prev_row else None
            eligible = conn.execute(
                ELIGIBLE_THEMES_SQL, {"previousThemeId": previous_theme_id, "needed": need}
            ).fetchall()
            if eligible:
                theme_id = weighted_theme_pick(eligible)["id"]
                newcomers = [r["id"] for r in conn.execute(THEMED_DRAW_SQL, {"themeId": theme_id, "needed": need}).fetchall()]
            else:
                newcomers = [r["id"] for r in conn.execute(NEWCOMER_IDS_SQL, (need,)).fetchall()]

        round_names = shuffle(survivors + newcomers)

        number = (conn.execute(MAX_ROUND_NUMBER_SQL).fetchone()["n"] or 0) + 1
        cur = conn.execute(INSERT_ROUND_SQL, (number, theme_id))
        round_id = cur.lastrowid
        for i, name_id in enumerate(round_names):
            conn.execute(INSERT_ROUND_NAME_SQL, (round_id, i // SET_SIZE, name_id))

        return conn.execute(OPEN_ROUND_SQL).fetchone()


def get_current_round(conn):
    """The round currently in play, assembling a new one if none is open."""
    row = conn.execute(OPEN_ROUND_SQL).fetchone()
    return row if row else _assemble_round(conn)


def round_payload(conn, user_id):
    """What this person should see right now: their next set to sort, a wait
    state once they've locked in all 5 and are ahead of their partner, or the
    result of a round that's now fully sealed but they haven't seen yet.
    Checking for an unacked result BEFORE touching get_current_round matters:
    it stops this person on round N's result even if round N+1 has already
    been assembled because their partner acked first and moved on.
    """
    pending = conn.execute(PENDING_RESULT_ROUND_SQL, (user_id,)).fetchone()
    if pending:
        return {
            "roundId": pending["id"],
            "number": pending["number"],
            "setIndex": SETS_PER_ROUND,
            "setsTotal": SETS_PER_ROUND,
            "names": None,
            "waiting": False,
            "resultReady": True,
            "themeTitle": None,
        }

    round_ = get_current_round(conn)
    done = len(conn.execute(SET_INDEXES_DONE_SQL, (round_["id"], user_id)).fetchall())
    if done >= SETS_PER_ROUND:
        partner_sets_done = len(conn.execute(SET_INDEXES_DONE_SQL, (round_["id"], other_user_id(user_id))).fetchall())
        return {
            "roundId": round_["id"],
            "number": round_["number"],
            "setIndex": done,
            "setsTotal": SETS_PER_ROUND,
            "names": None,
            "waiting": True,
            "partnerSetsDone": partner_sets_done,
            "themeTitle": round_["theme_title"],
        }

    names = shuffle([to_live_card(r) for r in conn.execute(NAMES_IN_SET_SQL, (round_["id"], done)).fetchall()])
    return {
        "roundId": round_["id"],
        "number": round_["number"],
        "setIndex": done,
        "setsTotal": SETS_PER_ROUND,
        "names": names,
        "waiting": False,
        "themeTitle": round_["theme_title"],
    }


def get_round_result(conn, user_id, round_id):
    """The full-screen recap for a sealed round: what got through, what each
    parent kept alone, and what's out. 403s until the round is actually
    sealed -- the server-side half of the blind-reveal guarantee.
    """
    round_ = conn.execute(ROUND_BY_ID_SQL, (round_id,)).fetchone()
    if not round_:
        raise ApiError("That round doesn't exist.", 404)
    if not round_["sealed_at"]:
        raise ApiError("That round hasn't been sealed by both parents yet.", 403)

    partner_id = other_user_id(user_id)
    mine = {r["id"] for r in conn.execute(KEPT_BY_SQL, (round_id, user_id)).fetchall()}
    theirs = {r["id"] for r in conn.execute(KEPT_BY_SQL, (round_id, partner_id)).fetchall()}

    through, mine_only, theirs_only, out = [], [], [], []
    for n in conn.execute(NAMES_IN_ROUND_FULL_SQL, (round_id,)).fetchall():
        got_mine = n["id"] in mine
        got_theirs = n["id"] in theirs
        if got_mine and got_theirs:
            through.append(to_card(n))
        elif got_mine:
            mine_only.append({"id": n["id"], "name": n["name"], "origin": n["origin"], "meaning": n["meaning"]})
        elif got_theirs:
            theirs_only.append({"id": n["id"], "name": n["name"], "origin": n["origin"], "meaning": n["meaning"]})
        else:
            out.append({"id": n["id"], "name": n["name"]})

    partner = conn.execute(USER_LABEL_SQL, (partner_id,)).fetchone()

    return {
        "roundId": round_["id"],
        "number": round_["number"],
        "totalNames": len(through) + len(mine_only) + len(theirs_only) + len(out),
        "through": through,
        "mineOnly": mine_only,
        "theirsOnly": theirs_only,
        "out": out,
        "partnerLabel": partner["name"] if partner else "your partner",
        "nextThemeHint": _compute_next_theme_hint(conn, round_),
    }


def _compute_next_theme_hint(conn, sealed_round):
    """Change Order 2 §2's "tease": what the next round is likely to draw
    from, shown on this round's recap. If that round has already been
    assembled, report its actual committed theme instead of a preview --
    otherwise preview up to 3 themes that currently qualify.
    """
    next_number = sealed_round["number"] + 1
    already = conn.execute(ROUND_BY_NUMBER_SQL, (next_number,)).fetchone()
    if already:
        return f"Round {next_number} draws from {already['theme_title']}" if already["theme_title"] else None

    survivors = len(conn.execute(SURVIVOR_IDS_SQL).fetchall())
    need = max(0, ROUND_SIZE - survivors)
    if need <= 0:
        return None

    eligible = conn.execute(
        ELIGIBLE_THEMES_SQL, {"previousThemeId": sealed_round["theme_id"], "needed": need}
    ).fetchall()
    if not eligible:
        return None

    picks = [t["title"] for t in shuffle(eligible)[:3]]
    last = picks.pop()
    return f"Round {next_number} draws from {', '.join(picks)} and {last}" if picks else f"Round {next_number} draws from {last}"


def ack_round(conn, user_id, round_id):
    """Marks a round's result as seen by this person, then hands back
    whatever they should see next."""
    round_ = conn.execute(ROUND_BY_ID_SQL, (round_id,)).fetchone()
    if not round_:
        raise ApiError("That round doesn't exist.", 404)
    if not round_["sealed_at"]:
        raise ApiError("That round hasn't been sealed yet.", 403)
    with immediate(conn):
        conn.execute(ACK_ROUND_SQL, (round_id, user_id))
    return round_payload(conn, user_id)


def user_label(conn, user_id):
    row = conn.execute(USER_LABEL_SQL, (user_id,)).fetchone()
    return row["name"] if row else "Your partner"


def _settle_round(conn, round_):
    """A name survives to the next round only if BOTH parents kept it in
    this round; everything else is out permanently. Always called from
    inside lock_set's transaction -- sqlite3 has no nested transactions
    either, same constraint the Node original notes. Returns the through
    count (CO-4 §12: the push notification needs it and it can't be
    recomputed after sealing without re-deriving this same set)."""
    kept_by_a = {r["id"] for r in conn.execute(KEPT_BY_SQL, (round_["id"], 1)).fetchall()}
    kept_by_b = {r["id"] for r in conn.execute(KEPT_BY_SQL, (round_["id"], 2)).fetchall()}
    through_count = 0
    for row in conn.execute(NAMES_IN_ROUND_SQL, (round_["id"],)).fetchall():
        name_id = row["id"]
        survived = name_id in kept_by_a and name_id in kept_by_b
        if survived:
            through_count += 1
        prior = conn.execute(NAME_STATE_SQL, (name_id,)).fetchone()
        rounds_survived = (prior["rounds_survived"] if prior else 0) + (1 if survived else 0)
        conn.execute(UPSERT_NAME_STATE_SQL, (name_id, rounds_survived, None if survived else round_["number"]))
    conn.execute(SEAL_ROUND_SQL, (round_["id"],))
    return through_count


def lock_set(conn, user_id, round_id, set_index, kept_ids):
    """Records one parent's keep/discard call for one set and returns what
    they should see next. When this is their fifth set of the round, seals
    their side; if their partner already sealed too, settles the round right
    here."""
    with immediate(conn):
        round_ = conn.execute("SELECT id, number FROM rounds WHERE id = ?", (round_id,)).fetchone()
        if not round_:
            raise ApiError("That round doesn't exist.", 400)
        if conn.execute(ALREADY_SUBMITTED_SQL, (round_id, set_index, user_id)).fetchone():
            raise ApiError("That set was already locked in.", 409)
        names = conn.execute(NAMES_IN_SET_SQL, (round_id, set_index)).fetchall()
        if len(names) != SET_SIZE:
            raise ApiError("That set doesn't exist.", 400)

        kept = set(kept_ids)
        set_keeps = sum(1 for n in names if n["id"] in kept)
        if set_keeps < MIN_KEEP:
            raise ApiError(f"Keep at least {MIN_KEEP} names before locking in.", 400)
        for n in names:
            conn.execute(INSERT_SET_RESULT_SQL, (round_id, set_index, user_id, n["id"], 1 if n["id"] in kept else 0, set_keeps))

        my_done = len(conn.execute(SET_INDEXES_DONE_SQL, (round_id, user_id)).fetchall())
        if my_done < SETS_PER_ROUND:
            return {"sealed": False}

        partner_done = len(conn.execute(SET_INDEXES_DONE_SQL, (round_id, other_user_id(user_id))).fetchall())
        if partner_done >= SETS_PER_ROUND:
            # CO-4 §12's second push trigger. through_count and number are
            # handed back rather than re-queried at the call site -- the
            # round is sealed by the time app.py sees this, so re-deriving
            # "how many survived" would mean redoing _settle_round's own work.
            through_count = _settle_round(conn, round_)
            return {"sealed": True, "roundClosed": True, "number": round_["number"], "throughCount": through_count}
        return {"sealed": True, "roundClosed": False, "number": round_["number"]}
