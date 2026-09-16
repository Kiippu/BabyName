const db = require("./db");
const { transaction } = require("./transaction");

// Change Order 1: a round is 5 sets of 6 names — 30 names per round per
// person, each name appearing exactly once. See nameplate-change-order.md.
const SETS_PER_ROUND = 5;
const SET_SIZE = 6;
const ROUND_SIZE = SETS_PER_ROUND * SET_SIZE;
// Revision to the original change order (owner's live call, post-launch
// testing): keeps are no longer optional. A parent must keep at least this
// many of the 6 before a set can be locked in — "in real life a name must be
// chosen," not left to a zero-effort skip.
const MIN_KEEP = 3;

const openRoundStmt = db.prepare(`
  SELECT r.id, r.number, r.started_at, r.sealed_at, r.theme_id, t.title AS theme_title
  FROM rounds r
  LEFT JOIN themes t ON t.id = r.theme_id
  WHERE r.sealed_at IS NULL
  ORDER BY r.number DESC LIMIT 1
`);
const maxRoundNumberStmt = db.prepare("SELECT MAX(number) AS n FROM rounds");
const lastRoundThemeStmt = db.prepare("SELECT theme_id FROM rounds ORDER BY number DESC LIMIT 1");
const roundByNumberStmt = db.prepare(`
  SELECT r.id, r.number, r.theme_id, t.title AS theme_title
  FROM rounds r
  LEFT JOIN themes t ON t.id = r.theme_id
  WHERE r.number = ?
`);
const insertRoundStmt = db.prepare("INSERT INTO rounds (number, theme_id) VALUES (?, ?)");
const insertRoundNameStmt = db.prepare(
  "INSERT INTO round_names (round_id, set_index, name_id) VALUES (?, ?, ?)"
);
// A name that has survived at least one round and hasn't fallen out yet.
const survivorIdsStmt = db.prepare("SELECT name_id AS id FROM name_state WHERE eliminated_in IS NULL");
// A name that has never appeared in any round at all — name_state rows are
// only written when a round is sealed (survived or eliminated), so "no row"
// means "still in the deck".
const newcomerIdsStmt = db.prepare(`
  SELECT id FROM names
  WHERE NOT EXISTS (SELECT 1 FROM name_state ns WHERE ns.name_id = names.id)
  ORDER BY RANDOM() LIMIT ?
`);
// Change Order 3 §3: which themes could supply this round's newcomers, walking
// region -> culture inheritance via the recursive CTE (a plain theme_id match
// returns zero rows for every region, since names never link to regions
// directly). Excludes whatever theme ran last round -- "never the same theme
// twice running" -- unless there wasn't one.
const eligibleThemesStmt = db.prepare(`
  WITH RECURSIVE sub(root, id) AS (
    SELECT id, id FROM themes
    UNION ALL
    SELECT s.root, t.id FROM themes t JOIN sub s ON t.parent_id = s.id
  )
  SELECT t.id, t.slug, t.title, t.kind, t.weight, COUNT(DISTINCT n.id) AS unseen
  FROM themes t
  JOIN packs p        ON p.id = t.pack_id
  JOIN sub            ON sub.root = t.id
  JOIN name_themes nt ON nt.theme_id = sub.id
  JOIN names n        ON n.id = nt.name_id
  LEFT JOIN name_state s ON s.name_id = n.id
  WHERE t.enabled = 1
    AND p.bundled = 1
    AND s.name_id IS NULL
    AND (@previousThemeId IS NULL OR t.id <> @previousThemeId)
  GROUP BY t.id
  HAVING unseen >= @needed
`);
// Clash-free draw from a theme (and, for a region, everything under it):
// GROUP BY the variant family allows at most one of Luca/Luka etc. per draw.
const themedDrawStmt = db.prepare(`
  WITH RECURSIVE sub(id) AS (
    SELECT @themeId
    UNION ALL
    SELECT t.id FROM themes t JOIN sub ON t.parent_id = sub.id
  )
  SELECT n.id FROM names n
  JOIN name_themes nt ON nt.name_id = n.id AND nt.theme_id IN (SELECT id FROM sub)
  LEFT JOIN name_state s ON s.name_id = n.id
  WHERE s.name_id IS NULL
  GROUP BY COALESCE(n.variant_family, n.id)
  ORDER BY RANDOM() LIMIT @needed
`);

