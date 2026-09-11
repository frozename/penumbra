import { expect, test } from "bun:test";

// eslint-disable-next-line no-restricted-imports -- e2e harness lives outside src/
import { startHarness } from "../../e2e/harness/index";

async function withDeadline<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error("task SSE deadline"));
        }, 2_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

for (const action of ["reset", "stop"] as const) {
  test(`task SSE sends initial frame and reaches EOF after ${action}`, async () => {
    const h = await startHarness();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await withDeadline(
        Bun.fetch(`${h.baseUrl}/tasks/events`, {
          headers: { Authorization: `Bearer ${h.token}`, Accept: "text/event-stream" },
        }),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      reader = response.body!.getReader();
      const first = await withDeadline(reader.read());
      expect(first.done).toBe(false);
      expect(new TextDecoder().decode(first.value)).toBe(": keepalive\n\n");
      const eof = withDeadline(reader.read());
      if (action === "reset") h.reset();
      else await withDeadline(h.stop());
      expect((await eof).done).toBe(true);
    } finally {
      if (reader) await reader.cancel();
      await h.stop();
    }
  });
}
