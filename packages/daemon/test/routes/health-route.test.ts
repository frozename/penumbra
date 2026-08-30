import { expect, test } from "bun:test";

import { healthRoute } from "@src/routes/health.js";

test("health route exposes LLM role floor violations", async () => {
  const response = healthRoute({
    llmRoleFloors: {
      ok: false,
      violations: [
        {
          role: "memory-refiner",
          consumer: "t2.promotion",
          requiredHolders: 2,
          actualHolders: 1,
          holderNames: ["solo-refiner"],
        },
      ],
    },
  });

  const body = (await response.json()) as Record<string, unknown>;
  expect(body.llmRoleFloors).toEqual({
    ok: false,
    violations: [
      {
        role: "memory-refiner",
        consumer: "t2.promotion",
        requiredHolders: 2,
        actualHolders: 1,
        holderNames: ["solo-refiner"],
      },
    ],
  });
});
