import { lookupSession } from "./session-registry.js";

export interface InjectRouteDeps {
  token: string;
  injectTimeoutMs?: number;
}

const DEFAULT_INJECT_TIMEOUT_MS = (() => {
  const raw = process.env.PENUMBRA_INJECT_TIMEOUT_MS;
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 30_000;
})();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function workerInjectRoute(
  req: Request,
  handoff_id: string,
  deps: InjectRouteDeps,
): Promise<Response> {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${deps.token}`) {
    return json({ error: "unauthorized" }, 401);
  }

  const raw = await safeJson(req);
  if (
    raw === null ||
    typeof raw !== "object" ||
    raw === null ||
    typeof (raw as Record<string, unknown>).content !== "string"
  ) {
    return json({ error: "invalid_json" }, 400);
  }

  const content = (raw as { content: string }).content.trim();
  if (!content) return json({ error: "validation_error" }, 400);

  const session = lookupSession(handoff_id);
  if (!session) {
    return json({ error: "not_found" }, 404);
  }
  const adapterId = session.adapter ?? "";
  if (!supportsMidSessionInject(adapterId) || typeof session.inject !== "function") {
    return json({ error: "adapter_unsupported" }, 409);
  }

  const timeoutMs = deps.injectTimeoutMs ?? DEFAULT_INJECT_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"__inject_timeout__">((resolve) => {
    timer = setTimeout(() => resolve("__inject_timeout__"), timeoutMs);
  });
  try {
    const injectPromise = Promise.resolve(session.inject({ role: "user", text: content })).then(
      () => "__inject_ok__" as const,
    );
    const result = await Promise.race([injectPromise, timeout]);
    if (result === "__inject_timeout__") {
      return json({ error: "inject_timeout", timeout_ms: timeoutMs }, 504);
    }
    return json({ ok: true });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function safeJson(req: Request): Promise<unknown | null> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

function supportsMidSessionInject(adapterId: string): boolean {
  return (
    adapterId === "stdio-acp" ||
    adapterId === "remote-worker" ||
    adapterId.startsWith("claude-acp") ||
    adapterId.startsWith("codex-acp") ||
    adapterId.startsWith("gemini-acp")
  );
}
