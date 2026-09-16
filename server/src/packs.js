const fs = require("node:fs");
const path = require("node:path");
const db = require("./db");
const { transaction } = require("./transaction");

const PACKS_DIR = path.join(__dirname, "..", "..", "seed", "packs");

const upsertPackStmt = db.prepare(`
  INSERT INTO packs (slug, title, blurb, bundled, sku, version, sort_order)
  VALUES (@slug, @title, @blurb, @bundled, @sku, @version, @sortOrder)
  ON CONFLICT(slug) DO UPDATE SET
    title = excluded.title, blurb = excluded.blurb, bundled = excluded.bundled,
    sku = excluded.sku, version = excluded.version, sort_order = excluded.sort_order
`);
const packIdBySlugStmt = db.prepare("SELECT id FROM packs WHERE slug = ?");

const upsertThemeStmt = db.prepare(`
  INSERT INTO themes (slug, title, blurb, pack_id, kind)
  VALUES (@slug, @title, @blurb, @packId, @kind)
  ON CONFLICT(slug) DO UPDATE SET
    title = excluded.title, blurb = excluded.blurb, pack_id = excluded.pack_id, kind = excluded.kind
`);
const themeIdBySlugStmt = db.prepare("SELECT id FROM themes WHERE slug = ?");
const setThemeParentStmt = db.prepare("UPDATE themes SET parent_id = ? WHERE id = ?");

const nameIdByNameStmt = db.prepare("SELECT id FROM names WHERE name = ?");
const insertNameStmt = db.prepare(`
  INSERT INTO names (name, origin, meaning, pack_id, variant_family, au_rank)
  VALUES (@name, @origin, @meaning, @packId, @variantFamily, @auRank)
`);
const updateNameStmt = db.prepare(`
  UPDATE names SET origin = @origin, meaning = @meaning, pack_id = @packId,
    variant_family = @variantFamily, au_rank = @auRank
  WHERE id = @id
`);
const linkNameThemeStmt = db.prepare("INSERT OR IGNORE INTO name_themes (name_id, theme_id) VALUES (?, ?)");

function readPackFiles() {
  if (!fs.existsSync(PACKS_DIR)) return [];
  return fs
    .readdirSync(PACKS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(PACKS_DIR, f), "utf8")));
}

/**
 * Scans seed/packs/*.json and upserts pack -> themes -> names -> links, never
 * truncating (Change Order 3, "The loader"). Upserting on the natural keys
 * (packs.slug, themes.slug, names.name) is what keeps ids -- and therefore
 * round history -- stable across every future import, including one that
 * only adds a pack the app has never seen before.
 */
const loadPacks = transaction(() => {
  const files = readPackFiles();

  // Pass 1 of 2 for themes: insert every theme bare (no parent yet). A child
  // can appear before its parent in a file, or reference a theme defined in
  // a different pack file, so no parent_id can be trusted until every theme
  // in this import has an id.
  for (const file of files) {
    upsertPackStmt.run({
      slug: file.pack.slug,
      title: file.pack.title,
      blurb: file.pack.blurb ?? null,
      bundled: file.pack.bundled ? 1 : 0,
      sku: file.pack.sku ?? null,
      version: file.pack.version ?? 1,
      sortOrder: file.pack.sortOrder ?? 0,
    });
  }
  for (const file of files) {
    const packId = packIdBySlugStmt.get(file.pack.slug).id;
    for (const theme of file.themes) {
      upsertThemeStmt.run({
        slug: theme.slug,
        title: theme.title,
        blurb: theme.blurb ?? null,
        packId,
        kind: theme.kind,
      });
    }
  }

  // Pass 2: every theme in this import now has an id, so parent slugs resolve.
  for (const file of files) {
    for (const theme of file.themes) {
      if (!theme.parent) continue;
      const parent = themeIdBySlugStmt.get(theme.parent);
      if (!parent) throw new Error(`Theme "${theme.slug}" names unknown parent "${theme.parent}"`);
      const child = themeIdBySlugStmt.get(theme.slug);
      setThemeParentStmt.run(parent.id, child.id);
    }
  }

  // Names, upserted by name -- the natural key that keeps ids stable so
  // round history stays attached across every future import.
  for (const file of files) {
    const packId = packIdBySlugStmt.get(file.pack.slug).id;
    for (const n of file.names) {
      const existing = nameIdByNameStmt.get(n.name);
      const fields = {
        origin: n.origin ?? null,
        meaning: n.meaning ?? null,
        packId,
        variantFamily: n.variantFamily ?? null,
        auRank: n.auRank ?? null,
      };
      if (existing) updateNameStmt.run({ ...fields, id: existing.id });
      else insertNameStmt.run({ ...fields, name: n.name });
    }
  }

  // Links, last -- every name and every theme in this import now has a
  // stable id to link together.
  for (const file of files) {
    for (const n of file.names) {
      const nameId = nameIdByNameStmt.get(n.name).id;
      for (const themeSlug of n.themes || []) {
        const theme = themeIdBySlugStmt.get(themeSlug);
        if (!theme) throw new Error(`Name "${n.name}" references unknown theme "${themeSlug}"`);
        linkNameThemeStmt.run(nameId, theme.id);
      }
    }
  }
});

function packStats() {
  return {
    packs: db.prepare("SELECT COUNT(*) AS n FROM packs").get().n,
    themes: db.prepare("SELECT COUNT(*) AS n FROM themes").get().n,
    names: db.prepare("SELECT COUNT(*) AS n FROM names").get().n,
    nameThemes: db.prepare("SELECT COUNT(*) AS n FROM name_themes").get().n,
  };
}

module.exports = { loadPacks, packStats };
