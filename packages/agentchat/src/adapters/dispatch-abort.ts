export interface DispatchAbortHandle {
  signal: AbortSignal;
  readonly timeoutError: Error | null;
  cleanup: () => void;
}

export function createDispatchAbortSignal(
  parent: AbortSignal,
  timeoutMs: number,
  makeTimeoutError: (timeoutMs: number) => Error,
): DispatchAbortHandle {
  if (timeoutMs <= 0) {
    return {
      signal: parent,
      get timeoutError(): Error | null {
        return null;
      },
      cleanup(): void {
        /* no resources to release */
      },
    };
  }

  const controller = new AbortController();
  const state: { timeoutError: Error | null } = { timeoutError: null };
  const abortWith = (reason?: unknown): void => {
    if (!controller.signal.aborted) controller.abort(reason);
  };

  const onParentAbort = (): void => {
    abortWith(parent.reason);
  };

  if (parent.aborted) {
    onParentAbort();
  } else {
    parent.addEventListener("abort", onParentAbort, { once: true });
  }

  const timer = setTimeout(() => {
    const err = makeTimeoutError(timeoutMs);
    err.name = "AbortError";
    state.timeoutError = err;
    abortWith(err);
  }, timeoutMs);

  return {
    signal: controller.signal,
    get timeoutError(): Error | null {
      return state.timeoutError;
    },
    cleanup(): void {
      clearTimeout(timer);
      parent.removeEventListener("abort", onParentAbort);
    },
  };
}
