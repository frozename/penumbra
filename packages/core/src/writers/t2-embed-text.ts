export type T2EmbedRecipe = "body_v1" | "title_only" | "title_plus_concise";

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
  if (resolved === "title_plus_concise") return `${title.slice(0, 200)}\n${body.slice(0, 256)}`;
  return body;
}
