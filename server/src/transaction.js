const db = require("./db");

// node:sqlite's DatabaseSync has no built-in `.transaction()` helper the way
// better-sqlite3 does, so wrap BEGIN/COMMIT/ROLLBACK by hand.
function transaction(fn) {
  return (...args) => {
    db.exec("BEGIN");
    try {
      const result = fn(...args);
      db.exec("COMMIT");
      return result;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  };
}

module.exports = { transaction };