// heldCount (name_state.rounds_survived BEFORE this round is decided) is
// fetched here but deliberately withheld from the live selection payload —
// see toLiveCard below. The column stays in this query because lockSet
// (further down) reuses namesInSetStmt for its own id/size checks.
const namesInSetStmt = db.prepare(`
  SELECT n.id, n.name, n.origin, n.meaning, COALESCE(ns.rounds_survived, 0) AS heldCount
  FROM round_names rn
  JOIN names n ON n.id = rn.name_id
  LEFT JOIN name_state ns ON ns.name_id = n.id
  WHERE rn.round_id = ? AND rn.set_index = ?
`);
const namesInRoundStmt = db.prepare("SELECT name_id AS id FROM round_names WHERE round_id = ?");
const setIndexesDoneStmt = db.prepare(
  "SELECT DISTINCT set_index FROM set_results WHERE round_id = ? AND user_id = ?"
);
const alreadySubmittedStmt = db.prepare(
  "SELECT 1 FROM set_results WHERE round_id = ? AND set_index = ? AND user_id = ? LIMIT 1"
);
const insertSetResultStmt = db.prepare(`
  INSERT INTO set_results (round_id, set_index, user_id, name_id, kept, set_keeps)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const keptByStmt = db.prepare(
  "SELECT name_id AS id FROM set_results WHERE round_id = ? AND user_id = ? AND kept = 1"
);
const sealRoundStmt = db.prepare("UPDATE rounds SET sealed_at = datetime('now') WHERE id = ?");
const nameStateStmt = db.prepare("SELECT rounds_survived, eliminated_in FROM name_state WHERE name_id = ?");
const upsertNameStateStmt = db.prepare(`
  INSERT INTO name_state (name_id, rounds_survived, eliminated_in) VALUES (?, ?, ?)
  ON CONFLICT(name_id) DO UPDATE SET rounds_survived = excluded.rounds_survived, eliminated_in = excluded.eliminated_in
`);

// Change order, "Seal -> waiting -> round result" (build order step 4). A
// round is fully sealed once BOTH parents finish it (settleRound above), but
// each parent still needs to see their OWN full-screen recap of it exactly
// once, whenever they next open the app — regardless of how far ahead their
// partner already is. round_acks tracks that per-person, independent of
// round progression itself, so "I acked round 4" and "round 5 already got
// assembled because my partner moved on" can both be true at once.
const pendingResultRoundStmt = db.prepare(`
  SELECT id, number FROM rounds
  WHERE sealed_at IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM round_acks ra WHERE ra.round_id = rounds.id AND ra.user_id = ?)
  ORDER BY number ASC LIMIT 1
`);
const ackRoundStmt = db.prepare("INSERT OR IGNORE INTO round_acks (round_id, user_id) VALUES (?, ?)");
const roundByIdStmt = db.prepare(`
  SELECT r.id, r.number, r.sealed_at, r.theme_id, t.title AS theme_title
  FROM rounds r
  LEFT JOIN themes t ON t.id = r.theme_id
  WHERE r.id = ?
`);
// Whole-round name list (all 5 sets), for the result screen — namesInSetStmt
// above is scoped to one set at a time, which the set screen needs but the
// result screen doesn't.
const namesInRoundFullStmt = db.prepare(`
  SELECT n.id, n.name, n.origin, n.meaning, COALESCE(ns.rounds_survived, 0) AS heldCount
  FROM round_names rn
  JOIN names n ON n.id = rn.name_id
  LEFT JOIN name_state ns ON ns.name_id = n.id
  WHERE rn.round_id = ?
