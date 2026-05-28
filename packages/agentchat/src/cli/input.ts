export type InputEvent = { kind: "message"; text: string } | { kind: "done" };

export interface ParseInputOpts {
  /**
   * 'split' (default) — interactive: blank line separates messages, a bare 'done' line ends input.
   * 'whole' — pipe / non-interactive: every line (including blanks and bare 'done') becomes part of
   * a single message; emits one message + done at EOF. Use when stdin is not a TTY.
   */
  mode?: "split" | "whole";
}

export async function* parseInputStream(
  iterator: AsyncIterator<string>,
  opts: ParseInputOpts = {},
): AsyncIterable<InputEvent> {
  if (opts.mode === "whole") {
    const lines: string[] = [];
    while (true) {
      const { value, done } = await iterator.next();
      if (done) break;
      lines.push((value as string).replace(/\r?\n$/, ""));
    }
    if (lines.length > 0) {
      yield { kind: "message", text: lines.join("\n") };
    }
    yield { kind: "done" };
    return;
  }

  let buffer: string[] = [];
  while (true) {
    const { value, done } = await iterator.next();
    if (done) break;
    const raw = value as string;
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
