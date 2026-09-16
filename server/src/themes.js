const db = require("./db");

const packsStmt = db.prepare("SELECT id, slug, title, blurb FROM packs ORDER BY sort_order, title");

// nameCount is inherited through parent_id (the recursive `sub` CTE) because
// names never link directly to a region -- see schema.sql and change-order-3.
// Without it every region would show a count of 0.
const themesWithCountsStmt = db.prepare(`
  WITH RECURSIVE sub(root, id) AS (
    SELECT id, id FROM themes
    UNION ALL
    SELECT s.root, t.id FROM themes t JOIN sub s ON t.parent_id = s.id
  )
  SELECT t.id, t.slug, t.title, t.kind, t.enabled, t.parent_id, t.pack_id, t.sort_order,
         COUNT(DISTINCT n.id) AS nameCount
  FROM themes t
  JOIN sub ON sub.root = t.id
  LEFT JOIN name_themes nt ON nt.theme_id = sub.id
  LEFT JOIN names n ON n.id = nt.name_id
  GROUP BY t.id
`);

const setEnabledStmt = db.prepare("UPDATE themes SET enabled = ? WHERE id = ?");
const themeExistsStmt = db.prepare("SELECT id FROM themes WHERE id = ?");

function buildChildren(themes, parentId) {
  return themes
    .filter((t) => t.parent_id === parentId)
    .sort((a, b) => a.sort_order - b.sort_order || a.title.localeCompare(b.title))
    .map((t) => ({
      id: t.id,
      slug: t.slug,
      title: t.title,
      kind: t.kind,
      enabled: !!t.enabled,
      nameCount: t.nameCount,
      children: buildChildren(themes, t.id),
    }));
}

/**
 * Themes screen (Change Order 3, build order step 6): packs -> themes, with
 * regions carrying their cultures nested underneath. A theme's own pack_id
 * (not its parent's) decides which pack section it's listed under.
 */
function getThemesTree() {
  const packs = packsStmt.all();
  const themes = themesWithCountsStmt.all();
  const roots = buildChildren(themes, null);
  const packIdByThemeId = new Map(themes.map((t) => [t.id, t.pack_id]));
  return packs.map((p) => ({
    id: p.id,
    slug: p.slug,
    title: p.title,
    blurb: p.blurb,
    themes: roots.filter((t) => packIdByThemeId.get(t.id) === p.id),
  }));
}

/** Toggles a single theme -- disabling a region does not touch its children. */
function setThemeEnabled(id, enabled) {
  if (!themeExistsStmt.get(id)) return false;
  setEnabledStmt.run(enabled ? 1 : 0, id);
  return true;
}

module.exports = { getThemesTree, setThemeEnabled };
