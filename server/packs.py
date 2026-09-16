"""Ported from server/src/packs.js. CO-4 §5: rewrite, all thin. Scans
seed/packs/*.json and upserts pack -> themes -> names -> links, never
truncating (Change Order 3, "The loader"). Upserting on the natural keys
(packs.slug, themes.slug, names.name) is what keeps ids -- and therefore
round history -- stable across every future import, including one that only
adds a pack the app has never seen before.

Not reached by any HTTP route (packs.js wasn't either) -- only init_db.py
calls this, by hand, per CO-4 §5's "DDL stops running at import".
"""

import json
import os

PACKS_DIR = os.path.join(os.path.dirname(__file__), "..", "seed", "packs")


def _read_pack_files():
    if not os.path.isdir(PACKS_DIR):
        return []
    files = []
    for name in sorted(os.listdir(PACKS_DIR)):
        if not name.endswith(".json"):
            continue
        with open(os.path.join(PACKS_DIR, name), "r", encoding="utf-8") as f:
            files.append(json.load(f))
    return files


def load_packs(conn):
    """Two passes for themes: insert every theme bare (no parent yet), since
    a child can appear before its parent in a file, or reference a theme
    defined in a different pack file. Only once every theme in this import
    has an id can parent slugs be trusted to resolve."""
    files = _read_pack_files()

    for file in files:
        pack = file["pack"]
        conn.execute(
            """
            INSERT INTO packs (slug, title, blurb, bundled, sku, version, sort_order)
            VALUES (:slug, :title, :blurb, :bundled, :sku, :version, :sortOrder)
            ON CONFLICT(slug) DO UPDATE SET
              title = excluded.title, blurb = excluded.blurb, bundled = excluded.bundled,
              sku = excluded.sku, version = excluded.version, sort_order = excluded.sort_order
            """,
            {
                "slug": pack["slug"],
                "title": pack["title"],
                "blurb": pack.get("blurb"),
                "bundled": 1 if pack.get("bundled") else 0,
                "sku": pack.get("sku"),
                "version": pack.get("version", 1),
                "sortOrder": pack.get("sortOrder", 0),
            },
        )

    for file in files:
        pack_id = conn.execute("SELECT id FROM packs WHERE slug = ?", (file["pack"]["slug"],)).fetchone()["id"]
        for theme in file["themes"]:
            conn.execute(
                """
                INSERT INTO themes (slug, title, blurb, pack_id, kind)
                VALUES (:slug, :title, :blurb, :packId, :kind)
                ON CONFLICT(slug) DO UPDATE SET
                  title = excluded.title, blurb = excluded.blurb,
                  pack_id = excluded.pack_id, kind = excluded.kind
                """,
                {
                    "slug": theme["slug"],
                    "title": theme["title"],
                    "blurb": theme.get("blurb"),
                    "packId": pack_id,
                    "kind": theme["kind"],
                },
            )

    # Pass 2: every theme in this import now has an id, so parent slugs resolve.
    for file in files:
        for theme in file["themes"]:
            parent_slug = theme.get("parent")
            if not parent_slug:
                continue
            parent = conn.execute("SELECT id FROM themes WHERE slug = ?", (parent_slug,)).fetchone()
            if not parent:
                raise ValueError(f'Theme "{theme["slug"]}" names unknown parent "{parent_slug}"')
            child = conn.execute("SELECT id FROM themes WHERE slug = ?", (theme["slug"],)).fetchone()
            conn.execute("UPDATE themes SET parent_id = ? WHERE id = ?", (parent["id"], child["id"]))

    # Names, upserted by name -- the natural key that keeps ids stable so
    # round history stays attached across every future import.
    for file in files:
        pack_id = conn.execute("SELECT id FROM packs WHERE slug = ?", (file["pack"]["slug"],)).fetchone()["id"]
        for n in file["names"]:
            existing = conn.execute("SELECT id FROM names WHERE name = ?", (n["name"],)).fetchone()
            fields = {
                "origin": n.get("origin"),
                "meaning": n.get("meaning"),
                "packId": pack_id,
                "variantFamily": n.get("variantFamily"),
                "auRank": n.get("auRank"),
            }
            if existing:
                conn.execute(
                    """
                    UPDATE names SET origin = :origin, meaning = :meaning, pack_id = :packId,
                      variant_family = :variantFamily, au_rank = :auRank
                    WHERE id = :id
                    """,
                    {**fields, "id": existing["id"]},
                )
            else:
                conn.execute(
                    """
                    INSERT INTO names (name, origin, meaning, pack_id, variant_family, au_rank)
                    VALUES (:name, :origin, :meaning, :packId, :variantFamily, :auRank)
                    """,
                    {**fields, "name": n["name"]},
                )

    # Links, last -- every name and every theme in this import now has a
    # stable id to link together.
    for file in files:
        for n in file["names"]:
            name_id = conn.execute("SELECT id FROM names WHERE name = ?", (n["name"],)).fetchone()["id"]
            for theme_slug in n.get("themes", []):
                theme = conn.execute("SELECT id FROM themes WHERE slug = ?", (theme_slug,)).fetchone()
                if not theme:
                    raise ValueError(f'Name "{n["name"]}" references unknown theme "{theme_slug}"')
                conn.execute("INSERT OR IGNORE INTO name_themes (name_id, theme_id) VALUES (?, ?)", (name_id, theme["id"]))


def pack_stats(conn):
    return {
        "packs": conn.execute("SELECT COUNT(*) AS n FROM packs").fetchone()["n"],
        "themes": conn.execute("SELECT COUNT(*) AS n FROM themes").fetchone()["n"],
        "names": conn.execute("SELECT COUNT(*) AS n FROM names").fetchone()["n"],
        "nameThemes": conn.execute("SELECT COUNT(*) AS n FROM name_themes").fetchone()["n"],
    }
