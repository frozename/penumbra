import { type TextContentEnvelope, toTextContent } from "@novaproto/mcp-shared";
import { MemoryVerifyAuthorizeInputShape as CoreMemoryVerifyAuthorizeInputShape } from "@penumbra/core";
import { z } from "zod";

import type { DaemonClient } from "../daemon-client.js";

export const MemoryVerifyAuthorizeInputShape = CoreMemoryVerifyAuthorizeInputShape;

const MemoryVerifyAuthorizeSchema = z.object(MemoryVerifyAuthorizeInputShape).strict();

export function memoryVerifyAuthorizeHandler(daemon: Pick<DaemonClient, "memoryVerifyAuthorize">) {
  return async (input: unknown): Promise<TextContentEnvelope> => {
    const parsed = MemoryVerifyAuthorizeSchema.parse(input);
    return toTextContent(await daemon.memoryVerifyAuthorize(parsed));
  };
}
