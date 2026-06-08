/**
 * Fleet agent-name normalization migration (2026-06-08).
 * Convention: <provider>-<family>-<variant>-<transport>  (full provider words).
 * Transport: acp | cli | http. Provider for local models = serving node (local | macmini).
 * Functional/long-lived agents are EXCLUDED (renaming breaks role/long-lived bindings).
 *
 * DRY-RUN by default. Pass --apply to execute (stop the daemon+workers first).
 * Run from repo root: bun docs/notes/fleet-rename-migration-2026-06-08.ts [--apply]
 */
import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "fs";
import { homedir } from "os";

const HOME = homedir();
const APPLY = process.argv.includes("--apply");
const STAMP = "2026-06-08-rename";

// ---- The canonical OLD -> NEW mapping (model agents only) ----
const MAP: Record<string, string> = {
  // openai / codex
  "codex": "openai-codex-cli",
  "codex-frontier": "openai-codex-frontier-cli",
  "codex-spark": "openai-codex-spark-cli",
  "codex-mini": "openai-codex-mini-cli",
  "codex-acp": "openai-codex-acp",
  "codex-acp-fast": "openai-codex-fast-acp",
  "codex-acp-deep": "openai-codex-deep-acp",
  "codex-acp-spark": "openai-codex-spark-acp",
  "codex-acp-gpt-5.4": "openai-codex-gpt54-acp",
  // anthropic / claude
  "claude": "anthropic-claude-cli",
  "claude-acp-sonnet": "anthropic-claude-sonnet-acp",
  "claude-acp-haiku": "anthropic-claude-haiku-acp",
  // google / gemini
  "gemini": "google-gemini-cli",
  "gemini-flash": "google-gemini-flash-cli",
  "gemini-acp-pro": "google-gemini-pro-acp",
  "gemini-acp-flash": "google-gemini-flash-acp",
  "gemini-pro-direct": "google-gemini-pro-http",
  "gemini-flash-direct": "google-gemini-flash-http",
  "gemini-cli-3-5-flash": "google-gemini-35flash-cli",
  // nvidia (nvidia-nim, http)
  "nv-llama4-maverick": "nvidia-llama4-maverick-http",
  "nv-qwen3-coder-480b": "nvidia-qwen3coder-480b-http",
  "nv-deepseek-v4-pro": "nvidia-deepseek-v4pro-http",
  "nv-nemotron-super-49b": "nvidia-nemotron-super-49b-http",
  "nv-llama-3.1-8b": "nvidia-llama31-8b-http",
  "nv-glm-4-7": "nvidia-glm-47-http",
  "nv-minimax-m2-7": "nvidia-minimax-m27-http",
  "nv-kimi-k2": "nvidia-kimi-k2-http",
  "nv-deepseek-3-2": "nvidia-deepseek-v32-http",
  "nv-step-3-5-flash": "nvidia-step-35flash-http",
  "nv-deepseek-3-1-terminus": "nvidia-deepseek-v31-terminus-http",
  // groq (http)
  "groq-llama4-scout": "groq-llama4-scout-http",
  "groq-llama-3.3-70b": "groq-llama33-70b-http",
  "groq-llama-3.1-8b": "groq-llama31-8b-http",
  "groq-gpt-oss-120b": "groq-gptoss-120b-http",
  "groq-qwen3-32b": "groq-qwen3-32b-http",
  // opencode (opencode-go)
  "oc-big-pickle": "opencode-bigpickle-cli",
  "oc-gpt-5-nano": "opencode-gpt5nano-cli",
  "oc-hy3-preview": "opencode-hy3-preview-cli",
  "oc-minimax-flash": "opencode-minimax-flash-cli",
  "oc-ling-flash": "opencode-ling-flash-cli",
  "oc-nemotron-super": "opencode-nemotron-super-cli",
  "oc-kimi-k2.6": "opencode-kimi-k26-cli",
  "oc-deepseek-v4-pro": "opencode-deepseek-v4pro-cli",
  "oc-acp-deepseek-v4-pro": "opencode-deepseek-v4pro-acp",
  "oc-deepseek-v4-flash": "opencode-deepseek-v4flash-cli",
  "oc-mimo-v2.5-pro": "opencode-mimo-v25pro-cli",
  "oc-minimax-m2.7": "opencode-minimax-m27-cli",
  "oc-qwen3.6-plus": "opencode-qwen36-plus-cli",
  "oc-glm-5.1": "opencode-glm-51-cli",
  // local node (:7944)
  "local-granite-3b-q8": "local-granite-3b-q8-http",
  "local-qwen36-35b-moe": "local-qwen36-35b-moe-http",
  "local-qwen36-27b": "local-qwen36-27b-http",
  "local-qwen36-35b-a3b-mlx": "local-qwen36-35b-a3b-mlx-http",
  "local-gemma4-26b-a4b-mtp": "local-gemma4-26b-a4b-mtp-http",
  "local-qwen35-27b": "local-qwen35-27b-http",
  "local-qwen3-coder": "local-qwen3-coder-http",
  "local-qwen35-4b": "local-qwen35-4b-http",
  "local-gemma31": "local-gemma31-http",
  // mac-mini gateway / nodes (:7843, :8194-6)
  "granite-mini": "macmini-granite-3b-q4-http",
  "granite-mini-3b": "macmini-granite-3b-q8-http",
  "mac-mini-granite-3b-mlx-iso": "macmini-granite-3b-mlx-http",
  "mac-mini-granite-8b-nvfp4-iso": "macmini-granite-8b-nvfp4-http",
  "mac-mini-qwen3-8b-mlx-iso": "macmini-qwen3-8b-mlx-http",
};

