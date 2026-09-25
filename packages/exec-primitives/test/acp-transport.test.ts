import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import * as lib from "../src/index.ts";
import { catchRejection, sleep } from "./helpers.ts";

function makeClient(opts?: { framing?: "newline" | "content-length" }): {
  client: lib.StdioAcpClient;
  stdin: PassThrough;
  stdout: PassThrough;
} {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const client = new lib.StdioAcpClient({ stdin, stdout, framing: opts?.framing });
  return { client, stdin, stdout };
}

describe("[B8] closed transport", () => {
  test("[B8] request() on a closed transport rejects AcpTransportClosedError within 50ms", async () => {
    const { client, stdout } = makeClient();
    stdout.destroy();
    await sleep(20);

    const t0 = Date.now();
    const outcome = await Promise.race([
      client.request("session/new", { cwd: "/tmp" }).then(
        () => ({ kind: "resolved" as const }),
        (err: unknown) => ({ kind: "rejected" as const, err }),
      ),
      sleep(50).then(() => ({ kind: "timed-out" as const })),
    ]);
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") throw new Error("unreachable");
    expect(outcome.err).toBeInstanceOf(lib.AcpTransportClosedError);
    expect(Date.now() - t0).toBeLessThan(50);
  });

  test("[B8] an in-flight request still rejects when the transport closes", async () => {
    const { client, stdout } = makeClient();
    const pending = client.request("initialize", { protocolVersion: 1 });
    stdout.destroy();

    const err = await catchRejection(pending);
    expect(err).toBeInstanceOf(lib.AcpTransportClosedError);
  });

  test("[B8] notify() after close throws AcpTransportClosedError synchronously", () => {
    const { client, stdout } = makeClient();
    stdout.destroy();
    expect(() => {
      client.notify("session/cancel", {});
    }).toThrow(lib.AcpTransportClosedError);
  });
});

describe("[B8] framing limits", () => {
  test("[B8] an oversized Content-Length frame breaks framing and rejects pending requests", async () => {
    const { client, stdin, stdout } = makeClient({ framing: "content-length" });
    const pending = client.request("initialize", { protocolVersion: 1 });
    stdin.on("data", () => {
      // drain outbound writes
    });

    stdout.write(`Content-Length: ${String(32 * 1024 * 1024)}\r\n\r\n`);

    const err = await catchRejection(pending);
    expect(err).toBeInstanceOf(Error);
    expect(client.isTransportOpen()).toBe(false);
  });
});
