import { createLogger } from "@penumbra/core";

export interface McpEvent {
  server: string;
  event: string;
  payload: unknown;
  published_at: number;
}

type Handler = (e: McpEvent) => void;

export interface McpEventBus {
  publish(e: McpEvent): void;
  subscribe(filter: { server: string; event: string }, handler: Handler): () => void;
  clear(): void;
}

const log = createLogger({ component: "daemon", level: "silent" });

export function createMcpEventBus(): McpEventBus {
  const subs = new Map<string, Set<Handler>>();
  const key = (server: string, event: string): string => `${server}::${event}`;

  return {
    publish(evt): void {
      const handlers = subs.get(key(evt.server, evt.event));
      if (!handlers) return;
      for (const handler of handlers) {
        try {
          handler(evt);
        } catch (err) {
          log.warn({ err, server: evt.server, event: evt.event }, "mcp-event subscriber threw");
        }
      }
    },
    subscribe({ server, event }, handler) {
      const k = key(server, event);
      let set = subs.get(k);
      if (!set) {
        set = new Set<Handler>();
        subs.set(k, set);
      }
      const bound = set;
      bound.add(handler);
      return () => {
        bound.delete(handler);
      };
    },
    clear(): void {
      subs.clear();
    },
  };
}

let _singleton: McpEventBus | null = null;

export function getMcpEventBus(): McpEventBus {
  _singleton ??= createMcpEventBus();
  return _singleton;
}

export function _resetForTest(): void {
  _singleton = null;
}
