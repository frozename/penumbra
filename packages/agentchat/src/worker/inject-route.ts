import { lookupSession } from "./session-registry.js";

export interface InjectRouteDeps {
  token: string;
}

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

  await session.inject({ role: "user", text: content });
  return json({ ok: true });
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
