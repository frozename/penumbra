import { json } from "./_helpers.js";
import type { LagSampler } from "../lag-sampler.js";

export function healthRoute(sampler?: LagSampler): Response {
  const payload: Record<string, unknown> = { status: "ok", version: "0.0.0" };
  if (sampler) {
    payload.lagMs = sampler.maxLag;
  }
  return Response.json(payload);
}
