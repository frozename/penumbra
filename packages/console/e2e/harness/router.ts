import type { IncomingMessage, ServerResponse } from "node:http";

export type FixtureContext = {
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  request: IncomingMessage;
  response: ServerResponse;
};

export type FixtureHandler = (ctx: FixtureContext) => void | Promise<void>;

interface Route {
  method: "GET" | "POST";
  path: string | RegExp;
  handler: FixtureHandler;
}

export class FixtureRouter {
  private routes: Route[] = [];
  private missed: Array<{ method: string; path: string }> = [];

  route(method: "GET" | "POST", path: string | RegExp, handler: FixtureHandler): void {
    for (const existing of this.routes) {
      if (existing.method !== method) continue;
      if (typeof existing.path === "string" && typeof path === "string" && existing.path === path) {
        throw new Error(`duplicate fixture route ${method} ${path}`);
      }
      if (
        existing.path instanceof RegExp &&
        path instanceof RegExp &&
        existing.path.source === path.source
      ) {
        throw new Error(`duplicate fixture route ${method} ${path}`);
      }
    }
    this.routes.push({ method, path, handler });
  }

  async dispatch(ctx: FixtureContext): Promise<boolean> {
    for (const route of this.routes) {
      if (route.method !== ctx.method) continue;
      const params = matchRoute(route.path, ctx.path);
      if (params === null) continue;
      await route.handler({ ...ctx, params });
      return true;
    }
    this.missed.push({ method: ctx.method, path: ctx.path });
    ctx.response.writeHead(404, { "content-type": "application/json" });
    ctx.response.end(
      JSON.stringify({
        error: "unregistered_fixture_route",
        method: ctx.method,
        path: ctx.path,
      }),
    );
    return false;
  }

  misses(): Array<{ method: string; path: string }> {
    return this.missed.slice();
  }
}

function matchRoute(pattern: string | RegExp, path: string): Record<string, string> | null {
  if (typeof pattern === "string") {
    return pattern === path ? {} : null;
  }
  const match = pattern.exec(path);
  if (!match) return null;
  const params: Record<string, string> = {};
  if (match.groups) {
    for (const [key, value] of Object.entries(match.groups)) {
      if (value !== undefined) params[key] = decodeURIComponent(value);
    }
  }
  for (let i = 1; i < match.length; i++) {
    if (match[i] !== undefined) {
      params[String(i - 1)] = match[i] as string;
    }
  }
  return params;
}
