export interface EventSourceLike {
  addEventListener: (
    event: string,
    listener: (msg: { data: string; type: string }) => void,
  ) => void;
  close: () => void;
}

export interface ShimOpts {
  url: string;
  headers: Record<string, string>;
  onTransportError?: (err: unknown) => void;
  fetchImpl?: typeof fetch;
}

const MAX_EVENT_BYTES = 64 * 1024;
const MAX_BUFFER_BYTES = 256 * 1024;

export function createSseSource(opts: ShimOpts): EventSourceLike {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const listeners = new Map<
    string,
    Array<(msg: { data: string; type: string }) => void>
  >();
  let closed = false;

  function addEventListener(
    event: string,
    listener: (msg: { data: string; type: string }) => void,
  ): void {
    let arr = listeners.get(event);
    if (!arr) {
      arr = [];
      listeners.set(event, arr);
    }
    arr.push(listener);
  }

  function close(): void {
    if (closed) return;
    closed = true;
    try {
      controller.abort();
    } catch {
      /* ignore */
    }
    listeners.clear();
  }

  function dispatch(eventName: string, data: string): void {
    const named = listeners.get(eventName);
    if (named) {
      for (const l of named) {
        try {
          l({ data, type: eventName });
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(`[sse:${opts.url}] listener threw`, err);
        }
      }
    }
    if (eventName !== "message") {
      const msg = listeners.get("message");
      if (msg) {
        for (const l of msg) {
          try {
            l({ data, type: eventName });
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error(`[sse:${opts.url}] listener threw`, err);
          }
        }
      }
    }
  }

  function parseEvent(rawChunk: string): void {
    let eventName = "message";
    const dataLines: string[] = [];
    let hasData = false;
    for (const line of rawChunk.split("\n")) {
      if (line === "" || line.startsWith(":")) continue;
      if (line.startsWith("event:")) {
        eventName = line.slice(6).replace(/^ /, "");
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
        hasData = true;
      }
      // ignore id:, retry:, others for P0
    }
    if (!hasData) return;
    dispatch(eventName, dataLines.join("\n"));
  }

  function reportOverflow(): void {
    if (closed) return;
    const err = new Error("sse_buffer_overflow");
    try {
      opts.onTransportError?.(err);
    } catch {
      /* ignore */
    }
    close();
  }

  void (async () => {
    try {
      const headers = { ...opts.headers, Accept: "text/event-stream" };
      const response = await fetchImpl(opts.url, {
        headers,
        signal: controller.signal,
        credentials: 'include',
      });
      if (!response.ok || !response.body) {
        throw new Error(`SSE connect failed: ${response.status}`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (!closed) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // Normalize CRLF to LF so the \n\n delimiter scan works for both framings.
        if (buffer.includes("\r\n")) buffer = buffer.replace(/\r\n/g, "\n");

        if (buffer.length > MAX_BUFFER_BYTES) {
          reportOverflow();
          return;
        }

        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const rawEvent = buffer.slice(0, idx);
          if (rawEvent.length > MAX_EVENT_BYTES) {
            reportOverflow();
            return;
          }
          buffer = buffer.slice(idx + 2);
          parseEvent(rawEvent);
        }
      }
    } catch (err) {
      if (closed) return;
      // eslint-disable-next-line no-console
      console.error(`[sse:${opts.url}] read error`, err);
      try {
        opts.onTransportError?.(err);
      } catch {
        /* ignore */
      }
    }
  })();

  return { addEventListener, close };
}
