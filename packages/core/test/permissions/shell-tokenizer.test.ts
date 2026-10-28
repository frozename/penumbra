import { describe, expect, test } from "bun:test";

import {
  isHarmlessRedirectTarget,
  LITERAL_DOLLAR,
  scanShellTokens,
  SEGMENT_OPS,
  type ShellTok,
  SUBST_MARKER,
  tokenizeShellCommand,
} from "@src/permissions/shell-tokenizer.js";

// #342: pin the token, substitution and redirect shapes the review_readonly
// shell classifier reads, at the tokenizer layer itself.
const BS = "\\";
const LD = LITERAL_DOLLAR;
const SUB = ` ${SUBST_MARKER} `;

function word(text: string): ShellTok {
  return { kind: "word", text };
}

function op(text: string): ShellTok {
  return { kind: "op", text };
}

function words(...texts: string[]): ShellTok[] {
  return texts.map(word);
}

type LexRow = [cmd: string, toks: ShellTok[], inner: string[]];
type ScanRow = [cmd: string, segments: string[][], redirectDeny: string | null];
type TargetRow = [target: string, harmless: boolean];

const OPERATOR_ROWS: LexRow[] = [
  ["git log | head", [word("git"), word("log"), op("|"), word("head")], []],
  ["a && b || c; d", [word("a"), op("&&"), word("b"), op("||"), word("c"), op(";"), word("d")], []],
  ["a |& b", [word("a"), op("|"), word("b")], []],
  ["cmd 2>&1", [word("cmd"), word("2"), op(">"), word("&1")], []],
  ["cmd &> f", [word("cmd"), op("&>"), word("f")], []],
  ["cmd &>> f", [word("cmd"), op("&>>"), word("f")], []],
  ["cat <<< hi", [word("cat"), op("<<<"), word("hi")], []],
  ["cat < in", [word("cat"), op("<"), word("in")], []],
  ["sleep 1 &", [word("sleep"), word("1"), op("&")], []],
  ["(cd x && ls)", [op("("), word("cd"), word("x"), op("&&"), word("ls"), op(")")], []],
  ["a\nb", [word("a"), op("\n"), word("b")], []],
  ["a\tb\rc", words("a", "b", "c"), []],
];

const QUOTING_ROWS: LexRow[] = [
  ["echo '$HOME'", words("echo", `${LD}HOME`), []],
  ["echo 'a b'", words("echo", "a b"), []],
  ['echo "$HOME"', words("echo", "$HOME"), []],
  ['echo "a$ b"', words("echo", `a${LD} b`), []],
  [`echo "${BS}$x"`, words("echo", `${LD}x`), []],
  [`echo ${BS}$x`, words("echo", `${LD}x`), []],
  [`echo a${BS} b`, words("echo", "a b"), []],
  ["echo a$", words("echo", `a${LD}`), []],
  ["a'b'\"c\"", words("abc"), []],
  ["echo 'abc", words("echo", "abc"), []],
  ['echo "abc', words("echo", "abc"), []],
];

const ANSI_C_ROWS: LexRow[] = [
  [`echo $'${BS}x72${BS}x6d'`, words("echo", "rm"), []],
  [`echo $'${BS}162${BS}155'`, words("echo", "rm"), []],
  [`echo $'${BS}u0072m'`, words("echo", "rm"), []],
  [`echo $'${BS}x726'`, words("echo", "r6"), []],
  [`echo $'${BS}xZ'`, words("echo", "xZ"), []],
  [`echo $'a${BS}tb'`, words("echo", "a\tb"), []],
  ["echo $'a$b'", words("echo", `a${LD}b`), []],
];

const SUBSTITUTION_ROWS: LexRow[] = [
  ["echo $(git stash)", words("echo", SUB), ["git stash"]],
  ["a$(b)c", words(`a${SUB}c`), ["b"]],
  ["echo $(a $(b) c)", words("echo", SUB), ["a $(b) c"]],
  ["echo $(echo ')')", words("echo", SUB), ["echo ')'"]],
  ["tee >(cat > f)", words("tee"), ["cat > f"]],
  ["echo `id`", words("echo", SUB), ["id"]],
  ["echo `id", words("echo", "`id"), []],
  ['echo "x`id`y"', words("echo", "xy"), ["id"]],
];

