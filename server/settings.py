"""Ported from server/src/settings.js. CO-4 §5: whole-object PUT, as built --
not the build spec's /api/settings/surname.
"""

from transaction import immediate

BABY_SURNAME_MODES = ["father", "mother", "both", "undecided"]


def get_settings(conn):
    father = conn.execute("SELECT id, name, surname FROM users WHERE id = 1").fetchone()
    mother = conn.execute("SELECT id, name, surname FROM users WHERE id = 2").fetchone()
    baby_surname_row = conn.execute("SELECT value FROM settings WHERE key = 'baby_surname'").fetchone()
    setup_done_row = conn.execute("SELECT value FROM settings WHERE key = 'setup_done'").fetchone()
    return {
        "babySurname": baby_surname_row["value"] if baby_surname_row else "undecided",
        "setupDone": setup_done_row is not None and setup_done_row["value"] == "true",
        "father": {"name": father["name"], "surname": father["surname"]},
        "mother": {"name": mother["name"], "surname": mother["surname"]},
    }


def update_settings(conn, father, mother, baby_surname):
    if baby_surname not in BABY_SURNAME_MODES:
        raise ValueError(f"babySurname must be one of {', '.join(BABY_SURNAME_MODES)}")
    with immediate(conn):
        conn.execute(
            "UPDATE users SET name = ?, surname = ? WHERE id = ?",
            (father["name"].strip() or "Dad", father["surname"].strip(), 1),
        )
        conn.execute(
            "UPDATE users SET name = ?, surname = ? WHERE id = ?",
            (mother["name"].strip() or "Mum", mother["surname"].strip(), 2),
        )
        conn.execute("UPDATE settings SET value = ? WHERE key = ?", (baby_surname, "baby_surname"))
        conn.execute("UPDATE settings SET value = ? WHERE key = ?", ("true", "setup_done"))
    return get_settings(conn)


def surname_options(baby_surname, father_surname, mother_surname):
    """Every surname a baby might end up carrying (build spec §9)."""
    f = (father_surname or "").strip()
    m = (mother_surname or "").strip()
    if baby_surname == "father":
        return [f] if f else []
    if baby_surname == "mother":
        return [m] if m else []
    if baby_surname == "both":
        joined = "-".join(x for x in (f, m) if x)
        return [joined] if joined else []
    out = []
    if f:
        out.append(f)
    if m and m != f:
        out.append(m)
    if f and m and f != m:
        out.append(f"{f}-{m}")
        out.append(f"{m}-{f}")
    return out


def full_names(first_name, settings):
    options = surname_options(settings["babySurname"], settings["father"]["surname"], settings["mother"]["surname"])
    return [f"{first_name} {s}" for s in options] if options else [first_name]
