import { type QueryKey, useMutation, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import { DaemonClient, type DaemonClientDeps } from "../api/client.js";
import { DaemonHttpError } from "../api/errors.js";
import { useDaemonStore } from "../stores/daemon-store.js";
import { useConfirm } from "../ui/ConfirmDialog.js";
import { useToast } from "../ui/Toast.js";

export type ActionTier = "safe" | "guarded" | "destructive";

export interface DaemonActionSpec<A, R> {
  id: string;
  tier: ActionTier;
  label: string;
  run: (client: DaemonClient, args: A, ctx: { reason?: string; signal: AbortSignal }) => Promise<R>;
  invalidate: (args: A, result: R) => QueryKey[];
  confirm?: { title: string; body?: (a: A) => ReactNode; typedTarget?: (a: A) => string };
}

export class ActionTierUnavailable extends Error {
  constructor(tier: ActionTier) {
    super(`action tier ${tier} is not available in this console build`);
    this.name = "ActionTierUnavailable";
  }
}

function makeDefaultClient(): DaemonClient {
  const deps: DaemonClientDeps = {
    getConfig: () => useDaemonStore.getState(),
  };
  return new DaemonClient(deps);
}

export function useDaemonAction<A, R>(
  spec: DaemonActionSpec<A, R>,
  opts?: { client?: DaemonClient },
): {
  execute(args: A): Promise<R | undefined>;
  isPending: boolean;
  lastError: DaemonHttpError | null;
} {
  if (spec.tier === "destructive") {
    throw new ActionTierUnavailable(spec.tier);
  }

  const client = useMemo(() => opts?.client ?? makeDefaultClient(), [opts?.client]);
  const confirm = useConfirm();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [lastError, setLastError] = useState<DaemonHttpError | null>(null);
  const controllersRef = useRef<Set<AbortController>>(new Set());

  useEffect((): (() => void) => {
    return (): void => {
      for (const c of controllersRef.current) {
        try {
          c.abort();
        } catch {
          /* ignore */
        }
      }
      controllersRef.current.clear();
    };
  }, []);

  const mutation = useMutation<R, Error, { args: A; reason?: string }>({
    mutationFn: async ({ args, reason }): Promise<R> => {
      const controller = new AbortController();
      controllersRef.current.add(controller);
      try {
        return await spec.run(client, args, { reason, signal: controller.signal });
      } finally {
        controllersRef.current.delete(controller);
      }
    },
  });

  async function execute(args: A): Promise<R | undefined> {
    if (spec.tier === "guarded") {
      const result = await confirm({
        title: spec.confirm?.title ?? spec.label,
        body: spec.confirm?.body?.(args),
        typedTarget: spec.confirm?.typedTarget?.(args),
      });
      if (result === null) return undefined;
      try {
        const res = await mutation.mutateAsync({ args, reason: result.reason });
        for (const key of spec.invalidate(args, res)) {
          await queryClient.invalidateQueries({ queryKey: key });
        }
        setLastError(null);
        return res;
      } catch (err) {
        handleError(err);
        return undefined;
      }
    }

    try {
      const res = await mutation.mutateAsync({ args });
      for (const key of spec.invalidate(args, res)) {
        await queryClient.invalidateQueries({ queryKey: key });
      }
      setLastError(null);
      return res;
    } catch (err) {
      handleError(err);
      return undefined;
    }
  }

  function handleError(err: unknown): void {
    if (err instanceof DaemonHttpError) {
      setLastError(err);
      if (err.reloadRequired) {
        useDaemonStore.getState().setSessionInvalid(true);
        return;
      }
      toast.push({
        kind: "error",
        text: `${spec.label} failed: ${err.code ?? String(err.status)}`,
      });
      return;
    }
    setLastError(null);
    toast.push({ kind: "error", text: `${spec.label} failed: ${String(err)}` });
  }

  return { execute, isPending: mutation.isPending, lastError };
}
