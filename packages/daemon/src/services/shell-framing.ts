export interface BuildFramedCommandInput {
  commandId: string;
  userCommand: string;
  stdin?: string;
}

export interface BuildFramedCommandResult {
  snippet: string;
  startMarker: string;
  endMarker: string;
}

export function buildFramedCommand(input: BuildFramedCommandInput): BuildFramedCommandResult {
  const startMarker = `__PEN_START_${input.commandId}__`;
  const endMarker = `__PEN_END_${input.commandId}__`;
  const stdinMarker = `__PEN_STDIN_${input.commandId}__`;

  const commandLines = [`echo "${startMarker}"`, `{ ${input.userCommand}; } 2>&3`];

  if (input.stdin !== undefined) {
    commandLines[1] = `${commandLines[1] ?? ""} <<${stdinMarker}\n${input.stdin}${input.stdin.endsWith("\n") ? "" : "\n"}${stdinMarker}`;
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
