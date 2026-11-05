// The capsule module's seam to the #391 eval primitives (deep imports are barred by no-restricted-imports).
export { digestOf } from "../evals/canonical.js";
export { GitShaSchema, RelPathSchema, Sha256HexSchema } from "../evals/manifest.js";