const SEGMENT_ROWS: ScanRow[] = [
  ["git log | head", [["git", "log"], ["head"]], null],
  ["a && b || c; d", [["a"], ["b"], ["c"], ["d"]], null],
  ["a |& b", [["a"], ["b"]], null],
  ["sleep 1 &", [["sleep", "1"]], null],
  ["a\nb", [["a"], ["b"]], null],
  ["; ; a", [["a"]], null],
  ["(cd x && ls)", [["cd", "x"], ["ls"]], null],
  ["", [], null],
];

const REDIRECT_ROWS: ScanRow[] = [
  ["cmd 2>&1", [["cmd"]], null],
  ["cmd 1>> /dev/null", [["cmd"]], null],
  ["x >&2", [["x"]], null],
  ["x 2>&-", [["x"]], null],
  ["echo hi > out.txt", [["echo", "hi"]], "write redirect to 'out.txt'"],
  ["echo hi >", [["echo", "hi"]], "write redirect with no target"],
  ["echo > a > b", [["echo"]], "write redirect to 'a'"],
  ["cmd &> f", [["cmd"]], "write redirect to 'f'"],
  ["cmd &>> f", [["cmd"]], "write redirect to 'f'"],
  ["cat < in", [["cat", "in"]], null],
  ["cat <<< hi", [["cat", "hi"]], null],
];

const TARGET_ROWS: TargetRow[] = [
  ["/dev/null", true],
  ["&1", true],
  ["&-", true],
  ["1", true],
  ["-", true],
  ["", false],
  ["&12", false],
  ["12", false],
  ["/dev/stderr", false],
  ["/dev/null2", false],
];

describe("shell-tokenizer constants", () => {
  test("LITERAL_DOLLAR and SUBST_MARKER keep their values", () => {
    expect(LITERAL_DOLLAR).toBe("\uE000");
    expect(SUBST_MARKER).toBe("__SUB__");
  });

  test("SEGMENT_OPS has exactly the eight segment operators", () => {
    expect(SEGMENT_OPS.size).toBe(8);
    for (const opText of [";", "&&", "||", "|", "&", "\n", "(", ")"]) {
      expect(SEGMENT_OPS.has(opText)).toBe(true);
    }
  });
});

describe("tokenizeShellCommand", () => {
  describe("operators and whitespace", () => {
    test.each(OPERATOR_ROWS)("%p", (cmd, toks, inner) => {
      expect(tokenizeShellCommand(cmd)).toEqual({ toks, inner });
    });
  });

  describe("quoting and literal dollar", () => {
    test.each(QUOTING_ROWS)("%p", (cmd, toks, inner) => {
      expect(tokenizeShellCommand(cmd)).toEqual({ toks, inner });
    });
  });

  describe("ANSI-C quoting", () => {
    test.each(ANSI_C_ROWS)("%p", (cmd, toks, inner) => {
      expect(tokenizeShellCommand(cmd)).toEqual({ toks, inner });
    });
  });

  describe("substitutions and inner", () => {
    test.each(SUBSTITUTION_ROWS)("%p", (cmd, toks, inner) => {
      expect(tokenizeShellCommand(cmd)).toEqual({ toks, inner });
    });
  });
});

describe("scanShellTokens", () => {
  describe("segments", () => {
    test.each(SEGMENT_ROWS)("%p", (cmd, segments, redirectDeny) => {
      expect(scanShellTokens(tokenizeShellCommand(cmd).toks)).toEqual({ segments, redirectDeny });
    });
  });

  describe("write redirects", () => {
    test.each(REDIRECT_ROWS)("%p", (cmd, segments, redirectDeny) => {
      expect(scanShellTokens(tokenizeShellCommand(cmd).toks)).toEqual({ segments, redirectDeny });
    });
  });
});

describe("isHarmlessRedirectTarget", () => {
  test.each(TARGET_ROWS)("%p", (target, harmless) => {
    expect(isHarmlessRedirectTarget(target)).toBe(harmless);
  });
});
