const db = require("./db");

const totalNamesStmt = db.prepare("SELECT COUNT(*) AS n FROM names");
const stillInStmt = db.prepare(`
  SELECT COUNT(*) AS n
  FROM names n
  LEFT JOIN name_state ns ON ns.name_id = n.id
  WHERE ns.eliminated_in IS NULL
`);
const sealedRoundIdsStmt = db.prepare("SELECT id FROM rounds WHERE sealed_at IS NOT NULL");
// Per round, how much did the two parents' keeps overlap. INTERSECT/UNION
// need the id list on both sides, hence the round id repeated four times.
const roundOverlapStmt = db.prepare(`
  SELECT
    (SELECT COUNT(*) FROM (
       SELECT name_id FROM set_results WHERE round_id = ? AND user_id = 1 AND kept = 1
       INTERSECT
       SELECT name_id FROM set_results WHERE round_id = ? AND user_id = 2 AND kept = 1
     )) AS bothKept,
    (SELECT COUNT(*) FROM (
       SELECT name_id FROM set_results WHERE round_id = ? AND user_id = 1 AND kept = 1
       UNION
       SELECT name_id FROM set_results WHERE round_id = ? AND user_id = 2 AND kept = 1
     )) AS eitherKept
`);

/**
 * Change order, "Agreement %": replaces pairwise Elo concordance (which
 * needs comparison data that no longer exists) with per-round overlap —
 * both_kept / either_kept, averaged across every sealed round. Scale-free,
 * and it still reads as "how often you two want the same thing".
 */
function agreement() {
  const rounds = sealedRoundIdsStmt.all();
  if (rounds.length === 0) return 0;
  let total = 0;
  let counted = 0;
  for (const { id } of rounds) {
    const { bothKept, eitherKept } = roundOverlapStmt.get(id, id, id, id);
    if (eitherKept > 0) {
      total += bothKept / eitherKept;
      counted++;
    }
  }
  return counted ? Math.round((total / counted) * 100) : 0;
}

/** Backs GET /api/stats — the strip at the foot of the shortlist. */
function getStats() {
  return {
    rounds: sealedRoundIdsStmt.all().length,
    stillIn: stillInStmt.get().n,
    totalNames: totalNamesStmt.get().n,
    agreement: agreement(),
  };
}

module.exports = { getStats };
