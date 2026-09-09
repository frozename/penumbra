#!/usr/bin/env bash
# Run the devin contention probe tests inside a Linux container (bun 1.3.14, 2 CPUs).
# The probe is timing- and SQLite-locking-sensitive: macOS scheduling hides bound
# violations that the GitHub ubuntu runner exposes. This reproduces that platform
# locally in ~3s. The probe imports only bun:sqlite, bun:test and node stdlib, so no
# install step is needed.
set -uo pipefail
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/fixtures"
# Keep this list closed over the import graph: probe.ts and probe.test.ts both import
# ./devin-contention-probe-evidence.js, which is where every classification predicate
# lives. Omitting it makes the container fail on an unresolved import rather than
# reproducing the timing bug, which is the whole point of this harness.
cp packages/agentchat/scripts/devin-contention-probe.ts \
   packages/agentchat/scripts/devin-contention-probe.test.ts \
   packages/agentchat/scripts/devin-contention-probe-evidence.ts \
   packages/agentchat/scripts/devin-contention-probe-transport.ts "$T"/ || exit 2
cp packages/agentchat/scripts/fixtures/devin-contention-fake.ts "$T/fixtures/" || exit 2
docker run --rm --cpus=2 -v "$T":/w -w /w oven/bun:1.3.14 bun test devin-contention-probe.test.ts
exit $?
