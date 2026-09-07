import { createContext, useContext, useId, useRef, useState, type ReactNode } from "react";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  body?: ReactNode;
  typedTarget?: string;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}

export function ConfirmDialog(props: ConfirmDialogProps): JSX.Element | null {
  const { open, title, body, typedTarget, onConfirm, onCancel } = props;
  const titleId = useId();
  const [reason, setReason] = useState("");
  const [targetValue, setTargetValue] = useState("");

  if (!open) return null;

  const reasonValid = reason.trim().length > 0;
  const targetValid = typedTarget === undefined || targetValue === typedTarget;
  const confirmDisabled = !reasonValid || !targetValid;

  return (
    <div role="dialog" aria-labelledby={titleId} className="dialog-overlay">
      <div className="dialog">
        <h2 id={titleId} className="dialog-title">
          {title}
        </h2>
        {body != null && <div className="dialog-body">{body}</div>}
        <textarea
          aria-label="Reason"
          className="dialog-textarea"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        {typedTarget !== undefined && (
          <input
            aria-label="Confirmation target"
            className="dialog-input"
            value={targetValue}
            onChange={(e) => setTargetValue(e.target.value)}
          />
        )}
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={confirmDisabled}
            onClick={() => onConfirm(reason)}
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}

interface PendingRequest {
  title: string;
  body?: ReactNode;
  typedTarget?: string;
  resolve: (value: { reason: string } | null) => void;
}

const ConfirmContext = createContext<
  | ((req: {
      title: string;
      body?: ReactNode;
      typedTarget?: string;
    }) => Promise<{ reason: string } | null>)
  | null
>(null);

export function ConfirmDialogProvider({ children }: { children: ReactNode }): JSX.Element {
  const [pending, setPending] = useState<PendingRequest | null>(null);
  const seqRef = useRef(0);

  const confirm = (req: {
    title: string;
    body?: ReactNode;
    typedTarget?: string;
  }): Promise<{ reason: string } | null> => {
    seqRef.current += 1;
    return new Promise<{ reason: string } | null>((resolve) => {
      setPending({ ...req, resolve });
    });
  };

  const handleConfirm = (reason: string) => {
    if (pending) {
      pending.resolve({ reason });
      setPending(null);
    }
  };

  const handleCancel = () => {
    if (pending) {
      pending.resolve(null);
      setPending(null);
    }
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <ConfirmDialog
        key={seqRef.current}
        open={pending !== null}
        title={pending?.title ?? ""}
        body={pending?.body}
        typedTarget={pending?.typedTarget}
        onConfirm={handleConfirm}
        onCancel={handleCancel}
      />
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): (req: {
  title: string;
  body?: ReactNode;
  typedTarget?: string;
}) => Promise<{ reason: string } | null> {
  const ctx = useContext(ConfirmContext);
  if (ctx === null) {
    throw new Error("useConfirm must be used within ConfirmDialogProvider");
  }
  return ctx;
}
