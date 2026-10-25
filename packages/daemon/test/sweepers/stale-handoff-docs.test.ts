import { expect, test } from "bun:test";

import { STALE_SWEEP_DRAIN_MAX_HOLD_MS } from "@src/services/provider-concurrency.js";

async function readDoc(relativePath: string): Promise<string> {
  return await Bun.file(new URL(relativePath, import.meta.url)).text();
}

test("AGENTS.md documents the stale-sweep liveness switches", async () => {
  const agents = await readDoc("../../../../AGENTS.md");
  const missing = [
    "PENUMBRA_STALE_SWEEP_LIVENESS_CHECK",
    "PENUMBRA_STALE_SWEEP_MAX_ALIVE_GRACE_MS",
  ].filter((name) => !agents.includes(name));
  expect(missing).toEqual([]);
});

test("AGENTS.md says a force-fail leaves the adapter session running and names the drain-hold exits", async () => {
  const agents = await readDoc("../../../../AGENTS.md");
  expect(agents).toContain("does not stop the adapter session");
  expect(agents).toContain("STALE_SWEEP_DRAIN_MAX_HOLD_MS");
  expect(agents).toContain("worker.recovery.drain_released");
  expect(agents).toContain(`${String(STALE_SWEEP_DRAIN_MAX_HOLD_MS / 60_000)} min`);
});

test("architecture.md and concepts.md point at the force-fail and liveness behaviour", async () => {
  const [architecture, concepts] = await Promise.all([
    readDoc("../../../../docs/architecture.md"),
    readDoc("../../../../docs/concepts.md"),
  ]);
  for (const doc of [architecture, concepts]) {
    expect(doc).toContain("does not stop the adapter session");
    expect(doc).toContain("PENUMBRA_STALE_SWEEP_LIVENESS_CHECK");
  }
});
