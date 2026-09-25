import { Fragment, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { RoundName, RoundPayload } from "../types";
import { RoundResult } from "./RoundResult";

type Slot = { kind: "cut" } | { kind: "card"; card: RoundName };

interface DragState {
  card: HTMLDivElement;
  y: number;
  moved: boolean;
  from: number;
  cur: number;
  h: number;
  mid: number;
  rects: { n: Element; mid: number }[];
}

// Revision to the original change order (owner's live call, post-launch
// testing): keeps are no longer optional. A parent must keep at least this
// many of the 6 before the set can be locked in — "in real life a name must
// be chosen," not left to a zero-effort skip. Mirrors MIN_KEEP in
// server/src/rounds.js; the server is the enforcement of record, this is
// just the UI gate so the button never fires a doomed request.
const MIN_KEEP = 3;

// Another revision to the original change order (owner's live call,
// post-launch testing): a card no longer shows how many prior rounds it
// already survived while it's actively being judged in a new one — knowing
// "we've kept this 3 times" anchors the decision instead of it being made
// fresh each round. The server (server/src/rounds.js's toLiveCard) withholds
// heldCount entirely from this screen's payload; RoundName has no such field
// any more. The count still exists and still shows up once the round is
// sealed, on the result recap (RoundResult.tsx).
function keepCount(layout: Slot[]): number {
  return layout.findIndex((s) => s.kind === "cut");
}

/** Splices `from` out of layout and back in at `to`. Null means "no-op". */
function moveTo(layout: Slot[], from: number, to: number): Slot[] | null {
  if (from === to) return null;
  const item = layout[from];
  const next = layout.slice();
  next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

// In-progress sort for the current set, kept at module level so it survives
// SetScreen unmounting while the shortlist is open. Memory only: a reload
// starts the set fresh, same as before.
let draft: { key: string; layout: Slot[] } | null = null;

function draftKey(round: RoundPayload): string {
  return `${round.roundId}:${round.setIndex}`;
}

/** The saved layout, if it's for this exact set and the same six cards. */
function restoreDraft(round: RoundPayload): Slot[] | null {
  if (!draft || draft.key !== draftKey(round) || !round.names) return null;
  const saved = draft.layout.flatMap((s) => (s.kind === "card" ? [s.card.id] : []));
  const fresh = new Set(round.names.map((c) => c.id));
  if (saved.length !== fresh.size || !saved.every((id) => fresh.has(id))) return null;
  return draft.layout;
}

/**
 * The set screen — build order step 3 (nameplate-change-order.md). Six cards
 * in one non-scrolling column, split by a cut line into Keep (above) and Out
 * (below); drag or tap moves a card across it. Layout, drag physics and copy
 * are lifted from nameplate-rounds-prototype.html, the signed-off mechanic
 * ("open it before writing code" / "the drag implementation ... are all
 * intended to carry over"). The prototype's `.bench` dev toolbar and `Reset`
 * button are intentionally NOT ported — spec §6: "Set screen: no chrome at
 * all beyond the prompt line and the lock-in button." One exception, added on
 * request: a Shortlist pill in the header, so you can check the list
 * mid-set (see `draft` above for how the half-sorted set survives the trip).
 *
 * Seal -> waiting -> round result (step 4) lives across this file and
 * RoundResult.tsx: this component owns the set-sorting UI and the "waiting
 * on your partner" state (polled every few seconds so a phone left
 * backgrounded still catches the transition), and hands off to
 * RoundResult once the server reports a sealed round this person hasn't
 * seen yet (`resultReady`).
 */
export function SetScreen({ onOpenShortlist }: { onOpenShortlist?: () => void }) {
  const [round, setRound] = useState<RoundPayload | undefined>(undefined);
  const [layout, setLayout] = useState<Slot[]>([]);
  const [locking, setLocking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pollStopped, setPollStopped] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);

  function applyRound(payload: RoundPayload) {
    setRound(payload);
    setPollStopped(false);
    if (payload.waiting || !payload.names) {
      setLayout([]);
    } else {
      setLayout(
        restoreDraft(payload) ?? [{ kind: "cut" }, ...payload.names.map((card) => ({ kind: "card" as const, card }))]
      );
    }
  }

  // Remember the half-sorted set so a trip to the shortlist and back
  // doesn't throw it away.
  useEffect(() => {
    if (round && !round.waiting && layout.length) {
      draft = { key: draftKey(round), layout };
    }
  }, [round, layout]);

  useEffect(() => {
    api
      .getRound()
      .then(applyRound)
      .catch((e) => setError(e instanceof Error ? e.message : "Something went wrong."));
  }, []);

  // Poll while waiting so whoever finishes first isn't stranded once the
  // partner also seals the round — the next fetch will come back with
  // resultReady:true and the branch above swaps in RoundResult. Mobile
  // browsers throttle or fully suspend setInterval once the tab is
  // backgrounded (screen locked, app switched away from) — so a phone left
  // on the "waiting" screen overnight won't notice the partner finished
  // until something forces a re-check. Re-fetch immediately whenever the
  // page becomes visible/focused again, on top of the steady-state poll, so
  // reopening the app is enough — no manual reload required.
  //
  // CO-4 §4: 3s -> 5s (nothing here is worth 0.3 requests/second against the
  // PythonAnywhere free-tier CPU budget), plus a hard stop after 10 minutes
  // -- a phone left awake on this screen overnight is the one realistic way
  // to burn through 100 CPU-seconds/day. The "Check again" button below
  // resumes it.
  const POLL_MS = 5000;
  const POLL_STOP_AFTER_MS = 10 * 60 * 1000;
  useEffect(() => {
    if (!round?.waiting || pollStopped) return;
    const startedAt = Date.now();
    const refresh = () => api.getRound().then(applyRound).catch(() => {});
    const t = setInterval(() => {
      if (Date.now() - startedAt >= POLL_STOP_AFTER_MS) {
        clearInterval(t);
        setPollStopped(true);
        return;
      }
      refresh();
    }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", refresh);
    window.addEventListener("pageshow", refresh);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("pageshow", refresh);
    };
  }, [round?.waiting, round?.roundId, pollStopped]);

  if (!round) return null;

  if (round.resultReady) {
    return <RoundResult roundId={round.roundId} onDone={applyRound} onOpenShortlist={onOpenShortlist} />;
  }

  if (round.waiting) {
    const partnerDone = round.partnerSetsDone ?? 0;
    const pct = Math.round((partnerDone / round.setsTotal) * 100);
    return (
      <div className="wait">
        <span className="kick">Round {round.number} sealed</span>
        <h2>Waiting on your partner</h2>
        <p>Nothing is revealed until you've both finished the round — that's the whole point.</p>
        <div className="meter">
          <b style={{ width: `${pct}%` }} />
        </div>
        {pollStopped && (
          <button className="linkish" onClick={() => api.getRound().then(applyRound).catch(() => {})}>
            Check again
          </button>
        )}
        {onOpenShortlist && (
          <button className="linkish" onClick={onOpenShortlist}>
            Browse the shortlist while you wait
          </button>
        )}
      </div>
    );
  }

  // Guard against a payload with no cards that is neither waiting nor a
  // result -- or a set short of cards (round 25, 25 Sep 2026: a short draw
  // left set 5 with 4 names). Either way the sorting screen would be a dead
  // end, so show a way out instead of an empty list.
  if (!round.names || round.names.length < 6 || round.setIndex >= round.setsTotal) {
    return (
      <div className="wait">
        <span className="kick">Round {round.number}</span>
        <h2>This set didn't load properly</h2>
        <p>Try again in a moment. If it keeps happening, the round needs a repair on the server.</p>
        {error && <p>{error}</p>}
        <button className="linkish" onClick={() => api.getRound().then(applyRound).catch((e) => setError(e instanceof Error ? e.message : "Something went wrong."))}>
          Check again
        </button>
        {onOpenShortlist && (
          <button className="linkish" onClick={onOpenShortlist}>
            Go to the shortlist
          </button>
        )}
      </div>
    );
  }

  const k = keepCount(layout);

  function onCardPointerDown(e: React.PointerEvent<HTMLDivElement>, idx: number) {
    if (e.button !== 0) return;
    e.preventDefault();
    const list = listRef.current;
    if (!list) return;
    const nodes = Array.from(list.children);
    const rects = nodes.map((n) => {
      const r = n.getBoundingClientRect();
      return { n, mid: r.top + r.height / 2 };
    });
    const card = e.currentTarget;
    const rect = card.getBoundingClientRect();
    dragRef.current = {
      card,
      y: e.clientY,
      moved: false,
      from: idx,
      cur: idx,
      h: rect.height + 7,
      mid: rect.top + rect.height / 2,
      rects,
    };
    card.classList.add("dragging");
    card.setPointerCapture(e.pointerId);
  }

  function onCardPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.card !== e.currentTarget) return;
    const dy = e.clientY - drag.y;
    if (Math.abs(dy) > 4) drag.moved = true;
    drag.card.style.transform = `translateY(${dy}px)`;

    const list = listRef.current;
    if (!list) return;
    // Target position from real DOM midpoints — rows aren't all the same
    // height (the cut label and empty state are shorter than a card).
    const centre = drag.mid + dy;
    let ni = 0;
    layout.forEach((item, i) => {
      if (i === drag.from) return;
      const node = item.kind === "cut" ? list.querySelector("[data-cut]") : list.querySelector(`[data-idx="${i}"]`);
      const r = drag.rects.find((x) => x.n === node);
      if (r && centre > r.mid) ni++;
    });
    if (ni !== drag.cur) {
      drag.cur = ni;
      if (navigator.vibrate) navigator.vibrate(4);
      const cards = Array.from(list.querySelectorAll<HTMLElement>(".rcard"));
      cards.forEach((c) => {
        if (c === drag.card) return;
        const i = Number(c.dataset.idx);
        let s = 0;
        if (drag.from < ni && i > drag.from && i <= ni) s = -drag.h;
        else if (drag.from > ni && i >= ni && i < drag.from) s = drag.h;
        c.style.transform = s ? `translateY(${s}px)` : "";
      });
    }
  }

  function endDrag(e: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.card !== e.currentTarget) return;
    const { from, cur, moved } = drag;
    dragRef.current = null;
    const list = listRef.current;
    if (list) {
      Array.from(list.querySelectorAll<HTMLElement>(".rcard")).forEach((c) => {
        c.style.transform = "";
        c.classList.remove("dragging");
      });
    }
    if (!moved) {
      tapToggle(from);
      return;
    }
    const next = moveTo(layout, from, cur);
    if (next) setLayout(next);
  }

  // Tapping flips a card across the cut — same outcome as a drag, no
  // dragging required. Not optional per the change order: "tap is the
  // one-handed path".
  function tapToggle(idx: number) {
    const kk = keepCount(layout);
    const to = idx < kk ? layout.length - 1 : Math.max(0, kk);
    const next = moveTo(layout, idx, to);
    if (next) setLayout(next);
  }

  async function handleLock() {
    if (!round || locking) return;
    setLocking(true);
    setError(null);
    const keptIds = layout
      .slice(0, k)
      .map((s) => (s.kind === "card" ? s.card.id : null))
      .filter((id): id is number => id !== null);
    try {
      const result = await api.lockSet(round.roundId, round.setIndex, keptIds);
      if (result.nextSet) applyRound(result.nextSet);
      else applyRound(await api.getRound());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setLocking(false);
    }
  }

  return (
    <div className="set-screen">
      <div className="head">
        <span className="where">
          Round <b>{round.number}</b>
          {round.themeTitle && (
            <>
              {" "}
              · <b>{round.themeTitle}</b>
            </>
          )}{" "}
          · Set <b>{round.setIndex + 1}</b> of <b>{round.setsTotal}</b>
        </span>
        {onOpenShortlist && (
          <button className="topbar-btn" onClick={onOpenShortlist}>
            Shortlist
          </button>
        )}
      </div>
      <p className="ask">
        Drag up at least <em>{MIN_KEEP}</em> worth keeping. Anything left below is out.
      </p>
      <div className="pips">
        {Array.from({ length: round.setsTotal }, (_, i) => (
          <div key={i} className={`pip${i < round.setIndex ? " done" : i === round.setIndex ? " now" : ""}`} />
        ))}
      </div>
      <div className="list" ref={listRef}>
        <div className="zlabel keep">
          <span>{k === 0 ? "Keep" : k < MIN_KEEP ? `Keep · ${k} of ${MIN_KEEP}` : `Keep · ${k}`}</span>
          <i />
        </div>
        {layout.map((slot, idx) =>
          slot.kind === "cut" ? (
            <Fragment key="cut">
              {k === 0 && <div className="empty">Drag at least {MIN_KEEP} names up here</div>}
              <div className="zlabel out" data-cut="1">
                <i />
                <span>Out</span>
                <i />
              </div>
            </Fragment>
          ) : (
            <div
              key={slot.card.id}
              className={`rcard ${idx < k ? "kept" : "dropped"}`}
              data-idx={idx}
              onPointerDown={(e) => onCardPointerDown(e, idx)}
              onPointerMove={onCardPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
            >
              <span>
                <span className="nm">{slot.card.name}</span>
                <span className="sub">
                  {slot.card.origin} · {slot.card.meaning}
                </span>
              </span>
              <span className="grip" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M5 9h14M5 15h14" />
                </svg>
              </span>
            </div>
          )
        )}
      </div>
      {error && <div className="set-error">{error}</div>}
      <div className="foot">
        <button className="primary" disabled={locking || k < MIN_KEEP} onClick={handleLock}>
          {locking
            ? "Locking in…"
            : k < MIN_KEEP
              ? `Keep ${MIN_KEEP - k} more to continue`
              : `Lock in ${k}`}
        </button>
      </div>
    </div>
  );
}
