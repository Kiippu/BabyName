"""BEGIN IMMEDIATE wrapper for every write path.

CO-4 §5 rule 4: take the write lock up front rather than letting sqlite3's
default deferred-BEGIN discover a conflict partway through. Mirrors
server/src/transaction.js's BEGIN/COMMIT/ROLLBACK-by-hand shape, since
Python's sqlite3 module has no built-in immediate-transaction context manager
either (its own `with conn:` only wraps commit/rollback, and still defers the
BEGIN).
"""

from contextlib import contextmanager


@contextmanager
def immediate(conn):
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield conn
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