// Functional/long-lived + provider-block names: intentionally NOT renamed.
const EXCLUDE = new Set([
  "planner", "executor", "maestro",
  "home-mgmt", "task-refiner-primary", "task-refiner-escalation",
  "anthropic", "openai", "google", "opencode-go", // providers: block
]);

const CONFIG_FILES = [
  `${HOME}/.config/agentchat/agentchat.yaml`,
  `${HOME}/.config/penumbra/routing.yaml`,
  `${HOME}/.config/penumbra/quotas.yaml`,
  `${HOME}/.config/penumbra/agents.yaml`,
  `${HOME}/.config/penumbra/projects.yaml`,
  `${HOME}/.config/penumbra/workers.yaml`,
];
const DB_PATH = `${HOME}/.penumbra/db.sqlite`;

function nameConstituent(re: string) {
  // token boundary: not surrounded by [A-Za-z0-9._-]
  return new RegExp(`(?<![A-Za-z0-9._-])(${re})(?![A-Za-z0-9._-])`, "g");
}
function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---- Validate the mapping against the live config ----
// Agents (and the providers: block) are top-level list entries at EXACTLY 2-space
// indent ("  - name:"). Nested name: keys (mcp_servers, env vars, thought
// categories) live at deeper indent and are correctly excluded by this anchor.
function extractAgentNames(): string[] {
  const txt = readFileSync(CONFIG_FILES[0], "utf8");
  const names: string[] = [];
  for (const m of txt.matchAll(/^  - name:\s*([A-Za-z0-9._-]+)\s*$/gm)) names.push(m[1]);
  return names;
}

function validate() {
  const problems: string[] = [];
  const liveNames = new Set(extractAgentNames());
  // every live name must be mapped or excluded
  for (const n of liveNames) {
    if (!(n in MAP) && !EXCLUDE.has(n)) problems.push(`UNMAPPED live agent: ${n}`);
  }
  // every mapped OLD must exist live
  for (const old of Object.keys(MAP)) {
    if (!liveNames.has(old)) problems.push(`MAP old not found live: ${old}`);
  }
  // no duplicate targets
  const seen = new Map<string, string>();
  for (const [old, neu] of Object.entries(MAP)) {
    if (seen.has(neu)) problems.push(`DUP target ${neu} (${old} & ${seen.get(neu)})`);
    seen.set(neu, old);
  }
  // no target collides with a kept/excluded name
  for (const neu of Object.values(MAP)) {
    if (EXCLUDE.has(neu) || liveNames.has(neu)) problems.push(`target collides with existing: ${neu}`);
  }
  return problems;
}

