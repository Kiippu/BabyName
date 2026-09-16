const express = require("express");
const cookieParser = require("cookie-parser");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

const qrcodeTerminal = require("qrcode-terminal");
const { Bonjour } = require("bonjour-service");

const db = require("./db");
const { seed } = require("./seed");
const { sessionMiddleware, mePayload, selectProfile } = require("./identity");
const { roundPayload, lockSet, getRoundResult, ackRound } = require("./rounds");
const { streamHandler } = require("./stream");
const { getSettings, updateSettings } = require("./settings");
const { getList } = require("./list");
const { getStats } = require("./stats");
const { getNameDetail } = require("./detail");
const { addName } = require("./names");
const { getThemesTree, setThemeEnabled } = require("./themes");

seed();

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(sessionMiddleware);

function requireUser(req, res) {
  if (!req.session.userId) {
    res.status(401).json({ error: "not signed in" });
    return null;
  }
  return req.session.userId;
}

app.get("/api/me", (req, res) => {
  res.json(mePayload(req.session));
});

app.post("/api/me", (req, res) => {
  const userId = Number(req.body.userId);
  if (userId !== 1 && userId !== 2) {
    return res.status(400).json({ error: "userId must be 1 or 2" });
  }
  const session = selectProfile(res, userId);
  res.json(mePayload(session));
});

app.get("/api/round", (req, res) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  res.json(roundPayload(userId));
});

app.post("/api/set", (req, res) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  const roundId = Number(req.body.roundId);
  const setIndex = Number(req.body.setIndex);
  const keptIds = Array.isArray(req.body.keptIds) ? req.body.keptIds.map(Number) : null;
  if (!roundId || !Number.isInteger(setIndex) || setIndex < 0 || !keptIds) {
    return res.status(400).json({ error: "roundId, setIndex, and keptIds are required" });
  }
  try {
    const result = lockSet(userId, roundId, setIndex, keptIds);
    res.json(result.sealed ? { sealed: true } : { nextSet: roundPayload(userId) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get("/api/round/:id/result", (req, res) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  const roundId = Number(req.params.id);
  if (!roundId) return res.status(400).json({ error: "invalid round id" });
  try {
    res.json(getRoundResult(userId, roundId));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post("/api/round/:id/ack", (req, res) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  const roundId = Number(req.params.id);
  if (!roundId) return res.status(400).json({ error: "invalid round id" });
  try {
    res.json(ackRound(userId, roundId));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post("/api/names", (req, res) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
  const note = typeof req.body.note === "string" ? req.body.note.trim() : "";
  if (!name) return res.status(400).json({ error: "name is required" });
  const result = addName(userId, name, note);
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json(result.row);
});

app.get("/api/list", (req, res) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  const tab = req.query.tab === "out" ? "out" : "in";
  res.json(getList(tab));
});

app.get("/api/stats", (req, res) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  res.json(getStats());
});

app.get("/api/names/:id", (req, res) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "invalid name id" });
  const detail = getNameDetail(id, userId);
  if (!detail) return res.status(404).json({ error: "not found" });
  res.json(detail);
});

app.get("/api/settings", (req, res) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  res.json(getSettings());
});

app.put("/api/settings", (req, res) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  const { father, mother, babySurname } = req.body;
  const validPerson = (p) => p && typeof p.name === "string" && typeof p.surname === "string";
  if (!validPerson(father) || !validPerson(mother) || typeof babySurname !== "string") {
    return res.status(400).json({ error: "father, mother, and babySurname are required" });
  }
  try {
    res.json(updateSettings({ father, mother, babySurname }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/themes", (req, res) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  res.json(getThemesTree());
});

app.put("/api/themes/:id", (req, res) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  const id = Number(req.params.id);
  if (typeof req.body.enabled !== "boolean") {
    return res.status(400).json({ error: "enabled must be a boolean" });
  }
  if (!setThemeEnabled(id, req.body.enabled)) {
    return res.status(404).json({ error: "not found" });
  }
  res.json(getThemesTree());
});

app.get("/api/stream", (req, res) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  streamHandler(req, res);
});

const clientDist = path.join(__dirname, "..", "..", "client", "dist");
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api")) return next();
    res.sendFile(path.join(clientDist, "index.html"));
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  const nets = os.networkInterfaces();
  const lanIps = [];
  for (const ifaceList of Object.values(nets)) {
    for (const iface of ifaceList || []) {
      if (iface.family === "IPv4" && !iface.internal) lanIps.push(iface.address);
    }
  }
  console.log(`Nameplate listening on port ${PORT}`);
  console.log(`  Local:   http://localhost:${PORT}`);
  for (const ip of lanIps) console.log(`  Network: http://${ip}:${PORT}`);

  if (lanIps.length) {
    qrcodeTerminal.generate(`http://${lanIps[0]}:${PORT}`, { small: true }, (qr) => {
      console.log(qr);
      console.log(`  Scan to open on a phone: http://${lanIps[0]}:${PORT}`);
    });
  }

  // Advertise nameplate.local so phones don't need to know the LAN IP (spec §11, optional nicety).
  try {
    const bonjour = new Bonjour();
    bonjour.publish({ name: "Nameplate", type: "http", port: Number(PORT), host: "nameplate.local" });
  } catch (err) {
    console.warn("mDNS advertisement failed (non-fatal):", err.message);
  }
});