`);
const userLabelStmt = db.prepare("SELECT name FROM users WHERE id = ?");

function otherUserId(userId) {
  return userId === 1 ? 2 : 1;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function toCard(row) {
  // rank is intentionally never sent here — see spec §10, no popularity anchor.
  return { id: row.id, name: row.name, origin: row.origin, meaning: row.meaning, heldCount: row.heldCount };
}

// Owner's live call, post-launch testing: heldCount ("kept N before") is
// withheld while a name is actively being judged in a new round — seeing
// that a name already survived prior rounds anchors the decision instead of
// it being made fresh each time. It's still tracked underneath and shown
// once the round is sealed, in the result recap (toCard/getRoundResult
// below) — this is scoped to live selection only, same shape as the
// no-popularity-anchor rule on rank just above.
function toLiveCard(row) {
  const { heldCount, ...rest } = toCard(row);
  return rest;
}

// Change Order 2 §2: one random theme supplies a round's newcomers, biased by
// t.weight. Plain linear-scan weighted pick — 30-ish eligible themes, called
// once per round, no need for anything fancier.
function weightedThemePick(themes) {
  const total = themes.reduce((sum, t) => sum + t.weight, 0);
  let roll = Math.random() * total;
  for (const t of themes) {
    roll -= t.weight;
    if (roll < 0) return t;
  }
  return themes[themes.length - 1];
}

/**
 * Rolls a fresh round: survivors of the last sealed round, topped up with
 * newcomers from the deck, shuffled together — never a "veterans round" or an
 * "all-new round" (change order, "Shuffling — do not skip this") — and split
 * into 5 sets of 6. The assignment is written to round_names once here, so
 * both parents are served the identical sets regardless of who opens the app
 * first (this table isn't in either source doc verbatim; it's what makes
 * "both parents see the same 30 names in the same sets" actually persist).
 *
 * Change Order 2 §2: the newcomers come from a single randomly-chosen theme
 * (never the same one two rounds running) instead of the whole pool. If no
 * theme has enough unseen names left for this round's need, the deck is
 * exhausted for a themed draw — CO1's full endgame (cap keeps at 3, run off
 * survivors) isn't built, so this falls back to the old unfiltered draw
 * rather than stalling the round.
 */
const assembleRound = transaction(() => {
  const survivors = survivorIdsStmt.all().map((r) => r.id);
  const need = Math.max(0, ROUND_SIZE - survivors.length);

  let themeId = null;
  let newcomers = [];
  if (need > 0) {
    const previousThemeId = lastRoundThemeStmt.get()?.theme_id ?? null;
    const eligible = eligibleThemesStmt.all({ previousThemeId, needed: need });
    if (eligible.length > 0) {
      themeId = weightedThemePick(eligible).id;
      newcomers = themedDrawStmt.all({ themeId, needed: need }).map((r) => r.id);
    } else {
      newcomers = newcomerIdsStmt.all(need).map((r) => r.id);
    }
  }
  const roundNames = shuffle(survivors.concat(newcomers));

  const number = (maxRoundNumberStmt.get().n || 0) + 1;
  const { lastInsertRowid: roundId } = insertRoundStmt.run(number, themeId);
  roundNames.forEach((nameId, i) => {
    insertRoundNameStmt.run(roundId, Math.floor(i / SET_SIZE), nameId);
  });
  return openRoundStmt.get();
});

/** The round currently in play, assembling a new one if none is open. */
function getCurrentRound() {
  return openRoundStmt.get() || assembleRound();
}

/**
 * What this person should see right now: their next set to sort, a wait
 * state once they've locked in all 5 and are ahead of their partner, or the
 * result of a round that's now fully sealed but they haven't seen yet.
 * Checking for an unacked result BEFORE touching getCurrentRound matters: it
 * stops this person on round N's result even if round N+1 has already been
 * assembled because their partner acked first and moved on. Nothing about a
 * round's outcome is ever revealed before it's sealed (blind reveal, change
 * order "restated") — settleRound is the only place that's decided.
 */
function roundPayload(userId) {
  const pending = pendingResultRoundStmt.get(userId);
  if (pending) {
    return {
      roundId: pending.id,
      number: pending.number,
      setIndex: SETS_PER_ROUND,
      setsTotal: SETS_PER_ROUND,
      names: null,
      waiting: false,
      resultReady: true,
      themeTitle: null,
    };
  }

  const round = getCurrentRound();
  const done = setIndexesDoneStmt.all(round.id, userId).length;
  if (done >= SETS_PER_ROUND) {
    const partnerSetsDone = setIndexesDoneStmt.all(round.id, otherUserId(userId)).length;
    return {
      roundId: round.id,
      number: round.number,
      setIndex: done,
      setsTotal: SETS_PER_ROUND,
      names: null,
      waiting: true,
      partnerSetsDone,
      themeTitle: round.theme_title ?? null,
    };
  }
  const names = shuffle(namesInSetStmt.all(round.id, done).map(toLiveCard));
  return {
    roundId: round.id,
    number: round.number,
    setIndex: done,
    setsTotal: SETS_PER_ROUND,
    names,
    waiting: false,
    themeTitle: round.theme_title ?? null,
  };
}

/**
 * The full-screen recap for a sealed round (change order, "The round result —
 * build this properly"): what got through, what each parent kept alone, and
 * what's out. 403s until the round is actually sealed — this is the
 * server-side half of the blind-reveal guarantee, the same as the old
 * per-name gating was for ratings.
 */
function getRoundResult(userId, roundId) {
  const round = roundByIdStmt.get(roundId);
  if (!round) throw Object.assign(new Error("That round doesn't exist."), { status: 404 });
  if (!round.sealed_at) {
    throw Object.assign(new Error("That round hasn't been sealed by both parents yet."), { status: 403 });
  }

  const partnerId = otherUserId(userId);
  const mine = new Set(keptByStmt.all(roundId, userId).map((r) => r.id));
  const theirs = new Set(keptByStmt.all(roundId, partnerId).map((r) => r.id));

  const through = [];
  const mineOnly = [];
  const theirsOnly = [];
  const out = [];
  for (const n of namesInRoundFullStmt.all(roundId)) {
    const gotMine = mine.has(n.id);
    const gotTheirs = theirs.has(n.id);
    if (gotMine && gotTheirs) through.push(toCard(n));
    else if (gotMine) mineOnly.push({ id: n.id, name: n.name, origin: n.origin, meaning: n.meaning });
    else if (gotTheirs) theirsOnly.push({ id: n.id, name: n.name, origin: n.origin, meaning: n.meaning });
    else out.push({ id: n.id, name: n.name });
  }

  const partner = userLabelStmt.get(partnerId);

  return {
    roundId: round.id,
    number: round.number,
    totalNames: through.length + mineOnly.length + theirsOnly.length + out.length,
    through,
    mineOnly,
    theirsOnly,
    out,
    partnerLabel: partner ? partner.name : "your partner",
    nextThemeHint: computeNextThemeHint(round),
  };
}

/**
 * Change Order 2 §2's "tease": what the next round is likely to draw from,
 * shown on this round's recap. If that round has already been assembled
 * (a partner well ahead can seal several rounds before this one is acked —
 * see round_acks above), report its actual committed theme instead of a
 * preview, since by then the pick is no longer hypothetical. Otherwise
 * preview up to 3 themes that currently qualify — the real pick happens
 * fresh, randomly, at assembly time, so this is a hint, not a promise.
 */
function computeNextThemeHint(sealedRound) {
  const nextNumber = sealedRound.number + 1;
  const already = roundByNumberStmt.get(nextNumber);
  if (already) {
    return already.theme_title ? `Round ${nextNumber} draws from ${already.theme_title}` : null;
  }

  const survivors = survivorIdsStmt.all().length;
  const need = Math.max(0, ROUND_SIZE - survivors);
  if (need <= 0) return null;

  const eligible = eligibleThemesStmt.all({ previousThemeId: sealedRound.theme_id, needed: need });
  if (eligible.length === 0) return null;

  const picks = shuffle(eligible)
    .slice(0, 3)
    .map((t) => t.title);
  const last = picks.pop();
  return picks.length ? `Round ${nextNumber} draws from ${picks.join(", ")} and ${last}` : `Round ${nextNumber} draws from ${last}`;
}

/**
 * Marks a round's result as seen by this person, then hands back whatever
 * they should see next (the next set, a wait state, or — if their partner
 * hasn't acked yet either but a further round is already moving — nothing
 * special; ordinary roundPayload rules apply from here).
 */
function ackRound(userId, roundId) {
  const round = roundByIdStmt.get(roundId);
  if (!round) throw Object.assign(new Error("That round doesn't exist."), { status: 404 });
  if (!round.sealed_at) {
    throw Object.assign(new Error("That round hasn't been sealed yet."), { status: 403 });
  }
  ackRoundStmt.run(roundId, userId);
  return roundPayload(userId);
}

/**
 * A name survives to the next round only if BOTH parents kept it in this
 * round; everything else is out permanently (change order, "Progression").
 * Plain (non-transactional) helper — always called from inside lockSet's
 * transaction below, and node:sqlite has no nested-transaction support.
 */
function settleRound(round) {
  const keptByA = new Set(keptByStmt.all(round.id, 1).map((r) => r.id));
  const keptByB = new Set(keptByStmt.all(round.id, 2).map((r) => r.id));
  for (const { id: nameId } of namesInRoundStmt.all(round.id)) {
    const survived = keptByA.has(nameId) && keptByB.has(nameId);
    const prior = nameStateStmt.get(nameId);
    const roundsSurvived = (prior?.rounds_survived || 0) + (survived ? 1 : 0);
    upsertNameStateStmt.run(nameId, roundsSurvived, survived ? null : round.number);
  }
  sealRoundStmt.run(round.id);
}

/**
 * Records one parent's keep/discard call for one set and returns what they
 * should see next. When this is their fifth set of the round, seals their
 * side; if their partner already sealed too, settles the round right here.
 */
const lockSet = transaction((userId, roundId, setIndex, keptIds) => {
  const round = db.prepare("SELECT id, number FROM rounds WHERE id = ?").get(roundId);
  if (!round) throw Object.assign(new Error("That round doesn't exist."), { status: 400 });
  if (alreadySubmittedStmt.get(roundId, setIndex, userId)) {
    throw Object.assign(new Error("That set was already locked in."), { status: 409 });
  }
  const names = namesInSetStmt.all(roundId, setIndex);
  if (names.length !== SET_SIZE) {
    throw Object.assign(new Error("That set doesn't exist."), { status: 400 });
  }

  const kept = new Set(keptIds);
  const setKeeps = names.filter((n) => kept.has(n.id)).length;
  if (setKeeps < MIN_KEEP) {
    throw Object.assign(new Error(`Keep at least ${MIN_KEEP} names before locking in.`), { status: 400 });
  }
  for (const n of names) {
    insertSetResultStmt.run(roundId, setIndex, userId, n.id, kept.has(n.id) ? 1 : 0, setKeeps);
  }

  const myDone = setIndexesDoneStmt.all(roundId, userId).length;
  if (myDone < SETS_PER_ROUND) return { sealed: false };

  const partnerDone = setIndexesDoneStmt.all(roundId, otherUserId(userId)).length;
  if (partnerDone >= SETS_PER_ROUND) settleRound(round);
  return { sealed: true };
});

module.exports = {
  SETS_PER_ROUND,
  SET_SIZE,
  getCurrentRound,
  roundPayload,
  lockSet,
  getRoundResult,
  ackRound,
};
