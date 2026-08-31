import { hasNonWhitespaceCharacter, parseWikiLinks, resolveStorageDbPath } from "@penumbra/core";
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const DEFAULT_DIGEST_LIMIT = 200;
const DEFAULT_STATUS_ROWS = 20;
const DEFAULT_PATTERN_ROWS = 180;
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;
const CLAUDE_CODE_KINDS = new Set(["user", "feedback", "project", "reference"]);
const APPLY_BATCH_SIZE = 8;

interface MemoryDigestRow {
  slug: string;
  title: string;
  hook: string;
}

export interface MemoryImportSummaryRow {
  file: string;
  status: "would_write" | "skipped" | "error";
  reason?: string;
  slug?: string;
  title?: string;
  hook?: string;
  cc_kind?: string;
  body?: string;
  body_preview?: string;
  wiki_links: string[];
}

export interface MemoryImportSummary {
  would_write: number;
  imported: number;
  updated: number;
  skipped: number;
  errors: number;
  rows: MemoryImportSummaryRow[];
  error?: "root_not_found";
}

export interface RunMemoryImportOpts {
  root: string;
  dryRun: boolean;
  apply: boolean;
  storageRoot?: string;
  daemonBaseUrl?: string;
  daemonToken?: string;
  fetch?: typeof fetch;
  db?: Database;
  print?: (line: string) => void;
}

export interface RunMemoryDigestOpts {
  maestro?: boolean;
  limit?: number;
  storageRoot: string;
  db?: Database;
  print?: (line: string) => void;
}

function resolveLimit(limit: number | undefined): number {
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error(
      `penumbra memory digest: --limit must be a positive integer (got: ${String(limit)})`,
    );
  }
  if (limit !== undefined) return limit;

  const raw = process.env.PENUMBRA_MEMORY_DIGEST_MAX_LINES;
  if (!raw) return DEFAULT_DIGEST_LIMIT;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 1) return DEFAULT_DIGEST_LIMIT;
  return value;
}

function resolveStatusRowLimit(): number {
  const raw = process.env.PENUMBRA_MEMORY_DIGEST_STATUS_ROWS;
  if (!raw) return DEFAULT_STATUS_ROWS;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 0) return DEFAULT_STATUS_ROWS;
  return value;
}

function resolvePatternRowLimit(): number {
  const raw = process.env.PENUMBRA_MEMORY_DIGEST_PATTERN_ROWS;
  if (!raw) return DEFAULT_PATTERN_ROWS;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 0) return DEFAULT_PATTERN_ROWS;
  return value;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
}

function resolveMemoryDaemon(opts: RunMemoryImportOpts): { baseUrl: string; token: string } {
  if (opts.daemonBaseUrl && opts.daemonToken) {
    return { baseUrl: opts.daemonBaseUrl, token: opts.daemonToken };
  }

  if (!opts.storageRoot) {
    throw new Error(
      "penumbra memory import-from-claude-code: storageRoot or daemon credentials required for --apply",
    );
  }

  const portPath = join(opts.storageRoot, "port");
  const tokenPath = join(opts.storageRoot, "token");
  const rawPort = readFileSync(portPath, "utf8").trim();
  const token = readFileSync(tokenPath, "utf8").trim();

  if (!rawPort || Number.isNaN(Number(rawPort))) {
    throw new Error(`penumbra memory import-from-claude-code: invalid daemon port in ${portPath}`);
  }
  if (!token) {
    throw new Error(`penumbra memory import-from-claude-code: empty daemon token in ${tokenPath}`);
  }

  return { baseUrl: `http://127.0.0.1:${rawPort}`, token };
}

interface ParsedFrontmatter {
  name: string;
  description: string;
  claudeCodeKind: string;
}

function evaluateFrontmatter(
  file: string,
  parsed: Record<string, unknown>,
  print: (line: string) => void,
):
  | { ok: true; value: ParsedFrontmatter }
  | { ok: false; status: "skipped" | "error"; reason: string } {
  const metadata = parsed.metadata as Record<string, unknown> | undefined;
  const name = typeof parsed.name === "string" ? parsed.name.trim() : undefined;
  const description =
    typeof parsed.description === "string" ? parsed.description.trim() : undefined;
  const claudeCodeKind =
    (metadata && typeof metadata.type === "string" ? metadata.type : undefined) ??
    (typeof parsed.type === "string" ? parsed.type : undefined);

  if (
    !name ||
    !hasNonWhitespaceCharacter(name) ||
    !description ||
    !hasNonWhitespaceCharacter(description) ||
    !claudeCodeKind
  ) {
    print(`SKIP ${file}: missing_required_fields\n`);
    return { ok: false, status: "skipped", reason: "missing_required_fields" };
  }
  if (!CLAUDE_CODE_KINDS.has(claudeCodeKind)) {
    print(`SKIP ${file}: unsupported_cc_kind\n`);
    return { ok: false, status: "skipped", reason: "unsupported_cc_kind" };
  }
  return { ok: true, value: { name, description, claudeCodeKind } };
}

