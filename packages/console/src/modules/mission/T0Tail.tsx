import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useVirtualizer, type VirtualItem } from "@tanstack/react-virtual";
import type { DispatchEvent } from "@penumbra/api-contract";
import { Card, CardHead } from "../../ui/Card";
import { Button } from "../../ui/Button";
import { EventTypeChip } from "../../ui/EventTypeChip";
import { useStream } from "../../hooks/useStream";
import type { StreamMessage, StreamTopic, Subscription } from "../../api/streams";
import { chainsByStatus, handoffsPending } from "../../lib/query-keys";
import { useMissionStore } from "./store";

type SubscribeImpl = <T>(
  topic: StreamTopic,
  onMessage: (msg: StreamMessage<T>) => void,
  opts?: { params?: Record<string, string> },
) => Subscription;

export interface T0TailProps {
  /** Override the stream subscribe impl (test seam). */
  subscribeImpl?: SubscribeImpl;
}

interface RowData {
  ts?: string;
  event: string;
  data: unknown;
}

const RECONNECTED_BANNER_MS = 3000;
const ROW_HEIGHT = 24;

function isReconnectSynthetic(msg: StreamMessage<unknown>): boolean {
  const d = msg.data as { reconnect?: unknown } | null | undefined;
  return msg.event === "__reconnect__" || (!!d && d.reconnect === true);
}

function toRow(msg: StreamMessage<DispatchEvent>): RowData {
  const data = msg.data as DispatchEvent | null | undefined;
  return {
    ts: data && typeof data.ts === "string" ? data.ts : undefined,
    event: data && typeof data.kind === "string" ? data.kind : msg.event,
    data,
  };
}

function matchesFilter(row: RowData, filter: string): boolean {
  const needle = filter.toLowerCase();
  if (row.event.toLowerCase().includes(needle)) return true;
  try {
    return JSON.stringify(row.data).toLowerCase().includes(needle);
  } catch {
    return false;
  }
}

export function T0Tail(props: T0TailProps = {}): JSX.Element {
  const tailFilter = useMissionStore((s) => s.tailFilter);
  const pausedTail = useMissionStore((s) => s.pausedTail);
  const setTailFilter = useMissionStore((s) => s.setTailFilter);
  const setPausedTail = useMissionStore((s) => s.setPausedTail);

  const stream = useStream<DispatchEvent>(
    "dispatch-events",
    undefined,
    props.subscribeImpl ? { subscribeImpl: props.subscribeImpl } : undefined,
  );

  const queryClient = useQueryClient();
  const lastReconnectSeen = useRef(0);
  const [showReconnected, setShowReconnected] = useState(false);
  const frozenRef = useRef<ReadonlyArray<StreamMessage<DispatchEvent>> | null>(null);
  const postResumeStartRef = useRef<number | null>(null);

  useEffect(() => {
    if (stream.reconnectCount > lastReconnectSeen.current) {
      lastReconnectSeen.current = stream.reconnectCount;
      setShowReconnected(true);
      // Preserve the pause invariant across reconnects: while paused, re-seed
      // frozenRef to the post-reset snapshot so the memo keeps returning a
      // frozen view instead of falling through to the live buffer.
      frozenRef.current = pausedTail ? stream.messages : null;
      postResumeStartRef.current = null;
      void queryClient.invalidateQueries({ queryKey: chainsByStatus("dispatched") });
      void queryClient.invalidateQueries({ queryKey: handoffsPending() });
      const handle = setTimeout(() => setShowReconnected(false), RECONNECTED_BANNER_MS);
      return () => clearTimeout(handle);
    }
    return undefined;
    // Intentionally read the latest `pausedTail` and `stream.messages` from
    // the render that bumped reconnectCount, not from later renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream.reconnectCount, queryClient]);

  // Frozen snapshot when paused: capture once at the moment pause flips on.
  useEffect(() => {
    if (pausedTail) {
      frozenRef.current = stream.messages;
    } else {
      frozenRef.current = null;
      postResumeStartRef.current = null;
    }
    // Intentionally only depend on `pausedTail` — we want the snapshot to
    // capture whatever messages are present at the instant pause flips on,
    // not to refresh while paused.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pausedTail]);

  const sourceMessages: ReadonlyArray<StreamMessage<DispatchEvent>> = useMemo(() => {
    if (pausedTail && frozenRef.current) {
      return frozenRef.current;
    }
    return stream.messages;
  }, [pausedTail, stream.messages]);

  const filtered = useMemo(() => {
    const rows: RowData[] = [];
    for (const msg of sourceMessages) {
      if (isReconnectSynthetic(msg)) continue;
      const row = toRow(msg);
      if (tailFilter && tailFilter.length > 0 && !matchesFilter(row, tailFilter)) continue;
      rows.push(row);
    }
    return rows;
  }, [sourceMessages, tailFilter]);

  const parentRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });

  return (
    <Card>
      <CardHead
        title="t0 events"
        id={`${filtered.length} ${pausedTail ? "(paused)" : ""}`.trim()}
        actions={
          <>
            <input
              type="text"
              placeholder="filter…"
              value={tailFilter ?? ""}
              onChange={(e) => setTailFilter(e.target.value || null)}
              className="mono"
              style={{
                fontSize: 11,
                padding: "2px 6px",
                background: "var(--color-surface-2)",
                border: "1px solid var(--color-border)",
                borderRadius: 3,
                color: "var(--color-text)",
              }}
              aria-label="Filter t0 events"
            />
            <Button variant="ghost" onClick={() => setPausedTail(!pausedTail)}>
              {pausedTail ? "▶ resume" : "⏸ pause"}
            </Button>
          </>
        }
      />
      {showReconnected && (
        <span className="t-tertiary mono" style={{ padding: 4, fontSize: 10 }} role="status">
          reconnected — refetching…
        </span>
      )}
      <div
        ref={parentRef}
        className="t0-tail-scroll"
        style={{
          height: 280,
          overflowY: "auto",
          background: "var(--color-surface)",
          border: "1px solid var(--color-border)",
          borderRadius: 3,
        }}
      >
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((vi) => {
            const row = filtered[vi.index];
            if (!row) return null;
            return <T0Row key={vi.index} row={row} virtualItem={vi} />;
          })}
        </div>
      </div>
    </Card>
  );
}

interface T0RowProps {
  row: RowData;
  virtualItem: VirtualItem;
}

function T0Row({ row, virtualItem }: T0RowProps): JSX.Element {
  return (
    <div
      className="t0-row mono"
      data-testid="t0-row"
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        transform: `translateY(${virtualItem.start}px)`,
        height: virtualItem.size,
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "2px 8px",
        fontSize: 11,
        borderBottom: "1px solid var(--color-border)",
      }}
    >
      <span style={{ color: "var(--color-text-tertiary)", minWidth: 60 }}>
        {row.ts ? new Date(row.ts).toLocaleTimeString() : "—"}
      </span>
      <EventTypeChip type={row.event ?? "—"} />
      <span
        style={{
          flex: 1,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {row.data ? JSON.stringify(row.data).slice(0, 200) : ""}
      </span>
    </div>
  );
}
