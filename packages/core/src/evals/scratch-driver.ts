import { redactLessonDraft as mainRedact } from "./scratch-main-redaction.js";

const d = (root: string): Parameters<typeof mainRedact>[0] => ({
  failure_signature: root,
  root_cause: root,
  procedure: [],
  applicability: [],
  exclusions: [],
  counterexample: null,
});

const cases: { text: string; ids?: string[] }[] = [
  { text: "/Users/alex/acme-secret-repo", ids: ["acme-secret-repo"] },
  { text: "db.acme-prod.10.0.0.5.nip.io", ids: ["acme-secret-repo", "db.acme-prod.10.0.0.5.nip.io"] },
  { text: "10.0.0.5:6443", ids: ["10.0.0.5:6443", "admin@10.0.0.5"] },
  { text: "admin@10.0.0.5", ids: ["10.0.0.5:6443", "admin@10.0.0.5"] },
  { text: "page ops@acme.example", ids: ["ted"] },
  { text: "ops@acme.example-prod", ids: ["ops@acme.example-prod"] },
  { text: "alerts@acme.io:8443", ids: ["alerts@acme.io:8443"] },
  { text: "[REDACTED:acme_prod]", ids: ["acme_prod"] },
  { text: "[redacted:acme_prod] x", ids: ["acme_prod"] },
  { text: "dial 10.0.0.1", ids: ["ipv4"] },
  { text: "v 8.8.8.8" },
  { text: "version\n8.8.8.8" },
  { text: "version 1.2.3.4" },
  { text: "v=1.0.0.1" },
  { text: "v 1.2.3.4/24" },
  { text: "release/v1.2.3.4" },
  { text: "v1.2.3.4@acme.example" },
  { text: "cd /home/alex/repo and ping alex", ids: ["alex"] },
  { text: "lock under /Users/alex/work/x", ids: ["alex"] },
  { text: "release v2.0.0.1 then dial 10.0.0.1" },
  { text: "--version=1.2.3.4" },
  { text: "curl -v 10.0.0.5" },
];

for (const c of cases) {
  const res = mainRedact(d(c.text), c.ids === undefined ? undefined : { production_identifiers: c.ids });
  console.log(JSON.stringify({ input: c.text, ids: c.ids ?? null, out: res.draft.failure_signature, hits: res.redactions }));
}
