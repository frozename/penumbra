export type ShellTok = { kind: "word"; text: string } | { kind: "op"; text: string };

export interface ShellTokens {
  toks: ShellTok[];
  inner: string[];
}

interface TokState {
  toks: ShellTok[];
  inner: string[];
  word: string;
}

const SUBST_PLACEHOLDER = " __SUB__ ";

// Longest-first multi-char operators. "|&" normalizes to "|"; fd-prefixed
// redirects (2>, 1>>) are handled at scan time via the preceding digit word.
const MULTI_OPS: readonly (readonly [string, string])[] = [
  ["&>>", "&>>"],
  ["<<<", "<<<"],
  ["&&", "&&"],
  ["||", "||"],
  ["|&", "|"],
  ["&>", "&>"],
  [">>", ">>"],
  ["<<", "<<"],
];

const SEGMENT_OP_CHARS = new Set([";", "|", "\n", "(", ")"]);

function flushWord(st: TokState): void {
  if (st.word.length > 0) {
    st.toks.push({ kind: "word", text: st.word });
    st.word = "";
  }
}

function pushOp(st: TokState, op: string): void {
  flushWord(st);
  st.toks.push({ kind: "op", text: op });
}

function readBalanced(src: string, start: number): number {
  let depth = 1;
  let j = start;
  while (j < src.length && depth > 0) {
    const ch = src[j];
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    else if (ch === "'") {
      j += 1;
      while (j < src.length && src[j] !== "'") j += 1;
    } else if (ch === "\\") j += 1;
    j += 1;
  }
  return j;
}

function readSingleQuoted(src: string, start: number): { text: string; next: number } {
  const close = src.indexOf("'", start + 1);
  const end = close === -1 ? src.length : close;
  return { text: src.slice(start + 1, end), next: close === -1 ? src.length : close + 1 };
}

function readDoubleQuoted(
  src: string,
  start: number,
  inner: string[],
): { text: string; next: number } {
  let text = "";
  let j = start + 1;
  while (j < src.length && src[j] !== '"') {
    if (src[j] === "\\" && j + 1 < src.length) {
      text += src[j + 1] ?? "";
      j += 2;
      continue;
    }
    if (src[j] === "`") {
      const bt = src.indexOf("`", j + 1);
      if (bt !== -1) {
        inner.push(src.slice(j + 1, bt));
        j = bt + 1;
        continue;
      }
    }
    if (src.slice(j, j + 2) === "$(") {
      const end = readBalanced(src, j + 2);
      inner.push(src.slice(j + 2, Math.max(j + 2, end - 1)));
      j = end;
      continue;
    }
    text += src[j] ?? "";
    j += 1;
  }
  return { text, next: j + 1 };
}

function readParenSubst(src: string, i: number, st: TokState, two: string): number {
  const end = readBalanced(src, i + 2);
  st.inner.push(src.slice(i + 2, Math.max(i + 2, end - 1)));
  if (two === "$(") st.word += SUBST_PLACEHOLDER;
  else flushWord(st);
  return end;
}

function readBacktick(src: string, i: number, st: TokState): number {
  const close = src.indexOf("`", i + 1);
  if (close === -1) {
    st.word += "`";
    return i + 1;
  }
  st.inner.push(src.slice(i + 1, close));
  st.word += SUBST_PLACEHOLDER;
  return close + 1;
}

const ANSI_C_ESCAPES: Record<string, string> = {
  a: "\x07",
  b: "\b",
  e: "\x1b",
  E: "\x1b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  "\\": "\\",
  "'": "'",
  '"': '"',
  "?": "?",
};

// $'...' ANSI-C quoting expands \xNN/\uNNNN/\NNN and simple escapes — without
// decoding, $'\x72\x6d' smuggles "rm" past the program denylist.
function readAnsiCEscape(src: string, j: number): { text: string; consumed: number } | null {
  const next = src[j + 1] ?? "";
  if (next === "") return null;
  const hex = /^x([0-9a-fA-F]{1,2})/.exec(src.slice(j + 1, j + 4));
  if (next === "x" && hex) {
    return {
      text: String.fromCharCode(parseInt(hex[1] ?? "0", 16)),
      consumed: 2 + (hex[1]?.length ?? 0),
    };
  }
  const uni = /^u([0-9a-fA-F]{1,4})/.exec(src.slice(j + 1, j + 6));
  if (next === "u" && uni) {
    return {
      text: String.fromCharCode(parseInt(uni[1] ?? "0", 16)),
      consumed: 2 + (uni[1]?.length ?? 0),
    };
  }
  const oct = /^([0-7]{1,3})/.exec(src.slice(j + 1, j + 4));
  if (/^[0-7]$/.test(next) && oct) {
    return { text: String.fromCharCode(parseInt(oct[0], 8)), consumed: 1 + oct[0].length };
  }
  return { text: ANSI_C_ESCAPES[next] ?? next, consumed: 2 };
}

