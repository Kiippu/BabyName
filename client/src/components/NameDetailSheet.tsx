import { useEffect, useState } from "react";
import { api } from "../api";
import { Sheet } from "./Sheet";
import type { NameDetail } from "../types";

// Change Order 1 dropped Elo/veto entirely — there's no "strike it out" or
// "bring it back" action any more (build spec §6: "There is no strike-out; a
// name leaves by failing to be kept"). This sheet is now read-only: origin,
// meaning, Australian rank, full name, and standing. Change Order 2 §1
// replaced the old round-by-round history list with plain kept counts.
function standingLine(detail: NameDetail) {
  if (detail.eliminatedIn != null) return `Out after round ${detail.eliminatedIn}`;
  if (detail.roundsSurvived === 0) return "Hasn't been through a round yet";
  return `Kept for ${detail.roundsSurvived} round${detail.roundsSurvived === 1 ? "" : "s"}`;
}

export function NameDetailSheet({ nameId, onClose }: { nameId: number; onClose: () => void }) {
  const [detail, setDetail] = useState<NameDetail | undefined>(undefined);

  useEffect(() => {
    setDetail(undefined);
    api.getNameDetail(nameId).then(setDetail);
  }, [nameId]);

  if (!detail) {
    return (
      <Sheet label="Name" onClose={onClose}>
        <div className="sheet-name" style={{ fontSize: 24 }}>
          &hellip;
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet label={detail.name} onClose={onClose}>
      <div>
        <div className="sheet-name">{detail.name}</div>
        <div className="plate-origin" style={{ marginTop: 8 }}>
          {detail.origin}
        </div>
      </div>
      <dl className="kv">
        <dt>Means</dt>
        <dd className="serif">{detail.meaning}</dd>
        <dt>In Australia</dt>
        <dd>{detail.auRank ? `#${detail.auRank} most popular last year` : "outside the top 100"}</dd>
        <dt>In full</dt>
        <dd className="serif">
          {detail.fullNames.map((f, i) => (
            <span key={f}>
              {i > 0 && <br />}
              {f}
            </span>
          ))}
        </dd>
        <dt>Standing</dt>
        <dd>{standingLine(detail)}</dd>
        <dt>Rounds survived</dt>
        <dd>{detail.roundsSurvived}</dd>
        <dt>You kept it</dt>
        <dd>
          {detail.youKeptCount} time{detail.youKeptCount === 1 ? "" : "s"}
        </dd>
        <dt>{detail.partnerLabel} kept it</dt>
        <dd>
          {detail.partnerKeptCount} time{detail.partnerKeptCount === 1 ? "" : "s"}
        </dd>
        <dt>First seen</dt>
        <dd>{detail.firstSeenRound != null ? `Round ${detail.firstSeenRound}` : "Not yet"}</dd>
      </dl>
      <div className="sheet-actions">
        <button className="ghost-btn" onClick={onClose}>
          Close
        </button>
      </div>
    </Sheet>
  );
}
