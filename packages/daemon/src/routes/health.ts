import { json } from "./_helpers.js";
export function healthRoute(): Response {
  return Response.json({ status: "ok", version: "0.0.0" });
}
