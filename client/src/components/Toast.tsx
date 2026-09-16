import { useEffect } from "react";

export interface ToastData {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}

export function Toast({ toast, onDismiss }: { toast: ToastData; onDismiss: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 4200);
    return () => clearTimeout(t);
  }, [toast, onDismiss]);

  return (
    <div className="toast">
      <span>{toast.message}</span>
      {toast.actionLabel && toast.onAction && (
        <button
          onClick={() => {
            toast.onAction?.();
            onDismiss();
          }}
        >
          {toast.actionLabel}
        </button>
      )}
    </div>
  );
}
