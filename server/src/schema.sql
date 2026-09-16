CREATE TABLE IF NOT EXISTS users (
  id       INTEGER PRIMARY KEY,     -- 1 = father, 2 = mother
  name     TEXT NOT NULL,           -- their actual first name, set at setup
  surname  TEXT NOT NULL DEFAULT ''  -- the two may differ; never assume they match
);

-- Owner's revision to spec §8's original "claimed once, forever" device
-- binding: a shared household device kept ending up permanently bound to the
-- wrong person (dev testing pollution, phone handed to the other parent,
-- etc.) with no self-service fix. Replaced with a short-lived, sliding
-- session instead: whoever opens the app picks who they are, and that
-- choice sticks for 5 minutes of activity before it has to be picked again.
-- No exclusivity — either person can be picked from any device at any time;
-- this is a two-person household, not a security boundary.
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL   -- epoch ms; session is dead once past this
);

CREATE TABLE IF NOT EXISTS names (
  id        INTEGER PRIMARY KEY,
  name      TEXT NOT NULL UNIQUE,
  origin    TEXT,
  meaning   TEXT,
  added_by  INTEGER REFERENCES users(id),   -- NULL for seed names
  "group"   TEXT,                            -- variant-family key; pairs must not share one
  rank      INTEGER,                         -- AU top-100 rank, or NULL; never shown on set screen
  created_at TEXT DEFAULT (datetime('now'))
);

-- Change Order 3 (Packs and themes as data). A pack is a distributable unit
-- of names -- all three ship bundled today; sku/bundled are the seam for
-- selling one later and do nothing yet.
CREATE TABLE IF NOT EXISTS packs (
  id           INTEGER PRIMARY KEY,
  slug         TEXT    NOT NULL UNIQUE,
  title        TEXT    NOT NULL,
  blurb        TEXT,
  bundled      INTEGER NOT NULL DEFAULT 1,
  sku          TEXT,
  version      INTEGER NOT NULL DEFAULT 1,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  installed_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- A theme is what a round draws its new names from, in three kinds because
-- they're genuinely different things: `culture` (a language or people, keyed
-- to names.origin), `region` (a parent holding cultures too thin to carry a
-- round alone -- only 14 of 43 cultures have 20+ names), and `collection` (a
-- curated list that isn't a culture, e.g. Australia's Top 100). Disabling one
-- is a data change, not a code change.
CREATE TABLE IF NOT EXISTS themes (
  id         INTEGER PRIMARY KEY,
  slug       TEXT    NOT NULL UNIQUE,
  title      TEXT    NOT NULL,
  blurb      TEXT,
  pack_id    INTEGER REFERENCES packs(id) ON DELETE CASCADE,
  parent_id  INTEGER REFERENCES themes(id) ON DELETE SET NULL,
  kind       TEXT    NOT NULL DEFAULT 'culture'
             CHECK (kind IN ('region','culture','collection')),
  enabled    INTEGER NOT NULL DEFAULT 1,
  weight     REAL    NOT NULL DEFAULT 1.0,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_themes_pack   ON themes(pack_id);
CREATE INDEX IF NOT EXISTS idx_themes_parent ON themes(parent_id);

-- Many-to-many on purpose: Lachlan is Scottish and Australian, Kai is
-- Hawaiian and in Australia's top 100. A name link disappears the moment the
-- name is dealt (name_state gets a row), from every theme at once -- there is
-- deliberately no per-theme "seen" flag, since that would be the same fact
-- stored twice. Names link only to cultures and collections, never regions --
-- region membership is inherited via parent_id.
CREATE TABLE IF NOT EXISTS name_themes (
  name_id  INTEGER NOT NULL REFERENCES names(id)  ON DELETE CASCADE,
  theme_id INTEGER NOT NULL REFERENCES themes(id) ON DELETE CASCADE,
  PRIMARY KEY (name_id, theme_id)
);
CREATE INDEX IF NOT EXISTS idx_name_themes_theme ON name_themes(theme_id);
CREATE INDEX IF NOT EXISTS idx_name_themes_name  ON name_themes(name_id);

-- Change Order 1 (Rounds). A round is 5 sets of 6 names; both parents see the
-- exact same 30 names in the exact same sets. Superseded: ratings/elo, duels,
-- round_results (old WWLL tournament), vetoes, matches -- see the change order.
CREATE TABLE IF NOT EXISTS rounds (
  id         INTEGER PRIMARY KEY,
  number     INTEGER NOT NULL,
  started_at TEXT DEFAULT (datetime('now')),
  sealed_at  TEXT                            -- NULL until BOTH parents finish every set
);

-- The shuffle is rolled once per round, not once per person, and stored here --
-- this is what lets a second parent open the app hours later and be served the
-- identical 5-sets-of-6 their partner saw, rather than a fresh independent
-- shuffle. Not in either source doc verbatim; added to close that gap.
CREATE TABLE IF NOT EXISTS round_names (
  round_id  INTEGER REFERENCES rounds(id),
  set_index INTEGER NOT NULL,        -- 0..4
  name_id   INTEGER REFERENCES names(id),
  PRIMARY KEY (round_id, name_id)
);

-- One row per name per parent per set. Append-only; name_state below is
-- derived from this, so the funnel can be replayed if progression is ever
-- retuned. set_keeps (how many of the 6 that parent kept in THIS set) is what
-- makes selectivity possible later -- it can't be reconstructed after the fact.
CREATE TABLE IF NOT EXISTS set_results (
  round_id  INTEGER REFERENCES rounds(id),
  set_index INTEGER,
  user_id   INTEGER REFERENCES users(id),
  name_id   INTEGER REFERENCES names(id),
  kept      INTEGER NOT NULL,        -- 0 or 1
  set_keeps INTEGER NOT NULL,        -- how many of the 6 that parent kept in this set
  PRIMARY KEY (round_id, set_index, user_id, name_id)
);

CREATE TABLE IF NOT EXISTS name_state (
  name_id         INTEGER PRIMARY KEY REFERENCES names(id),
  rounds_survived INTEGER NOT NULL DEFAULT 0,
  eliminated_in   INTEGER             -- round number it fell out in, NULL while still in
);

-- Build order step 4 ("Seal -> waiting -> round result"). A round seals the
-- instant BOTH parents finish it, but each parent still needs their own
-- full-screen recap exactly once. This is separate from round progression
-- itself: a person can ack round 4 well after round 5 has already been
-- assembled because their partner moved on first.
CREATE TABLE IF NOT EXISTS round_acks (
  round_id INTEGER REFERENCES rounds(id),
  user_id  INTEGER REFERENCES users(id),
  PRIMARY KEY (round_id, user_id)
);

-- keys: baby_surname ('father'|'mother'|'both'|'undecided'), setup_done
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
