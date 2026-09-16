const db = require("./db");

const BABY_SURNAME_MODES = ["father", "mother", "both", "undecided"];

const getSetting = db.prepare("SELECT value FROM settings WHERE key = ?");
const setSetting = db.prepare("UPDATE settings SET value = ? WHERE key = ?");
const getUsers = db.prepare("SELECT id, name, surname FROM users ORDER BY id");
const updateUser = db.prepare("UPDATE users SET name = ?, surname = ? WHERE id = ?");

function getSettings() {
  const [father, mother] = getUsers.all();
  return {
    babySurname: getSetting.get("baby_surname")?.value ?? "undecided",
    setupDone: getSetting.get("setup_done")?.value === "true",
    father: { name: father.name, surname: father.surname },
    mother: { name: mother.name, surname: mother.surname },
  };
}

function updateSettings({ father, mother, babySurname }) {
  if (!BABY_SURNAME_MODES.includes(babySurname)) {
    throw new Error(`babySurname must be one of ${BABY_SURNAME_MODES.join(", ")}`);
  }
  updateUser.run(father.name.trim() || "Dad", father.surname.trim(), 1);
  updateUser.run(mother.name.trim() || "Mum", mother.surname.trim(), 2);
  setSetting.run(babySurname, "baby_surname");
  setSetting.run("true", "setup_done");
  return getSettings();
}

/** Every surname a baby might end up carrying (spec §9). */
function surnameOptions(babySurname, fatherSurname, motherSurname) {
  const f = (fatherSurname || "").trim();
  const m = (motherSurname || "").trim();
  switch (babySurname) {
    case "father":
      return f ? [f] : [];
    case "mother":
      return m ? [m] : [];
    case "both": {
      const joined = [f, m].filter(Boolean).join("-");
      return joined ? [joined] : [];
    }
    default: {
      const out = [];
      if (f) out.push(f);
      if (m && m !== f) out.push(m);
      if (f && m && f !== m) {
        out.push(`${f}-${m}`);
        out.push(`${m}-${f}`);
      }
      return out;
    }
  }
}

function fullNames(firstName, settings) {
  const options = surnameOptions(settings.babySurname, settings.father.surname, settings.mother.surname);
  return options.length ? options.map((s) => `${firstName} ${s}`) : [firstName];
}

module.exports = { getSettings, updateSettings, fullNames, BABY_SURNAME_MODES };
