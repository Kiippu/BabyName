"""Ported from server/src/names.js. Add a name to the shared pile (build spec
§6, "Add a name to the pile"). No per-user rating rows to seed any more
(Change Order 1 dropped ratings entirely) -- a freshly added name simply has
no name_state row yet, which is exactly what rounds.py's newcomer query
looks for when it tops up the next round, so it enters the deck for free.
"""

from transaction import immediate

FIND_BY_NAME_SQL = "SELECT id FROM names WHERE LOWER(name) = LOWER(?)"
INSERT_NAME_SQL = "INSERT INTO names (name, origin, meaning, added_by) VALUES (?, 'Yours', ?, ?)"
NAME_BY_ID_SQL = "SELECT id, name, origin, meaning FROM names WHERE id = ?"
USER_LABEL_SQL = "SELECT name FROM users WHERE id = ?"


def add_name(conn, user_id, name, note):
    with immediate(conn):
        if conn.execute(FIND_BY_NAME_SQL, (name,)).fetchone():
            return {"ok": False, "error": f'"{name}" is already in the pile.'}
        label = conn.execute(USER_LABEL_SQL, (user_id,)).fetchone()["name"]
        meaning = note or f"added by {label}"
        cur = conn.execute(INSERT_NAME_SQL, (name, meaning, user_id))
        row = conn.execute(NAME_BY_ID_SQL, (cur.lastrowid,)).fetchone()
        return {"ok": True, "row": dict(row)}
