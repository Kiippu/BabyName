const db = require("./db");
const { loadPacks } = require("./packs");

function ensureUsers() {
  const count = db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
  if (count > 0) return;
  const insert = db.prepare("INSERT INTO users (id, name, surname) VALUES (?, ?, ?)");
  insert.run(1, "Dad", "");
  insert.run(2, "Mum", "");
}

function ensureSettings() {
  const insert = db.prepare(
    "INSERT INTO settings (key, value) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = ?)"
  );
  insert.run("baby_surname", "undecided", "baby_surname");
  insert.run("setup_done", "false", "setup_done");
}

function seed() {
  ensureUsers();
  ensureSettings();
  loadPacks();
}

module.exports = { seed };
