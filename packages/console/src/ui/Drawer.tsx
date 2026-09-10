import { type ReactNode, useCallback, useEffect, useId, useRef } from "react";

const FOCUSABLE_SELECTOR = [
  "button",
  "a[href]",
  "input",
  "select",
  "textarea",
  "[tabindex]:not([tabindex='-1'])",
  "[contenteditable]:not([contenteditable='false'])",
].join(", ");

function getFocusableElements(root: Element): HTMLElement[] {
  return Array.from(root.querySelectorAll(FOCUSABLE_SELECTOR)).filter((el): el is HTMLElement => {
    if (!(el instanceof HTMLElement) || el.tabIndex < 0 || el.matches(":disabled")) {
      return false;
    }
    for (let node: HTMLElement | null = el; node; node = node.parentElement) {
      if (
        node.matches("fieldset[disabled]") &&
        !node.querySelector(":scope > legend")?.contains(el)
      ) {
        return false;
      }
      const style = getComputedStyle(node);
      if (node.hidden || node.inert || style.display === "none" || style.visibility === "hidden") {
        return false;
      }
    }
    return true;
  });
}

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}

export function Drawer({ open, onClose, title, children }: DrawerProps): JSX.Element | null {
  const titleId = useId();
  const drawerRef = useRef<HTMLElement>(null);
  const openerRef = useRef<Element | null>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const moveFocus = useCallback((root: HTMLElement) => {
    const focusable = getFocusableElements(root);
    const first = focusable[0];
    if (first) {
      first.focus();
    } else {
      root.tabIndex = -1;
      root.focus();
    }
  }, []);

  useEffect(() => {
    if (!open) return;

    const drawer = drawerRef.current;
    if (!drawer) return;

    openerRef.current = document.activeElement;
    moveFocus(drawer);

    function handleKeyDown(event: KeyboardEvent) {
      const currentDrawer = drawerRef.current;
      if (!currentDrawer) return;

      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }

      if (event.key !== "Tab") return;

      const focusable = getFocusableElements(currentDrawer);
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }

      event.preventDefault();

      const active = document.activeElement;
      const activeIndex = active ? focusable.findIndex((el) => el === active) : -1;
      const lastIndex = focusable.length - 1;

      let nextIndex: number;
      if (event.shiftKey) {
        nextIndex = activeIndex <= 0 ? lastIndex : activeIndex - 1;
      } else {
        nextIndex = activeIndex >= lastIndex ? 0 : activeIndex + 1;
      }

      const next = focusable[nextIndex];
      if (next) {
        next.focus();
      }
    }

    const handleFocusIn = (event: FocusEvent): void => {
      if (event.target instanceof Node && !drawer.contains(event.target)) {
        moveFocus(drawer);
      }
    };

    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("focusin", handleFocusIn);

    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("focusin", handleFocusIn);
      const opener = openerRef.current;
      if (opener && "focus" in opener) {
        (opener as HTMLElement).focus();
      }
    };
  }, [open, moveFocus]);

  if (!open) return null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "var(--color-surface-overlay)",
        zIndex: 150,
      }}
    >
      <aside
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={{
          position: "fixed",
          inset: "0 0 0 auto",
          width: "320px",
          maxWidth: "90vw",
          display: "flex",
          flexDirection: "column",
          background: "var(--color-surface-1)",
          borderLeft: "1px solid var(--color-border)",
          boxShadow: "var(--shadow-lg)",
          zIndex: 150,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            padding: "14px 16px",
            borderBottom: "1px solid var(--color-border)",
          }}
        >
          <h2
            id={titleId}
            style={{
              margin: 0,
              fontSize: "var(--fs-16)",
              fontWeight: 600,
              lineHeight: 1.2,
              color: "var(--color-text)",
            }}
          >
            {title}
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={() => {
              onCloseRef.current();
            }}
            style={{
              appearance: "none",
              background: "transparent",
              border: "1px solid var(--color-border-strong)",
              width: 26,
              height: 26,
              display: "grid",
              placeItems: "center",
              borderRadius: 6,
              cursor: "pointer",
              color: "var(--color-text-tertiary)",
              fontSize: 18,
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 16 }}>{children}</div>
      </aside>
    </div>
  );
}
