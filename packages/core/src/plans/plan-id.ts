import { createHash } from "node:crypto";

/**
 * Derive a plan_id from the plan file's bytes and the registration time.
 * Format: <sha256-prefix-12>-<unix-seconds>
 *
 * Identical content + identical timestamp -> identical id (deterministic collision).
 * Different timestamps -> different ids.
 * Different bytes -> different ids (with overwhelming probability).
 */
export function derivePlanId(
  fileBytes: Buffer | Uint8Array | string,
  registeredAt: number,
): string {
  const buf =
    typeof fileBytes === "string" ? Buffer.from(fileBytes, "utf8") : Buffer.from(fileBytes);
  const sha = createHash("sha256").update(buf).digest("hex");
  const prefix = sha.slice(0, 12);
  const unixSeconds = Math.floor(registeredAt / 1000);
  return `${prefix}-${String(unixSeconds)}`;
}
