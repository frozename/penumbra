import { type TextContentEnvelope, toTextContent } from "@novaproto/mcp-shared";
import {
  RegistrarActorSchema,
  RegistrarEventInputSchema,
  RegistrarEventKindSchema,
  RegistrarLinkKindSchema,
  RegistrarPhaseStatusSchema,
} from "@penumbra/api-contract";
import { z } from "zod";

import type { DaemonClient } from "../daemon-client.js";

import { DaemonHttpError } from "../daemon-client.js";

export const RegistrarAppendInputShape = {
  registrar_id: z.string().min(1).describe("The registrar entry ID to append to."),
  kind: RegistrarEventKindSchema,
  phase_no: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Required for phase_transition; optional phase association for other event kinds."),
  actor: RegistrarActorSchema,
  body: z
    .string()
    .refine(
      (body) => new TextEncoder().encode(body).byteLength <= 4096,
      "body must be at most 4096 bytes",
    ),
  state: z
    .union([
      z.enum(["opened", "resolved"]),
      z.enum(["owed", "done", "dropped"]),
      RegistrarPhaseStatusSchema,
    ])
    .optional()
    .describe(
      "Required for blocker (opened|resolved), follow_up (owed|done|dropped), and phase_transition (a phase status).",
    ),
  ref_event_id: z.number().int().positive().optional(),
  from_status: RegistrarPhaseStatusSchema.optional().describe(
    "Required for phase_transition and must name the phase status being transitioned from.",
  ),
  link_kind: RegistrarLinkKindSchema.optional(),
  link_value: z.string().min(1).optional(),
};

const RegistrarAppendInputSchema = z.object(RegistrarAppendInputShape).strict();

export function registrarAppendHandler(daemon: Pick<DaemonClient, "registrarAppend">) {
  return async (input: unknown): Promise<TextContentEnvelope> => {
    const { registrar_id, ...eventInput } = RegistrarAppendInputSchema.parse(input);
    const event = RegistrarEventInputSchema.parse(eventInput);
    try {
      return toTextContent(await daemon.registrarAppend({ registrar_id, event }));
    } catch (err) {
      if (err instanceof DaemonHttpError && err.status === 409) {
        throw new Error("registrar.append phase already transitioned");
      }
      if (err instanceof DaemonHttpError && err.status === 404) {
        const body = err.body;
        if (typeof body === "object" && body !== null && "error" in body) {
          if (body.error === "registrar_not_found") {
            throw new Error("registrar entry not found");
          }
          if (
            body.error === "phase_not_found" &&
            "phase_no" in body &&
            typeof body.phase_no === "number"
          ) {
            throw new Error(`registrar phase ${String(body.phase_no)} not found`);
          }
        }
        throw new Error("registrar.append returned 404; registrar feature may be disabled");
      }
      if (err instanceof DaemonHttpError && err.status === 400) {
        throw new Error(formatValidationMessage(err));
      }
      throw err;
    }
  };
}

function formatValidationMessage(err: DaemonHttpError): string {
  const body = err.body;
  if (typeof body !== "object" || body === null) {
    return "registrar.append validation_failed";
  }
  const error =
    "error" in body && typeof body.error === "string" ? body.error : "validation_failed";
  const details = "details" in body ? `: ${JSON.stringify(body.details)}` : "";
  return `registrar.append ${error}${details}`;
}
