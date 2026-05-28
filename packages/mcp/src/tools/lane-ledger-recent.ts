import { z } from "zod";
import { TaskClassSchema } from "@penumbra/core";
import type { DaemonClient } from "../daemon-client.js";

export const LaneLedgerRecentInputShape = {
  status: z.enum(["open", "passed", "failed", "skipped", "review_debt"]).optional(),
  task_class: TaskClassSchema.optional(),
  since: z.string().optional(),
  limit: z.coerce.number().int().min(1).optional(),
};

export function laneLedgerRecentHandler(daemon: DaemonClient) {
  return async (input: {
    status?: "open" | "passed" | "failed" | "skipped" | "review_debt";
    task_class?: z.infer<typeof TaskClassSchema>;
    since?: string;
    limit?: number;
  }) => {
    const response = await getFromDaemon(daemon, "/lanes/recent", {
      status: input.status,
      task_class: input.task_class,
      since: input.since,
      limit: input.limit,
    });
    return response as { lanes: unknown[] };
  };
}

async function getFromDaemon(
  daemon: DaemonClient,
  path: string,
  query: Record<string, string | number | undefined>,
): Promise<unknown> {
  const { baseUrl, token } = (
    daemon as unknown as { resolve: () => { baseUrl: string; token: string } }
  ).resolve();
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const queryString = params.toString();
  const res = await fetch(`${baseUrl}${path}${queryString ? `?${queryString}` : ""}`, {
    method: "GET",
    headers: {
      authorization: `Bearer ${token}`,
    },
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
