#!/usr/bin/env python3
"""One-time DB setup, run by hand (CO-4 §5 "DDL stops running at import",
§7 "First run"). Replaces db.js's every-boot schema.exec + seed() + loadPacks()
— those ran on every Node process start; here they run once, and create_app()
only asserts the counts came out right.

    python init_db.py               creates schema.sql, seeds users/settings,
                                     loads seed/packs/*.json, prints counts
    python init_db.py --assert-only checks counts == (3, 61, 846, 1032) and
                                     exits non-zero if they don't match --
                                     what a WSGI worker start should do

Never touches data/nameplate.db by default: NAMEPLATE_DB_PATH must be set
(db.connect() raises otherwise). Point it at a copy while developing.
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import db  # noqa: E402
from packs import load_packs  # noqa: E402
from transaction import immediate  # noqa: E402

EXPECTED_COUNTS = (3, 61, 846, 1032)


def create_schema(conn):
    schema_path = os.path.join(os.path.dirname(__file__), "schema.sql")
    with open(schema_path, "r", encoding="utf-8") as f:
        conn.executescript(f.read())
    _add_columns(conn)


def _column_names(conn, table):
    return [row["name"] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()]


def _add_columns(conn):
    """schema.sql predates CO-3 (Packs and themes as data); db.js's guarded
    ALTERs are what actually put these columns on a real database, so a fresh
    schema.sql-only db is missing them. Ported here rather than into
    schema.sql itself, since CO-4 §5 calls schema.sql unchanged and treats
    these as one-time migrations, same as db.js did — just run once by hand
    instead of on every process start."""
    name_cols = _column_names(conn, "names")
    if "pack_id" not in name_cols:
        conn.execute("ALTER TABLE names ADD COLUMN pack_id INTEGER REFERENCES packs(id)")
    if "variant_family" not in name_cols:
        conn.execute("ALTER TABLE names ADD COLUMN variant_family TEXT")
    if "au_rank" not in name_cols:
        conn.execute("ALTER TABLE names ADD COLUMN au_rank INTEGER")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_names_family ON names(variant_family)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_names_pack ON names(pack_id)")

    round_cols = _column_names(conn, "rounds")
    if "theme_id" not in round_cols:
        conn.execute("ALTER TABLE rounds ADD COLUMN theme_id INTEGER REFERENCES themes(id)")

    # CO-4 §3: pin_hash is in schema.sql's CREATE TABLE now, which only
    # helps a brand-new database -- a database that already has a users
    # table (dev scratch copies, and eventually the real one after §6) needs
    # the column added the same guarded way.
    user_cols = _column_names(conn, "users")
    if "pin_hash" not in user_cols:
        conn.execute("ALTER TABLE users ADD COLUMN pin_hash TEXT")


def ensure_users(conn):
    """Transcribed from seed.js's ensureUsers — only inserts if the table is
    empty, so this is a no-op on a database that already has real users."""
    n = conn.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"]
    if n > 0:
        return
    conn.execute("INSERT INTO users (id, name, surname) VALUES (?, ?, ?)", (1, "Dad", ""))
    conn.execute("INSERT INTO users (id, name, surname) VALUES (?, ?, ?)", (2, "Mum", ""))


def ensure_settings(conn):
    conn.execute(
        "INSERT INTO settings (key, value) SELECT ?, ? WHERE NOT EXISTS "
        "(SELECT 1 FROM settings WHERE key = ?)",
        ("baby_surname", "undecided", "baby_surname"),
    )
    conn.execute(
        "INSERT INTO settings (key, value) SELECT ?, ? WHERE NOT EXISTS "
        "(SELECT 1 FROM settings WHERE key = ?)",
        ("setup_done", "false", "setup_done"),
    )


def counts(conn):
    return (
        conn.execute("SELECT COUNT(*) AS n FROM packs").fetchone()["n"],
        conn.execute("SELECT COUNT(*) AS n FROM themes").fetchone()["n"],
        conn.execute("SELECT COUNT(*) AS n FROM names").fetchone()["n"],
        conn.execute("SELECT COUNT(*) AS n FROM name_themes").fetchone()["n"],
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--assert-only", action="store_true")
    args = parser.parse_args()

    conn = db.connect()
    try:
        if args.assert_only:
            actual = counts(conn)
            if actual != EXPECTED_COUNTS:
                print(f"Count mismatch: expected {EXPECTED_COUNTS}, got {actual}. Run init_db.py.", file=sys.stderr)
                sys.exit(1)
            print(f"OK: {actual}")
            return

        create_schema(conn)
        with immediate(conn):
            ensure_users(conn)
            ensure_settings(conn)
        with immediate(conn):
            load_packs(conn)

        actual = counts(conn)
        print(f"Loaded: packs={actual[0]} themes={actual[1]} names={actual[2]} name_themes={actual[3]}")
        if actual != EXPECTED_COUNTS:
            print(f"Warning: expected {EXPECTED_COUNTS}, got {actual}.", file=sys.stderr)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
