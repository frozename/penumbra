import type { T0EventInput } from "@penumbra/core";

import type { IPenumbraDaemonClient } from "./client.js";

export interface PenumbraDaemonClientOpts {
  baseUrl: string;
  token: string;
  /** Per-request timeout in milliseconds. Defaults to 2000. */
  timeoutMs?: number;
}

export class PenumbraDaemonClient implements IPenumbraDaemonClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(opts: PenumbraDaemonClientOpts) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? 2000;
  }

  async observe(event: T0EventInput): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/observations`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(event),
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(
          `penumbra daemon /observations: HTTP ${String(res.status)}${detail ? ` — ${detail}` : ""}`,
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
