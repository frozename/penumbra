import { spawn } from "node:child_process";

export type ClipboardResult = { warnings: string[] };

export async function emitClipboardOutput(input: { body: string }): Promise<ClipboardResult> {
  return new Promise((resolve) => {
    const cmd = process.platform === "darwin" ? "pbcopy" : "xclip";
    const args = process.platform === "darwin" ? [] : ["-selection", "clipboard"];
    const child = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", (err) => resolve({ warnings: [`output clipboard: ${err.message}`] }));
    child.on("close", (code) =>
      resolve({ warnings: code === 0 ? [] : [`output clipboard: exit ${code}`] }),
    );
    child.stdin.write(input.body);
    child.stdin.end();
  });
}
