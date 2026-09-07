import type { z } from "zod";

import { ErrorEnvelopeSchema } from "@penumbra/api-contract";

type ZodIssueLike = z.core.$ZodIssue;

export function extractErrorCode(bodyText: string): string | null {
  let raw: unknown;
  try {
    raw = JSON.parse(bodyText);
  } catch {
    return null;
  }
  const parsed = ErrorEnvelopeSchema.safeParse(raw);
  if (!parsed.success) return null;
  const e = parsed.data.error;
  return typeof e === "string" ? e : e.code;
}

export class DaemonHttpError extends Error {
  override name = "DaemonHttpError";
  readonly status: number;
  readonly statusText: string;
  readonly bodyText: string;
  readonly url: string;
  readonly code: string | null;
  readonly reloadRequired: boolean;

  constructor(args: { status: number; statusText: string; bodyText: string; url: string }) {
    super(`daemon ${String(args.status)} ${args.statusText} for ${args.url}`);
    this.status = args.status;
    this.statusText = args.statusText;
    this.bodyText = args.bodyText;
    this.url = args.url;
    this.code = extractErrorCode(args.bodyText);
    this.reloadRequired = args.status === 401 && this.code === "invalid_session";
  }
}

export class DaemonContractError extends Error {
  override name = "DaemonContractError";
  readonly url: string;
  readonly issues: ZodIssueLike[];
  readonly rawBody: unknown;

  constructor(args: { url: string; issues: ZodIssueLike[]; rawBody: unknown }) {
    super(`daemon response failed contract for ${args.url}`);
    this.url = args.url;
    this.issues = args.issues;
    this.rawBody = args.rawBody;
  }
}
