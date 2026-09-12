import type { Services } from "@penumbra/core";

import { ChainMessagesTailOptionsSchema } from "@penumbra/api-contract";

import { json } from "./_helpers.js";

const LIMIT_TAIL_RE = /^[1-9][0-9]*$/;

function missingConversationError(): Response {
  return json(
    { error: { code: "missing_param", message: "conversation_id query parameter is required" } },
    400,
  );
}

function invalidTailOptions(): Response {
  return json(
    { error: { code: "validation_error", message: "Invalid transcript tail options" } },
    400,
  );
}

function parseTailLimit(rawLimit: string | null): number | undefined {
  if (rawLimit === null) return undefined;
  if (!LIMIT_TAIL_RE.test(rawLimit)) return undefined;
  return Number(rawLimit);
}

function parseTypesParam(url: URL): string[] | undefined {
  const typesParam = url.searchParams.get("types");
  if (typesParam === null) return undefined;
  const types = typesParam
    .split(",")
    .map((type) => type.trim())
    .filter((type) => type.length > 0);
  return types.length > 0 ? types : undefined;
}

function parseTailMode(url: URL):
  | {
      kind: "tail";
      limit: number;
      offset?: 0;
      before_ts?: string;
    }
  | Response {
  const rawLimit = url.searchParams.get("limit");
  if (rawLimit !== null && !LIMIT_TAIL_RE.test(rawLimit)) return invalidTailOptions();
  const rawOffset = url.searchParams.get("offset");
  if (rawOffset !== null && rawOffset !== "0") return invalidTailOptions();
  const parsedTail = ChainMessagesTailOptionsSchema.safeParse({
    tail: true,
    limit: parseTailLimit(rawLimit),
    offset: rawOffset === "0" ? 0 : undefined,
    before_ts: url.searchParams.get("before_ts") ?? undefined,
  });
  if (!parsedTail.success) return invalidTailOptions();

  return {
    kind: "tail",
    limit: parsedTail.data.limit,
    offset: parsedTail.data.offset,
    before_ts:
      parsedTail.data.before_ts !== undefined && parsedTail.data.before_ts.length > 0
        ? parsedTail.data.before_ts
        : undefined,
  };
}

function parseLegacyMode(url: URL): {
  limit?: number;
  offset?: number;
  before_ts?: string;
} {
  const limitParam = url.searchParams.get("limit");
  const offsetParam = url.searchParams.get("offset");
  const beforeTsParam = url.searchParams.get("before_ts");
  const parsedLimit = limitParam !== null ? Number.parseInt(limitParam, 10) : undefined;
  const parsedOffset = offsetParam !== null ? Number.parseInt(offsetParam, 10) : undefined;

  return {
    limit:
      parsedLimit !== undefined && Number.isFinite(parsedLimit) && parsedLimit > 0
        ? parsedLimit
        : undefined,
    offset:
      parsedOffset !== undefined && Number.isFinite(parsedOffset) && parsedOffset >= 0
        ? parsedOffset
        : undefined,
    before_ts: beforeTsParam !== null && beforeTsParam.length > 0 ? beforeTsParam : undefined,
  };
}

export function chainsMessagesRoute(req: Request, services: Services): Response {
  const url = new URL(req.url);
  const conversation_id = url.searchParams.get("conversation_id");
  if (!conversation_id) {
    return missingConversationError();
  }

  const types = parseTypesParam(url);

  const tailParam = url.searchParams.get("tail");
  if (tailParam === "true") {
    const parsedTail = parseTailMode(url);
    if (parsedTail instanceof Response) {
      return parsedTail;
    }

    const events = services.chainReader.getMessages(conversation_id, types, {
      tail: true,
      limit: parsedTail.limit,
      offset: parsedTail.offset,
      before_ts: parsedTail.before_ts,
    });
    return json({ events });
  }

  if (tailParam !== null && tailParam !== "false") {
    return invalidTailOptions();
  }

  const parsedLegacy = parseLegacyMode(url);

  const events = services.chainReader.getMessages(conversation_id, types, {
    limit: parsedLegacy.limit,
    offset: parsedLegacy.offset,
    before_ts: parsedLegacy.before_ts,
    tail: tailParam === "false" ? false : undefined,
  });
  return json({ events });
}
