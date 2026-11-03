import { expect, test } from "bun:test";

type JsonObject = Record<string, unknown>;

interface SchemaLike {
  safeParse: (value: unknown) => { success: boolean };
}

interface CanonicalModule {
  CanonicalJsonError: new (message: string) => Error;
  canonicalJson: (value: unknown) => string;
  handoffRefDigest: (handoffId: string) => string;
  recipeHash: (recipe: JsonObject) => string;
  sha256Hex: (value: string) => string;
  taskDigest: (text: string) => string;
}

// The evals modules do not exist yet. Keeping the specifier non-literal
// leaves the import unresolved for tsc (no TS2307), and `.catch` keeps a
// missing module a failed assertion, never a load error.
const EVALS_MODULE = ["@src", "evals", "canonical.js"].join("/");
const EVALS_PKG_CANONICAL = ["@penumbra/core", "evals", "canonical"].join("/");
const EVALS_PKG_FIXTURE = ["@penumbra/core", "evals", "fixture"].join("/");
const EVALS_PKG_MANIFEST = ["@penumbra/core", "evals", "manifest"].join("/");

test("case 23: canonicalJson sorts object keys recursively, preserves array order", async () => {
  const mod = (await import(EVALS_MODULE).catch(() => null)) as unknown as CanonicalModule | null;
  expect(mod).not.toBeNull();
  if (!mod) return;
  expect(mod.canonicalJson({ b: 1, a: { d: 1, c: 2 }, l: [2, 1] })).toBe(
    '{"a":{"c":2,"d":1},"b":1,"l":[2,1]}',
  );
});

test("case 24: canonicalJson throws CanonicalJsonError on non-JSON values", async () => {
  const mod = (await import(EVALS_MODULE).catch(() => null)) as unknown as CanonicalModule | null;
  expect(mod).not.toBeNull();
  if (!mod) return;
  const badInputs: unknown[] = [
    { a: undefined },
    Number.NaN,
    Number.POSITIVE_INFINITY,
    (): number => 1,
    1n,
  ];
  for (const bad of badInputs) {
    let err: unknown;
    try {
      mod.canonicalJson(bad);
    } catch (e) {
      err = e;
    }
    expect(err instanceof mod.CanonicalJsonError).toBe(true);
  }
});

test("case 25: sha256Hex is raw SHA-256; recipeHash ignores recipe_id and notes", async () => {
  const mod = (await import(EVALS_MODULE).catch(() => null)) as unknown as CanonicalModule | null;
  expect(mod).not.toBeNull();
  if (!mod) return;
  expect(mod.sha256Hex("")).toBe(
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  const recipe: JsonObject = {
    recipe_id: "r1",
    status: "ready",
    blocked_on: null,
    notes: null,
    arms: ["minimal"],
    limits: { max_rounds: 2 },
  };
  const reordered: JsonObject = {
    limits: { max_rounds: 2 },
    arms: ["minimal"],
    notes: null,
    blocked_on: null,
    status: "ready",
    recipe_id: "r1",
  };
  expect(mod.recipeHash(recipe)).toBe(mod.recipeHash(reordered));
  expect(mod.recipeHash({ ...recipe, recipe_id: "r2" })).toBe(mod.recipeHash(recipe));
  expect(mod.recipeHash({ ...recipe, notes: "changed" })).toBe(mod.recipeHash(recipe));
  expect(mod.recipeHash({ ...recipe, limits: { max_rounds: 3 } })).not.toBe(mod.recipeHash(recipe));
});

test("case 26: taskDigest normalizes CRLF/unicode; handoffRefDigest prefixes", async () => {
  const mod = (await import(EVALS_MODULE).catch(() => null)) as unknown as CanonicalModule | null;
  expect(mod).not.toBeNull();
  if (!mod) return;
  expect(mod.taskDigest("a \r\nb\r\n\r\n")).toBe(mod.taskDigest("a\nb"));
  expect(mod.taskDigest("\u00e9")).toBe(mod.taskDigest("e\u0301"));
  expect(mod.taskDigest("fix a")).not.toBe(mod.taskDigest("fix b"));
  expect(mod.handoffRefDigest("h1")).toBe(mod.sha256Hex("handoff:h1"));
});

test("case 27: ./evals/* package subpath exports resolve and expose the schemas", async () => {
  const manifest = (await import(EVALS_PKG_MANIFEST).catch(() => null)) as unknown as {
    EpisodeSchema: SchemaLike;
  } | null;
  const fixture = (await import(EVALS_PKG_FIXTURE).catch(() => null)) as unknown as {
    FixturePublicSchema: SchemaLike;
  } | null;
  const canonical = (await import(EVALS_PKG_CANONICAL).catch(
    () => null,
  )) as unknown as CanonicalModule | null;
  expect(manifest).not.toBeNull();
  expect(fixture).not.toBeNull();
  expect(canonical).not.toBeNull();
  if (!manifest || !fixture || !canonical) return;
  expect(manifest.EpisodeSchema).toBeDefined();
  expect(fixture.FixturePublicSchema).toBeDefined();
  expect(canonical.canonicalJson).toBeDefined();
});
