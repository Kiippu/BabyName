import { useRef, useState } from "react";

// CO-4 §3: replaces ClaimDevice.tsx. There's no picker any more -- the PIN
// itself is the claim, so this is a single 6-digit numeric field rather than
// a "which one of you is this?" choice. Shown whenever there's no live
// session: first contact on a device, or 30 days of inactivity (see
// server/identity.py's SESSION_TTL_MS).
export function PinScreen({ onGate }: { onGate: (pin: string) => Promise<void> }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function submit(value: string) {
    if (value.length !== 6 || pending) return;
    setError(null);
    setPending(true);
    try {
      await onGate(value);
    } catch (e) {
      // CO-4 §3: "one failure message ... no hints" -- the server already
      // enforces that (401 and 429 both say exactly "That PIN isn't
      // right."), so this just surfaces whatever message came back.
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setPin("");
      inputRef.current?.focus();
    } finally {
      setPending(false);
    }
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const digits = e.target.value.replace(/\D/g, "").slice(0, 6);
    setPin(digits);
    if (digits.length === 6) submit(digits);
  }

  return (
    <div className="takeover">
      <div className="kicker">Enter your PIN</div>
      <input
        ref={inputRef}
        className="pin-input"
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        autoFocus
        maxLength={6}
        value={pin}
        disabled={pending}
        onChange={handleChange}
        aria-label="6-digit PIN"
      />
      {error && <div className="sub">{error}</div>}
    </div>
  );
}
