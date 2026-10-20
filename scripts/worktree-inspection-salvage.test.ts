import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("dispatcher salvage requires branch_log content as evidence of commits ahead", () => {
  const protocol = readFileSync(
    new URL("../plugin/agents/penumbra-dispatcher.md", import.meta.url),
    "utf8",
  );
  const salvage = protocol.split("4. SALVAGE")[1]?.split("5. Response handling")[0];
  expect(salvage).toBeDefined();
  expect(salvage?.replaceAll(/\s+/g, " ")).toContain("(`branch_log` is non-empty)");
  expect(salvage).not.toContain("or `diff_against_main`");
});
