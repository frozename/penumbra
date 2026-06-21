import { expect, mock, test } from "bun:test";

import {
  refineDispatchPrompt,
  RefineError,
  REFINER_INPUT_MAX_BYTES,
  REFINER_OUTPUT_MAX_BYTES,
} from "../../src/services/dispatch-prompt-refiner.js";

// Capture the rejection from a promise so assertions can run against the
// caught error. Sidesteps the bun-types type gap where `.rejects.X()` is
// declared `void` but returns a Promise at runtime.
const catchRejection = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected promise to reject");
};

test("refineDispatchPrompt happy path returns trimmed output", async () => {
  const chat = mock(() => Promise.resolve("  Reshaped prompt.  \n"));
  const refined = await refineDispatchPrompt({
    message: "# Spike\n\nDo X.",
    chat,
    model: "gpt-4o",
  });
  expect(refined).toBe("Reshaped prompt.");
  expect(chat).toHaveBeenCalledTimes(1);
});

test("refineDispatchPrompt rejects input larger than REFINER_INPUT_MAX_BYTES", async () => {
  const chat = mock(() => Promise.resolve("unused"));
  const big = "a".repeat(REFINER_INPUT_MAX_BYTES + 1);
  const err1 = await catchRejection(refineDispatchPrompt({ message: big, chat, model: "gpt-4o" }));
  expect(err1).toBeInstanceOf(RefineError);
  const err2 = await catchRejection(refineDispatchPrompt({ message: big, chat, model: "gpt-4o" }));
  expect(err2).toMatchObject({ code: "input_too_large" });
  expect(chat).not.toHaveBeenCalled();
});

test("refineDispatchPrompt rejects blank input", async () => {
  const chat = mock(() => Promise.resolve("unused"));
  const err = await catchRejection(
    refineDispatchPrompt({ message: "   \n\t  ", chat, model: "gpt-4o" }),
  );
  expect(err).toMatchObject({ code: "input_blank" });
  expect(chat).not.toHaveBeenCalled();
});

test("refineDispatchPrompt rejects empty refined output", async () => {
  const chat = mock(() => Promise.resolve("   \n  "));
  const err = await catchRejection(
    refineDispatchPrompt({ message: "real input", chat, model: "gpt-4o" }),
  );
  expect(err).toMatchObject({ code: "output_empty" });
});

test("refineDispatchPrompt rejects oversize refined output", async () => {
  const chat = mock(() => Promise.resolve("a".repeat(REFINER_OUTPUT_MAX_BYTES + 1)));
  const err = await catchRejection(
    refineDispatchPrompt({ message: "real input", chat, model: "gpt-4o" }),
  );
  expect(err).toMatchObject({ code: "output_too_large" });
});

test("refineDispatchPrompt wraps upstream errors with upstream_failed code", async () => {
  const chat = mock(() => Promise.reject(new Error("sirius down")));
  const err = await catchRejection(
    refineDispatchPrompt({ message: "real input", chat, model: "gpt-4o" }),
  );
  expect(err).toMatchObject({
    code: "upstream_failed",
    message: "sirius down",
  });
});

test("refineDispatchPrompt passes system + user roles to chat fn", async () => {
  let captured: { role: string; content: string }[] | null = null;
  const chat = mock((opts: { messages: { role: string; content: string }[] }) => {
    captured = opts.messages;
    return Promise.resolve("ok");
  });
  await refineDispatchPrompt({ message: "real input", chat, model: "haiku-test" });
  expect(captured).not.toBeNull();
  expect(captured!.length).toBe(2);
  expect(captured![0].role).toBe("system");
  expect(captured![1]).toEqual({ role: "user", content: "real input" });
});
