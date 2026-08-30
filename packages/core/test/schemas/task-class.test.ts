import { describe, expect, it } from "bun:test";

import { TaskClassSchema } from "@src/schemas/task-class.js";

describe("task class schema", () => {
  it("accepts boundary", () => {
    expect(TaskClassSchema.parse("BOUNDARY")).toBe("BOUNDARY");
  });

  it("accepts standard", () => {
    expect(TaskClassSchema.parse("STANDARD")).toBe("STANDARD");
  });

  it("accepts trivial", () => {
    expect(TaskClassSchema.parse("TRIVIAL")).toBe("TRIVIAL");
  });

  it("rejects unknown variants", () => {
    expect(() => TaskClassSchema.parse("NOT_A_CLASS")).toThrow();
  });

  it("narrows the inferred type", () => {
    const taskClass: import("@src/schemas/task-class.js").TaskClass = "STANDARD";
    expect(taskClass).toBe("STANDARD");
  });
});
