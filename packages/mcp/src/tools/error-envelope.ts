import { type TextContentEnvelope, toTextContent } from "@novaproto/mcp-shared";

export function errorEnvelope(
  tool: string,
  code: string,
  message: string,
): TextContentEnvelope & { isError: true } {
  return {
    ...toTextContent({
      error: {
        code,
        message: `${tool}: ${message}`,
      },
    }),
    isError: true,
  };
}
