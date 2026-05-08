import { describe, expect, test } from "bun:test";
import { MODULES, getModule } from "../../src/modules/manifest";

describe("module manifest", () => {
  test("keeps mission first for the default route", () => {
    expect(MODULES[0].id).toBe("mission");
  });

  test("uses lowercase ids that match the route segment", () => {
    for (const module of MODULES) {
      const routeId = module.path.slice(1) as typeof module.id;
      const lowerId = module.id.toLowerCase() as typeof module.id;
      expect(module.id).toBe(routeId);
      expect(module.id).toBe(lowerId);
    }
  });

  test("returns the mission module by id", () => {
    expect(getModule("mission")).toEqual(MODULES[0]);
  });
});
