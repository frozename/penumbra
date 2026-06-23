import type { Services } from "@penumbra/core";

import { qualityStatus } from "@penumbra/core";
import { z } from "zod";

import { json } from "./_helpers.js";
const QuerySchema = z.object({
  window_hours: z.coerce.number().int().min(1).max(168).default(24),
  min_samples: z.coerce.number().int().min(1).default(3),
  task_type: z.string().default("implement_substantial"),
});

export function qualityStatusRoute(req: Request, services: Services): Response {
  const url = new URL(req.url);
  const parsed = QuerySchema.safeParse({
    window_hours: url.searchParams.get("window_hours") ?? undefined,
    min_samples: url.searchParams.get("min_samples") ?? undefined,
    task_type: url.searchParams.get("task_type") ?? undefined,
  });
  if (!parsed.success) {
    return json(
      {
        error: {
          code: "validation_error",
          message: "query failed schema validation",
          field_errors: parsed.error.issues.map((issue) => ({
            path: issue.path,
            message: issue.message,
          })),
        },
      },
      400,
    );
  }

  return json(qualityStatus(services.db, parsed.data));
}
