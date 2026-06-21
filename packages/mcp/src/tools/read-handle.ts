import { type TextContentEnvelope, toTextContent } from "@nova/mcp-shared";
import { z } from "zod";

import type { HandleStore } from "../handle-store.js";

export const ReadHandleInputShape = {
  handle_id: z
    .string()
    .min(1)
    .describe("A handle_id returned in a prior tool call's _meta.handle_id."),
};

export const READ_HANDLE_DESCRIPTION =
  "Retrieve the full content for a handle_id returned by a prior tool call (e.g. an oversized result stored out-of-band). Returns the stored payload verbatim.";

export function readHandleHandler(
  store: HandleStore,
): (input: unknown) => Promise<TextContentEnvelope | (TextContentEnvelope & { isError: true })> {
  return (input): Promise<TextContentEnvelope | (TextContentEnvelope & { isError: true })> => {
    const { handle_id } = (input ?? {}) as { handle_id?: string };
    const content = handle_id !== undefined ? store.get(handle_id) : undefined;
    if (content === undefined) {
      return Promise.resolve({
        ...toTextContent({
          error: {
            code: "handle_not_found",
            message: `Handle not found or expired: ${handle_id ?? "(missing)"}`,
          },
        }),
        isError: true,
      });
    }
    return Promise.resolve({ content: [{ type: "text", text: content }] });
  };
}