function readAnsiCQuoted(src: string, start: number): { text: string; next: number } {
  let text = "";
  let j = start + 1;
  while (j < src.length && src[j] !== "'") {
    if (src[j] === "\\") {
      const esc = readAnsiCEscape(src, j);
      if (esc !== null) {
        text += esc.text;
        j += esc.consumed;
        continue;
      }
    }
    text += src[j] ?? "";
    j += 1;
  }
  return { text, next: j + 1 };
}

function stepQuoted(src: string, i: number, st: TokState): number | null {
  const ch = src[i];
  if (ch === "$" && src[i + 1] === "'") {
    const r = readAnsiCQuoted(src, i + 1);
    st.word += r.text;
    return r.next;
  }
  if (ch === "'") {
    const r = readSingleQuoted(src, i);
    st.word += r.text;
    return r.next;
  }
  if (ch === '"') {
    const r = readDoubleQuoted(src, i, st.inner);
    st.word += r.text;
    return r.next;
  }
  if (ch === "\\") {
    st.word += src[i + 1] ?? "";
    return i + 2;
  }
  if (ch === "`") return readBacktick(src, i, st);
  const two = src.slice(i, i + 2);
  if (two === "$(" || two === ">(" || two === "<(") return readParenSubst(src, i, st, two);
  return null;
}

function stepAmpersand(src: string, i: number, st: TokState): number {
  const next = src[i + 1] ?? "";
  // &digit / &- after a redirect is the fd-dup target word, not a separator.
  if (/[\d-]/.test(next)) {
    st.word += "&";
    return i + 1;
  }
  pushOp(st, "&");
  return i + 1;
}

function stepOperator(src: string, i: number, st: TokState): number | null {
  const ch = src[i];
  for (const [op, emit] of MULTI_OPS) {
    if (src.startsWith(op, i)) {
      pushOp(st, emit);
      return i + op.length;
    }
  }
  if (ch === "&") return stepAmpersand(src, i, st);
  if (ch === ">" || ch === "<" || SEGMENT_OP_CHARS.has(ch ?? "")) {
    pushOp(st, ch ?? "");
    return i + 1;
  }
  if (ch === " " || ch === "\t" || ch === "\r") {
    flushWord(st);
    return i + 1;
  }
  return null;
}

function advanceWord(src: string, i: number, st: TokState): number {
  st.word += src[i] ?? "";
  return i + 1;
}

export function tokenizeShellCommand(command: string): ShellTokens {
  const st: TokState = { toks: [], inner: [], word: "" };
  let i = 0;
  while (i < command.length) {
    i = stepQuoted(command, i, st) ?? stepOperator(command, i, st) ?? advanceWord(command, i, st);
  }
  flushWord(st);
  return { toks: st.toks, inner: st.inner };
}

export const SEGMENT_OPS = new Set([";", "&&", "||", "|", "&", "\n", "(", ")"]);
const WRITE_REDIRECT_OPS = new Set([">", ">>", "&>", "&>>"]);

export interface ShellScan {
  segments: string[][];
  redirectDeny: string | null;
}

export function isHarmlessRedirectTarget(target: string): boolean {
  if (target === "") return false;
  if (target === "/dev/null") return true;
  // fd duplication / close: >&1 >&2 2>&1 >&- 2>&-
  if (/^&[\d-]$/.test(target)) return true;
  if (/^[\d-]$/.test(target)) return true;
  return false;
}

interface ScanCtx {
  argv: string[];
  segments: string[][];
  deny: string | null;
}

function handleWriteRedirect(toks: ShellTok[], idx: number, ctx: ScanCtx): number {
  const op = toks[idx]?.text ?? "";
  const prev = ctx.argv[ctx.argv.length - 1];
  // A bare digit word right before > / >> is the fd prefix (2>, 1>>).
  if ((op === ">" || op === ">>") && prev !== undefined && /^\d+$/.test(prev)) {
    ctx.argv.pop();
  }
  const next = toks[idx + 1];
  const target = next?.kind === "word" ? next.text : "";
  const consumed = next?.kind === "word" ? idx + 2 : idx + 1;
  if (!isHarmlessRedirectTarget(target)) {
    ctx.deny ??= target === "" ? "write redirect with no target" : `write redirect to '${target}'`;
  }
  return consumed;
}

function visitTok(toks: ShellTok[], idx: number, ctx: ScanCtx): number {
  const tok = toks[idx];
  if (tok === undefined) return idx + 1;
  if (tok.kind === "word") {
    ctx.argv.push(tok.text);
    return idx + 1;
  }
  if (SEGMENT_OPS.has(tok.text)) {
    if (ctx.argv.length > 0) {
      ctx.segments.push(ctx.argv);
      ctx.argv = [];
    }
    return idx + 1;
  }
  if (WRITE_REDIRECT_OPS.has(tok.text)) return handleWriteRedirect(toks, idx, ctx);
  return idx + 1;
}

export function scanShellTokens(toks: ShellTok[]): ShellScan {
  const ctx: ScanCtx = { argv: [], segments: [], deny: null };
  let idx = 0;
  while (idx < toks.length) {
    idx = visitTok(toks, idx, ctx);
  }
  if (ctx.argv.length > 0) ctx.segments.push(ctx.argv);
  return { segments: ctx.segments, redirectDeny: ctx.deny };
}
