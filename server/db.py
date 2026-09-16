"""Per-request SQLite connections for the Flask port.

CO-4 §5, rules 1-3 and 5: a WSGI worker is not a single long-lived process the
way the Node server was, so there is no module-level connection here — each
request gets its own via flask.g, closed in teardown_appcontext. Every
connection gets a busy_timeout (turns most "database is locked" into a short
wait), foreign_keys ON (off by default, per-connection), and journal_mode =
DELETE (WAL needs a shared-memory file that PythonAnywhere's networked
storage doesn't provide reliably — this inverts db.js's choice, which was
correct for a laptop, on purpose).

No default for NAMEPLATE_DB_PATH: the port must never fall back to touching
the real household database by accident.
"""

import os
import sqlite3


def _db_path():
    path = os.environ.get("NAMEPLATE_DB_PATH")
    if not path:
        raise RuntimeError(
            "NAMEPLATE_DB_PATH is not set. Refusing to guess a database path."
        )
    return path


def connect():
    """Opens one connection with the pragmas CO-4 §5 requires. Callers that
    aren't inside a Flask request (init_db.py, set_pin.py, tests) use this
    directly instead of get_db()."""
    conn = sqlite3.connect(_db_path())
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 5000")
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = DELETE")
    return conn


def get_db():
    """Request-scoped connection, per CO-4 §5 rule 1. Import inside the
    function so this module has no hard dependency on an app context existing
    (connect() above works standalone for scripts and tests)."""
    from flask import g

    if "db" not in g:
        g.db = connect()
    return g.db


def close_db(exception=None):
    from flask import g

    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_app(app):
    app.teardown_appcontext(close_db)
