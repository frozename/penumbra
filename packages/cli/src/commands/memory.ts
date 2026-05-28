import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { parseWikiLinks } from "@penumbra/core";

const DEFAULT_DIGEST_LIMIT = 200;
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
  const resolvedLimit = limit ?? DEFAULT_DIGEST_LIMIT;
  if (!Number.isInteger(resolvedLimit) || resolvedLimit < 1) {
    throw new Error(
      `penumbra memory digest: --limit must be a positive integer (got: ${resolvedLimit})`,
    );
  }
  return resolvedLimit;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
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

  const print = opts.print ?? ((line: string) => process.stdout.write(line));
  const files = readdirSync(opts.root, { withFileTypes: true })
    .map((entry) => ({
      name: entry.name,
      isMarkdown: entry.isFile() && entry.name.endsWith(".md"),
    }))
    .filter((entry) => entry.isMarkdown)
    .map((entry) => entry.name)
    .sort();

  const rows: MemoryImportSummaryRow[] = [];
  let wouldWrite = 0;
  let imported = 0;
  let updated = 0;
  let skipped = 0;
  let errors = 0;
  const applyPlans: ApplyPlan[] = [];

  for (const file of files) {
    const fullPath = join(opts.root, file);
    const content = readFileSync(fullPath, "utf8");
    const match = content.match(FRONTMATTER_RE);

    if (!match) {
      const summary: MemoryImportSummaryRow = {
        file,
        status: "skipped",
        reason: "no_frontmatter",
        wiki_links: [],
      };
      print(`SKIP ${file}: no_frontmatter\n`);
      rows.push(summary);
      skipped += 1;
      continue;
    }

    const rawFrontmatter = match[1] ?? "";
    const parsedBody = (match[2] ?? "").trim();
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = parseYaml(rawFrontmatter) as Record<string, unknown>;
    } catch (err) {
      const summary: MemoryImportSummaryRow = {
        file,
        status: "error",
        reason: "yaml_parse_failed",
        wiki_links: [],
      };
      const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
      print(`ERROR ${file}: yaml_parse_failed (${msg})\n`);
      rows.push(summary);
      errors += 1;
      continue;
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      const summary: MemoryImportSummaryRow = {
        file,
        status: "error",
        reason: "invalid_frontmatter",
        wiki_links: [],
      };
      print(`ERROR ${file}: invalid_frontmatter\n`);
      rows.push(summary);
      errors += 1;
      continue;
    }

    const metadata = parsed.metadata as Record<string, unknown> | undefined;
    const name = typeof parsed.name === "string" ? parsed.name : undefined;
    const description = typeof parsed.description === "string" ? parsed.description : undefined;
    // Two frontmatter shapes in the wild: newer files put kind under
    // metadata.type (nested); older files put it at the top level as
    // `type: project`. Support both.
    const claudeCodeKind =
      (metadata && typeof metadata.type === "string" ? metadata.type : undefined) ??
      (typeof parsed.type === "string" ? parsed.type : undefined);

    if (!name || !description || !claudeCodeKind) {
      const summary: MemoryImportSummaryRow = {
        file,
        status: "skipped",
        reason: "missing_required_fields",
        wiki_links: [],
      };
      print(`SKIP ${file}: missing_required_fields\n`);
      rows.push(summary);
      skipped += 1;
      continue;
    }

    if (!CLAUDE_CODE_KINDS.has(claudeCodeKind)) {
      const summary: MemoryImportSummaryRow = {
        file,
        status: "skipped",
        reason: "unsupported_cc_kind",
        wiki_links: [],
      };
      print(`SKIP ${file}: unsupported_cc_kind\n`);
      rows.push(summary);
      skipped += 1;
      continue;
    }

    // F18 is intentionally deferred: keep slugify(name) as the upsert key so existing
    // importer callers remain backward-compatible; source filename-only keys are left
    // to a future schema- and migration-aware follow-up.
    const slug = slugify(name);
    if (!slug) {
      const summary: MemoryImportSummaryRow = {
        file,
        status: "error",
        reason: "empty_slug",
        wiki_links: [],
      };
      print(`ERROR ${file}: empty_slug\n`);
      rows.push(summary);
      errors += 1;
      continue;
    }

    const links = parseWikiLinks(parsedBody);
    const summary: MemoryImportSummaryRow = {
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

    rows.push(summary);
    wouldWrite += 1;

    if (opts.apply) {
      applyPlans.push({
        file,
        summary,
        title: name,
        body: parsedBody,
        slug,
        hook: description,
        ccKind: claudeCodeKind,
      });
    } else {
      print(`PLAN ${file}: slug=${slug} kind=${claudeCodeKind}\n`);
    }
  }

  if (opts.apply && applyPlans.length > 0) {
    const processApply = async (plan: ApplyPlan): Promise<void> => {
      try {
        const response = await fetcher(`${daemon!.baseUrl}/memory/write`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${daemon!.token}`,
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
          plan.summary.reason = `apply_http_error:${response.status}`;
          errors += 1;
          print(`ERROR ${plan.file}: apply_http_error:${response.status}\n`);
          return;
        }

        const body = (await response.json().catch(() => null)) as MemoryWriteResponse | null;
        if (!body || typeof body.memory_id !== "string" || typeof body.created !== "boolean") {
          plan.summary.status = "error";
          plan.summary.reason = "apply_http_error:invalid_response";
          errors += 1;
          print(`ERROR ${plan.file}: apply_http_error:invalid_response\n`);
          return;
        }

        if (body.created) {
          imported += 1;
        } else {
          updated += 1;
        }
      } catch (err) {
        plan.summary.status = "error";
        plan.summary.reason = `apply_http_error:${String(err instanceof Error ? err.message : err)}`;
        errors += 1;
        print(`ERROR ${plan.file}: apply_http_error\n`);
      }
    };

    for (let i = 0; i < applyPlans.length; i += APPLY_BATCH_SIZE) {
      const chunk = applyPlans.slice(i, i + APPLY_BATCH_SIZE);
      await Promise.all(chunk.map(processApply));
    }

    // imported and updated were tracked inline in processApply based on
    // memory-write responses. parse/effect errors were already accounted for.
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
  const print = opts.print ?? ((line: string) => process.stdout.write(line));
  const shouldClose = !opts.db;

  const db = opts.db ?? new Database(join(opts.storageRoot, "db.sqlite"), { readonly: true });
  try {
    const rows = db
      .query<MemoryDigestRow, [string, number]>(
        `
      SELECT slug, title, hook
      FROM t2_memories
      WHERE origin = ?
        AND retired_at IS NULL
        AND slug IS NOT NULL
        AND hook IS NOT NULL
        ${opts.maestro ? "AND project_id IS NULL" : ""}
      ORDER BY updated_at DESC
      LIMIT ?
    `,
      )
      .all("direct", limit);

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
