import { describe, expect, test } from "bun:test";

import { getModule, MODULES } from "@src/modules/manifest.js";

describe("module manifest", () => {
  test("keeps mission first for the default route", () => {
    expect(MODULES[0].id).toBe("mission");
  });

  test("uses lowercase ids that match the route segment", () => {
    for (const module of MODULES) {
      const routeId = module.path.slice(1);
      const lowerId = module.id.toLowerCase();
      expect(routeId).toBe(module.id);
      expect(lowerId).toBe(module.id);
    }
  });

  test("returns the mission module by id", () => {
    expect(getModule("mission")).toEqual(MODULES[0]);
  });
});

describe("registrar module", () => {
  test("MODULES includes a registrar entry with available:true", () => {
    const registrar = MODULES.find((module) => module.id === "registrar");
    expect(registrar).toBeDefined();
    expect(registrar?.available).toBe(true);
    expect(registrar?.path).toBe("/registrar");
    expect(registrar?.label).toBe("Plans");
  });
});
