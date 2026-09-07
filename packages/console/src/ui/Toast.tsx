import { createContext, type ReactNode, useCallback, useContext, useRef, useState } from "react";

export interface ToastEntry {
  id: number;
  kind: "error" | "info";
  text: string;
}

export interface ToastApi {
  push(t: { kind: "error" | "info"; text: string }): void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({
  children,
  dismissMs,
}: {
  children: ReactNode;
  dismissMs?: number;
}): JSX.Element {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const seqRef = useRef(0);
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (t: { kind: "error" | "info"; text: string }) => {
      seqRef.current += 1;
      const id = seqRef.current;
      setToasts((prev) => [...prev, { id, ...t }]);
      if (dismissMs !== undefined) {
        const timer = setTimeout(() => {
          dismiss(id);
        }, dismissMs);
        timersRef.current.set(id, timer);
      }
    },
    [dismissMs, dismiss],
  );

  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      <div role="status" aria-live="polite" className="toast-region">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            <span className="toast-text">{t.text}</span>
            <button
              type="button"
              aria-label="Dismiss"
              className="toast-dismiss"
              onClick={() => {
                dismiss(t.id);
              }}
            >
              x
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (ctx === null) {
    throw new Error("useToast must be used within ToastProvider");
  }
  return ctx;
}
