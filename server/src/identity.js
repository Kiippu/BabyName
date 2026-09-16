const crypto = require("node:crypto");
const db = require("./db");

const SESSION_COOKIE = "nameplate_session";
// 5 minutes, owner's call: short on purpose. The old model (see schema.sql's
// comment on the retired `devices` table) bound a device to a person forever,
// which kept leaving a shared phone stuck as the wrong person with no
// self-service fix. A short, sliding session means the worst case is "pick
// who you are again" — never "ask someone to go edit the database."
const SESSION_TTL_MS = 5 * 60 * 1000;

const getSession = db.prepare("SELECT user_id AS userId, expires_at AS expiresAt FROM sessions WHERE token = ?");
const insertSession = db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)");
const touchSession = db.prepare("UPDATE sessions SET expires_at = ? WHERE token = ?");
const deleteSession = db.prepare("DELETE FROM sessions WHERE token = ?");
const sweepExpired = db.prepare("DELETE FROM sessions WHERE expires_at < ?");
const getUser = db.prepare("SELECT id, name, surname FROM users WHERE id = ?");
const allUsers = db.prepare("SELECT id, name, surname FROM users ORDER BY id");

function cookieOpts() {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: false, // LAN-only, plain HTTP — see spec §2/§8
    maxAge: SESSION_TTL_MS,
  };
}

/**
 * Resolves the session cookie to a user on every request, and — as long as
 * it's still valid — slides the expiry forward another 5 minutes. That
 * sliding behaviour matters: it means actively using the app (say, working
 * through a round) doesn't log you out mid-task; only the app sitting
 * untouched for a full 5 minutes (or a fresh device with no cookie at all)
 * does. An expired or missing session just means req.session.userId is
 * null — route handlers treat that exactly like "not signed in yet".
 */
function sessionMiddleware(req, res, next) {
  const token = req.cookies ? req.cookies[SESSION_COOKIE] : undefined;
  const session = token ? getSession.get(token) : undefined;

  if (session && session.expiresAt > Date.now()) {
    const expiresAt = Date.now() + SESSION_TTL_MS;
    touchSession.run(expiresAt, token);
    res.cookie(SESSION_COOKIE, token, cookieOpts());
    req.session = { token, userId: session.userId };
  } else {
    if (session) deleteSession.run(token); // stale — don't leave dead rows lying around
    req.session = { token: null, userId: null };
  }
  next();
}

function mePayload(session) {
  const user = session.userId ? getUser.get(session.userId) : null;
  // No "taken" exclusivity any more (see schema.sql) — both names are always
  // pickable, from any device, at any time.
  const candidates = allUsers.all().map((u) => ({ id: u.id, label: u.name }));
  return {
    userId: session.userId,
    label: user ? user.name : null,
    surname: user ? user.surname : null,
    claimed: session.userId != null,
    candidates,
  };
}

/**
 * Starts a fresh 5-minute session for this browser, bound to the chosen
 * person, and sets the cookie for it. Called once per "which one of you is
 * this?" pick — see index.js's POST /api/me.
 */
function selectProfile(res, userId) {
  sweepExpired.run(Date.now()); // opportunistic cleanup, keeps the table small
  const token = crypto.randomUUID();
  insertSession.run(token, userId, Date.now() + SESSION_TTL_MS);
  res.cookie(SESSION_COOKIE, token, cookieOpts());
  return { userId };
}

module.exports = { sessionMiddleware, mePayload, selectProfile, SESSION_COOKIE };
