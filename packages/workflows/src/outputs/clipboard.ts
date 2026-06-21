import { spawn } from "node:child_process";

export type ClipboardResult = { warnings: string[] };

export type ClipboardInput = {
  body: string;
  command?: { cmd: string; args: string[] };
  timeoutMs?: number;
};

export async function emitClipboardOutput(input: ClipboardInput): Promise<ClipboardResult> {
  return await new Promise((resolve) => {
    const cmd = input.command?.cmd ?? (process.platform === "darwin" ? "pbcopy" : "xclip");
    const args =
      input.command?.args ?? (process.platform === "darwin" ? [] : ["-selection", "clipboard"]);
    const timeoutMs = input.timeoutMs ?? 3000;
    const child = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
    let settled = false;
    const settle = (result: ClipboardResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore: child may already be dead
      }
      settle({ warnings: ["output clipboard: timed out"] });
    }, timeoutMs);
    child.on("error", (err) => {
      settle({ warnings: [`output clipboard: ${err.message}`] });
    });
    child.on("close", (code) => {
      settle({ warnings: code === 0 ? [] : [`output clipboard: exit ${String(code)}`] });
    });
    child.stdin.write(input.body);
    child.stdin.end();
  });
}
