"""Ported from server/src/detail.js. Backing data for the name detail sheet
(build spec §6 "Shortlist", Change Order 2 §1).
"""

from settings import full_names, get_settings

NAME_BY_ID_SQL = "SELECT id, name, origin, meaning, rank FROM names WHERE id = ?"
NAME_STATE_SQL = "SELECT rounds_survived, eliminated_in FROM name_state WHERE name_id = ?"
USER_LABEL_SQL = "SELECT name FROM users WHERE id = ?"
# Only sealed rounds count -- blind reveal means an in-progress round can't
# leak into these numbers.
KEEP_COUNT_SQL = """
    SELECT COUNT(*) AS n
    FROM set_results sr
    JOIN rounds r ON r.id = sr.round_id
    WHERE sr.name_id = ? AND sr.user_id = ? AND sr.kept = 1 AND r.sealed_at IS NOT NULL
"""
FIRST_SEEN_SQL = """
    SELECT MIN(r.number) AS round
    FROM set_results sr
    JOIN rounds r ON r.id = sr.round_id
    WHERE sr.name_id = ? AND r.sealed_at IS NOT NULL
"""


def _other_user_id(user_id):
    return 2 if user_id == 1 else 1


def get_name_detail(conn, name_id, viewer_id):
    n = conn.execute(NAME_BY_ID_SQL, (name_id,)).fetchone()
    if not n:
        return None

    state = conn.execute(NAME_STATE_SQL, (name_id,)).fetchone()
    partner_id = _other_user_id(viewer_id)
    partner = conn.execute(USER_LABEL_SQL, (partner_id,)).fetchone()
    first_seen = conn.execute(FIRST_SEEN_SQL, (name_id,)).fetchone()

    return {
        "id": n["id"],
        "name": n["name"],
        "origin": n["origin"],
        "meaning": n["meaning"],
        "auRank": n["rank"],
        "fullNames": full_names(n["name"], get_settings(conn)),
        "roundsSurvived": state["rounds_survived"] if state else 0,
        "eliminatedIn": state["eliminated_in"] if state else None,
        "youKeptCount": conn.execute(KEEP_COUNT_SQL, (name_id, viewer_id)).fetchone()["n"],
        "partnerLabel": partner["name"],
        "partnerKeptCount": conn.execute(KEEP_COUNT_SQL, (name_id, partner_id)).fetchone()["n"],
        "firstSeenRound": first_seen["round"] if first_seen else None,
    }
