import { type QueryKey } from "@tanstack/react-query";

import type { DaemonClient } from "@src/api/client";
import type { StreamTopic } from "@src/api/streams";
import type { DaemonActionSpec } from "@src/hooks/useDaemonAction";

export interface ApprovalItem {
  id: string;
  ts: string;
  title: string;
  subtitle?: string;
}

export interface ErasedQueue {
  readonly kind: "handoff" | "permission" | "draft" | "task-draft";
  readonly queryKey: () => QueryKey;
  readonly topic?: StreamTopic;
  fetch(client: DaemonClient): Promise<ApprovalItem[]>;
  readonly approve?: DaemonActionSpec<ApprovalItem, unknown>;
  readonly reject?: DaemonActionSpec<ApprovalItem, unknown>;
}
