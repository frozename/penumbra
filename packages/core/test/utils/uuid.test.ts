import { expect, test } from "bun:test";

import { systemUuid, type Uuid } from "../../src/utils/uuid.js";

test("systemUuid returns a v4-shaped string", () => {
  const id = systemUuid();
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("Uuid type is a zero-arg function returning string", () => {
  const counter = ((): Uuid => {
    let n = 0;
    return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  })();
  expect(counter()).toBe("00000000-0000-4000-8000-000000000001");
  expect(counter()).toBe("00000000-0000-4000-8000-000000000002");
});
