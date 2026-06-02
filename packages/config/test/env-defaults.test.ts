import { afterEach, describe, expect, test } from "bun:test";
import { getConfig, resetConfigForTest } from "../src/load.js";

afterEach(resetConfigForTest);

describe("activation-flag defaults (fresh-install replication)", () => {
  test("PENUMBRA_T2_EMBED_RECIPE defaults to title_plus_concise so a fresh install gets the validated recall recipe", () => {
    const config = getConfig({});
    expect(config.env.PENUMBRA_T2_EMBED_RECIPE).toBe("title_plus_concise");
    expect(config.sources.PENUMBRA_T2_EMBED_RECIPE).toBe("default");
  });

  test("an operator override still wins over the default", () => {
    const config = getConfig({ PENUMBRA_T2_EMBED_RECIPE: "body_v1" });
    expect(config.env.PENUMBRA_T2_EMBED_RECIPE).toBe("body_v1");
    expect(config.sources.PENUMBRA_T2_EMBED_RECIPE).toBe("explicit");
  });
});
