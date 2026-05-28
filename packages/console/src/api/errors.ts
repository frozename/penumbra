import type { ZodIssue } from "zod";

export class DaemonHttpError extends Error {
  override name = "DaemonHttpError";
  readonly status: number;
  readonly statusText: string;
  readonly bodyText: string;
  readonly url: string;

  constructor(args: { status: number; statusText: string; bodyText: string; url: string }) {
    super(`daemon ${args.status} ${args.statusText} for ${args.url}`);
    this.status = args.status;
    this.statusText = args.statusText;
    this.bodyText = args.bodyText;
    this.url = args.url;
  }
}

export class DaemonContractError extends Error {
  override name = "DaemonContractError";
  readonly url: string;
  readonly issues: ZodIssue[];
  readonly rawBody: unknown;

  constructor(args: { url: string; issues: ZodIssue[]; rawBody: unknown }) {
    super(`daemon response failed contract for ${args.url}`);
    this.url = args.url;
    this.issues = args.issues;
    this.rawBody = args.rawBody;
  }
}
