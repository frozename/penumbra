# Third-party notices

The following materials retain their upstream license terms alongside Penumbra's
[MIT license](./LICENSE).

## Superpowers skills

Adapted from [Superpowers v5.1.0](https://github.com/obra/superpowers/tree/f2cbfbefebbfef77321e4c9abc9e949826bea9d7),
revision `f2cbfbefebbfef77321e4c9abc9e949826bea9d7`.
Copyright (c) 2025 Jesse Vincent. The complete upstream MIT notice is retained in
[`plugin/LICENSE.superpowers`](./plugin/LICENSE.superpowers), inside the distributed
plugin.

The adapted material is in these directories, including their supporting files:

- `plugin/skills/brainstorming/`
- `plugin/skills/executing-plans/`
- `plugin/skills/finishing-a-development-branch/`
- `plugin/skills/receiving-code-review/`
- `plugin/skills/requesting-code-review/`
- `plugin/skills/systematic-debugging/`
- `plugin/skills/test-driven-development/`
- `plugin/skills/verification-before-completion/`
- `plugin/skills/writing-plans/`
- `plugin/skills/writing-skills/`

Supporting material includes the brainstorming spec-review prompt and the
systematic-debugging examples, scripts, guides, creation log, and exercises.
Local adaptations add Penumbra dispatch, recall, review, and planning conventions.
Retain the upstream MIT notice when redistributing this material.

## all-MiniLM-L6-v2 embedding model

The bundled embedder uses Qdrant's ONNX export of
[`sentence-transformers/all-MiniLM-L6-v2`](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2),
licensed under Apache License 2.0. The six model files match
[Qdrant revision `cb27c1f221563ca44e58ad2a694965db39c8153d`](https://huggingface.co/Qdrant/all-MiniLM-L6-v2-onnx/tree/cb27c1f221563ca44e58ad2a694965db39c8153d).

- [Complete Apache License 2.0](./licenses/all-MiniLM-L6-v2.LICENSE.txt)
- [Provenance, source revisions, and file hashes](./licenses/all-MiniLM-L6-v2.NOTICE.txt)

The model distribution must include both files as `LICENSE` and `NOTICE` beside
the six model files. The provenance notice identifies Penumbra's repackaging;
the model, tokenizer, vocabulary, and configuration bytes are unchanged.

## Installed dependencies

Dependencies installed through Bun retain their own licenses in their packages.
This document covers the vendored skill material and redistributed embedding
model; it is not a complete dependency license inventory.
