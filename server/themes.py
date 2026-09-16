"""Ported from server/src/themes.js. Themes screen (Change Order 3, build
order step 6): packs -> themes, with regions carrying their cultures nested
underneath.
"""

from transaction import immediate

PACKS_SQL = "SELECT id, slug, title, blurb FROM packs ORDER BY sort_order, title"
# nameCount is inherited through parent_id (the recursive `sub` CTE) because
# names never link directly to a region -- see schema.sql and change-order-3.
# Without it every region would show a count of 0.
THEMES_WITH_COUNTS_SQL = """
    WITH RECURSIVE sub(root, id) AS (
      SELECT id, id FROM themes
      UNION ALL
      SELECT s.root, t.id FROM themes t JOIN sub s ON t.parent_id = s.id
    )
    SELECT t.id, t.slug, t.title, t.kind, t.enabled, t.parent_id, t.pack_id, t.sort_order,
           COUNT(DISTINCT n.id) AS nameCount
    FROM themes t
    JOIN sub ON sub.root = t.id
    LEFT JOIN name_themes nt ON nt.theme_id = sub.id
    LEFT JOIN names n ON n.id = nt.name_id
    GROUP BY t.id
"""
SET_ENABLED_SQL = "UPDATE themes SET enabled = ? WHERE id = ?"
THEME_EXISTS_SQL = "SELECT id FROM themes WHERE id = ?"


def _build_children(themes, parent_id):
    children = [t for t in themes if t["parent_id"] == parent_id]
    children.sort(key=lambda t: (t["sort_order"], t["title"]))
    return [
        {
            "id": t["id"],
            "slug": t["slug"],
            "title": t["title"],
            "kind": t["kind"],
            "enabled": bool(t["enabled"]),
            "nameCount": t["nameCount"],
            "children": _build_children(themes, t["id"]),
        }
        for t in children
    ]


def get_themes_tree(conn):
    packs = conn.execute(PACKS_SQL).fetchall()
    themes = conn.execute(THEMES_WITH_COUNTS_SQL).fetchall()
    roots = _build_children(themes, None)
    pack_id_by_theme_id = {t["id"]: t["pack_id"] for t in themes}
    return [
        {
            "id": p["id"],
            "slug": p["slug"],
            "title": p["title"],
            "blurb": p["blurb"],
            "themes": [t for t in roots if pack_id_by_theme_id.get(t["id"]) == p["id"]],
        }
        for p in packs
    ]


def set_theme_enabled(conn, theme_id, enabled):
    """Toggles a single theme -- disabling a region does not touch its children."""
    if not conn.execute(THEME_EXISTS_SQL, (theme_id,)).fetchone():
        return False
    with immediate(conn):
        conn.execute(SET_ENABLED_SQL, (1 if enabled else 0, theme_id))
    return True
