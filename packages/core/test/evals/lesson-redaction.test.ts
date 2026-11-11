import { beforeAll, expect, test } from "bun:test";

// Input and output shapes are declared locally: lesson-redaction.ts does not
// exist at the base, so no value or type may be imported from it.
type LessonDraft = {
  project_id: string;
  polarity: "positive" | "negative";
  failure_signature: string;
  root_cause: string;
  procedure: string[];
  applicability: string[];
  exclusions: string[];
  counterexample: string | null;
  created_at: string;
  expires_at: string;
};
type RedactionEntry = { rule_id: string; count: number };
type RedactResult = { draft: LessonDraft; redactions: RedactionEntry[] };
type RedactOpts = { production_identifiers?: string[] };
type RedactFn = (draft: LessonDraft, opts?: RedactOpts) => RedactResult;

const MOD_URL = new URL("../../src/evals/lesson-redaction.ts", import.meta.url).href;

async function load(): Promise<Record<string, unknown> | null> {
  try {
    return (await import(MOD_URL)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

let mod: Record<string, unknown> | null = null;

beforeAll(async () => {
  mod = await load();
});

const redactLessonDraft = (): RedactFn => mod?.["redactLessonDraft"] as RedactFn;

const CREATED_AT = "2026-11-01T00:00:00.000Z";
const EXPIRES_AT = "2027-02-01T00:00:00.000Z";

function draft(overrides: Partial<LessonDraft> = {}): LessonDraft {
  return {
    project_id: "penumbra",
    polarity: "positive",
    failure_signature: "bun test hangs on unclosed sqlite handle",
    root_cause: "db handle left open",
    procedure: ["close db in afterAll"],
    applicability: ["packages/core tests"],
    exclusions: ["daemon integration"],
    counterexample: null,
    created_at: CREATED_AT,
    expires_at: EXPIRES_AT,
    ...overrides,
  };
}

test("redact: production identifiers are replaced in every text field", () => {
  expect(typeof mod?.["redactLessonDraft"]).toBe("function");
  if (!mod) {
    return;
  }
  const id = "db-prod-7.acme.example";
  const input = draft({
    failure_signature: `pool checkout failed on ${id}`,
    root_cause: `connection refused by ${id}`,
    procedure: [`fail over away from ${id}`],
    applicability: [`only while ${id} is primary`],
    exclusions: [`never pin ${id} in config`],
    counterexample: `green while ${id} was healthy`,
  });
  const res = redactLessonDraft()(input, { production_identifiers: [id] });
  expect(res.draft.failure_signature).toBe(
    "pool checkout failed on [REDACTED:production_identifier]",
  );
  expect(res.draft.root_cause).toBe("connection refused by [REDACTED:production_identifier]");
  expect(res.draft.procedure[0]).toBe("fail over away from [REDACTED:production_identifier]");
  expect(res.draft.applicability[0]).toBe("only while [REDACTED:production_identifier] is primary");
  expect(res.draft.exclusions[0]).toBe("never pin [REDACTED:production_identifier] in config");
  expect(res.draft.counterexample).toBe("green while [REDACTED:production_identifier] was healthy");
  expect(res.redactions).toEqual([{ rule_id: "production_identifier", count: 6 }]);
});

test("redact: identifier matching ignores case", () => {
  expect(typeof mod?.["redactLessonDraft"]).toBe("function");
  if (!mod) {
    return;
  }
  const res = redactLessonDraft()(
    draft({ root_cause: "pool exhausted on DB-PROD-7.ACME.EXAMPLE" }),
    { production_identifiers: ["db-prod-7.acme.example"] },
  );
  expect(res.draft.root_cause).toBe("pool exhausted on [REDACTED:production_identifier]");
  expect(res.redactions).toEqual([{ rule_id: "production_identifier", count: 1 }]);
});

test("redact: the longest production identifier wins", () => {
  expect(typeof mod?.["redactLessonDraft"]).toBe("function");
  if (!mod) {
    return;
  }
  const res = redactLessonDraft()(draft({ root_cause: "acme-prod-cluster down" }), {
    production_identifiers: ["acme", "acme-prod-cluster"],
  });
  expect(res.draft.root_cause).toBe("[REDACTED:production_identifier] down");
  expect(res.redactions).toEqual([{ rule_id: "production_identifier", count: 1 }]);
});

test("redact: identifier matching is literal, not regex", () => {
  expect(typeof mod?.["redactLessonDraft"]).toBe("function");
  if (!mod) {
    return;
  }
  const res = redactLessonDraft()(draft({ root_cause: "svcXprod restart loop" }), {
    production_identifiers: ["svc.prod"],
  });
  expect(res.draft.root_cause).toBe("svcXprod restart loop");
  expect(res.redactions).toEqual([]);
});

test("redact: empty and whitespace identifiers are ignored", () => {
  expect(typeof mod?.["redactLessonDraft"]).toBe("function");
  if (!mod) {
    return;
  }
  const input = draft({ root_cause: "db handle left open" });
  const res = redactLessonDraft()(input, { production_identifiers: ["", "  "] });
  expect(res.draft).toEqual(input);
  expect(res.redactions).toEqual([]);
});

test("redact: home paths collapse to ~", () => {
  expect(typeof mod?.["redactLessonDraft"]).toBe("function");
  if (!mod) {
    return;
  }
  const res = redactLessonDraft()(
    draft({
      root_cause: "lock held under /Users/alex/work/x",
      procedure: ["cd /home/bob/repo && bun test"],
    }),
  );
  expect(res.draft.root_cause).toBe("lock held under ~/work/x");
  expect(res.draft.procedure[0]).toBe("cd ~/repo && bun test");
  expect(res.redactions).toEqual([{ rule_id: "home_path", count: 2 }]);
});

test("redact: email and ipv4 built-ins fire while partial addresses stay", () => {
  expect(typeof mod?.["redactLessonDraft"]).toBe("function");
  if (!mod) {
    return;
  }
  const res = redactLessonDraft()(
    draft({
      failure_signature: "dial 10.20.30.40 timed out",
      root_cause: "ops@acme.example bounced the alert",
      procedure: ["ping 1.2.3 for reachability"],
      applicability: ["hosts like 999.1.1.1 are out of scope"],
    }),
  );
  expect(res.draft.failure_signature).toBe("dial [REDACTED:ipv4] timed out");
  expect(res.draft.root_cause).toBe("[REDACTED:email] bounced the alert");
  expect(res.draft.procedure[0]).toBe("ping 1.2.3 for reachability");
  expect(res.draft.applicability[0]).toBe("hosts like 999.1.1.1 are out of scope");
  expect(res.redactions).toEqual([
    { rule_id: "email", count: 1 },
    { rule_id: "ipv4", count: 1 },
  ]);
});

test("redact: scope fields are untouched and the input is not mutated", () => {
  expect(typeof mod?.["redactLessonDraft"]).toBe("function");
  if (!mod) {
    return;
  }
  const id = "db-prod-7.acme.example";
  const input = draft({ project_id: id, counterexample: null });
  const before = structuredClone(input);
  const res = redactLessonDraft()(input, { production_identifiers: [id] });
  expect(res.draft.project_id).toBe(id);
  expect(res.draft.polarity).toBe("positive");
  expect(res.draft.created_at).toBe(CREATED_AT);
  expect(res.draft.expires_at).toBe(EXPIRES_AT);
  expect(res.draft.counterexample).toBeNull();
  expect(res.draft).toEqual(before);
  expect(input).toEqual(before);
  expect(res.redactions).toEqual([]);
});

test("redact: redactions are sorted, omit zero-hit rules, and sum across fields", () => {
  expect(typeof mod?.["redactLessonDraft"]).toBe("function");
  if (!mod) {
    return;
  }
  const res = redactLessonDraft()(
    draft({
      failure_signature: "flaky on db-prod-7.acme.example",
      root_cause: "page ops@acme.example",
      procedure: ["cc admin@acme.example"],
    }),
    { production_identifiers: ["db-prod-7.acme.example"] },
  );
  expect(res.draft.root_cause).toBe("page [REDACTED:email]");
  expect(res.draft.procedure[0]).toBe("cc [REDACTED:email]");
  expect(res.redactions).toEqual([
    { rule_id: "email", count: 2 },
    { rule_id: "production_identifier", count: 1 },
  ]);
});

test("redact: an email is fully redacted even when its domain is a listed identifier", () => {
  expect(typeof mod?.["redactLessonDraft"]).toBe("function");
  if (!mod) {
    return;
  }
  const res = redactLessonDraft()(draft({ root_cause: "page ops@acme.example" }), {
    production_identifiers: ["acme.example"],
  });
  expect(res.draft.root_cause).toBe("page [REDACTED:email]");
  expect(res.redactions).toEqual([{ rule_id: "email", count: 1 }]);
});

test("redact: an email is fully redacted even when its local part is a listed identifier", () => {
  expect(typeof mod?.["redactLessonDraft"]).toBe("function");
  if (!mod) {
    return;
  }
  const res = redactLessonDraft()(draft({ root_cause: "mail alex@acme.example now" }), {
    production_identifiers: ["alex"],
  });
  expect(res.draft.root_cause).toBe("mail [REDACTED:email] now");
  expect(res.redactions).toEqual([{ rule_id: "email", count: 1 }]);
});

test("redact: a home path whose user segment is a listed identifier counts once as home_path", () => {
  expect(typeof mod?.["redactLessonDraft"]).toBe("function");
  if (!mod) {
    return;
  }
  const res = redactLessonDraft()(draft({ root_cause: "lock under /Users/alex/work/x" }), {
    production_identifiers: ["alex"],
  });
  expect(res.draft.root_cause).toBe("lock under ~/work/x");
  expect(res.redactions).toEqual([{ rule_id: "home_path", count: 1 }]);
});

test("redact: an identifier outside the home path is still redacted and counted once", () => {
  expect(typeof mod?.["redactLessonDraft"]).toBe("function");
  if (!mod) {
    return;
  }
  const res = redactLessonDraft()(draft({ root_cause: "cd /home/alex/repo and ping alex" }), {
    production_identifiers: ["alex"],
  });
  expect(res.draft.root_cause).toBe("cd ~/repo and ping [REDACTED:production_identifier]");
  expect(res.redactions).toEqual([
    { rule_id: "home_path", count: 1 },
    { rule_id: "production_identifier", count: 1 },
  ]);
});

test("redact: four-part versions after 'version' or 'v' are not treated as ipv4", () => {
  expect(typeof mod?.["redactLessonDraft"]).toBe("function");
  if (!mod) {
    return;
  }
  const res = redactLessonDraft()(
    draft({
      failure_signature: "bump to version 1.2.3.4",
      root_cause: "Version: 1.2.3.4 ships",
      procedure: ["pin version=1.2.3.4"],
      applicability: ["v 1.2.3.4 only"],
    }),
  );
  expect(res.draft.failure_signature).toBe("bump to version 1.2.3.4");
  expect(res.draft.root_cause).toBe("Version: 1.2.3.4 ships");
  expect(res.draft.procedure[0]).toBe("pin version=1.2.3.4");
  expect(res.draft.applicability[0]).toBe("v 1.2.3.4 only");
  expect(res.redactions).toEqual([]);
});

test("redact: a glued v-prefix is not an ipv4 match", () => {
  expect(typeof mod?.["redactLessonDraft"]).toBe("function");
  if (!mod) {
    return;
  }
  const res = redactLessonDraft()(draft({ root_cause: "v1.2.3.4" }));
  expect(res.draft.root_cause).toBe("v1.2.3.4");
  expect(res.redactions).toEqual([]);
});

test("redact: ipv4 redaction is not suppressed by a v inside a word", () => {
  expect(typeof mod?.["redactLessonDraft"]).toBe("function");
  if (!mod) {
    return;
  }
  const res = redactLessonDraft()(draft({ root_cause: "dev 10.20.30.40" }));
  expect(res.draft.root_cause).toBe("dev [REDACTED:ipv4]");
  expect(res.redactions).toEqual([{ rule_id: "ipv4", count: 1 }]);
});

test("redact: glued v-versions stay while bare addresses are redacted", () => {
  expect(typeof mod?.["redactLessonDraft"]).toBe("function");
  if (!mod) {
    return;
  }
  const res = redactLessonDraft()(draft({ root_cause: "release v2.0.0.1 then dial 10.0.0.1" }));
  expect(res.draft.root_cause).toBe("release v2.0.0.1 then dial [REDACTED:ipv4]");
  expect(res.redactions).toEqual([{ rule_id: "ipv4", count: 1 }]);
});

test("redact: a listed identifier does not match inside an existing placeholder", () => {
  expect(typeof mod?.["redactLessonDraft"]).toBe("function");
  if (!mod) {
    return;
  }
  const res = redactLessonDraft()(draft({ root_cause: "page ops@acme.example" }), {
    production_identifiers: ["ted"],
  });
  expect(res.draft.root_cause).toBe("page [REDACTED:email]");
  expect(res.redactions).toEqual([{ rule_id: "email", count: 1 }]);
});

test("redact: identifier redaction composes with email redaction", () => {
  expect(typeof mod?.["redactLessonDraft"]).toBe("function");
  if (!mod) {
    return;
  }
  const res = redactLessonDraft()(draft({ root_cause: "page ops@acme.example on red" }), {
    production_identifiers: ["red"],
  });
  expect(res.draft.root_cause).toBe("page [REDACTED:email] on [REDACTED:production_identifier]");
  expect(res.redactions).toEqual([
    { rule_id: "email", count: 1 },
    { rule_id: "production_identifier", count: 1 },
  ]);
});

test("redact: built-in ipv4 placeholder is not re-scanned by identifiers", () => {
  expect(typeof mod?.["redactLessonDraft"]).toBe("function");
  if (!mod) {
    return;
  }
  const res = redactLessonDraft()(draft({ root_cause: "dial 10.0.0.1" }), {
    production_identifiers: ["ipv4"],
  });
  expect(res.draft.root_cause).toBe("dial [REDACTED:ipv4]");
  expect(res.redactions).toEqual([{ rule_id: "ipv4", count: 1 }]);
});

test("redact: addresses after a -v CLI flag are still redacted", () => {
  expect(typeof mod?.["redactLessonDraft"]).toBe("function");
  if (!mod) {
    return;
  }
  const res = redactLessonDraft()(draft({ root_cause: "curl -v 10.0.0.5" }));
  expect(res.draft.root_cause).toBe("curl -v [REDACTED:ipv4]");
  expect(res.redactions).toEqual([{ rule_id: "ipv4", count: 1 }]);
});

test("redact: multiple -v flag addresses are all redacted", () => {
  expect(typeof mod?.["redactLessonDraft"]).toBe("function");
  if (!mod) {
    return;
  }
  const res = redactLessonDraft()(
    draft({ root_cause: "ssh -v 192.168.1.10 then tcpdump -v 10.0.0.1" }),
  );
  expect(res.draft.root_cause).toBe("ssh -v [REDACTED:ipv4] then tcpdump -v [REDACTED:ipv4]");
  expect(res.redactions).toEqual([{ rule_id: "ipv4", count: 2 }]);
});

test("redact: a --version flag does not suppress ipv4 redaction", () => {
  expect(typeof mod?.["redactLessonDraft"]).toBe("function");
  if (!mod) {
    return;
  }
  const res = redactLessonDraft()(draft({ root_cause: "--version=1.2.3.4" }));
  expect(res.draft.root_cause).toBe("--version=[REDACTED:ipv4]");
  expect(res.redactions).toEqual([{ rule_id: "ipv4", count: 1 }]);
});

test("redact: newline/tab after version does not suppress ipv4 redaction", () => {
  expect(typeof mod?.["redactLessonDraft"]).toBe("function");
  if (!mod) {
    return;
  }
  const res = redactLessonDraft()(
    draft({
      failure_signature: "version\n10.0.0.12",
      root_cause: "version\t10.0.0.11",
    }),
  );
  expect(res.draft.failure_signature).toBe("version\n[REDACTED:ipv4]");
  expect(res.draft.root_cause).toBe("version\t[REDACTED:ipv4]");
  expect(res.redactions).toEqual([{ rule_id: "ipv4", count: 2 }]);
});

test("redact: 'see v', 'V:', '/v' with space followed by IPv4 is redacted", () => {
  expect(typeof mod?.["redactLessonDraft"]).toBe("function");
  if (!mod) {
    return;
  }
  const res = redactLessonDraft()(
    draft({
      failure_signature: "see v 10.0.0.1",
      root_cause: "V: 172.16.0.9",
    }),
  );
  expect(res.draft.failure_signature).toBe("see v [REDACTED:ipv4]");
  expect(res.draft.root_cause).toBe("V: [REDACTED:ipv4]");
  expect(res.redactions).toEqual([{ rule_id: "ipv4", count: 2 }]);
});

test("redact: '/v 10.0.0.1' and 'version=10.1.2.3' are redacted", () => {
  expect(typeof mod?.["redactLessonDraft"]).toBe("function");
  if (!mod) {
    return;
  }
  const res = redactLessonDraft()(
    draft({
      failure_signature: "/v 10.0.0.1",
      root_cause: "version=10.1.2.3",
    }),
  );
  expect(res.draft.failure_signature).toBe("/v [REDACTED:ipv4]");
  expect(res.draft.root_cause).toBe("version=[REDACTED:ipv4]");
  expect(res.redactions).toEqual([{ rule_id: "ipv4", count: 2 }]);
});

test("redact: identifier containing a built-in match is redacted whole", () => {
  expect(typeof mod?.["redactLessonDraft"]).toBe("function");
  if (!mod) {
    return;
  }
  const res = redactLessonDraft()(
    draft({
      failure_signature: "/Users/alex/acme-secret-repo",
      root_cause: "db.acme-prod.10.0.0.5.nip.io",
    }),
    { production_identifiers: ["acme-secret-repo", "db.acme-prod.10.0.0.5.nip.io"] },
  );
  expect(res.draft.failure_signature).toBe("~/[REDACTED:production_identifier]");
  expect(res.draft.root_cause).toBe("[REDACTED:production_identifier]");
  expect(res.redactions).toEqual([{ rule_id: "production_identifier", count: 2 }]);
});

test("redact: identifier containing an IPv4 and email is redacted whole", () => {
  expect(typeof mod?.["redactLessonDraft"]).toBe("function");
  if (!mod) {
    return;
  }
  const res = redactLessonDraft()(
    draft({
      failure_signature: "10.0.0.5:6443",
      root_cause: "admin@10.0.0.5",
    }),
    { production_identifiers: ["10.0.0.5:6443", "admin@10.0.0.5"] },
  );
  expect(res.draft.failure_signature).toBe("[REDACTED:production_identifier]");
  expect(res.draft.root_cause).toBe("[REDACTED:production_identifier]");
  expect(res.redactions).toEqual([{ rule_id: "production_identifier", count: 2 }]);
});
