"""Ported from server/src/list.js. Backs GET /api/list?tab=in|out (build
spec §6 "Shortlist"), Change Order 1 "Shortlist ordering":
    ORDER BY rounds_survived DESC, selectivity DESC
selectivity = avg over kept sets of (6 - set_keeps) / 5 -- the tiebreaker for
(generalised to (size - set_keeps) / (size - 1) so the endgame's smaller sets
score on the same 0-1 scale; for a normal 6-name set it is identical)
names that have all survived the same number of rounds. It rewards being
kept out of a set where the keeper was picky (few of that set's other five
also survived), which rounds_survived alone can't distinguish. Computed over
EVERY kept row for the name, from either parent, across every round played
-- not scoped to one person, since nothing on the shortlist is gated
per-viewer any more (that gate is the in-progress round itself, via
sealed_at; once a round is sealed its outcome is common knowledge).
"""

SELECTIVITY_SQL = """
    SELECT sr.name_id,
           AVG(CASE WHEN sz.n > 1 THEN (sz.n - sr.set_keeps) * 1.0 / (sz.n - 1) ELSE 0 END) AS selectivity
    FROM set_results sr
    JOIN (SELECT round_id, set_index, COUNT(*) AS n FROM round_names GROUP BY round_id, set_index) sz
      ON sz.round_id = sr.round_id AND sz.set_index = sr.set_index
    WHERE sr.kept = 1
    GROUP BY sr.name_id
"""

STILL_IN_SQL = f"""
    SELECT n.id, n.name, n.origin, n.meaning,
           COALESCE(ns.rounds_survived, 0) AS roundsSurvived,
           COALESCE(sel.selectivity, 0) AS selectivity
    FROM names n
    LEFT JOIN name_state ns ON ns.name_id = n.id
    LEFT JOIN ({SELECTIVITY_SQL}) sel ON sel.name_id = n.id
    WHERE ns.eliminated_in IS NULL
    ORDER BY roundsSurvived DESC, selectivity DESC, n.id ASC
"""

OUT_SQL = f"""
    SELECT n.id, n.name, n.origin, n.meaning,
           ns.rounds_survived AS roundsSurvived,
           ns.eliminated_in AS eliminatedIn,
           COALESCE(sel.selectivity, 0) AS selectivity
    FROM names n
    JOIN name_state ns ON ns.name_id = n.id
    LEFT JOIN ({SELECTIVITY_SQL}) sel ON sel.name_id = n.id
    WHERE ns.eliminated_in IS NOT NULL
    ORDER BY ns.eliminated_in DESC, roundsSurvived DESC, selectivity DESC, n.id ASC
"""


def _to_row(n):
    return {
        "id": n["id"],
        "name": n["name"],
        "origin": n["origin"],
        "meaning": n["meaning"],
        "roundsSurvived": n["roundsSurvived"],
        "eliminatedIn": n["eliminatedIn"] if "eliminatedIn" in n.keys() and n["eliminatedIn"] is not None else None,
    }


def get_list(conn, tab):
    rows = conn.execute(OUT_SQL if tab == "out" else STILL_IN_SQL).fetchall()
    return [_to_row(r) for r in rows]
