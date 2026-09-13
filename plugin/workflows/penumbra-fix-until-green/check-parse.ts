export type CheckVerdict = { passed: boolean; output: string };

export type CheckParseInput = {
  check_line?: string | null;
  response?: string | null;
  failure_tail?: string | null;
};

export type ResponseMode = "first_line" | "full" | "none";

const OUTPUT_TAIL_MAX = 4000;

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function bashCheckCommand(cmd: string): string {
  return `bash -c ${shellQuote(cmd)}`;
}

type FenceState = { char: string; length: number };

function matchFence(line: string): { indent: string; marker: string } | null {
  const m = /^( {0,3})(`{3,}|~{3,})/.exec(line);
  if (!m) return null;
  const [indent, marker] = [m[1], m[2]];
  if (indent === undefined || marker === undefined) return null;
  return { indent, marker };
}

export function stripFencedBlocks(text: string): string {
  const visibleLines: string[] = [];
  let fence: FenceState | null = null;

  for (const line of text.split("\n")) {
    const fenceLine = matchFence(line);
    if (!fence) {
      if (fenceLine) {
        fence = { char: fenceLine.marker[0] ?? "", length: fenceLine.marker.length };
        continue;
      }
      visibleLines.push(line);
      continue;
    }

    if (fenceLine) {
      const marker = fenceLine.marker;
      const closesFence =
        (marker[0] ?? "") === fence.char &&
        marker.length >= fence.length &&
        line.slice(fenceLine.indent.length + marker.length).trim().length === 0;
      if (closesFence) {
        fence = null;
      }
    }
  }

  return visibleLines.join("\n");
}

function scanForMarker(text: string): { sawPass: boolean; sawFail: boolean } {
  let sawPass = false;
  let sawFail = false;
  for (const line of stripFencedBlocks(text).split("\n")) {
    const marker = /^ {0,3}CHECK_RESULT:\s*(PASS|FAIL)\b/i.exec(line);
    if (marker?.[1] === undefined) continue;
    const value = marker[1].toUpperCase();
    if (value === "FAIL") sawFail = true;
    if (value === "PASS") sawPass = true;
  }
  return { sawPass, sawFail };
}

function firstLineOf(text: string | null | undefined): string {
  if (text === null || text === undefined) return "";
  return text;
}

function tailOf(text: string, max: number): string {
  return text.length > max ? text.slice(-max) : text;
}

function scanCheckLine(checkLine: string): { sawPass: boolean; sawFail: boolean } {
  return scanForMarker(checkLine);
}

function tryFullResponseScan(
  result: CheckParseInput,
): { sawPass: boolean; sawFail: boolean } | null {
  if (typeof result.response !== "string") return null;
  const fullScan = scanForMarker(result.response);
  if (!fullScan.sawFail && fullScan.sawPass) return fullScan;
  return null;
}

function failureOutput(result: CheckParseInput): string {
  const tail = result.failure_tail ?? result.response ?? result.check_line ?? "";
  return tailOf(tail, OUTPUT_TAIL_MAX);
}

function selectText(result: CheckParseInput, useFirstLine: boolean, hasResponse: boolean): string {
  if (useFirstLine) return firstLineOf(result.check_line);
  if (hasResponse) return firstLineOf(result.response);
  return firstLineOf(result.check_line);
}

function scanText(
  text: string,
  useFirstLine: boolean,
  checkLine: string | null | undefined,
): { sawPass: boolean; sawFail: boolean } {
  if (useFirstLine) return scanCheckLine(checkLine ?? "");
  return scanForMarker(text);
}

export function parseCheck(
  result: CheckParseInput | null,
  responseMode: ResponseMode = "first_line",
): CheckVerdict {
  if (!result) return { passed: false, output: "" };

  const hasCheckLine = typeof result.check_line === "string";
  const hasResponse = typeof result.response === "string";
  const useFirstLine = responseMode === "first_line" && hasCheckLine;

  const text = selectText(result, useFirstLine, hasResponse);
  const { sawPass, sawFail } = scanText(text, useFirstLine, result.check_line);

  if (!sawFail && sawPass) return { passed: true, output: "" };

  if (useFirstLine && !sawFail && !sawPass && hasResponse) {
    const fullScan = tryFullResponseScan(result);
    if (fullScan) return { passed: true, output: "" };
  }

  if (useFirstLine) {
    return { passed: false, output: failureOutput(result) };
  }
  return { passed: false, output: tailOf(text, OUTPUT_TAIL_MAX) };
}

export function roundMessage(
  roundIndex: number,
  taskMessage: string,
  check: string,
  prevBranch: string | null,
  prevOutput: string | null,
): string {
  const prevNote = prevOutput ?? "(none captured)";
  const branchLabel = prevBranch ?? "(unknown)";
  const head =
    roundIndex === 0
      ? taskMessage
      : `A previous attempt (branch ${branchLabel}) still fails the check. Build on that branch and fix it.\n\nOriginal task:\n${taskMessage}\n\nLast failure output:\n${prevNote}`;
  return [
    head,
    "",
    "When done, run this check in the repo by spawning bash with the command as a single argument:",
    `    ${bashCheckCommand(check)}`,
    "If it fails, fix and re-run until it passes or you cannot make further progress. Commit your work on the worktree branch.",
    "IMPORTANT: BEGIN your FINAL message with a line that is exactly `CHECK_RESULT: PASS` or `CHECK_RESULT: FAIL`. If FAIL, follow it with the last ~50 lines of the check output inside a fenced ``` block.",
  ].join("\n");
}

export function validateCheckCommand(check: string, allowPartialCheck: boolean): string | null {
  if (allowPartialCheck) return null;
  const missing: string[] = [];
  if (!/lint:strict\b/.test(check)) missing.push("lint:strict");
  if (!/check-typecheck-coverage\.ts\b/.test(check)) missing.push("check-typecheck-coverage.ts");
  if (missing.length === 0) return null;
  return `check must include ${missing.join(" and ")} (or set allow_partial_check: true)`;
}