interface ApplyContext {
  fetcher: typeof globalThis.fetch;
  daemon: { baseUrl: string; token: string };
  print: (line: string) => void;
}

async function applyMemoryPlan(
  plan: ApplyPlan,
  ctx: ApplyContext,
): Promise<"created" | "updated" | "error"> {
  try {
    const response = await ctx.fetcher(`${ctx.daemon.baseUrl}/memory/write`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ctx.daemon.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: plan.title,
        body: plan.body,
        slug: plan.slug,
        hook: plan.hook,
        cc_kind: plan.ccKind,
        project_id: null,
      }),
    });

    if (!response.ok) {
      plan.summary.status = "error";
      plan.summary.reason = `apply_http_error:${String(response.status)}`;
      ctx.print(`ERROR ${plan.file}: apply_http_error:${String(response.status)}\n`);
      return "error";
    }

    const body = (await response.json().catch(() => null)) as MemoryWriteResponse | null;
    if (!body || typeof body.memory_id !== "string" || typeof body.created !== "boolean") {
      plan.summary.status = "error";
      plan.summary.reason = "apply_http_error:invalid_response";
      ctx.print(`ERROR ${plan.file}: apply_http_error:invalid_response\n`);
      return "error";
    }
    return body.created ? "created" : "updated";
  } catch (err) {
    plan.summary.status = "error";
    plan.summary.reason = `apply_http_error:${err instanceof Error ? err.message : String(err)}`;
    ctx.print(`ERROR ${plan.file}: apply_http_error\n`);
    return "error";
  }
}

interface MemoryWriteResponse {
  memory_id: string;
  created: boolean;
}

function bodyPreview(body: string, max = 140): string {
  return body.length <= max ? body : `${body.slice(0, max)}...`;
}

interface ApplyPlan {
  file: string;
  summary: MemoryImportSummaryRow;
  title: string;
  body: string;
  slug: string;
  hook: string;
  ccKind: string;
}

function processImportFile(
  file: string,
  fullPath: string,
  print: (line: string) => void,
): { row: MemoryImportSummaryRow; plan?: ApplyPlan } {
  const content = readFileSync(fullPath, "utf8");
  const match = FRONTMATTER_RE.exec(content);

  if (!match) {
    print(`SKIP ${file}: no_frontmatter\n`);
    return {
      row: { file, status: "skipped", reason: "no_frontmatter", wiki_links: [] },
    };
  }

  const rawFrontmatter = match[1] ?? "";
  const parsedBody = (match[2] ?? "").trim();
  let parsed: unknown = null;
  try {
    parsed = parseYaml(rawFrontmatter);
  } catch (err) {
    const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
    print(`ERROR ${file}: yaml_parse_failed (${msg ?? ""})\n`);
    return { row: { file, status: "error", reason: "yaml_parse_failed", wiki_links: [] } };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    print(`ERROR ${file}: invalid_frontmatter\n`);
    return { row: { file, status: "error", reason: "invalid_frontmatter", wiki_links: [] } };
  }

  const fm = evaluateFrontmatter(file, parsed as Record<string, unknown>, print);
  if (!fm.ok) {
    return { row: { file, status: fm.status, reason: fm.reason, wiki_links: [] } };
  }
  const { name, description, claudeCodeKind } = fm.value;

  const slug = slugify(name);
  if (!slug) {
    print(`ERROR ${file}: empty_slug\n`);
    return { row: { file, status: "error", reason: "empty_slug", wiki_links: [] } };
  }

  const links = parseWikiLinks(parsedBody);
  const row: MemoryImportSummaryRow = {
    file,
    status: "would_write",
    slug,
    title: name,
    hook: description,
    cc_kind: claudeCodeKind,
    body: parsedBody,
    body_preview: bodyPreview(parsedBody),
    wiki_links: links,
  };
  const plan: ApplyPlan = {
    file,
    summary: row,
    title: name,
    body: parsedBody,
    slug,
    hook: description,
    ccKind: claudeCodeKind,
  };
  return { row, plan };
}

interface ScanResult {
  rows: MemoryImportSummaryRow[];
  applyPlans: ApplyPlan[];
  wouldWrite: number;
  skipped: number;
  errors: number;
}

