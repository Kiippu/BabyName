"""Ported from server/src/stats.js. Backs GET /api/stats -- the strip at the
foot of the shortlist. Change order, "Agreement %": replaces pairwise Elo
concordance (which needs comparison data that no longer exists) with
per-round overlap -- both_kept / either_kept, averaged across every sealed
round. Scale-free, and it still reads as "how often you two want the same
thing".
"""

TOTAL_NAMES_SQL = "SELECT COUNT(*) AS n FROM names"
STILL_IN_SQL = """
    SELECT COUNT(*) AS n
    FROM names n
    LEFT JOIN name_state ns ON ns.name_id = n.id
    WHERE ns.eliminated_in IS NULL
"""
SEALED_ROUND_IDS_SQL = "SELECT id FROM rounds WHERE sealed_at IS NOT NULL"
# Per round, how much did the two parents' keeps overlap. INTERSECT/UNION
# need the id list on both sides, hence the round id repeated four times.
ROUND_OVERLAP_SQL = """
    SELECT
      (SELECT COUNT(*) FROM (
         SELECT name_id FROM set_results WHERE round_id = ? AND user_id = 1 AND kept = 1
         INTERSECT
         SELECT name_id FROM set_results WHERE round_id = ? AND user_id = 2 AND kept = 1
       )) AS bothKept,
      (SELECT COUNT(*) FROM (
         SELECT name_id FROM set_results WHERE round_id = ? AND user_id = 1 AND kept = 1
         UNION
         SELECT name_id FROM set_results WHERE round_id = ? AND user_id = 2 AND kept = 1
       )) AS eitherKept
"""


def _agreement(conn):
    rounds = conn.execute(SEALED_ROUND_IDS_SQL).fetchall()
    if not rounds:
        return 0
    total = 0.0
    counted = 0
    for r in rounds:
        row = conn.execute(ROUND_OVERLAP_SQL, (r["id"], r["id"], r["id"], r["id"])).fetchone()
        if row["eitherKept"] > 0:
            total += row["bothKept"] / row["eitherKept"]
            counted += 1
    if not counted:
        return 0
    # int(x + 0.5) rather than round() -- Python's round() is banker's
    # rounding (round-half-to-even), JS's Math.round is round-half-up. Both
    # values here are non-negative percentages, so this is exact for that range.
    return int((total / counted) * 100 + 0.5)


def get_stats(conn):
    return {
        "rounds": len(conn.execute(SEALED_ROUND_IDS_SQL).fetchall()),
        "stillIn": conn.execute(STILL_IN_SQL).fetchone()["n"],
        "totalNames": conn.execute(TOTAL_NAMES_SQL).fetchone()["n"],
        "agreement": _agreement(conn),
    }
