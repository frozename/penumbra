import type { z } from "zod";

import { buildRequestUrl } from "../lib/url.js";
import { DaemonContractError, DaemonHttpError } from "./errors.js";

export interface DaemonTransportDeps {
  getConfig: () => { baseUrl: string; token: string };
  fetch?: typeof fetch;
}

export class DaemonTransport {
  constructor(private readonly deps: DaemonTransportDeps) {}

  private buildHeaders(extra?: Record<string, string>): Record<string, string> {
    const cfg = this.deps.getConfig();
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...(extra ?? {}),
    };
    if (cfg.token) {
      headers["Authorization"] = `Bearer ${cfg.token}`;
    }
    return headers;
  }

  async request<S extends z.ZodType>(opts: {
    method?: "GET" | "POST";
    path: string;
    query?: Record<string, string | number | boolean | null | undefined>;
    body?: unknown;
    schema: S;
    signal?: AbortSignal;
  }): Promise<z.output<S>> {
    const { baseUrl } = this.deps.getConfig();
    const url = buildRequestUrl(baseUrl, opts.path, opts.query);
    const init: RequestInit = {
      method: opts.method ?? "GET",
      credentials: "include",
      headers: this.buildHeaders(
        opts.body !== undefined ? { "Content-Type": "application/json" } : undefined,
      ),
    };
    if (opts.body !== undefined) {
      init.body = JSON.stringify(opts.body);
    }
    if (opts.signal !== undefined) {
      init.signal = opts.signal;
    }

    let response: Response;
    try {
      response = await (this.deps.fetch ?? globalThis.fetch)(url, init);
    } catch (err) {
      throw new DaemonHttpError({
        status: 0,
        statusText: "network_error",
        bodyText: err instanceof Error ? err.message : String(err),
        url,
      });
    }

    if (!response.ok) {
      const bodyText: string = await response.text().catch(() => "");
      throw new DaemonHttpError({
        status: response.status,
        statusText: response.statusText,
        bodyText,
        url,
      });
    }

    const rawBody: unknown = await response.json();
    const parsed = opts.schema.safeParse(rawBody);
    if (!parsed.success) {
      throw new DaemonContractError({
        url,
        issues: parsed.error.issues,
        rawBody,
      });
    }
    return parsed.data;
  }
}
