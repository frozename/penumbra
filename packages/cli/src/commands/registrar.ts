import { RegistrarCreateRequestSchema } from "@penumbra/api-contract";
import { parsePlanMeta } from "@penumbra/workflows";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";

export type Out = (line: string) => void;

export interface RunRegistrarRegisterOpts {
  path: string;
  storageRoot: string;
  fetch?: typeof fetch;
  out: Out;
  err: Out;
}

export function parsePhaseHeaders(markdown: string): string[] {
  const phases: string[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const prefix = /^## Phase \d+(?: — |: )/.exec(line)?.[0];
    if (prefix) phases.push(line.slice(prefix.length).trim());
  }
  return phases;
}

function planSlug(path: string): string {
  return basename(path)
    .replace(/\.md$/i, "")
    .replace(/^\d{4}-\d{2}-\d{2}[-_ ]*/, "")
    .replace(/[-_ ]*\d{4}-\d{2}-\d{2}$/, "")
    .normalize("NFKD")
    .replaceAll(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
}

function firstHeading(markdown: string): string {
  for (const line of markdown.split(/\r?\n/)) {
    const prefix = /^#{1,6} /.exec(line)?.[0];
    if (prefix) return line.slice(prefix.length).trim();
  }
  return "";
}

function resolveDaemon(storageRoot: string): { baseUrl: string; token: string } {
  const port = Number(readFileSync(join(storageRoot, "port"), "utf8").trim());
  const token = readFileSync(join(storageRoot, "token"), "utf8").trim();
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`penumbra registrar: invalid daemon port in ${join(storageRoot, "port")}`);
  }
  if (!token) {
    throw new Error(`penumbra registrar: empty daemon token in ${join(storageRoot, "token")}`);
  }
  return { baseUrl: `http://127.0.0.1:${String(port)}`, token };
}

async function readPlan(path: string, err: Out): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    err(`penumbra registrar register: cannot read ${path}: ${detail}`);
    return null;
  }
}

function parseDaemonFailure(text: string): { detail: string; errorCode?: string } {
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === "string") {
      return { detail: parsed.error, errorCode: parsed.error };
    }
  } catch {
    return { detail: text };
  }
  return { detail: text };
}

export async function runRegistrarRegister(opts: RunRegistrarRegisterOpts): Promise<number> {
  const markdown = await readPlan(opts.path, opts.err);
  if (markdown === null) return 2;
  const { header } = parsePlanMeta(markdown);
  const body = RegistrarCreateRequestSchema.parse({
    title: firstHeading(markdown),
    slug: planSlug(opts.path),
    home_project: header?.home_project ?? "",
    phases: parsePhaseHeaders(markdown),
    source_doc_path: opts.path,
  });
  const daemon = opts.fetch ? null : resolveDaemon(opts.storageRoot);
  const response = await (opts.fetch ?? fetch)(
    daemon === null ? "/registrar" : `${daemon.baseUrl}/registrar`,
    {
      method: "POST",
      headers: {
        ...(daemon === null ? {} : { authorization: `Bearer ${daemon.token}` }),
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  if (response.status !== 201) {
    const text = await response.text();
    const { detail, errorCode } = parseDaemonFailure(text);
    if (response.status === 409 && errorCode === "registrar_slug_taken") {
      opts.out(`already registered: ${body.slug}`);
      return 0;
    }
    opts.err(
      `penumbra registrar register: daemon /registrar returned HTTP ${String(response.status)}${detail ? ` (${detail})` : ""}`,
    );
    return 2;
  }
  const result = (await response.json()) as { registrar_id: string };
  opts.out(result.registrar_id);
  return 0;
}

export async function dispatchRegistrarSubcommand(
  args: string[],
  storageRoot: string,
): Promise<number> {
  const out: Out = (line) => process.stdout.write(`${line}\n`);
  const err: Out = (line) => process.stderr.write(`${line}\n`);
  const path = args[1];
  if (args[0] !== "register" || !path || path.startsWith("-")) {
    err("usage: penumbra registrar register <plan-file>");
    return 2;
  }
  return await runRegistrarRegister({ path, storageRoot, out, err });
}
