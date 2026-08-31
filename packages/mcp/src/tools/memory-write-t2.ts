import { type TextContentEnvelope, toTextContent } from "@novaproto/mcp-shared";
import { nonBlankStringSchema } from "@penumbra/core";
import { z } from "zod";

import type { DaemonClient } from "../daemon-client.js";

export const MemoryWriteT2InputShape = {
  title: z.string().min(1),
  body: z.string().min(1),
  slug: nonBlankStringSchema("slug"),
  hook: nonBlankStringSchema("hook"),
  sub_kind: z.string().optional().nullable(),
  cc_kind: z.string().optional().nullable(),
  why: z.string().optional().nullable(),
  source_quote: z.string().optional().nullable(),
  obs_type: z.string().optional().nullable(),
  durability: z.string().optional().nullable(),
  is_episodic: z.boolean().optional().nullable(),
  project_id: z.string().nullable().optional(),
};

const MemoryWriteT2Schema = z.object(MemoryWriteT2InputShape).strict();

export function memoryWriteT2Handler(daemon: Pick<DaemonClient, "memoryWriteT2">) {
  return async (input: unknown): Promise<TextContentEnvelope> => {
    const parsed = MemoryWriteT2Schema.parse(input);
    return toTextContent(await daemon.memoryWriteT2(parsed));
  };
}
