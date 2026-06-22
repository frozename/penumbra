import { describe, expect, it } from "bun:test";

import { buildFramedCommand, parseFramedOutput } from "../../src/services/shell-framing.js";

describe("buildFramedCommand", () => {
  it("produces a shell snippet that emits the start marker, runs the command, and emits the end marker with exit code", () => {
    const { snippet, startMarker, endMarker } = buildFramedCommand({
      commandId: "c-1",
      userCommand: "echo hi",
    });
    expect(startMarker).toContain("c-1");
    expect(endMarker).toContain("c-1");
    expect(snippet).toContain(startMarker);
    expect(snippet).toContain("echo hi");
    expect(snippet).toContain(`echo "${endMarker} exit:$?"`);
  });

  it("redirects stderr to fd 3 so the parser can demultiplex", () => {
    const { snippet } = buildFramedCommand({ commandId: "c-1", userCommand: "echo hi" });
    expect(snippet).toContain("2>&3");
  });

  it("writes optional stdin payload via heredoc", () => {
    const { snippet } = buildFramedCommand({
      commandId: "c-1",
      userCommand: "cat",
      stdin: "hello\n",
    });
    expect(snippet).toContain("<<__PEN_STDIN_c-1__");
    expect(snippet).toContain("hello\n");
  });
});

describe("parseFramedOutput", () => {
  it("extracts stdout, stderr, and exit code between start and end markers", () => {
    const startMarker = "__PEN_START_c-1__";
    const endMarker = "__PEN_END_c-1__";
    const stdout = `\n${startMarker}\nhi\n${endMarker} exit:0\n`;
    const stderr = "";
    const result = parseFramedOutput({ stdout, stderr, startMarker, endMarker });
    expect(result).toEqual({ stdout: "hi\n", stderr: "", exitCode: 0, complete: true });
  });

  it("reports complete=false when end marker is missing", () => {
    const startMarker = "__PEN_START_c-1__";
    const endMarker = "__PEN_END_c-1__";
    const stdout = `${startMarker}\npartial`;
    const result = parseFramedOutput({ stdout, stderr: "", startMarker, endMarker });
    expect(result.complete).toBe(false);
  });

  it("captures stderr separately from the demuxed stream", () => {
    const startMarker = "__PEN_START_c-1__";
    const endMarker = "__PEN_END_c-1__";
    const stdout = `${startMarker}\nout\n${endMarker} exit:1\n`;
    const stderr = "err\n";
    const result = parseFramedOutput({ stdout, stderr, startMarker, endMarker });
    expect(result.stdout).toBe("out\n");
    expect(result.stderr).toBe("err\n");
    expect(result.exitCode).toBe(1);
  });

  it("preserves exit code when command fails non-zero", () => {
    const startMarker = "__PEN_START_c-1__";
    const endMarker = "__PEN_END_c-1__";
    const stdout = `${startMarker}\n${endMarker} exit:127\n`;
    const result = parseFramedOutput({
      stdout,
      stderr: "command not found\n",
      startMarker,
      endMarker,
    });
    expect(result.exitCode).toBe(127);
  });
});
