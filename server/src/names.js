const db = require("./db");
const { transaction } = require("./transaction");

const findByName = db.prepare("SELECT id FROM names WHERE LOWER(name) = LOWER(?)");
const insertName = db.prepare(`INSERT INTO names (name, origin, meaning, added_by) VALUES (?, 'Yours', ?, ?)`);
const nameById = db.prepare("SELECT id, name, origin, meaning FROM names WHERE id = ?");
const userLabel = db.prepare("SELECT name FROM users WHERE id = ?");

/**
 * Add a name to the shared pile (build spec §6, "Add a name to the pile").
 * No per-user rating rows to seed any more (Change Order 1 dropped ratings
 * entirely) — a freshly added name simply has no name_state row yet, which
 * is exactly what rounds.js's newcomer query looks for when it tops up the
 * next round, so it enters the deck for free.
 */
const addName = transaction((userId, name, note) => {
  if (findByName.get(name)) {
    return { ok: false, error: `"${name}" is already in the pile.` };
  }
  const meaning = note || `added by ${userLabel.get(userId).name}`;
  const info = insertName.run(name, meaning, userId);
  return { ok: true, row: nameById.get(info.lastInsertRowid) };
});

module.exports = { addName };
