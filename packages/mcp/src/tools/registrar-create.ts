import { type TextContentEnvelope, toTextContent } from "@novaproto/mcp-shared";
import { RegistrarCreateRequestSchema } from "@penumbra/api-contract";

import type { DaemonClient } from "../daemon-client.js";

import { DaemonHttpError } from "../daemon-client.js";

export const RegistrarCreateInputShape = RegistrarCreateRequestSchema.shape;

export function registrarCreateHandler(daemon: Pick<DaemonClient, "registrarCreate">) {
  return async (input: unknown): Promise<TextContentEnvelope> => {
    const request = RegistrarCreateRequestSchema.parse(input);
    try {
      const result = await daemon.registrarCreate(request);
      return toTextContent({ ...result, status: request.status });
    } catch (err) {
      if (err instanceof DaemonHttpError && err.status === 400) {
        throw new Error(formatValidationMessage(err));
      }
      if (err instanceof DaemonHttpError && err.status === 409) {
        throw new Error(formatSlugTakenMessage(err));
      }
      throw err;
    }
  };
}

function formatSlugTakenMessage(err: DaemonHttpError): string {
  const body = err.body;
  const slug =
    typeof body === "object" && body !== null && "slug" in body && typeof body.slug === "string"
      ? `: ${body.slug}`
      : "";
  return `registrar slug already taken${slug}`;
}

function formatValidationMessage(err: DaemonHttpError): string {
  const body = err.body;
  if (typeof body !== "object" || body === null) {
    return "registrar.create validation_failed";
  }
  const error =
    "error" in body && typeof body.error === "string" ? body.error : "validation_failed";
  const details = "details" in body ? `: ${JSON.stringify(body.details)}` : "";
  return `registrar.create ${error}${details}`;
}
