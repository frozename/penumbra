# Superpowers fork smoke — 2026-05-14

Verdict: PASS

## Skill presence

| Skill | Lines | Frontmatter | Verdict |
| --- | ---: | ---: | --- |
| brainstorming | 202 | 1 | PASS |
| writing-plans | 247 | 1 | PASS |
| test-driven-development | 423 | 1 | PASS |
| verification-before-completion | 139 | 1 | PASS |
| systematic-debugging | 296 | 1 | PASS |
| receiving-code-review | 223 | 1 | PASS |
| requesting-code-review | 114 | 1 | PASS |
| writing-skills | 666 | 1 | PASS |
| executing-plans | 84 | 1 | PASS |
| finishing-a-development-branch | 212 | 1 | PASS |

## Variance gate

`brainstorming` contains 5 matches for `HARD GATE` or `Measurement classification`, which clears the required threshold of at least 2. `writing-plans` contains 3 matches for `Measurement gate` or `variance`, which clears the required threshold of at least 1.

## Penumbra integration sections

The five adopted skills that should include a `Penumbra integration` section each have exactly one match:

- `receiving-code-review`: 1
- `requesting-code-review`: 1
- `writing-skills`: 1
- `executing-plans`: 1
- `finishing-a-development-branch`: 1

The two verbatim adoptions correctly have no `Penumbra integration` section:

- `verification-before-completion`: 0
- `systematic-debugging`: 0

## TDD inline anti-patterns

`test-driven-development` contains 3 matches across `mock behavior`, `test-only methods`, or `without understanding`, which satisfies the expected coverage. It contains 0 references to `@testing-anti-patterns`, which matches the requirement.

## Issues found

None.

## Conclusion

The 10 ported skills are present, structurally sane, and match the expected content gates for the smoke check. The adopted skills have the expected integration sections, the verbatim copies remain unchanged in that respect, and the TDD skill preserves the inline anti-pattern guidance without reintroducing the banned reference.
