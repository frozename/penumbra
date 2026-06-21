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
  onConnected?: () => void;
  onTransportError?: (err: unknown) => void;
  fetchImpl?: typeof fetch;
}

type Listener = (msg: { data: string; type: string }) => void;
type ListenerMap = Map<string, Listener[]>;

const MAX_EVENT_BYTES = 64 * 1024;
const MAX_BUFFER_BYTES = 256 * 1024;

function invokeListeners(url: string, list: Listener[], data: string, eventName: string): void {
  for (const l of list) {
    try {
      l({ data, type: eventName });
    } catch (err) {
      console.error(`[sse:${url}] listener threw`, err);
    }
  }
}

function dispatchEvent(listeners: ListenerMap, url: string, eventName: string, data: string): void {
  const named = listeners.get(eventName);
  if (named) invokeListeners(url, named, data, eventName);
  if (eventName === "message") return;
  const fallback = listeners.get("message");
  if (fallback) invokeListeners(url, fallback, data, eventName);
}

function parseEventChunk(rawChunk: string, emit: (eventName: string, data: string) => void): void {
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
  emit(eventName, dataLines.join("\n"));
}

interface ReadLoopCtx {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  isClosed: () => boolean;
  emit: (eventName: string, data: string) => void;
  onOverflow: () => boolean;
}

function drainBuffer(buffer: string, ctx: ReadLoopCtx): { buffer: string; overflowed: boolean } {
  let rest = buffer;
  let idx = rest.indexOf("\n\n");
  while (idx !== -1) {
    const rawEvent = rest.slice(0, idx);
    if (rawEvent.length > MAX_EVENT_BYTES) {
      ctx.onOverflow();
      return { buffer: rest, overflowed: true };
    }
    rest = rest.slice(idx + 2);
    parseEventChunk(rawEvent, ctx.emit);
    idx = rest.indexOf("\n\n");
  }
  return { buffer: rest, overflowed: false };
}

async function readLoop(ctx: ReadLoopCtx): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  while (!ctx.isClosed()) {
    const { value, done } = await ctx.reader.read();
    if (done) throw new Error("sse_stream_ended");
    buffer += decoder.decode(value, { stream: true });
    if (buffer.includes("\r\n")) buffer = buffer.replaceAll("\r\n", "\n");
    if (buffer.length > MAX_BUFFER_BYTES) {
      ctx.onOverflow();
      return;
    }
    const drained = drainBuffer(buffer, ctx);
    if (drained.overflowed) return;
    buffer = drained.buffer;
  }
}

async function runSseConnection(
  opts: ShimOpts,
  ctx: {
    fetchImpl: typeof fetch;
    controller: AbortController;
    isClosed: () => boolean;
    emit: (eventName: string, data: string) => void;
    onOverflow: () => boolean;
  },
): Promise<void> {
  try {
    const headers = { ...opts.headers, Accept: "text/event-stream" };
    const response = await ctx.fetchImpl(opts.url, {
      headers,
      signal: ctx.controller.signal,
      credentials: "include",
    });
    if (!response.ok || !response.body) {
      throw new Error(`SSE connect failed: ${String(response.status)}`);
    }
    opts.onConnected?.();
    await readLoop({
      reader: response.body.getReader(),
      isClosed: ctx.isClosed,
      emit: ctx.emit,
      onOverflow: ctx.onOverflow,
    });
  } catch (err) {
    if (ctx.isClosed()) return;
    console.error(`[sse:${opts.url}] read error`, err);
    try {
      opts.onTransportError?.(err);
    } catch {
      /* ignore */
    }
  }
}

export function createSseSource(opts: ShimOpts): EventSourceLike {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const listeners: ListenerMap = new Map();
  let closed = false;

  function addEventListener(event: string, listener: Listener): void {
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

  function reportOverflow(): boolean {
    if (closed) return false;
    const err = new Error("sse_buffer_overflow");
    try {
      opts.onTransportError?.(err);
    } catch {
      /* ignore */
    }
    close();
    return true;
  }

  void runSseConnection(opts, {
    fetchImpl,
    controller,
    isClosed: () => closed,
    emit: (eventName, data) => {
      dispatchEvent(listeners, opts.url, eventName, data);
    },
    onOverflow: reportOverflow,
  });

  return { addEventListener, close };
}
