"""One-off migration for the CO-1 endgame (Oct 2026): adds rounds.endgame,
which rounds.py sets at assembly once the deck has run out so a round's
keep cap can't change mid-round. Guarded, so running it twice is harmless.
The app works before this runs (it falls back to "a short round is the
endgame"), but run it on deploy so a full-size last round is capped too.

    python migrate_endgame.py            # dry run
    python migrate_endgame.py --apply    # writes it

Needs NAMEPLATE_DB_PATH, same as the app.
"""

import sys

import db
import rounds
from transaction import immediate


def main(apply):
    conn = db.connect()
    cols = [r["name"] for r in conn.execute("PRAGMA table_info(rounds)").fetchall()]
    if "endgame" in cols:
        print("rounds.endgame already exists.")
    elif not apply:
        print("Would add rounds.endgame.")
    else:
        with immediate(conn):
            conn.execute("ALTER TABLE rounds ADD COLUMN endgame INTEGER NOT NULL DEFAULT 0")
        print("Added rounds.endgame.")

    rnd = conn.execute(rounds.OPEN_ROUND_SQL).fetchone()
    if rnd:
        n = conn.execute(rounds.ROUND_NAME_COUNT_SQL, (rnd["id"],)).fetchone()["n"]
        sizes = [r["n"] for r in conn.execute(rounds.SET_SIZES_SQL, (rnd["id"],)).fetchall()]
        in_round = [r["id"] for r in conn.execute(rounds.NAMES_IN_ROUND_SQL, (rnd["id"],)).fetchall()]
        endgame = n < rounds.ROUND_SIZE or rounds.deck_is_empty(conn, in_round)
        print(f"Open round {rnd['number']}: {n} names, sets {sizes}, endgame={endgame}")
        if endgame and apply:
            with immediate(conn):
                conn.execute(rounds.SET_ENDGAME_FLAG_SQL, (rnd["id"],))
            print(f"Marked round {rnd['number']} as an endgame round.")
    if not apply:
        print("\nDry run. Re-run with --apply to write this.")
    return 0


if __name__ == "__main__":
    sys.exit(main("--apply" in sys.argv))