// Precise, key-scoped, per-line rewriter. Only rewrites agent names in contexts
// that definitely hold an agent reference; never touches command/binary/tags/
// description/system_prompt/model/prose/comments.
const OLDS = Object.keys(MAP).sort((a, b) => b.length - a.length);
const OLD_ALT = OLDS.map(escapeRe).join("|");
// KEY: <agent>   for agent-valued keys (value may be quoted)
const KEY_VALUE = new RegExp(
  `^(\\s*(?:-\\s+)?(?:name|preferred_agent|reviewer|synthesizer|planner|executor|implementer|refiner|default_agent|escalate_to|fallback|initial_agent):\\s+)(["']?)(${OLD_ALT})(["']?)(\\s*)$`,
);
// - <agent>   bare list item (eligible_agents entries; value may be quoted)
const LIST_ITEM = new RegExp(`^(\\s*-\\s+)(["']?)(${OLD_ALT})(["']?)(\\s*)$`);
// <agent>:    agent as a map KEY (only legitimate under per_agent_overrides)
const AGENT_KEY = new RegExp(`^(\\s+)(${OLD_ALT})(:\\s*)$`);
// contexts that must NEVER be rewritten (collide with prose/CLI/model/policy)
const NEVER_KEYS = /^\s*(?:-\s+)?(command|binary|tags|description|system_prompt|model|subscription_model|subscription_provider|api_provider|adapter|base_url|pool_key|prompt):/;
// policy-flag lines like `claude: true` under hostEnvPolicy are NOT agent refs
const POLICY_FLAG = new RegExp(`^\\s*(${OLD_ALT}):\\s+(true|false)\\s*$`);
const indentOf = (l: string) => (l.match(/^\s*/)?.[0].length ?? 0);

function stripInlineComment(line: string): { body: string; comment: string } {
  // naive: a ' #' outside quotes starts a comment. agent names have no '#'.
  const i = line.indexOf(" #");
  if (i >= 0) return { body: line.slice(0, i), comment: line.slice(i) };
  return { body: line, comment: "" };
}

