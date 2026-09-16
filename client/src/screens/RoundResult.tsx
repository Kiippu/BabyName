import { useEffect, useState } from "react";
import { api } from "../api";
import type { RoundPayload, RoundResultPayload } from "../types";

/**
 * The round result — build order step 4, change order §"The round result —
 * build this properly, it is the point". Layout order lifted from
 * nameplate-rounds-prototype.html's showResult(): ink hero, then "you both
 * kept these" (brass), then the two near-miss groups (claret) — "these are
 * the actual conversation this app exists to start" — then a plain struck-
 * through "out" list. Nothing here is filler; the near-miss groups are the
 * whole point of building this screen at all.
 */
export function RoundResult({
  roundId,
  onDone,
  onOpenShortlist,
}: {
  roundId: number;
  onDone: (next: RoundPayload) => void;
  onOpenShortlist?: () => void;
}) {
  const [result, setResult] = useState<RoundResultPayload | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [continuing, setContinuing] = useState(false);

  // Acking can chain straight into another unacked result (e.g. two rounds
  // sealed silently before this fix landed, or a partner who's several
  // rounds ahead) — onDone hands back a fresh roundId to the SAME mounted
  // instance rather than remounting it. Reset local state on every roundId
  // change so the old round's content and the disabled "Starting…" button
  // don't linger while the new one loads.
  useEffect(() => {
    setResult(undefined);
    setError(null);
    setContinuing(false);
    api
      .getRoundResult(roundId)
      .then(setResult)
      .catch((e) => setError(e instanceof Error ? e.message : "Something went wrong."));
  }, [roundId]);

  async function handleContinue() {
    if (continuing) return;
    setContinuing(true);
    setError(null);
    try {
      onDone(await api.ackRound(roundId));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setContinuing(false);
    }
  }

  if (error && !result) {
    return (
      <div className="wait">
        <p>{error}</p>
      </div>
    );
  }
  if (!result) return null;

  const { through, mineOnly, theirsOnly, out, partnerLabel, totalNames, number, nextThemeHint } = result;

  return (
    <div className="result">
      <div className="rhero">
        <span className="kick">Round {number} complete</span>
        <h2>{through.length} through</h2>
        <span className="tally">
          of {totalNames} names · {out.length} out
        </span>
        {nextThemeHint && <p className="rnext">{nextThemeHint}</p>}
      </div>
      <div className="rbody">
        {through.length > 0 ? (
          <div className="rgroup win">
            <h3>You both kept these</h3>
            {through.map((n, i) => (
              <div className="rrow win" key={n.id} style={{ animationDelay: `${0.05 * i + 0.15}s` }}>
                <span className="n">{n.name}</span>
                <span className="tag">{n.heldCount > 1 ? `kept ${n.heldCount}` : "new"}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="rgroup">
            <h3>Nothing got through</h3>
            <p className="rnote">
              You didn't keep a single name in common. It happens — the next thirty are queued.
            </p>
          </div>
        )}

        {mineOnly.length > 0 && (
          <div className="rgroup">
            <h3>You kept these, {partnerLabel} didn't</h3>
            {mineOnly.map((n, i) => (
              <div
                className="rrow near"
                key={n.id}
                style={{ animationDelay: `${0.05 * (i + through.length) + 0.15}s` }}
              >
                <span className="n">{n.name}</span>
                <span className="tag">you only</span>
              </div>
            ))}
          </div>
        )}

        {theirsOnly.length > 0 && (
          <div className="rgroup">
            <h3>{partnerLabel} kept these, you didn't</h3>
            {theirsOnly.map((n, i) => (
              <div
                className="rrow near"
                key={n.id}
                style={{ animationDelay: `${0.05 * (i + through.length + mineOnly.length) + 0.15}s` }}
              >
                <span className="n">{n.name}</span>
                <span className="tag">{partnerLabel} only</span>
              </div>
            ))}
          </div>
        )}

        <div className="rgroup">
          <h3>Out</h3>
          <div className="gonewrap">
            {out.map((n) => (
              <span className="gonechip" key={n.id}>
                {n.name}
              </span>
            ))}
          </div>
        </div>
      </div>
      {error && <div className="set-error">{error}</div>}
      <div className="foot">
        {onOpenShortlist && (
          <button className="secondary" onClick={onOpenShortlist}>
            Shortlist
          </button>
        )}
        <button className="primary" disabled={continuing} onClick={handleContinue}>
          {continuing ? "Starting…" : `Start round ${number + 1}`}
        </button>
      </div>
    </div>
  );
}
