The dependency audit requires minimatch 11 and glob 14 for
[GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) and
[GHSA-3g3m-2fjr-6pw4](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4).
ESLint 10 removes the legacy minimatch 3 consumers; the existing `@eslint/js` 9
recommended rules remain unchanged.

Import-x 4.16.2 still imports minimatch's removed `makeRe` API. Its patch uses
`minimatch(path, pattern)` for the existing allow/forbid checks in both module
entrypoints. The compatibility tests exercise the real rule with matching and
nonmatching literals, braces, negation, dotfiles, extglobs, and case distinctions.
Remove the patch when an upstream release supports minimatch 11.
