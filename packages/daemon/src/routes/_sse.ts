export const SSE_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  connection: "keep-alive",
};

export function sseCallbackStream(opts: {
  keepaliveMs?: number;
  start: (write: (chunk: string) => boolean) => (() => void) | null;
}): Response {
  let unsubscribe: (() => void) | null = null;
  let keepalive: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller): void {
      const encoder = new TextEncoder();
      const close = (): void => {
        if (closed) return;
        closed = true;
        if (keepalive) clearInterval(keepalive);
        keepalive = null;
        try {
          unsubscribe?.();
        } catch {
          /* noop */
        }
        unsubscribe = null;
      };
      const write = (chunk: string): boolean => {
        if (closed) return false;
        try {
          controller.enqueue(encoder.encode(chunk));
          return true;
        } catch {
          close();
          return false;
        }
      };

      unsubscribe = opts.start(write);
      if (closed) {
        try {
          unsubscribe?.();
        } catch {
          /* noop */
        }
        unsubscribe = null;
        return;
      }
      keepalive = setInterval(() => {
        write(": keepalive\n\n");
      }, opts.keepaliveMs ?? 15_000);
    },
    cancel(): void {
      if (closed) return;
      closed = true;
      if (keepalive) clearInterval(keepalive);
      keepalive = null;
      try {
        unsubscribe?.();
      } catch {
        /* noop */
      }
      unsubscribe = null;
    },
  });

  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}

export function sseIteratorStream<T>(opts: {
  subscribe: () => AsyncIterableIterator<T>;
  replay?: () => Iterable<T>;
  format?: (event: T) => string;
  keepaliveMs?: number;
}): Response {
  let shutdown: (() => Promise<void>) | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller): void {
      const encoder = new TextEncoder();
      const iterator = opts.subscribe();
      let keepalive: ReturnType<typeof setInterval> | null = null;
      let closed = false;
      const format = opts.format ?? ((event: T) => `data: ${JSON.stringify(event)}\n\n`);

      const write = (chunk: string): boolean => {
        if (closed) return false;
        try {
          controller.enqueue(encoder.encode(chunk));
          return true;
        } catch {
          return false;
        }
      };
      const close = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        if (keepalive) clearInterval(keepalive);
        keepalive = null;
        try {
          await iterator.return?.();
        } catch {
          /* noop */
        }
      };
      shutdown = close;

      for (const event of opts.replay?.() ?? []) {
        if (!write(format(event))) {
          void close();
          return;
        }
      }
      if (!write(": ok\n\n")) {
        void close();
        return;
      }

      void (async (): Promise<void> => {
        try {
          for await (const event of iterator) {
            if (!write(format(event))) break;
          }
        } finally {
          await close();
        }
      })();

      keepalive = setInterval(() => {
        if (!write(": keepalive\n\n")) {
          void close();
        }
      }, opts.keepaliveMs ?? 30_000);
    },
    cancel(): void {
      if (shutdown) {
        void shutdown();
      }
      shutdown = null;
    },
  });

  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}
