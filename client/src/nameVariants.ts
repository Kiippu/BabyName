import type { BabySurnameMode, Settings } from "./types";

/** Every surname a baby might end up carrying (spec §9). Mirrors server/src/settings.js. */
function surnameOptions(babySurname: BabySurnameMode, fatherSurname: string, motherSurname: string): string[] {
  const f = fatherSurname.trim();
  const m = motherSurname.trim();
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
      const out: string[] = [];
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

export function fullNames(firstName: string, settings: Settings): string[] {
  const options = surnameOptions(settings.babySurname, settings.father.surname, settings.mother.surname);
  return options.length ? options.map((s) => `${firstName} ${s}`) : [firstName];
}
