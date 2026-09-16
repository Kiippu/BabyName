const db = require("./db");
const { getSettings, fullNames } = require("./settings");

const nameByIdStmt = db.prepare("SELECT id, name, origin, meaning, rank FROM names WHERE id = ?");
const nameStateStmt = db.prepare("SELECT rounds_survived, eliminated_in FROM name_state WHERE name_id = ?");
const userLabelStmt = db.prepare("SELECT name FROM users WHERE id = ?");
// Only sealed rounds count -- blind reveal means an in-progress round can't
// leak into these numbers.
const keepCountStmt = db.prepare(`
  SELECT COUNT(*) AS n
  FROM set_results sr
  JOIN rounds r ON r.id = sr.round_id
  WHERE sr.name_id = ? AND sr.user_id = ? AND sr.kept = 1 AND r.sealed_at IS NOT NULL
`);
const firstSeenStmt = db.prepare(`
  SELECT MIN(r.number) AS round
  FROM set_results sr
  JOIN rounds r ON r.id = sr.round_id
  WHERE sr.name_id = ? AND r.sealed_at IS NOT NULL
`);

const otherUserId = (id) => (id === 1 ? 2 : 1);

/** Backing data for the name detail sheet (build spec §6 "Shortlist", Change Order 2 §1). */
function getNameDetail(nameId, viewerId) {
  const n = nameByIdStmt.get(nameId);
  if (!n) return null;

  const state = nameStateStmt.get(nameId);
  const partnerId = otherUserId(viewerId);
  const partner = userLabelStmt.get(partnerId);
  const firstSeen = firstSeenStmt.get(nameId);

  return {
    id: n.id,
    name: n.name,
    origin: n.origin,
    meaning: n.meaning,
    auRank: n.rank,
    fullNames: fullNames(n.name, getSettings()),
    roundsSurvived: state?.rounds_survived ?? 0,
    eliminatedIn: state?.eliminated_in ?? null,
    youKeptCount: keepCountStmt.get(nameId, viewerId).n,
    partnerLabel: partner.name,
    partnerKeptCount: keepCountStmt.get(nameId, partnerId).n,
    firstSeenRound: firstSeen?.round ?? null,
  };
}

module.exports = { getNameDetail };
