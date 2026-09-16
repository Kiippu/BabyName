#!/usr/bin/env python3
"""Sets or resets a parent's PIN. CO-4 §3 "Recovery", §7 "First run".

    python set_pin.py <1|2> <6-digit pin>
"""

import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from werkzeug.security import generate_password_hash  # noqa: E402

import db  # noqa: E402


def main():
    if len(sys.argv) != 3:
        print("usage: set_pin.py <1|2> <6-digit pin>", file=sys.stderr)
        sys.exit(1)

    try:
        user_id = int(sys.argv[1])
    except ValueError:
        print("userId must be 1 or 2", file=sys.stderr)
        sys.exit(1)
    if user_id not in (1, 2):
        print("userId must be 1 or 2", file=sys.stderr)
        sys.exit(1)

    pin = sys.argv[2]
    if not (pin.isdigit() and len(pin) == 6):
        print("pin must be exactly 6 digits", file=sys.stderr)
        sys.exit(1)

    conn = db.connect()
    try:
        conn.execute("UPDATE users SET pin_hash = ? WHERE id = ?", (generate_password_hash(pin), user_id))
        conn.commit()
    finally:
        conn.close()
    print(f"PIN set for user {user_id}")


if __name__ == "__main__":
    main()
