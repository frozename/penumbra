import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stdin as processStdin, stdout as processStdout } from "node:process";
import { createInterface } from "node:readline/promises";

export interface DispatchTimelineEvent {
  handoff_id: string;
  worker_id: string | null;
  source: string;
  kind: string;
  ts: string;
  meta: Record<string, unknown> | null;
}

export interface DispatchTimelineResponse {
  events: DispatchTimelineEvent[];
}

interface DispatchLandResponse {
  ok: boolean;
  commit_sha: string;
  message_subject: string;
  branch_deleted: boolean;
  pr_closed: boolean;
}

interface DispatchLandAcceptedResponse {
  ok: boolean;
  task_id: string;
  status: "queued" | "running" | "done" | "failed";
}

interface DispatchLandTaskStatusResponse {
  task_id: string;
  status: "queued" | "running" | "done" | "failed";
  result: DispatchLandResponse | null;
  error: {
    code: string;
    files?: string[];
    hint?: string;
    verdict?: Record<string, unknown>;
  } | null;
}

interface DispatchLandConflictError {
  code?: string;
  files?: unknown;
  hint?: unknown;
  verdict?: Record<string, unknown>;
}

interface ReconcilerVerdictsResponse {
  verdicts: {
    handoff_id?: string | null;
    to_agent?: string | null;
    verdict?: {
      typecheck?: string;
      tests?: string;
      files_changed?: number;
      lines_added?: number;
      lines_deleted?: number;
      summary?: string;
    };
  }[];
}

export interface RunDispatchTimelineOpts {
  handoffId: string;
  json: boolean;
  storageRoot: string;
  fetch?: typeof fetch;
  print?: (line: string) => void;
}

export interface RunDispatchLandOpts {
  handoffId: string;
  storageRoot: string;
  message?: string;
  mode?: "squash" | "ff";
  deleteBranch?: boolean;
  force?: boolean;
  editor?: string;
  fetch?: typeof fetch;
  print?: (line: string) => void;
  confirm?: (prompt: string) => Promise<boolean>;
  editCommitMessage?: (template: string) => Promise<string>;
}

export interface RunDispatchListPendingOpts {
  storageRoot: string;
  limit?: number;
  fetch?: typeof fetch;
  print?: (line: string) => void;
}

function defaultPrint(line: string): void {
  process.stdout.write(`${line}\n`);
}

const DISPATCH_LAND_POLL_INTERVAL_MS = 200;

function resolveDaemon(storageRoot: string): { baseUrl: string; token: string } {
  const portPath = join(storageRoot, "port");
  const tokenPath = join(storageRoot, "token");
  if (!existsSync(portPath) || !existsSync(tokenPath)) {
    throw new Error(
      `penumbra dispatch timeline: missing ${portPath} or ${tokenPath}. Run 'penumbra start' first.`,
    );
  }

  const port = Number(readFileSync(portPath, "utf8").trim());
  const token = readFileSync(tokenPath, "utf8").trim();
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`penumbra dispatch timeline: invalid daemon port in ${portPath}`);
  }
  if (!token) {
    throw new Error(`penumbra dispatch timeline: empty daemon token in ${tokenPath}`);
  }

  return { baseUrl: `http://127.0.0.1:${String(port)}`, token };
}

function stripEditorCommentsAndTrim(raw: string): string {
  const filtered = raw
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n")
    .trim();
  return filtered;
}

function runGitRead(args: string[]): string {
  const proc = Bun.spawnSync({
    cmd: ["git", ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    const stderr = proc.stderr.toString().trim();
    throw new Error(stderr.length > 0 ? stderr : `git ${args.join(" ")} failed`);
  }
  return proc.stdout.toString();
}

function buildEditorTemplate(handoffId: string): string {
  const branch = `agent/${handoffId}`;
  let recentCommits = "(unable to read git log)";
  let diffStat = "(unable to read git diff --stat)";
  try {
    recentCommits = runGitRead(["log", "--oneline", "-10", branch]).trim() || "(no commits)";
  } catch {
    // best-effort
  }
  try {
    diffStat = runGitRead(["diff", "--stat", `main..${branch}`]).trim() || "(no diff)";
  } catch {
    // best-effort
  }

  const commitLines = recentCommits
    .split("\n")
    .map((line) => `#   ${line}`)
    .join("\n");
  const diffLines = diffStat
    .split("\n")
    .map((line) => `#   ${line}`)
    .join("\n");
  return [
    `# Curated commit message for landing dispatch ${handoffId}`,
    "# First line is the subject. Lines starting with # are stripped.",
    "#",
    "# Recent commits on agent branch:",
    commitLines,
    "#",
    "# Diff stat:",
    diffLines,
    "#",
    "",
    "",
  ].join("\n");
}

async function openEditorAndReadMessage(opts: {
  handoffId: string;
  editor?: string;
  editCommitMessage?: (template: string) => Promise<string>;
}): Promise<string> {
  const template = buildEditorTemplate(opts.handoffId);
  if (opts.editCommitMessage) {
    const edited = await opts.editCommitMessage(template);
    const cleaned = stripEditorCommentsAndTrim(edited);
    if (!cleaned) throw new Error("penumbra dispatch land: commit message is empty");
    return cleaned;
  }

  const editor = opts.editor ?? process.env.EDITOR ?? "vi";
  const dir = mkdtempSync(join(tmpdir(), "penumbra-dispatch-land-"));
  const filePath = join(dir, "COMMIT_EDITMSG");
  await Bun.write(filePath, template);

  const proc = Bun.spawn({
    cmd: [editor, filePath],
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`penumbra dispatch land: editor exited with code ${String(code)}`);
  }
  const edited = await Bun.file(filePath).text();
  const cleaned = stripEditorCommentsAndTrim(edited);
  if (!cleaned) throw new Error("penumbra dispatch land: commit message is empty");
  return cleaned;
}

async function defaultConfirm(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: processStdin, output: processStdout });
  try {
    const ans = (await rl.question(prompt)).trim().toLowerCase();
    return ans === "y" || ans === "yes";
  } finally {
    rl.close();
  }
}

