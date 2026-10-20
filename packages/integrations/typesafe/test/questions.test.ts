import { expect, test } from "bun:test";

import { choice, noul, score } from "../src/questions.js";

test("noul omits criteria unless given, and carries both labels when given", () => {
  const bare = noul("Is it durable?");
  expect(bare).toEqual({ type: "noul", instructions: "Is it durable?" });
  expect("criteria" in bare).toBe(false);

  const described = noul("q", { true: "yes means durable", false: "no means fragile" });
  expect(described).toEqual({
    type: "noul",
    instructions: "q",
    criteria: { true: "yes means durable", false: "no means fragile" },
  });
});

test("choice keeps the criteria map including null descriptions", () => {
  expect(choice("Which team?", { billing: "Payments", technical: null })).toEqual({
    type: "choice",
    instructions: "Which team?",
    criteria: { billing: "Payments", technical: null },
  });
});

test("score keeps an ordered criteria copy that later mutation cannot reach", () => {
  const levels: [string, string, ...string[]] = ["low", "medium", "high"];
  const question = score("How risky?", levels);
  expect(question).toEqual({
    type: "score",
    instructions: "How risky?",
    criteria: ["low", "medium", "high"],
  });
  levels.push("extreme");
  expect(question.criteria).toEqual(["low", "medium", "high"]);
});
