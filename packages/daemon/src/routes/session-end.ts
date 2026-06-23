import type { Services } from "@penumbra/core";

import { ContextFileWriter, T1Rollup } from "@penumbra/core";
import { z } from "zod";

import { bodyJson, json } from "./_helpers.js";
const BodySchema = z.object({ session_id: z.string().min(1) });

export async function sessionEndRoute(req: Request, services: Services): Promise<Response> {
  const raw = await bodyJson(req);
  if (raw === null)
    return json(
      { error: { code: "invalid_json", message: "request body was not valid JSON" } },
      400,
    );
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return json(
      {
        error: {
          code: "validation_error",
          message: "body failed schema validation",
          field_errors: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
        },
      },
      400,
    );
  }
  const t1 = new T1Rollup({
    db: services.db,
    embedder: services.embedder,
    clock: services.clock,
    uuid: services.uuid,
  });
  const rollupId = await t1.rollupSession(parsed.data.session_id);
  if (rollupId) {
    const row = services.db
      .query<
        { project_id: string | null },
        [string]
      >("SELECT project_id FROM t1_rollups WHERE rollup_id=?")
      .get(rollupId);
    if (row?.project_id) {
      new ContextFileWriter({
        db: services.db,
        storageRoot: services.storageRoot,
        topK: 10,
      }).rewrite(row.project_id);
    }
  }
  return json({ ok: true, rollup_id: rollupId });
}