function scanImportFiles(
  files: string[],
  root: string,
  apply: boolean,
  print: (line: string) => void,
): ScanResult {
  const rows: MemoryImportSummaryRow[] = [];
  const applyPlans: ApplyPlan[] = [];
  let wouldWrite = 0;
  let skipped = 0;
  let errors = 0;
  for (const file of files) {
    const fullPath = join(root, file);
    const { row, plan } = processImportFile(file, fullPath, print);
    rows.push(row);
    if (row.status === "skipped") {
      skipped += 1;
    } else if (row.status === "error") {
      errors += 1;
    } else {
      wouldWrite += 1;
      if (apply && plan) applyPlans.push(plan);
      else print(`PLAN ${file}: slug=${row.slug ?? ""} kind=${row.cc_kind ?? ""}\n`);
    }
  }
  return { rows, applyPlans, wouldWrite, skipped, errors };
}

async function runApplyPhase(
  applyPlans: ApplyPlan[],
  ctx: ApplyContext,
): Promise<{ imported: number; updated: number; errors: number }> {
  let imported = 0;
  let updated = 0;
  let errors = 0;
  for (let i = 0; i < applyPlans.length; i += APPLY_BATCH_SIZE) {
    const chunk = applyPlans.slice(i, i + APPLY_BATCH_SIZE);
    const results = await Promise.all(chunk.map((plan) => applyMemoryPlan(plan, ctx)));
    for (const result of results) {
      if (result === "created") imported += 1;
      else if (result === "updated") updated += 1;
      else errors += 1;
    }
  }
  return { imported, updated, errors };
}

export async function runMemoryImport(opts: RunMemoryImportOpts): Promise<MemoryImportSummary> {
  if (!existsSync(opts.root) || !statSync(opts.root).isDirectory()) {
    return {
      would_write: 0,
      imported: 0,
      updated: 0,
      skipped: 0,
      errors: 0,
      rows: [],
      error: "root_not_found",
    };
  }

  const fetcher = opts.fetch ?? globalThis.fetch;
  const daemon = opts.apply ? resolveMemoryDaemon(opts) : null;

  const print =
    opts.print ??
    ((line: string): void => {
      process.stdout.write(line);
    });
  const files = readdirSync(opts.root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name)
    .sort();

  const scan = scanImportFiles(files, opts.root, opts.apply, print);
  const { rows, applyPlans, wouldWrite, skipped } = scan;
  let { errors } = scan;

  let imported = 0;
  let updated = 0;
  if (opts.apply && daemon && applyPlans.length > 0) {
    const result = await runApplyPhase(applyPlans, { fetcher, daemon, print });
    imported = result.imported;
    updated = result.updated;
    errors += result.errors;
  }

  return {
    would_write: wouldWrite,
    imported,
    updated,
    skipped,
    errors,
    rows,
  };
}

export function runMemoryDigest(opts: RunMemoryDigestOpts): number {
  const limit = resolveLimit(opts.limit);
  const print =
    opts.print ??
    ((line: string): void => {
      process.stdout.write(line);
    });
  const shouldClose = !opts.db;

  const db = opts.db ?? new Database(resolveStorageDbPath(opts.storageRoot), { readonly: true });
  try {
    const baseWhere = `
        origin = ?
        AND retired_at IS NULL
        AND slug IS NOT NULL
        AND hook IS NOT NULL
        ${opts.maestro ? "AND project_id IS NULL" : ""}
    `;
    const statusRows = db
      .query<MemoryDigestRow, [string, number]>(
        `
      SELECT slug, title, hook
      FROM t2_memories
      WHERE ${baseWhere}
        AND (is_episodic = 1 OR durability = 'volatile' OR obs_type = 'session')
      ORDER BY updated_at DESC
      LIMIT ?
    `,
      )
      .all("direct", resolveStatusRowLimit());

    const strictPatternLimit =
      process.env.PENUMBRA_MEMORY_DIGEST_STATUS_ROWS !== undefined ||
      process.env.PENUMBRA_MEMORY_DIGEST_PATTERN_ROWS !== undefined;
    const unusedDefaultStatusRows = strictPatternLimit
      ? 0
      : Math.max(0, DEFAULT_STATUS_ROWS - statusRows.length);
    const patternRows = db
      .query<MemoryDigestRow, [string, number]>(
        `
      SELECT slug, title, hook
      FROM t2_memories
      WHERE ${baseWhere}
        AND COALESCE(is_episodic, 0) != 1
        AND (durability IS NULL OR durability != 'volatile')
        AND (obs_type IS NULL OR obs_type != 'session')
      ORDER BY updated_at DESC
      LIMIT ?
    `,
      )
      .all("direct", resolvePatternRowLimit() + unusedDefaultStatusRows);

    const rows = [...statusRows, ...patternRows].slice(0, limit);
    if (statusRows.length > 0) {
      print("## Recent Status\n");
    }
    for (const row of rows) {
      print(`- [${row.title}](${row.slug}) — ${row.hook}\n`);
    }
    return 0;
  } finally {
    if (shouldClose) {
      db.close();
    }
  }
}
