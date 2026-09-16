import type { ReactNode } from "react";

// Sheets are position: fixed and vertically centred, never bottom-anchored —
// a bottom sheet would open into the strip of viewport that phone browser
// chrome eats (spec §6, "Overlays").
export function Sheet({
  label,
  onClose,
  children,
}: {
  label: string;
  onClose?: () => void;
  children: ReactNode;
}) {
  return (
    <div
      className="sheet-wrap"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      <div className="sheet" role="dialog" aria-label={label}>
        {onClose && (
          <button className="sheet-x" aria-label="Close" onClick={onClose}>
            ×
          </button>
        )}
        {children}
      </div>
    </div>
  );
}