function printConflictFiles(print: (line: string) => void, files: unknown, hint: unknown): void {
  const normalized = Array.isArray(files) ? files : [];
  print("merge conflict files:");
  for (const file of normalized) print(`  ${String(file)}`);
  if (typeof hint === "string") print(hint);
}

function stringifyVerdictField(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "unknown";
}

function printVerdictFailure(
  print: (line: string) => void,
  verdict: Record<string, unknown>,
): void {
  const typecheck = stringifyVerdictField(verdict.typecheck);
  const tests = stringifyVerdictField(verdict.tests);
  print(`verdict failed: typecheck=${typecheck} tests=${tests}`);
  if (typeof verdict.summary === "string" && verdict.summary.length > 0) {
    print(`summary: ${verdict.summary}`);
  }
}

type Conflict409Outcome = "abort_merge_conflict" | "abort_cancelled" | "retry_force" | "unknown";

async function handle409Conflict(
  res: Response,
  force: boolean,
  confirm: (prompt: string) => Promise<boolean>,
  print: (line: string) => void,
): Promise<Conflict409Outcome> {
  const conflict = await parseConflictErrorResponse(res);
  if (conflict.code === "merge_conflict") {
    printConflictFiles(print, conflict.files, conflict.hint);
    return "abort_merge_conflict";
  }
  if (conflict.code === "verdict_unverified" && !force) {
    printVerdictFailure(print, conflict.verdict ?? {});
    const shouldForce = await confirm("land anyway? [y/N] ");
    if (!shouldForce) return "abort_cancelled";
    return "retry_force";
  }
  return "unknown";
}

async function parseConflictErrorResponse(res: Response): Promise<DispatchLandConflictError> {
  const body = (await res.json().catch(() => ({}))) as { error?: DispatchLandConflictError };
  return body.error ?? {};
}

export async function runDispatchTimeline(opts: RunDispatchTimelineOpts): Promise<void> {
  const fetcher = opts.fetch ?? fetch;
  const print = opts.print ?? defaultPrint;
  const daemon = resolveDaemon(opts.storageRoot);
  const params = new URLSearchParams({ handoff_id: opts.handoffId });
  const res = await fetcher(`${daemon.baseUrl}/dispatch/events?${params.toString()}`, {
    headers: { authorization: `Bearer ${daemon.token}` },
  });
  if (!res.ok) {
    throw new Error(
      `penumbra dispatch timeline: daemon /dispatch/events returned HTTP ${String(res.status)}`,
    );
  }

  const body = (await res.json()) as DispatchTimelineResponse;
  if (opts.json) {
    print(JSON.stringify(body, null, 2));
    return;
  }

  if (body.events.length === 0) {
    print("(no events)");
    return;
  }

  for (const event of body.events) {
    const meta = event.meta === null ? "-" : JSON.stringify(event.meta);
    print(`${event.ts}  ${event.source}  ${event.kind}  ${meta}`);
    if (event.kind === "dispatch.end" && event.meta?.classifier_declined === true) {
      print("safety_classifier:");
      print("  classifier_declined: yes");
      const declineReason = event.meta.decline_reason;
      print(`  decline_reason: ${typeof declineReason === "string" ? declineReason : "unknown"}`);
    }
  }
}

