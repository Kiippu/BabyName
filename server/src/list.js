const db = require("./db");

// Change Order 1, "Shortlist ordering" (nameplate-change-order.md):
//   ORDER BY rounds_survived DESC, selectivity DESC
//   selectivity = avg over kept sets of (6 - set_keeps) / 5
// selectivity is the tiebreaker for names that have all survived the same
// number of rounds — it rewards being kept out of a set where the keeper was
// picky (few of that set's other five also survived), which rounds_survived
// alone can't distinguish once several names have a perfect record so far.
// It's computed over EVERY kept row for the name, from either parent, across
// every round played — not scoped to one person, since nothing on the
// shortlist is gated per-viewer any more (that gate is the in-progress
// round itself, via sealed_at; once a round is sealed its outcome is common
// knowledge to both parents).
const selectivitySql = `
  SELECT name_id, AVG((6.0 - set_keeps) / 5.0) AS selectivity
  FROM set_results
  WHERE kept = 1
  GROUP BY name_id
`;

const stillInStmt = db.prepare(`
  SELECT n.id, n.name, n.origin, n.meaning,
         COALESCE(ns.rounds_survived, 0) AS roundsSurvived,
         COALESCE(sel.selectivity, 0) AS selectivity
  FROM names n
  LEFT JOIN name_state ns ON ns.name_id = n.id
  LEFT JOIN (${selectivitySql}) sel ON sel.name_id = n.id
  WHERE ns.eliminated_in IS NULL
  ORDER BY roundsSurvived DESC, selectivity DESC, n.id ASC
`);

const outStmt = db.prepare(`
  SELECT n.id, n.name, n.origin, n.meaning,
         ns.rounds_survived AS roundsSurvived,
         ns.eliminated_in AS eliminatedIn,
         COALESCE(sel.selectivity, 0) AS selectivity
  FROM names n
  JOIN name_state ns ON ns.name_id = n.id
  LEFT JOIN (${selectivitySql}) sel ON sel.name_id = n.id
  WHERE ns.eliminated_in IS NOT NULL
  ORDER BY ns.eliminated_in DESC, roundsSurvived DESC, selectivity DESC, n.id ASC
`);

function toRow(n) {
  return {
    id: n.id,
    name: n.name,
    origin: n.origin,
    meaning: n.meaning,
    roundsSurvived: n.roundsSurvived,
    eliminatedIn: n.eliminatedIn ?? null,
  };
}

/** Backs GET /api/list?tab=in|out (build spec §6 "Shortlist"). */
function getList(tab) {
  const rows = tab === "out" ? outStmt.all() : stillInStmt.all();
  return rows.map(toRow);
}

module.exports = { getList };
