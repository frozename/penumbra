/**
 * Phase 0 GATE probe (Option-B warm-pool re-architecture).
 *
 * Question: can a codex-acp PROCESS spawned with OS cwd = dirA correctly serve
 * a SESSION opened with session/new.cwd = dirB? i.e. does the agent honor the
 * per-session cwd over its process cwd for file resolution? If yes, Option B
 * (pool the process, fresh session/new per dispatch at the worktree cwd) is
 * viable. If no, fall back to Option A.
 *
 * Method: spawn at A, open a session at B. Put WHICH_DIR.txt in each dir
 * containing its own letter. Advertise ONLY fs.readTextFile (no terminal) so
 * the agent must read via the fs/read_text_file client callback — where we both
 * (a) observe the absolute path it resolved a relative read to, and (b) return
 * the real file's content. Ask it to read WHICH_DIR.txt and echo the contents.
 * Verdict comes from the resolved path AND the agent's echoed letter.
 *
 * Run: cd packages/agentchat && bun run scripts/cwd-portability-probe.ts
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStdioAcpServer } from "../src/adapters/stdio-acp-server.js";
import { StdioAcpClient } from "../src/adapters/stdio-acp-client.js";

const UNSET_ENV = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "LOCAL_AI_PROVIDER_URL",
  "LOCAL_AI_API_KEY",
  "LOCAL_AI_PROVIDER",
  "PENUMBRA_SIRIUS_BASE_URL",
  "PENUMBRA_SIRIUS_TOKEN",
  "PENUMBRA_JUDGE_MODEL",
  "SIRIUS_URL",
  "PENUMBRA_T2_PROMOTION_DELAY_HOURS",
];

const CODEX_ARGS = [
  "-c",
  "features.computer_use=false",
  "-c",
  "features.browser_use=false",
  "-c",
  "features.in_app_browser=false",
];

function log(...a: unknown[]) {
  console.log("[probe]", ...a);
}

async function main() {
  const dirA = mkdtempSync(join(tmpdir(), "cwdprobe-A-"));
  const dirB = mkdtempSync(join(tmpdir(), "cwdprobe-B-"));
  writeFileSync(join(dirA, "WHICH_DIR.txt"), "PROCESS_DIR_A");
  writeFileSync(join(dirB, "WHICH_DIR.txt"), "SESSION_DIR_B");
  log("process cwd (A):", dirA);
  log("session cwd (B):", dirB);

  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const k of UNSET_ENV) delete env[k];

  const server = await startStdioAcpServer({
    binary: "codex-acp",
    args: CODEX_ARGS,
    cwd: dirA,
    env,
  });
  log("spawned codex-acp pid", server.pid, "at A");

  const client = new StdioAcpClient({
    stdin: server.stdin,
    stdout: server.stdout,
    framing: "newline",
  });

  const fsReadPaths: string[] = [];
  client.onRequest("fs/read_text_file", (params: { path?: string }) => {
    const p = params?.path ?? "";
    fsReadPaths.push(p);
    log("fs/read_text_file requested path:", p);
    try {
      return { content: existsSync(p) ? readFileSync(p, "utf8") : "" };
    } catch {
      return { content: "" };
    }
  });
  client.onRequest("fs/write_text_file", () => ({}));
  client.onRequest("session/request_permission", (params: any) => {
    const opts = params?.options ?? [];
    const allow =
      opts.find((o: any) => /allow/i.test(o.optionId ?? o.kind ?? o.name ?? "")) ?? opts[0];
    log("permission requested -> approving", allow?.optionId ?? allow?.kind);
    return { outcome: { outcome: "selected", optionId: allow?.optionId ?? "allow" } };
  });

  const agentText: string[] = [];
  client.on("session/update", (params: any) => {
    const u = params?.update ?? params;
    const kind = u?.sessionUpdate ?? u?.kind;
    const content = u?.content;
    const text = typeof content === "string" ? content : content?.text;
    if (text) agentText.push(text);
    if (kind) log("session/update:", kind, text ? JSON.stringify(text).slice(0, 80) : "");
  });

  const initResp = await client.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    clientInfo: { name: "cwd-probe", version: "1.0.0" },
  });
  log("initialize ok; authMethods:", JSON.stringify(initResp?.authMethods ?? []));

  const authMethods = initResp?.authMethods ?? [];
  if (authMethods.length > 0) {
    const envVar = authMethods.find(
      (m: any) => m.type === "env_var" && (m.vars ?? []).every((v: any) => !!env[v.name]),
    );
    const chosen =
      envVar?.id ?? authMethods.find((m: any) => m.type !== "env_var")?.id ?? authMethods[0].id;
    log("authenticate with", chosen);
    await client.request("authenticate", { methodId: chosen });
  }

  const session = await client.request("session/new", { cwd: dirB, mcpServers: [] });
  const sessionId = session?.sessionId;
  log("session/new -> sessionId", sessionId, "(requested cwd = B)");

  log("sending prompt...");
  const promptResult = await client.request("session/prompt", {
    sessionId,
    prompt: [
      {
        type: "text",
        text:
          "Read the file named WHICH_DIR.txt located in your current working directory " +
          "and reply with ONLY its exact contents, nothing else.",
      },
    ],
  });
  log("prompt stopReason:", JSON.stringify(promptResult));

  const joined = agentText.join("");
  log("=== VERDICT ===");
  log("fs read paths:", JSON.stringify(fsReadPaths));
  const pathUnderB = fsReadPaths.some((p) => p.startsWith(dirB));
  const pathUnderA = fsReadPaths.some((p) => p.startsWith(dirA));
  const saysB = /SESSION_DIR_B/.test(joined);
  const saysA = /PROCESS_DIR_A/.test(joined);
  log("agent final text mentions B:", saysB, "| mentions A:", saysA);
  log("fs path resolved under B:", pathUnderB, "| under A:", pathUnderA);
  if (saysB || (pathUnderB && !pathUnderA)) {
    log("RESULT: SESSION CWD AUTHORITATIVE -> Option B VIABLE");
  } else if (saysA || (pathUnderA && !pathUnderB)) {
    log("RESULT: PROCESS CWD WINS -> Option B NOT viable, fall back to Option A");
  } else {
    log("RESULT: INCONCLUSIVE — agent text:", JSON.stringify(joined).slice(0, 300));
  }

  server.kill();
  setTimeout(() => process.exit(0), 500);
}

main().catch((e) => {
  console.error("[probe] FAILED:", e);
  process.exit(1);
});