export async function runDispatchLand(opts: RunDispatchLandOpts): Promise<void> {
  const fetcher = opts.fetch ?? fetch;
  const print = opts.print ?? defaultPrint;
  const daemon = resolveDaemon(opts.storageRoot);
  const mode = opts.mode ?? "squash";
  const deleteBranch = opts.deleteBranch ?? true;
  const message =
    opts.message ??
    (await openEditorAndReadMessage({
      handoffId: opts.handoffId,
      editor: opts.editor,
      editCommitMessage: opts.editCommitMessage,
    }));
  const confirm = opts.confirm ?? defaultConfirm;

  const post = async (force: boolean): Promise<Response> =>
    await fetcher(`${daemon.baseUrl}/dispatch/land`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${daemon.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        handoff_id: opts.handoffId,
        commit_message: message,
        mode,
        delete_branch: deleteBranch,
        force,
      }),
    });

  let force = Boolean(opts.force);
  let res = await post(force);
  while (res.status === 409) {
    const next = await handle409Conflict(res, force, confirm, print);
    if (next === "abort_merge_conflict") throw new Error("merge conflict");
    if (next === "abort_cancelled") throw new Error("dispatch land cancelled by user");
    if (next === "retry_force") {
      force = true;
      res = await post(force);
      continue;
    }
    throw new Error("penumbra dispatch land: daemon /dispatch/land returned HTTP 409");
  }

  if (!res.ok && res.status !== 202) {
    throw new Error(
      `penumbra dispatch land: daemon /dispatch/land returned HTTP ${String(res.status)}`,
    );
  }

  const terminalBody =
    res.status === 202
      ? await pollDispatchLandTask({
          fetcher,
          daemonBaseUrl: daemon.baseUrl,
          token: daemon.token,
          accepted: (await res.json()) as DispatchLandAcceptedResponse,
          print,
        })
      : ((await res.json()) as DispatchLandResponse);

  print(`Landed: ${terminalBody.commit_sha} "${terminalBody.message_subject}"`);
  if (terminalBody.pr_closed) {
    print(`PR closed for agent/${opts.handoffId}`);
  }
}

function rewindStatus(
  body: DispatchLandTaskStatusResponse,
  print: (line: string) => void,
): DispatchLandResponse | null {
  if (body.status === "done") {
    if (!body.result) throw new Error("penumbra dispatch land: missing task result");
    return body.result;
  }
  if (body.status === "failed") {
    const error = body.error ?? { code: "unknown" };
    if (error.code === "merge_conflict") {
      printConflictFiles(print, error.files, error.hint);
      throw new Error("merge conflict");
    }
    if (error.code === "verdict_unverified") {
      printVerdictFailure(print, error.verdict ?? {});
    }
    throw new Error(`penumbra dispatch land failed: ${error.code}`);
  }
  return null;
}

async function pollDispatchLandTask(input: {
  fetcher: typeof fetch;
  daemonBaseUrl: string;
  token: string;
  accepted: DispatchLandAcceptedResponse;
  print: (line: string) => void;
}): Promise<DispatchLandResponse> {
  let status = input.accepted.status;
  const taskId = input.accepted.task_id;
  while (status === "queued" || status === "running") {
    await Bun.sleep(DISPATCH_LAND_POLL_INTERVAL_MS);
    const res = await input.fetcher(
      `${input.daemonBaseUrl}/dispatch/land/${encodeURIComponent(taskId)}`,
      {
        headers: { authorization: `Bearer ${input.token}` },
      },
    );
    if (!res.ok) {
      throw new Error(
        `penumbra dispatch land: daemon /dispatch/land/${taskId} returned HTTP ${String(res.status)}`,
      );
    }
    const body = (await res.json()) as DispatchLandTaskStatusResponse;
    status = body.status;
    const terminal = rewindStatus(body, input.print);
    if (terminal) return terminal;
  }
  throw new Error("penumbra dispatch land: task did not reach terminal state");
}

export async function runDispatchListPending(opts: RunDispatchListPendingOpts): Promise<void> {
  const fetcher = opts.fetch ?? fetch;
  const print = opts.print ?? defaultPrint;
  const daemon = resolveDaemon(opts.storageRoot);
  const limit = opts.limit ?? 25;

  const res = await fetcher(
    `${daemon.baseUrl}/reconciler/verdicts?limit=${encodeURIComponent(String(limit))}`,
    {
      headers: { authorization: `Bearer ${daemon.token}` },
    },
  );
  if (!res.ok) {
    throw new Error(
      `penumbra dispatch list-pending: daemon /reconciler/verdicts returned HTTP ${String(res.status)}`,
    );
  }

  const body = (await res.json()) as ReconcilerVerdictsResponse;
  if (body.verdicts.length === 0) {
    print("(no verdicts)");
    return;
  }

  for (const row of body.verdicts) {
    const handoffId = row.handoff_id ?? "unknown";
    const v = row.verdict ?? {};
    const typecheck = v.typecheck ?? "unknown";
    const tests = v.tests ?? "unknown";
    const files = v.files_changed ?? 0;
    const added = v.lines_added ?? 0;
    const deleted = v.lines_deleted ?? 0;
    print(
      `${handoffId}  agent=${row.to_agent ?? "-"}  typecheck=${typecheck}  tests=${tests}  files=${String(files)}  +${String(added)}/-${String(deleted)}`,
    );
    print(`  hint: penumbra dispatch land ${handoffId}`);
  }
}
