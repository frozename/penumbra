import { buildFramedCommand, parseFramedOutput } from "@src/services/shell-framing.js";
import { describe, expect, it } from "bun:test";

async function runFramedSnippet(
  snippet: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  // Mirror shell-session-pool bootstrap: fd 3 aliases stderr so that `2>&3` in
  // the snippet has an open sink.
  const proc = Bun.spawn(["bash", "-c", `exec 3>&2\n${snippet}`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return { stdout, stderr, exitCode: proc.exitCode ?? -1 };
}

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

  it("writes optional stdin payload via heredoc with a quoted delimiter", () => {
    const { snippet } = buildFramedCommand({
      commandId: "c-1",
      userCommand: "cat",
      stdin: "hello\n",
    });
    expect(snippet).toContain("<<'__PEN_STDIN_c-1__'");
    expect(snippet).toContain("hello\n");
  });

  it("delivers stdin as byte-literal data — no parameter/command substitution in the heredoc body", async () => {
    const stdin = "$(printf PWNED)\n";
    const { snippet, startMarker, endMarker } = buildFramedCommand({
      commandId: "expand-1",
      userCommand: "cat",
      stdin,
    });
    const { stdout, stderr } = await runFramedSnippet(snippet);
    const parsed = parseFramedOutput({ stdout, stderr, startMarker, endMarker });
    expect(parsed.complete).toBe(true);
    expect(parsed.exitCode).toBe(0);
    expect(parsed.stdout).toBe(stdin);
  });

  it("delivers stdin containing backticks as byte-literal data", async () => {
    const stdin = "`printf PWNED`\n";
    const { snippet, startMarker, endMarker } = buildFramedCommand({
      commandId: "backtick-1",
      userCommand: "cat",
      stdin,
    });
    const { stdout, stderr } = await runFramedSnippet(snippet);
    const parsed = parseFramedOutput({ stdout, stderr, startMarker, endMarker });
    expect(parsed.complete).toBe(true);
    expect(parsed.exitCode).toBe(0);
    expect(parsed.stdout).toBe(stdin);
  });

  it("preserves framing when stdin contains the default marker as a line — derives a collision-free marker", async () => {
    const collidingStdin = "before\n__PEN_STDIN_c-collide__\nafter\n";
    const { snippet, startMarker, endMarker } = buildFramedCommand({
      commandId: "c-collide",
      userCommand: "cat",
      stdin: collidingStdin,
      randomSuffix: () => "SFX",
    });
    const { stdout, stderr } = await runFramedSnippet(snippet);
    const parsed = parseFramedOutput({ stdout, stderr, startMarker, endMarker });
    expect(parsed.complete).toBe(true);
    expect(parsed.exitCode).toBe(0);
    expect(parsed.stdout).toBe(collidingStdin);
  });

  it("retries suffix generation until the marker is collision-free", () => {
    let call = 0;
    const suffixes = ["S", "T", "U"];
    const stdin = "__PEN_STDIN_c-x__\n__PEN_STDIN_c-x_S__\n__PEN_STDIN_c-x_T__\nline\n";
    const { snippet } = buildFramedCommand({
      commandId: "c-x",
      userCommand: "cat",
      stdin,
      randomSuffix: () => {
        const s = suffixes[call] ?? "Z";
        call += 1;
        return s;
      },
    });
    expect(snippet).toContain("<<'__PEN_STDIN_c-x_U__'");
    expect(snippet.endsWith('__PEN_STDIN_c-x_U__\necho "__PEN_END_c-x__ exit:$?"')).toBe(true);
  });

  it("throws when unable to derive a collision-free stdin marker", () => {
    const stdin = "__PEN_STDIN_c-x__\n__PEN_STDIN_c-x_S__\n";
    expect(() =>
      buildFramedCommand({
        commandId: "c-x",
        userCommand: "cat",
        stdin,
        randomSuffix: () => "S",
      }),
    ).toThrow(/collision-free/);
  });

  it("propagates the inner command exit code through framing when stdin is provided", async () => {
    const { snippet, startMarker, endMarker } = buildFramedCommand({
      commandId: "exit-code",
      userCommand: "cat; ( exit 7 )",
      stdin: "payload\n",
    });
    const { stdout, stderr } = await runFramedSnippet(snippet);
    const parsed = parseFramedOutput({ stdout, stderr, startMarker, endMarker });
    expect(parsed.complete).toBe(true);
    expect(parsed.exitCode).toBe(7);
  });

  it("appends a trailing newline to stdin bodies that do not already end with one", async () => {
    const stdin = "no-trailing-newline";
    const { snippet, startMarker, endMarker } = buildFramedCommand({
      commandId: "trail-1",
      userCommand: "cat",
      stdin,
    });
    const { stdout, stderr } = await runFramedSnippet(snippet);
    const parsed = parseFramedOutput({ stdout, stderr, startMarker, endMarker });
    expect(parsed.complete).toBe(true);
    expect(parsed.exitCode).toBe(0);
    expect(parsed.stdout).toBe("no-trailing-newline\n");
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
