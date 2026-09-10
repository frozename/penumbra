import type { DispatchLandAccepted, DispatchLandTask } from "@penumbra/api-contract";

import { type QueryKey, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";

import { DaemonClient, type DaemonClientDeps } from "@src/api/client";
import { DaemonHttpError } from "@src/api/errors";
import { useDaemonAction } from "@src/hooks/useDaemonAction";
import {
  chainsByStatus,
  dispatchAudit,
  dispatchEvents,
  handoffDetail,
  handoffsPendingInvalidations,
} from "@src/lib/query-keys";
import { useDaemonStore } from "@src/stores/daemon-store";
import { Card, CardHead } from "@src/ui/Card";

// This unit exposes the two local merge modes; the API also supports gh.
type LandMode = "squash" | "ff";

export interface LandPanelProps {
  handoffId: string;
  client?: DaemonClient;
  scheduler?: typeof setTimeout;
}

function makeDefaultClient(): DaemonClient {
  const deps: DaemonClientDeps = {
    getConfig: () => useDaemonStore.getState(),
  };
  return new DaemonClient(deps);
}

function landFailInvalidations(handoffId: string): QueryKey[] {
  return [
    handoffDetail(handoffId),
    dispatchAudit(handoffId),
    dispatchEvents(handoffId),
    ["handoffs", "by-status", "pending"],
    ["handoffs", "by-status", "dispatched"],
    ["handoffs", "by-status", "completed"],
    ["handoffs", "by-status", "failed"],
    ...handoffsPendingInvalidations(),
    chainsByStatus("dispatched"),
  ];
}

interface LandArgs {
  handoff_id: string;
  mode: LandMode;
  commit_message?: string;
  generation: number;
}

export function LandPanel(props: LandPanelProps): JSX.Element {
  const { handoffId, scheduler = setTimeout } = props;
  const client = useMemo(() => props.client ?? makeDefaultClient(), [props.client]);
  const queryClient = useQueryClient();

  const audit = useQuery({
    queryKey: dispatchAudit(handoffId),
    queryFn: () => client.dispatchAudit.audit(handoffId),
  });
  const report = audit.data?.report ?? null;
  const canAccept = !audit.isError && report?.recommended_action === "accept";

  const [mode, setMode] = useState<LandMode>("squash");
  const [commitSubject, setCommitSubject] = useState("");
  const [landTaskId, setLandTaskId] = useState<string | null>(null);
  const [landTask, setLandTask] = useState<DispatchLandTask | null>(null);
  const [landError, setLandError] = useState<string | null>(null);
  const [isPolling, setIsPolling] = useState(false);
  const [landedSha, setLandedSha] = useState<string | null>(null);
  const [isConfirming, setIsConfirming] = useState(false);
  const [failError, setFailError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const confirmationRef = useRef(false);
  const currentIdRef = useRef(handoffId);
  currentIdRef.current = handoffId;
  const acceptRef = useRef(canAccept);
  acceptRef.current = canAccept;
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      if (pollTimerRef.current !== null) clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    };
  }, []);

  useEffect(() => {
    generationRef.current += 1;
    if (pollTimerRef.current !== null) clearTimeout(pollTimerRef.current);
    pollTimerRef.current = null;
    setLandTaskId(null);
    setLandTask(null);
    setLandError(null);
    setIsPolling(false);
    setLandedSha(null);
    setIsConfirming(false);
    confirmationRef.current = false;
    setFailError(null);
  }, [handoffId]);

  function isCurrent(id: string, generation: number): boolean {
    return (
      mountedRef.current && currentIdRef.current === id && generationRef.current === generation
    );
  }

  function errorMessage(error: unknown): string {
    return error instanceof DaemonHttpError ? (error.code ?? String(error.status)) : String(error);
  }

  const landSpec = useMemo(
    () => ({
      id: "land",
      tier: "guarded" as const,
      label: "Land",
      run: async (c: DaemonClient, args: LandArgs): Promise<DispatchLandAccepted | undefined> => {
        if (!isCurrent(args.handoff_id, args.generation) || !acceptRef.current) return undefined;
        const { generation: _generation, ...request } = args;
        try {
          return await c.dispatchLand.land(request);
        } catch (error) {
          if (isCurrent(args.handoff_id, args.generation)) setLandError(errorMessage(error));
          throw error;
        }
      },
      invalidate: (): QueryKey[] => [],
      confirm: {
        title: "Land handoff",
        body: (a: LandArgs) => (
          <div>
            mode: {a.mode}
            {" · subject: "}
            {a.commit_message ?? "(branch default)"}
          </div>
        ),
        typedTarget: (a: LandArgs) => a.handoff_id,
      },
    }),
    [],
  );
  const landAction = useDaemonAction(landSpec, { client });

  const failSpec = useMemo(
    () => ({
      id: "fail",
      tier: "guarded" as const,
      label: "Fail",
      run: async (
        c: DaemonClient,
        args: { id: string; generation: number },
        ctx: { reason?: string; signal: AbortSignal },
      ) => {
        if (!isCurrent(args.id, args.generation) || ctx.signal.aborted) return undefined;
        try {
          return await c.handoffs.fail(args.id, { reason: ctx.reason ?? "" });
        } catch (error) {
          if (isCurrent(args.id, args.generation)) setFailError(errorMessage(error));
          throw error;
        }
      },
      invalidate: (args: { id: string; generation: number }, result: unknown): QueryKey[] =>
        result !== undefined && isCurrent(args.id, args.generation)
          ? landFailInvalidations(args.id)
          : [],
      confirm: {
        title: "Fail handoff",
        typedTarget: (args: { id: string; generation: number }) => args.id,
      },
    }),
    [],
  );
  const failAction = useDaemonAction(failSpec, { client });

  async function pollTask(taskId: string, gen: number): Promise<void> {
    if (!mountedRef.current || generationRef.current !== gen) return;
    try {
      const task = await client.dispatchLand.task(taskId);
      if (!mountedRef.current || generationRef.current !== gen) return;
      setLandTask(task);
      setLandError(null);
      if (task.status === "done" || task.status === "failed") {
        setIsPolling(false);
        if (task.status === "done" && task.result) {
          setLandedSha(task.result.commit_sha);
          for (const key of landFailInvalidations(handoffId)) {
            if (!isCurrent(handoffId, gen)) return;
            await queryClient.invalidateQueries({ queryKey: key });
          }
        } else if (task.status === "failed") {
          setLandError(task.error?.code ?? "land failed");
        } else {
          setLandError("Land task completed without a result");
        }
        return;
      }
      pollTimerRef.current = scheduler(() => {
        void pollTask(taskId, gen);
      }, 2000);
    } catch (err) {
      if (!mountedRef.current || generationRef.current !== gen) return;
      setLandError(err instanceof DaemonHttpError ? (err.code ?? String(err.status)) : String(err));
      setIsPolling(false);
    }
  }

  async function handleLand(): Promise<void> {
    if (
      !canAccept ||
      confirmationRef.current ||
      failAction.isPending ||
      landAction.isPending ||
      isPolling ||
      hasUnresolvedTask ||
      landTask?.status === "done"
    )
      return;
    const gen = generationRef.current;
    confirmationRef.current = true;
    setIsConfirming(true);
    setLandError(null);
    const args: LandArgs = { handoff_id: handoffId, mode, generation: gen };
    if (commitSubject.trim()) args.commit_message = commitSubject;
    try {
      const accepted = await landAction.execute(args);
      if (!accepted || !isCurrent(handoffId, gen)) return;
      setLandTask(null);
      setLandTaskId(accepted.task_id);
      setIsPolling(true);
      void pollTask(accepted.task_id, gen);
    } finally {
      if (isCurrent(handoffId, gen)) {
        confirmationRef.current = false;
        setIsConfirming(false);
      }
    }
  }

  async function handleFail(): Promise<void> {
    if (
      confirmationRef.current ||
      landAction.isPending ||
      isPolling ||
      failAction.isPending ||
      hasUnresolvedTask ||
      landTask?.status === "done"
    )
      return;
    const gen = generationRef.current;
    confirmationRef.current = true;
    setIsConfirming(true);
    setFailError(null);
    try {
      await failAction.execute({ id: handoffId, generation: gen });
    } finally {
      if (isCurrent(handoffId, gen)) {
        confirmationRef.current = false;
        setIsConfirming(false);
      }
    }
  }

  function handleRetry(): void {
    if (!landTaskId || isPolling || landedSha) return;
    setLandError(null);
    setIsPolling(true);
    const gen = generationRef.current;
    void pollTask(landTaskId, gen);
  }

  const errorText = landError;
  const hasUnresolvedTask =
    !!landTaskId && landTask?.status !== "done" && landTask?.status !== "failed";
  const landDisabled =
    !canAccept ||
    isConfirming ||
    failAction.isPending ||
    landAction.isPending ||
    isPolling ||
    hasUnresolvedTask ||
    landTask?.status === "done";
  const failDisabled =
    isConfirming ||
    landAction.isPending ||
    isPolling ||
    failAction.isPending ||
    hasUnresolvedTask ||
    landTask?.status === "done";
  const showRetry = !!errorText && !isPolling && hasUnresolvedTask;

  return (
    <Card>
      <CardHead title="Land / Fail" />
      <div style={{ padding: 12, display: "grid", gap: 8 }}>
        <div style={{ display: "flex", gap: 12 }}>
          <label>
            <input
              type="radio"
              data-testid="land-mode-squash"
              name={`land-mode-${handoffId}`}
              value="squash"
              checked={mode === "squash"}
              onChange={() => {
                setMode("squash");
              }}
            />
            squash
          </label>
          <label>
            <input
              type="radio"
              data-testid="land-mode-ff"
              name={`land-mode-${handoffId}`}
              value="ff"
              checked={mode === "ff"}
              onChange={() => {
                setMode("ff");
              }}
            />
            ff
          </label>
        </div>
        <input
          type="text"
          data-testid="land-subject"
          aria-label="Commit subject"
          style={{
            width: "100%",
            padding: "8px 10px",
            border: "1px solid var(--color-border)",
            borderRadius: 6,
            font: "inherit",
            background: "var(--color-surface-0)",
            color: "var(--color-text)",
          }}
          placeholder="Blank uses the branch's commit subject"
          value={commitSubject}
          onChange={(e) => {
            setCommitSubject(e.target.value);
          }}
        />
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button
            type="button"
            data-testid="land-button"
            className="btn btn-primary"
            disabled={landDisabled}
            title={canAccept ? undefined : "audit does not recommend accept"}
            onClick={() => {
              void handleLand();
            }}
          >
            Land
          </button>
          {landTaskId && (
            <span data-testid="land-task-id" className="mono" style={{ fontSize: 11 }}>
              {landTaskId}
            </span>
          )}
          <button
            type="button"
            data-testid="fail-button"
            className="btn btn-secondary"
            disabled={failDisabled}
            onClick={() => {
              void handleFail();
            }}
          >
            Fail
          </button>
        </div>
        {errorText && (
          <div
            data-testid="land-error"
            className="t-tertiary mono"
            style={{ color: "var(--color-err)" }}
          >
            {errorText}
          </div>
        )}
        {landedSha && (
          <div data-testid="land-result" className="mono" style={{ fontSize: 11 }}>
            landed {landedSha}
          </div>
        )}
        {failError && (
          <div
            data-testid="fail-error"
            className="t-tertiary mono"
            style={{ color: "var(--color-err)" }}
          >
            {failError}
          </div>
        )}
        {showRetry && (
          <button
            type="button"
            data-testid="land-retry"
            className="btn btn-secondary"
            onClick={handleRetry}
          >
            Retry status
          </button>
        )}
      </div>
    </Card>
  );
}
