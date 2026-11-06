import { sha256Hex } from "../eval-primitives.js";
import { ValuePatternRedactor, type ValuePatternRule } from "../preflight-primitives.js";
import { type DroppedItem, utf8ByteLength } from "./budget.js";
import { compileCapsule, type CompileInput, type CompileOptions } from "./compile.js";
import { type ExcerptRedactor } from "./refs.js";
import { renderCapsule, type RenderedCapsule } from "./render.js";
import {
  type Capsule,
  type CapsuleRefusal,
  LAST_ERROR_EXCERPT_MAX_BYTES,
  type LastError,
} from "./schema.js";

export const RESUME_EXCERPT_MAX_BYTES = LAST_ERROR_EXCERPT_MAX_BYTES;

export const RESUME_TRUNCATION_MARKER = "\n[... truncated ...]\n";

export const RESUME_LOG_HEAD_BYTES = Math.floor(
  (RESUME_EXCERPT_MAX_BYTES - utf8ByteLength(RESUME_TRUNCATION_MARKER)) / 2,
);

export const RESUME_LOG_TAIL_BYTES =
  RESUME_EXCERPT_MAX_BYTES - utf8ByteLength(RESUME_TRUNCATION_MARKER) - RESUME_LOG_HEAD_BYTES;

export type ResumeErrorCategory = "compiler" | "test" | "permission_denied" | "tool";

export interface ResumeLastErrorInput {
  readonly category: ResumeErrorCategory;
  readonly log: string;
}

export interface ResumePrev {
  readonly input: CompileInput;
  readonly transcript: string;
}

export interface ResumePorts extends CompileOptions {
  readonly redactor?: ExcerptRedactor;
}

export interface ResumeSuccess {
  ok: true;
  capsule: Capsule;
  dropped: DroppedItem[];
  rendered: RenderedCapsule;
}

export type ResumeResult = ResumeSuccess | CapsuleRefusal;

// Mirrors preflight.ts / agentchat maestro-output token rules until a shared core rule set exists.
const TOKEN_REDACTION_RULE: ValuePatternRule = {
  id: "token",
  pattern:
    /\b(?:gh[oprsu]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|sk-[\w-]{20,}|xox[abprs]-[\w-]{10,})/g,
  replacement: "[REDACTED:token]",
};

const HOME_GENERIC_REDACTION_RULE: ValuePatternRule = {
  id: "home_generic",
  pattern: /\/(?:Users|home)\/[^/\s]+/g,
  replacement: "~",
};

const BUILTIN_REDACTOR = new ValuePatternRedactor([
  TOKEN_REDACTION_RULE,
  HOME_GENERIC_REDACTION_RULE,
]);

const KIND_BY_CATEGORY: Record<ResumeErrorCategory, LastError["kind"]> = {
  compiler: "compiler",
  test: "test",
  permission_denied: "permission",
  tool: "tool",
};

function isContinuationByte(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}

function truncateExcerpt(redacted: string): string {
  const bytes = new TextEncoder().encode(redacted);
  let headEnd = RESUME_LOG_HEAD_BYTES;
  while (isContinuationByte(bytes[headEnd])) {
    headEnd -= 1;
  }
  let tailStart = bytes.byteLength - RESUME_LOG_TAIL_BYTES;
  while (isContinuationByte(bytes[tailStart])) {
    tailStart += 1;
  }
  const decoder = new TextDecoder();
  const head = decoder.decode(bytes.subarray(0, headEnd));
  const tail = decoder.decode(bytes.subarray(tailStart));
  return head + RESUME_TRUNCATION_MARKER + tail;
}

/**
 * log_sha256 identifies the REDACTED log: the whole log is redacted before any
 * truncation, so raw secrets never reach the capsule, not even as a hash
 * preimage target. The excerpt is stored raw; escaping happens only in the
 * renderer.
 */
export function compactLastError(
  input: ResumeLastErrorInput,
  redactor?: ExcerptRedactor,
): LastError {
  let redacted = BUILTIN_REDACTOR.redactString(input.log).redacted;
  if (redactor !== undefined) {
    redacted = redactor.redactString(redacted).redacted;
  }
  const overCap = utf8ByteLength(redacted) > RESUME_EXCERPT_MAX_BYTES;
  // truncated reports that the source log exceeded the excerpt budget: a
  // redaction that collapses a huge log below the cap must still tell the
  // reader the excerpt stands for the full log named by log_sha256.
  const truncated = overCap || utf8ByteLength(input.log) > RESUME_EXCERPT_MAX_BYTES;
  return {
    kind: KIND_BY_CATEGORY[input.category],
    excerpt: overCap ? truncateExcerpt(redacted) : redacted,
    truncated,
    log_sha256: sha256Hex(redacted),
  };
}

export async function buildResume(
  prev: ResumePrev,
  ports: ResumePorts,
  lastError: ResumeLastErrorInput,
): Promise<ResumeResult> {
  const last_error = compactLastError(lastError, ports.redactor);
  const input: CompileInput = { ...prev.input, last_error };
  const options: CompileOptions = {
    git: ports.git,
    budget: ports.budget,
    ...(ports.counter !== undefined ? { counter: ports.counter } : {}),
  };
  const compiled = await compileCapsule(input, options);
  if (!compiled.ok) {
    return compiled;
  }
  return {
    ok: true,
    capsule: compiled.capsule,
    dropped: compiled.dropped,
    rendered: renderCapsule(compiled.capsule),
  };
}
