export type T2EmbedRecipe = "body_v1" | "title_only" | "title_plus_concise";
export const MAX_BODY_CHARS = 4096;
export const T2_CONCISE_BODY_CHARS = 320;

const T2_XML_BLEED_PATTERN =
  /<\/?(?:function_calls|invoke|tool_call|tool_use|antml:[a-z_]+)[\s>]/i;

export type T2BodyValidationResult = { ok: true } | { ok: false; reason: "length" | "xml" };

function resolveRecipe(recipe?: T2EmbedRecipe): T2EmbedRecipe {
  if (recipe) return recipe;
  const envRecipe = process.env.PENUMBRA_T2_EMBED_RECIPE;
  if (envRecipe === "title_only") return "title_only";
  if (envRecipe === "title_plus_concise") return "title_plus_concise";
  return "body_v1";
}

export function buildT2EmbedText(title: string, body: string, recipe?: T2EmbedRecipe): string {
  const resolved = resolveRecipe(recipe);
  if (resolved === "title_only") return title.slice(0, 200);
  // Tuned via live-corpus sweep: +54 weak lift, regression 2, golden 49/50 at 320 chars (<=5 guard with margin).
  if (resolved === "title_plus_concise")
    return `${title.slice(0, 200)}\n${body.slice(0, T2_CONCISE_BODY_CHARS)}`;
  return body;
}

export function validateT2Body(body: string): T2BodyValidationResult {
  if (body.length > MAX_BODY_CHARS) return { ok: false, reason: "length" };
  if (T2_XML_BLEED_PATTERN.test(body)) return { ok: false, reason: "xml" };
  return { ok: true };
}
