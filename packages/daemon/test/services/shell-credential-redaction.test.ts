import { describe, expect, it } from "bun:test";

import {
  buildScrubbedChildEnv,
  DAEMON_SECRET_ENV_KEYS,
  redactCredentials,
} from "@src/services/shell-session-pool.js";

function buildGhpTok(): string {
  return "ghp_" + "A".repeat(24);
}

function buildSkTok(): string {
  return "sk-" + "B".repeat(24);
}

function buildAIZaTok(): string {
  return "AIza" + "1".repeat(35);
}

function buildGskTok(): string {
  return "gsk_" + "C".repeat(24);
}

function buildNvapiTok(): string {
  return "nvapi-" + "D".repeat(24);
}

function buildXaiTok(): string {
  return "xai-" + "E".repeat(24);
}

function buildFcTok(): string {
  return "fc-" + "F".repeat(24);
}

describe("redactCredentials positive patterns", () => {
  it("sk- prefix with 20+ chars is redacted", () => {
    const tok = buildSkTok();
    const input = `token=${tok} end`;
    const output = redactCredentials(input);
    expect(output).toBe("token=[REDACTED] end");
  });

  it.each([
    ["ghp_", buildGhpTok()],
    ["gho_", "gho_" + "A".repeat(24)],
    ["ghu_", "ghu_" + "A".repeat(24)],
    ["ghs_", "ghs_" + "A".repeat(24)],
    ["ghr_", "ghr_" + "A".repeat(24)],
  ])("GitHub prefix %s with 20+ chars is redacted", (_prefix, tok) => {
    const input = `token=${tok} end`;
    const output = redactCredentials(input);
    expect(output).toBe("token=[REDACTED] end");
  });

  it("AIza prefix with exactly 35 chars followed by space is redacted", () => {
    const tok = buildAIZaTok();
    const input = `key=${tok} end`;
    const output = redactCredentials(input);
    expect(output).toBe("key=[REDACTED] end");
  });

  it("gsk_ prefix with 20+ alphanumeric chars is redacted", () => {
    const tok = buildGskTok();
    const input = `token=${tok} end`;
    const output = redactCredentials(input);
    expect(output).toBe("token=[REDACTED] end");
  });

  it("nvapi- prefix with 20+ chars is redacted", () => {
    const tok = buildNvapiTok();
    const input = `token=${tok} end`;
    const output = redactCredentials(input);
    expect(output).toBe("token=[REDACTED] end");
  });

  it("xai- prefix with 20+ alphanumerics is redacted", () => {
    const tok = buildXaiTok();
    const input = `token=${tok} end`;
    const output = redactCredentials(input);
    expect(output).toBe("token=[REDACTED] end");
  });

  it("fc- prefix with 20+ alphanumerics is redacted", () => {
    const tok = buildFcTok();
    const input = `token=${tok} end`;
    const output = redactCredentials(input);
    expect(output).toBe("token=[REDACTED] end");
  });

  it("Discord webhook URL is redacted in full", () => {
    const webhook = "https://discord.com/api/webhooks/123456789/abc_DEF-ghi";
    const input = `webhook=${webhook} end`;
    const output = redactCredentials(input);
    expect(output).toBe("webhook=[REDACTED] end");
  });

  it("Authorization: Bearer is redacted (match consumes Bearer)", () => {
    const tok = "abc.DEF-123_x";
    const input = `Authorization: Bearer ${tok}`;
    const output = redactCredentials(input);
    expect(output).toBe("Authorization: [REDACTED]");
  });
});

describe("redactCredentials global replacement", () => {
  it("two distinct sk- tokens and one ghp_ token all replaced", () => {
    const sk1 = buildSkTok();
    const sk2 = "sk-" + "Z".repeat(24);
    const ghp = buildGhpTok();
    const input = `first=${sk1} middle=${ghp} last=${sk2}`;
    const output = redactCredentials(input);
    const redactedCount = (output.match(/\[REDACTED\]/g) ?? []).length;
    expect(redactedCount).toBe(3);
    expect(output).not.toContain(sk1);
    expect(output).not.toContain(sk2);
    expect(output).not.toContain(ghp);
  });

  it("two Bearer occurrences both redacted", () => {
    const input = "Bearer aaa.bbb and Bearer ccc-ddd";
    const output = redactCredentials(input);
    expect(output).toBe("[REDACTED] and [REDACTED]");
  });
});

const GLOBAL_PATTERN_CASES: readonly (readonly [string, string])[] = [
  ["sk-", buildSkTok()],
  ["ghp_", buildGhpTok()],
  ["AIza", buildAIZaTok()],
  ["gsk_", buildGskTok()],
  ["nvapi-", buildNvapiTok()],
  ["xai-", buildXaiTok()],
  ["fc-", buildFcTok()],
  ["discord-webhook", "https://discord.com/api/webhooks/123456789/abc_DEF-ghi"],
  ["bearer", "Bearer aaa.bbb"],
];

