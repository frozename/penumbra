import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(".claude/workflows/penumbra-fix-until-green.js"), "utf8");
const match = source.match(/\/\/ rubric-match:begin\n([\s\S]*?)\/\/ rubric-match:end/);
expect(match, "rubric matcher markers should exist").not.toBeNull();

const matchRubricGrade = new Function(`${match![1]}\nreturn matchRubricGrade`)();

test("matches exact rubric criterion text", () => {
  const rubric = ["Keep meta export first", "Do not import modules"];
  const grade = {
    criteria: [
      { criterion: "Keep meta export first", pass: true, evidence: "line 1" },
      { criterion: "Do not import modules", pass: true, evidence: "no imports" },
    ],
  };

  expect(matchRubricGrade(rubric, grade)).toEqual({
    results: [
      { index: 1, criterion: rubric[0], pass: true, evidence: "line 1" },
      { index: 2, criterion: rubric[1], pass: true, evidence: "no imports" },
    ],
    missing: [],
    extra: [],
  });
});

test("matches rubric criterion text with a numbered prefix", () => {
  const rubric = ["Keep meta export first"];
  const grade = {
    criteria: [{ criterion: "1. Keep meta export first.", pass: true, evidence: "line 1" }],
  };

  expect(matchRubricGrade(rubric, grade)).toEqual({
    results: [{ index: 1, criterion: rubric[0], pass: true, evidence: "line 1" }],
    missing: [],
    extra: [],
  });
});

test("uses index for paraphrased criterion text", () => {
  const rubric = ["Do not use Date.now() or Math.random()"];
  const grade = {
    criteria: [
      {
        index: 1,
        criterion: "No nondeterministic time or random APIs",
        pass: true,
        evidence: "none found",
      },
    ],
  };

  expect(matchRubricGrade(rubric, grade)).toEqual({
    results: [{ index: 1, criterion: rubric[0], pass: true, evidence: "none found" }],
    missing: [],
    extra: [],
  });
});

test("reports missing criteria", () => {
  const rubric = ["Keep meta export first", "Do not import modules"];
  const grade = {
    criteria: [{ index: 1, criterion: "Keep meta export first", pass: true, evidence: "line 1" }],
  };

  expect(matchRubricGrade(rubric, grade)).toEqual({
    results: [
      { index: 1, criterion: rubric[0], pass: true, evidence: "line 1" },
      { index: 2, criterion: rubric[1], pass: false, evidence: "" },
    ],
    missing: ["Do not import modules"],
    extra: [],
  });
});

test("combines duplicate items for one criterion and fails if any item fails", () => {
  const rubric = ["Keep meta export first"];
  const grade = {
    criteria: [
      { index: 1, criterion: "Keep meta export first", pass: true, evidence: "line 1" },
      {
        index: 1,
        criterion: "Keep meta export first",
        pass: false,
        evidence: "comment before export",
      },
    ],
  };

  expect(matchRubricGrade(rubric, grade)).toEqual({
    results: [
      { index: 1, criterion: rubric[0], pass: false, evidence: "line 1; comment before export" },
    ],
    missing: [],
    extra: [{ criterion: "Keep meta export first", reason: "duplicate" }],
  });
});

test("reports unmatched stray grader items as extra", () => {
  const rubric = ["Keep meta export first"];
  const grade = {
    criteria: [
      { index: 1, criterion: "Keep meta export first", pass: true, evidence: "line 1" },
      { criterion: "Unrelated style concern", pass: false, evidence: "stray" },
    ],
  };

  expect(matchRubricGrade(rubric, grade)).toEqual({
    results: [{ index: 1, criterion: rubric[0], pass: true, evidence: "line 1" }],
    missing: [],
    extra: [{ criterion: "Unrelated style concern", reason: "unknown" }],
  });
});

test("falls back to text matching when index is out of range", () => {
  const rubric = ["Do not import modules"];
  const grade = {
    criteria: [
      { index: 99, criterion: "1) Do not import modules.", pass: true, evidence: "no imports" },
    ],
  };

  expect(matchRubricGrade(rubric, grade)).toEqual({
    results: [{ index: 1, criterion: rubric[0], pass: true, evidence: "no imports" }],
    missing: [],
    extra: [],
  });

  const containmentGrade = {
    criteria: [{ index: 99, criterion: "import modules", pass: false, evidence: "found import" }],
  };

  expect(matchRubricGrade(rubric, containmentGrade)).toEqual({
    results: [{ index: 1, criterion: rubric[0], pass: false, evidence: "found import" }],
    missing: [],
    extra: [],
  });
});
