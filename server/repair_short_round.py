"""One-off repair for a round that was assembled short (see the comment above
THEMED_DRAW_SQL in rounds.py). Tops up any set of the OPEN round that has
fewer than SET_SIZE names, but only while nobody has locked that set in yet,
so no one's keeps are changed or invalidated. Prefers unseen names from the
round's own theme, then falls back to the whole deck; never adds a name from
a variant family already in the round.

    python repair_short_round.py            # dry run: shows what it would add
    python repair_short_round.py --apply    # writes it

Safe to run more than once: a round with full sets is left alone.
Needs NAMEPLATE_DB_PATH, same as the app.
"""

import sys

import db
import rounds
from transaction import immediate


def main(apply):
    conn = db.connect()
    rnd = conn.execute(rounds.OPEN_ROUND_SQL).fetchone()
    if not rnd:
        print("No open round. Nothing to repair.")
        return 0

    in_round = [r["id"] for r in conn.execute(rounds.NAMES_IN_ROUND_SQL, (rnd["id"],)).fetchall()]
    plan = []
    for set_index in range(rounds.SETS_PER_ROUND):
        have = conn.execute(
            "SELECT COUNT(*) FROM round_names WHERE round_id = ? AND set_index = ?", (rnd["id"], set_index)
        ).fetchone()[0]
        short = rounds.SET_SIZE - have
        if short <= 0:
            continue
        if conn.execute("SELECT 1 FROM set_results WHERE round_id = ? AND set_index = ? LIMIT 1",
                        (rnd["id"], set_index)).fetchone():
            print(f"Set {set_index + 1} is short by {short} but someone already locked it in. Not touching it.")
            continue

        picks = []
        if rnd["theme_id"] is not None:
            # Themed first, filtered through top_up's family check.
            themed = [r["id"] for r in conn.execute(
                rounds.THEMED_DRAW_SQL, {"themeId": rnd["theme_id"], "needed": 1000}).fetchall()]
            families = {conn.execute(rounds.FAMILY_OF_SQL, (i,)).fetchone()["variant_family"] for i in in_round}
            families.discard(None)
            for name_id in themed:
                if len(picks) >= short:
                    break
                fam = conn.execute(rounds.FAMILY_OF_SQL, (name_id,)).fetchone()["variant_family"]
                if name_id in in_round or (fam and fam in families):
                    continue
                picks.append(name_id)
                if fam:
                    families.add(fam)
        if len(picks) < short:
            picks += rounds.top_up(conn, in_round + picks, short - len(picks))

        in_round += picks
        plan.append((set_index, have, picks))

    if not plan:
        print(f"Round {rnd['number']}: every set already has {rounds.SET_SIZE} names. Nothing to do.")
        return 0

    for set_index, have, picks in plan:
        names = [conn.execute("SELECT name FROM names WHERE id = ?", (i,)).fetchone()["name"] for i in picks]
        print(f"Round {rnd['number']}, set {set_index + 1}: has {have}, adding {', '.join(names)}")

    if not apply:
        print("\nDry run. Re-run with --apply to write this.")
        return 0

    with immediate(conn):
        for set_index, _, picks in plan:
            for name_id in picks:
                conn.execute(rounds.INSERT_ROUND_NAME_SQL, (rnd["id"], set_index, name_id))
    print("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main("--apply" in sys.argv))
