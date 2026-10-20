import { expect, test } from "bun:test";

async function agentsDoc(): Promise<string> {
  return await Bun.file(new URL("../AGENTS.md", import.meta.url)).text();
}

test("AGENTS.md documents bun run check:ci as the command that mirrors CI", async () => {
  const doc = await agentsDoc();
  expect(doc).toContain("bun run check:ci");
});

test("AGENTS.md tells penumbra fix-until-green lanes to pass the parity check", async () => {
  const doc = await agentsDoc();
  expect(doc).toContain('parityCheck: "bun run check:ci"');
});

test("AGENTS.md notes that host-only tests are excluded from the parity verdict", async () => {
  const doc = await agentsDoc();
  expect(doc).toMatch(/host-only/i);
  expect(doc).toMatch(/parity/i);
});
