import { randomUUID } from "node:crypto";
import { z } from "zod";
import { toTextContent } from "@nova/mcp-shared";
import { TaskClassSchema } from "@penumbra/core";
import type { DaemonClient } from "../daemon-client.js";

export const LaneOpenInputShape = {
  implementer_handoff_id: z.string().min(1),
  task_class: TaskClassSchema,
};

export function laneOpenHandler(daemon: DaemonClient) {
  return async (input: {
    implementer_handoff_id: string;
    task_class: z.infer<typeof TaskClassSchema>;
  }) => {
    const response = await postToDaemon(daemon, "/lanes/open", {
      lane_id: randomUUID(),
      implementer_handoff: input.implementer_handoff_id,
      task_class: input.task_class,
    });
    return toTextContent(response);
  };
}

async function postToDaemon(daemon: DaemonClient, path: string, body: unknown): Promise<unknown> {
  const { baseUrl, token } = (
    daemon as unknown as { resolve: () => { baseUrl: string; token: string } }
  ).resolve();
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await daemonHttpError(path, res);
  return await res.json();
}

async function daemonHttpError(path: string, res: Response): Promise<Error> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {}
  return new Error(
    `daemon ${path}: HTTP ${res.status}${body === undefined ? "" : ` ${JSON.stringify(body)}`}`,
  );
}