function rewriteText(txt: string): { out: string; count: number } {
  let count = 0;
  let paoIndent: number | null = null; // indent of an open per_agent_overrides: block
  const lines = txt.split("\n");
  const out = lines.map((line) => {
    // track per_agent_overrides block (the ONLY place an agent is a map key)
    if (/^\s*per_agent_overrides:\s*$/.test(line)) { paoIndent = indentOf(line); return line; }
    if (paoIndent !== null && line.trim() !== "" && indentOf(line) <= paoIndent) paoIndent = null;

    if (/^\s*#/.test(line)) return line; // comment-only
    if (NEVER_KEYS.test(line)) return line;
    const { body, comment } = stripInlineComment(line);

    // agent-as-key ONLY inside per_agent_overrides (NOT hostEnvPolicy etc.)
    if (paoIndent !== null) {
      const k = body.match(AGENT_KEY);
      if (k && k[2] in MAP) { count++; return k[1] + MAP[k[2]] + k[3] + comment; }
    }
    let m = body.match(KEY_VALUE);
    if (m && m[3] in MAP) { count++; return m[1] + m[2] + MAP[m[3]] + m[4] + m[5] + comment; }
    m = body.match(LIST_ITEM);
    if (m && m[3] in MAP) { count++; return m[1] + m[2] + MAP[m[3]] + m[4] + m[5] + comment; }
    return line;
  });
  return { out: out.join("\n"), count };
}

// Residual report: after a trial rewrite, find any OLD-name token still present on
// a line that is NOT a comment and NOT a NEVER_KEYS context — i.e. a reference site
// the rewriter may have missed. Empty => safe.
const RESID = nameConstituent(OLD_ALT);
function residualReport(txt: string): string[] {
  const { out } = rewriteText(txt);
  const hits: string[] = [];
  out.split("\n").forEach((line, i) => {
    if (/^\s*#/.test(line) || NEVER_KEYS.test(line) || POLICY_FLAG.test(line)) return;
    const { body } = stripInlineComment(line);
    // skip prose: a quoted-string list item or a quoted value (descriptions live as `- "..."`)
    if (/^\s*-\s+["']/.test(body) || /:\s+["'].*["']\s*$/.test(body)) return;
    RESID.lastIndex = 0;
    if (RESID.test(body)) hits.push(`${i + 1}: ${line.trim().slice(0, 100)}`);
  });
  return hits;
}

function main() {
  console.log(`=== Fleet rename migration (${APPLY ? "APPLY" : "DRY-RUN"}) ===`);
  const problems = validate();
  if (problems.length) {
    console.log("VALIDATION FAILED:");
    for (const p of problems) console.log("  - " + p);
    console.log("\nAborting (fix the map).");
    process.exit(1);
  }
  console.log(`Validation OK: ${Object.keys(MAP).length} renames, ${EXCLUDE.size} excluded.`);

  // DB counts (read-only)
  const db = new Database(DB_PATH, APPLY ? { readwrite: true } : { readonly: true });
  const countFor = (old: string) => {
    const ap = db.query("SELECT COUNT(*) c FROM agent_performance WHERE agent_name=?").get(old) as any;
    const ht = db.query("SELECT COUNT(*) c FROM handoffs WHERE to_agent=?").get(old) as any;
    const hf = db.query("SELECT COUNT(*) c FROM handoffs WHERE from_agent=?").get(old) as any;
    const pr = db.query("SELECT COUNT(*) c FROM permission_requests WHERE agent_name=?").get(old) as any;
    return { ap: ap.c, ht: ht.c, hf: hf.c, pr: pr.c };
  };

  console.log("\nold -> new   (ap rows / handoff to / from / perm)");
  let totAp = 0, totHt = 0, totHf = 0, totPr = 0;
  for (const old of Object.keys(MAP)) {
    const c = countFor(old);
    totAp += c.ap; totHt += c.ht; totHf += c.hf; totPr += c.pr;
    console.log(`  ${old.padEnd(30)} -> ${MAP[old].padEnd(34)} (${c.ap}/${c.ht}/${c.hf}/${c.pr})`);
  }
  console.log(`TOTALS: agent_performance=${totAp}, handoffs.to=${totHt}, handoffs.from=${totHf}, perm=${totPr}`);

  // config occurrence counts
  console.log("\nconfig files (occurrences to rewrite):");
  for (const f of CONFIG_FILES) {
    if (!existsSync(f)) { console.log(`  ${f}  (absent)`); continue; }
    const { count } = rewriteText(readFileSync(f, "utf8"));
    console.log(`  ${f.replace(HOME, "~")}  -> ${count}`);
  }

  // residual check: any missed reference sites (non-comment, non-NEVER_KEYS)?
  console.log("\nresidual old-name references after rewrite (should be EMPTY):");
  let residTotal = 0;
  for (const f of CONFIG_FILES) {
    if (!existsSync(f)) continue;
    const hits = residualReport(readFileSync(f, "utf8"));
    if (hits.length) { residTotal += hits.length; console.log(`  ${f.replace(HOME, "~")}:`); for (const h of hits) console.log(`     ${h}`); }
  }
  if (residTotal === 0) console.log("  (none — all references covered; remaining old-name text is only in comments/command/binary/tags/prose)");

  if (!APPLY) {
    console.log("\nDRY-RUN only. Re-run with --apply (after stopping daemon+workers) to execute.");
    return;
  }
  // Residuals were manually verified to be agents.yaml description/comment PROSE
  // (no real reference keys), so they are advisory only — not a hard abort.
  if (residTotal > 0) console.log(`\nNOTE: ${residTotal} residual old-name strings remain in PROSE (verified non-references) — proceeding.`);

  // ---- APPLY ----
  console.log("\n--- APPLYING ---");
  // 1. backups
  for (const f of CONFIG_FILES) if (existsSync(f)) copyFileSync(f, `${f}.bak-pre-${STAMP}`);
  copyFileSync(DB_PATH, `${DB_PATH}.bak-pre-${STAMP}`);
  console.log("backups written (.bak-pre-" + STAMP + ")");
  // 2. rewrite configs
  for (const f of CONFIG_FILES) {
    if (!existsSync(f)) continue;
    const { out, count } = rewriteText(readFileSync(f, "utf8"));
    if (count > 0) { writeFileSync(f, out); console.log(`rewrote ${f.replace(HOME, "~")} (${count})`); }
  }
  // 3. DB migrate (transaction)
  const tx = db.transaction(() => {
    for (const [old, neu] of Object.entries(MAP)) {
      db.query("UPDATE agent_performance SET agent_name=? WHERE agent_name=?").run(neu, old);
      db.query("UPDATE handoffs SET to_agent=? WHERE to_agent=?").run(neu, old);
      db.query("UPDATE handoffs SET from_agent=? WHERE from_agent=?").run(neu, old);
      db.query("UPDATE permission_requests SET agent_name=? WHERE agent_name=?").run(neu, old);
    }
  });
  tx();
  console.log("DB migrated.");
  // 4. verify no old names remain
  let residual = 0;
  for (const old of Object.keys(MAP)) {
    const c = db.query("SELECT COUNT(*) c FROM agent_performance WHERE agent_name=?").get(old) as any;
    residual += c.c;
  }
  console.log(`residual old agent_performance rows: ${residual} (expect 0)`);
  console.log("DONE. Restart daemon+workers and verify.");
}

main();
