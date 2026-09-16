const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

// Node's built-in synchronous SQLite (stable since Node 22) — no native
// toolchain to build, one file to back up, same "boring" spirit as the
// better-sqlite3 the build spec names, without requiring a C++ build
// environment on the machine that runs this.
const DATA_DIR = path.join(__dirname, "..", "..", "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Override lets integration tests point at a throwaway file instead of the
// real household database; unset in normal operation.
const dbPath = process.env.NAMEPLATE_DB_PATH || path.join(DATA_DIR, "nameplate.db");
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
db.exec(schema);

function columnNames(table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}
function tableExists(table) {
  return !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?")
    .get(table);
}

// One-time migration for Change Order 1 ("Rounds", user-confirmed 2026-09-07,
// backup taken first): the Elo/pairwise-duel tournament and vetoes/matches are
// retired outright in favour of the set-screen mechanic (rounds/round_names/
// set_results/name_state, created by schema.sql above). Drop what's left of
// the old mechanic so seed.js and the new route handlers don't have to
// coexist with dead tables. Guarded so this is a no-op on a database that has
// already been migrated once.
if (tableExists("live_names")) db.exec("DROP VIEW live_names");
for (const table of ["matches", "vetoes", "round_results", "duels", "ratings"]) {
  if (tableExists(table)) db.exec(`DROP TABLE ${table}`);
}

const nameCols = columnNames("names");
if (nameCols.includes("status")) db.exec("ALTER TABLE names DROP COLUMN status");
if (nameCols.includes("current_round")) db.exec("ALTER TABLE names DROP COLUMN current_round");

// One-time migration for Change Order 3 ("Packs and themes as data"): themes
// stop being a hardcoded enum and become rows, so adding a pack is a JSON
// file and a restart, not a code change. Guarded the same way as the
// migrations above -- SQLite has no ADD COLUMN IF NOT EXISTS.
if (!nameCols.includes("pack_id")) db.exec("ALTER TABLE names ADD COLUMN pack_id INTEGER REFERENCES packs(id)");
if (!nameCols.includes("variant_family")) db.exec("ALTER TABLE names ADD COLUMN variant_family TEXT");
if (!nameCols.includes("au_rank")) db.exec("ALTER TABLE names ADD COLUMN au_rank INTEGER");
db.exec("CREATE INDEX IF NOT EXISTS idx_names_family ON names(variant_family)");
db.exec("CREATE INDEX IF NOT EXISTS idx_names_pack ON names(pack_id)");

const roundCols = columnNames("rounds");
if (!roundCols.includes("theme_id")) db.exec("ALTER TABLE rounds ADD COLUMN theme_id INTEGER REFERENCES themes(id)");

// One-time migration for the session-based identity model (owner's call,
// 2026-09-07): the old "claimed once, forever" devices table kept getting a
// shared phone stuck as the wrong person with no way to fix it themselves —
// replaced by the short-lived `sessions` table above. Guarded so this is a
// no-op once already migrated.
if (tableExists("devices")) db.exec("DROP TABLE devices");

module.exports = db;
