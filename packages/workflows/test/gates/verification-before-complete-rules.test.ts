import { expect, test } from "bun:test";

import { verifyVerificationBeforeComplete } from "@src/gates/verification-before-complete.js";

test("does not treat completion words inside longer words as a claim", () => {
  const r = verifyVerificationBeforeComplete({ text: "Checking completeness and the donor list." });
  expect(r.passed).toBe(true);
  expect(r.evidence).toBe("no completion claim made");
});

test("fails a claim with evidence when the text also hedges", () => {
  const r = verifyVerificationBeforeComplete({
    text: "I ran the suite and saw it pass, so it should be fixed.",
  });
  expect(r.passed).toBe(false);
  expect(r.evidence).toBe(
    'completion claimed but should; gate requires explicit "ran X and saw Y" evidence',
  );
});

test("flags the leftmost hedge in the text, not the first hedge in the pattern list", () => {
  const r = verifyVerificationBeforeComplete({
    text: "Done, I tested it; it might hold and should stay.",
  });
  expect(r.evidence).toBe(
    'completion claimed but might; gate requires explicit "ran X and saw Y" evidence',
  );
});

test("keeps the original casing of the flagged hedge word", () => {
  const r = verifyVerificationBeforeComplete({ text: "Maybe done. Ran tests." });
  expect(r.evidence).toBe(
    'completion claimed but Maybe; gate requires explicit "ran X and saw Y" evidence',
  );
});

test("reports run-and-saw evidence for an unhedged claim with evidence", () => {
  const r = verifyVerificationBeforeComplete({ text: "Tested locally; landed." });
  expect(r.passed).toBe(true);
  expect(r.evidence).toBe("completion claim accompanied by run-and-saw evidence");
});
