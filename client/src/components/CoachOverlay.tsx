const COACHED_KEY = "nameplate.coached";

export function hasSeenCoach(): boolean {
  try {
    return localStorage.getItem(COACHED_KEY) === "1";
  } catch {
    return false;
  }
}

function markCoached() {
  try {
    localStorage.setItem(COACHED_KEY, "1");
  } catch {
    /* private browsing, etc — worst case the overlay reappears once more */
  }
}

export function CoachOverlay({ onDone }: { onDone: () => void }) {
  return (
    <div className="takeover">
      <div className="kicker">Two names at a time</div>
      <div className="coach-lines">
        <p>
          <em>Tap</em> the name you like more. It wins.
        </p>
        <p>
          <em>Hold</em> a name to strike it out for good.
        </p>
      </div>
      <div className="rule" />
      <div className="sub">
        Neither of you sees the other&rsquo;s ratings until you&rsquo;ve both rated a name three
        times.
      </div>
      <button
        onClick={() => {
          markCoached();
          onDone();
        }}
      >
        Start
      </button>
    </div>
  );
}
