import { useState } from "react";
import type { Candidate } from "../types";

// Shown whenever there's no live session (spec §8, revised): first contact
// on a device, or any time 5 minutes have passed since the last pick — see
// server/src/identity.js. Either name can always be picked from any device;
// there's no "already claimed elsewhere" state any more.
export function ClaimDevice({
  candidates,
  onClaim,
}: {
  candidates: Candidate[];
  onClaim: (userId: number) => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<number | null>(null);

  async function pick(id: number) {
    setError(null);
    setPending(id);
    try {
      await onClaim(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="takeover">
      <div className="kicker">Which one of you is this?</div>
      <div className="claim-options">
        {candidates.map((c) => (
          <button
            key={c.id}
            className="claim-btn"
            disabled={pending !== null}
            onClick={() => pick(c.id)}
          >
            {c.label}
          </button>
        ))}
      </div>
      {error && <div className="sub">{error}</div>}
    </div>
  );
}
