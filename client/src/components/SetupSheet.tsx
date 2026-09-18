import { useEffect, useState } from "react";
import { api } from "../api";
import { fullNames } from "../nameVariants";
import { isPushSubscribed, pushSupported, subscribeToPush, unsubscribeFromPush } from "../push";
import { Sheet } from "./Sheet";
import type { BabySurnameMode, Me, Settings } from "../types";

const SUR_MODES: { value: BabySurnameMode; label: string }[] = [
  { value: "father", label: "Father's" },
  { value: "mother", label: "Mother's" },
  { value: "both", label: "Both, hyphenated" },
  { value: "undecided", label: "Not decided yet" },
];

const PREVIEW_SAMPLE = "Theodore";

// CO-4 §12: "granted" — pushed on; "off" — supported but not subscribed;
// "denied" — Chrome will never show the permission dialog again for this
// origin, so the toggle explains rather than pretending to work;
// "unsupported" — not Chrome/Android, or no service worker.
type PushToggleState = "checking" | "granted" | "off" | "denied" | "unsupported";

export function SetupSheet({
  settings,
  me,
  firstRun,
  onClose,
  onSaved,
}: {
  settings: Settings;
  me: Me;
  firstRun: boolean;
  onClose?: () => void;
  onSaved: (settings: Settings) => void;
}) {
  const [fatherName, setFatherName] = useState(settings.father.name);
  const [fatherSurname, setFatherSurname] = useState(settings.father.surname);
  const [motherName, setMotherName] = useState(settings.mother.name);
  const [motherSurname, setMotherSurname] = useState(settings.mother.surname);
  const [babySurname, setBabySurname] = useState<BabySurnameMode>(settings.babySurname);
  const [saving, setSaving] = useState(false);

  const partnerName = (me.userId === 1 ? settings.mother.name : settings.father.name) || "your partner";
  const [pushState, setPushState] = useState<PushToggleState>("checking");

  useEffect(() => {
    if (!pushSupported()) {
      setPushState("unsupported");
      return;
    }
    if (Notification.permission === "denied") {
      setPushState("denied");
      return;
    }
    isPushSubscribed().then((on) => setPushState(on ? "granted" : "off"));
  }, []);

  // The permission prompt only fires from inside a real click handler --
  // Chrome ignores Notification.requestPermission() called any other way.
  async function togglePush() {
    if (pushState === "granted") {
      await unsubscribeFromPush();
      setPushState("off");
      return;
    }
    const result = await subscribeToPush();
    setPushState(result === "granted" ? "granted" : result);
  }

  const preview = fullNames(PREVIEW_SAMPLE, {
    father: { name: fatherName, surname: fatherSurname },
    mother: { name: motherName, surname: motherSurname },
    babySurname,
    setupDone: settings.setupDone,
  });

  async function save() {
    setSaving(true);
    try {
      const updated = await api.updateSettings({
        father: { name: fatherName, surname: fatherSurname },
        mother: { name: motherName, surname: motherSurname },
        babySurname,
      });
      onSaved(updated);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet label="Names and surnames" onClose={firstRun ? undefined : onClose}>
      <div>
        <div className="sheet-name" style={{ fontSize: 27 }}>
          {firstRun ? "Before you start" : "Names & surnames"}
        </div>
        <p className="sheet-lead">
          Who&rsquo;s rating, and the surname he&rsquo;ll carry &mdash; that&rsquo;s what the
          say-it-aloud test is measured against. All of it can change later.
        </p>
      </div>
      <div className="who-block">
        <div className="who-label">Father</div>
        <div className="pair">
          <input
            className="small"
            placeholder="First name"
            aria-label="Father's first name"
            value={fatherName}
            onChange={(e) => setFatherName(e.target.value)}
            autoComplete="off"
          />
          <input
            className="small"
            placeholder="Surname"
            aria-label="Father's surname"
            value={fatherSurname}
            onChange={(e) => setFatherSurname(e.target.value)}
            autoComplete="off"
          />
        </div>
      </div>
      <div className="who-block">
        <div className="who-label">Mother</div>
        <div className="pair">
          <input
            className="small"
            placeholder="First name"
            aria-label="Mother's first name"
            value={motherName}
            onChange={(e) => setMotherName(e.target.value)}
            autoComplete="off"
          />
          <input
            className="small"
            placeholder="Surname"
            aria-label="Mother's surname"
            value={motherSurname}
            onChange={(e) => setMotherSurname(e.target.value)}
            autoComplete="off"
          />
        </div>
      </div>
      <div className="who-block">
        <div className="who-label">The surname he&rsquo;ll carry</div>
        <div className="chips">
          {SUR_MODES.map((m) => (
            <button key={m.value} aria-pressed={babySurname === m.value} onClick={() => setBabySurname(m.value)}>
              {m.label}
            </button>
          ))}
        </div>
      </div>
      <div className="preview">
        <div className="full-variants">
          {preview.map((p) => (
            <div className="full" key={p}>
              {p}
            </div>
          ))}
        </div>
        <small>How a name will read</small>
      </div>
      {pushState !== "unsupported" && (
        <div className="who-block">
          <div className="who-label">Notifications</div>
          {pushState === "denied" ? (
            <p className="section-note">
              Notifications are blocked for this app in Chrome. To turn them on, open Chrome&rsquo;s
              site settings for this app and allow notifications, then come back here.
            </p>
          ) : (
            <div className="chips">
              <button aria-pressed={pushState === "granted"} disabled={pushState === "checking"} onClick={togglePush}>
                Tell me when {partnerName} finishes a round
              </button>
            </div>
          )}
        </div>
      )}
      <button className="solid-btn" disabled={saving} onClick={save}>
        {firstRun ? "Start sorting" : "Save"}
      </button>
    </Sheet>
  );
}
