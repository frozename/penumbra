import { randomBytes } from "node:crypto";

export interface BuildFramedCommandInput {
  commandId: string;
  userCommand: string;
  stdin?: string;
  randomSuffix?: () => string;
}

export interface BuildFramedCommandResult {
  snippet: string;
  startMarker: string;
  endMarker: string;
}

const MAX_MARKER_ATTEMPTS = 8;

function defaultRandomSuffix(): string {
  return randomBytes(8).toString("hex");
}

function stdinContainsMarkerLine(stdin: string, marker: string): boolean {
  // A heredoc closes when a line equals the delimiter exactly. Split by \n so
  // any interior or trailing line matching the marker is detected.
  return stdin.split("\n").includes(marker);
}

export function buildFramedCommand(input: BuildFramedCommandInput): BuildFramedCommandResult {
  const startMarker = `__PEN_START_${input.commandId}__`;
  const endMarker = `__PEN_END_${input.commandId}__`;
  let stdinMarker = `__PEN_STDIN_${input.commandId}__`;

  const commandLines = [`echo "${startMarker}"`, `{ ${input.userCommand}; } 2>&3`];

  if (input.stdin !== undefined) {
    if (stdinContainsMarkerLine(input.stdin, stdinMarker)) {
      const randomSuffix = input.randomSuffix ?? defaultRandomSuffix;
      let attempts = 0;
      let candidate = stdinMarker;
      while (stdinContainsMarkerLine(input.stdin, candidate)) {
        if (attempts >= MAX_MARKER_ATTEMPTS) {
          throw new Error(
            `shell-framing: unable to derive collision-free stdin marker after ${String(MAX_MARKER_ATTEMPTS)} attempts`,
          );
        }
        candidate = `__PEN_STDIN_${input.commandId}_${randomSuffix()}__`;
        attempts += 1;
      }
      stdinMarker = candidate;
    }
    // Quoted delimiter (`<<'MARKER'`) prevents parameter, command, and
    // arithmetic expansion in the heredoc body — stdin is delivered byte-literal.
    commandLines[1] = `${commandLines[1] ?? ""} <<'${stdinMarker}'\n${input.stdin}${input.stdin.endsWith("\n") ? "" : "\n"}${stdinMarker}`;
  }

  commandLines.push(`echo "${endMarker} exit:$?"`);

  return {
    snippet: commandLines.join("\n"),
    startMarker,
    endMarker,
  };
}

export interface ParseFramedOutputInput {
  stdout: string;
  stderr: string;
  startMarker: string;
  endMarker: string;
}

export interface ParseFramedOutputResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  complete: boolean;
}

export function parseFramedOutput(input: ParseFramedOutputInput): ParseFramedOutputResult {
  const startIdx = input.stdout.indexOf(input.startMarker);
  if (startIdx === -1) {
    return {
      stdout: "",
      stderr: input.stderr,
      exitCode: -1,
      complete: false,
    };
  }

  let framedOutput = input.stdout.slice(startIdx + input.startMarker.length);
  if (framedOutput.startsWith("\r\n")) {
    framedOutput = framedOutput.slice(2);
  } else if (framedOutput.startsWith("\n")) {
    framedOutput = framedOutput.slice(1);
  }

  const endIdx = framedOutput.indexOf(input.endMarker);
  if (endIdx === -1) {
    return {
      stdout: framedOutput,
      stderr: input.stderr,
      exitCode: -1,
      complete: false,
    };
  }

  const stdout = framedOutput.slice(0, endIdx);
  const tail = framedOutput.slice(endIdx + input.endMarker.length);
  const exitMatch = /exit:(-?\d+)/.exec(tail);

  return {
    stdout,
    stderr: input.stderr,
    exitCode: exitMatch ? Number.parseInt(exitMatch[1] ?? "-1", 10) : -1,
    complete: true,
  };
}
