import type {
  DispatchAuditResponse,
  DispatchLandTask,
  HandoffDetailResponse,
} from "@penumbra/api-contract";

import { useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import type { DaemonClient } from "@src/api/client";
import { dispatchAudit, dispatchEvents, handoffDetail } from "@src/lib/query-keys";

import { makeDispatchAuditResponse, makeHandoffDetail } from "./fixtures";

export function useHandoffStoryClient(): DaemonClient {
  const cache = useQueryClient();
  return useMemo(() => {
    const tasks = new Map<string, DispatchLandTask>();
    const get: DaemonClient["handoffs"]["get"] = (id) =>
      Promise.resolve(
        cache.getQueryData<HandoffDetailResponse>(handoffDetail(id)) ??
          makeHandoffDetail({ handoff_id: id }),
      );
    const fail: DaemonClient["handoffs"]["fail"] = async (id, body) => {
      const detail = await get(id);
      cache.setQueryData(handoffDetail(id), {
        ...detail,
        handoff: { ...detail.handoff, status: "failed", resolution_reason: body.reason },
      });
      return { handoff_id: id, status: "failed" };
    };
    const land: DaemonClient["dispatchLand"]["land"] = (request) => {
      const taskId = `storybook-land-${String(tasks.size + 1)}`;
      tasks.set(taskId, {
        task_id: taskId,
        handoff_id: request.handoff_id,
        status: "done",
        created_at: "2026-09-07T10:00:00.000Z",
        started_at: "2026-09-07T10:00:01.000Z",
        finished_at: "2026-09-07T10:00:02.000Z",
        result: {
          ok: true,
          commit_sha: "abc123-storybook",
          message_subject: request.commit_message ?? "feat(console): demonstrate landing",
          branch_deleted: true,
          pr_closed: false,
          worktree_torn_down: true,
        },
        error: null,
      });
      return Promise.resolve({ ok: true, task_id: taskId, status: "queued" });
    };
    const task: DaemonClient["dispatchLand"]["task"] = (taskId) => {
      const result = tasks.get(taskId);
      if (!result) return Promise.reject(new Error("Unknown story task"));
      return Promise.resolve(result);
    };
    const audit: DaemonClient["dispatchAudit"]["audit"] = (id) =>
      Promise.resolve(
        cache.getQueryData<DispatchAuditResponse>(dispatchAudit(id)) ??
          makeDispatchAuditResponse({ handoff_id: id }),
      );
    const list: DaemonClient["dispatchEvents"]["list"] = (id) =>
      Promise.resolve(cache.getQueryData(dispatchEvents(id)) ?? { events: [] });
    return {
      handoffs: { get, fail },
      dispatchLand: { land, task },
      dispatchAudit: { audit },
      dispatchEvents: { list },
    } as unknown as DaemonClient;
  }, [cache]);
}
