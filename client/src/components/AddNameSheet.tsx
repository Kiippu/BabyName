import { useState } from "react";
import { api } from "../api";
import { fullNames } from "../nameVariants";
import { Sheet } from "./Sheet";
import type { Settings } from "../types";

const PREVIEW_FALLBACK = "Theodore";

export function AddNameSheet({
  settings,
  onClose,
  onAdded,
  onDuplicate,
}: {
  settings: Settings;
  onClose: () => void;
  onAdded: (name: string) => void;
  onDuplicate: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);

  const preview = fullNames(name.trim() || PREVIEW_FALLBACK, settings);

  async function submit() {
    const trimmed = name.trim();
    if (!trimmed || pending) return;
    setPending(true);
    try {
      await api.addName(trimmed, note.trim());
      onAdded(trimmed);
    } catch (e) {
      if (e instanceof Error && /already in the pile/i.test(e.message)) {
        onDuplicate(trimmed);
      } else {
        throw e;
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <Sheet label="Add a name" onClose={onClose}>
      <div className="sheet-name" style={{ fontSize: 30 }}>
        Add a name
      </div>
      <div className="field">
        <label htmlFor="newName">The name</label>
        <input
          id="newName"
          placeholder="Banjo"
          autoComplete="off"
          spellCheck={false}
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />
      </div>
      <div className="field">
        <label htmlFor="newMeaning">Why it&rsquo;s in (optional)</label>
        <input
          id="newMeaning"
          className="small"
          placeholder="My grandfather's name"
          autoComplete="off"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>
      <button className="solid-btn" disabled={!name.trim() || pending} onClick={submit}>
        Put it in the pile
      </button>
      <div className="preview">
        <div className="full-variants">
          {preview.map((p) => (
            <div className="full" key={p}>
              {p}
            </div>
          ))}
        </div>
        <small>Said in full</small>
      </div>
      <button className="ghost-btn" onClick={onClose}>
        Close
      </button>
    </Sheet>
  );
}
