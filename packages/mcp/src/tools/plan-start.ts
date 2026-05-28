import { z } from "zod";
import type { DaemonClient } from "../daemon-client.js";
import { DaemonHttpError } from "../daemon-client.js";

export const PlanStartInputShape = {
  file_path: z.string().min(1).describe("Path to the plan file to register."),
};

export function planStartHandler(daemon: Pick<DaemonClient, "planStart">) {
  return async (input: { file_path: string }) => {
    try {
      return await daemon.planStart({ file_path: input.file_path });
    } catch (err) {
      if (isValidationFailed(err)) {
        throw new Error(formatValidationFailedMessage(err));
      }
      throw err;
    }
  };
}

function isValidationFailed(err: unknown): err is DaemonHttpError {
  if (!(err instanceof DaemonHttpError)) return false;
  if (err.status !== 400) return false;
  const body = err.body;
  return (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    (body as { error?: unknown }).error === "validation_failed"
  );
}

function formatValidationFailedMessage(err: DaemonHttpError): string {
  const body = err.body;
  if (typeof body === "object" && body !== null && "details" in body) {
    return `plan.start validation_failed: ${JSON.stringify((body as { details?: unknown }).details)}`;
  }
  return "plan.start validation_failed";
}
