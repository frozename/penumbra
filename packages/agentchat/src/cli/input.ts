export type InputEvent = { kind: "message"; text: string } | { kind: "done" };

export interface ParseInputOpts {
  /**
   * 'split' (default) — interactive: blank line separates messages, a bare 'done' line ends input.
   * 'whole' — pipe / non-interactive: every line (including blanks and bare 'done') becomes part of
   * a single message; emits one message + done at EOF. Use when stdin is not a TTY.
   */
  mode?: "split" | "whole";
}

type StringIter = AsyncIterator<string, unknown, undefined>;

function toAsyncIterable(iterator: StringIter): AsyncIterable<string> {
  return {
    [Symbol.asyncIterator]: (): AsyncIterator<string, unknown, undefined> => iterator,
  };
}

export async function* parseInputStream(
  iterator: StringIter,
  opts: ParseInputOpts = {},
): AsyncIterable<InputEvent> {
  if (opts.mode === "whole") {
    yield* parseWholeMode(toAsyncIterable(iterator));
    return;
  }
  yield* parseSplitMode(toAsyncIterable(iterator));
}

async function* parseWholeMode(source: AsyncIterable<string>): AsyncIterable<InputEvent> {
  const lines: string[] = [];
  for await (const raw of source) {
    lines.push(raw.replace(/\r?\n$/, ""));
  }
  if (lines.length > 0) {
    yield { kind: "message", text: lines.join("\n") };
  }
  yield { kind: "done" };
}

async function* parseSplitMode(source: AsyncIterable<string>): AsyncIterable<InputEvent> {
  let buffer: string[] = [];
  for await (const raw of source) {
    const line = raw.trim();
    if (line === "done" && buffer.length === 0) {
      yield { kind: "done" };
      return;
    }
    if (line === "") {
      if (buffer.length > 0) {
        yield { kind: "message", text: buffer.join("\n") };
        buffer = [];
      }
      continue;
    }
    buffer.push(line);
  }
  if (buffer.length > 0) {
    yield { kind: "message", text: buffer.join("\n") };
  }
}