describe("redactCredentials global flag per pattern", () => {
  it.each(GLOBAL_PATTERN_CASES)("%s: both occurrences redacted", (_label, tok) => {
    const input = `a=${tok} b=${tok} c`;
    const output = redactCredentials(input);
    expect(output).toBe("a=[REDACTED] b=[REDACTED] c");
    expect(output).not.toContain(tok);
  });
});

describe("redactCredentials length thresholds", () => {
  it("sk- with 19 chars is returned unchanged", () => {
    const tok = "sk-" + "A".repeat(19);
    expect(redactCredentials(tok)).toBe(tok);
  });

  it("ghp_ with 19 chars is returned unchanged", () => {
    const tok = "ghp_" + "A".repeat(19);
    expect(redactCredentials(tok)).toBe(tok);
  });

  it("xai- with 19 chars is returned unchanged", () => {
    const tok = "xai-" + "A".repeat(19);
    expect(redactCredentials(tok)).toBe(tok);
  });

  it("sk- with exactly 20 chars is redacted (boundary)", () => {
    const tok = "sk-" + "A".repeat(20);
    const output = redactCredentials(tok);
    expect(output).toBe("[REDACTED]");
  });

  it.each([
    ["ghp_", "ghp_"],
    ["xai-", "xai-"],
  ])("%s with exactly 20 chars is redacted (boundary)", (_label, prefix) => {
    const tok = prefix + "A".repeat(20);
    const output = redactCredentials(tok);
    expect(output).toBe("[REDACTED]");
  });
});

describe("redactCredentials non-credential text", () => {
  it("plain build output is returned byte-identical", () => {
    const input = "plain build output: 42 tests passed, see https://example.com/docs";
    const output = redactCredentials(input);
    expect(output).toBe(input);
  });

  it("empty string returns empty string", () => {
    expect(redactCredentials("")).toBe("");
  });
});

describe("DAEMON_SECRET_ENV_KEYS", () => {
  it("equals the expected array of daemon token keys", () => {
    expect(DAEMON_SECRET_ENV_KEYS).toEqual([
      "PENUMBRA_TOKEN",
      "PENUMBRA_DAEMON_TOKEN",
      "PENUMBRA_JUDGE_TOKEN",
      "PENUMBRA_EMBEDDINGS_TOKEN",
    ]);
  });
});

describe("buildScrubbedChildEnv daemon token drop", () => {
  it("drops all DAEMON_SECRET_ENV_KEYS from result, keeps non-secret extra", () => {
    const prevHome = process.env.HOME;
    process.env.HOME = "/home/test";
    try {
      const extra: Record<string, string> = {};
      for (const key of DAEMON_SECRET_ENV_KEYS) {
        extra[key] = `dummy-${key}`;
      }
      extra.KEEP_ME = "1";
      const result = buildScrubbedChildEnv(undefined, extra);
      for (const key of DAEMON_SECRET_ENV_KEYS) {
        expect(result[key]).toBeUndefined();
      }
      expect(result.KEEP_ME).toBe("1");
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  });

  it("same result with unsetEnv []", () => {
    const prevHome = process.env.HOME;
    process.env.HOME = "/home/test";
    try {
      const extra: Record<string, string> = {};
      for (const key of DAEMON_SECRET_ENV_KEYS) {
        extra[key] = `dummy-${key}`;
      }
      extra.KEEP_ME = "1";
      const result = buildScrubbedChildEnv([], extra);
      for (const key of DAEMON_SECRET_ENV_KEYS) {
        expect(result[key]).toBeUndefined();
      }
      expect(result.KEEP_ME).toBe("1");
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  });
});

describe("buildScrubbedChildEnv allowlist + explicit drop", () => {
  it("HOME dropped from allowlist, CUSTOM_Y from extraEnv included", () => {
    const prevHome = process.env.HOME;
    const prevPath = process.env.PATH;
    process.env.HOME = "/known-home";
    process.env.PATH = "/usr/bin";
    try {
      const result = buildScrubbedChildEnv(["HOME", "CUSTOM_X"], {
        HOME: "/x",
        CUSTOM_X: "1",
        CUSTOM_Y: "2",
      });
      expect(result.HOME).toBeUndefined();
      expect(result.CUSTOM_X).toBeUndefined();
      expect(result.CUSTOM_Y).toBe("2");
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevPath === undefined) delete process.env.PATH;
      else process.env.PATH = prevPath;
    }
  });
});
