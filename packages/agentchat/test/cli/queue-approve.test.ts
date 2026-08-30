import { runApprove } from "@src/cli/approve.js";
import { runQueue } from "@src/cli/queue.js";
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface RequestRecord {
  url: string;
  body: unknown;
}

type FetchImpl = (input: Request | string | URL, init?: RequestInit) => Promise<Response>;

function mkRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "aq-"));
  writeFileSync(join(root, "port"), `1\n`);
  writeFileSync(join(root, "token"), "tk\n");
  return root;
}
function toRequest(input: Request | URL | string, init?: RequestInit): Request {
  if (input instanceof Request) return input;
  if (input instanceof URL) return new Request(input.toString(), init);
  return new Request(input, init);
}

async function expectRejection(promise: Promise<unknown>, matcher: RegExp): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeDefined();
  const message = caught instanceof Error ? caught.message : String(caught);
  expect(message).toMatch(matcher);
}

test("runQueue lists pending handoffs by hitting penumbra", async () => {
  const root = mkRoot();
  const fetchImpl: FetchImpl = () =>
    Promise.resolve(
      Response.json({
        handoffs: [
          {
            handoff_id: "h1111111-aaaa-bbbb-cccc-dddddddddddd",
            ts: "t",
            from_agent: "a",
            to_agent: "b",
            message: "go",
            status: "pending",
            conversation_id: "c",
            project_id: null,
            to_role: null,
            resolved_by: null,
            resolved_at: null,
            redirected_to: null,
            triggered_by_event_id: null,
          },
        ],
      }),
    );

  const rows = await runQueue({ storageRoot: root, fetch: fetchImpl as typeof fetch });
  expect(rows.length).toBe(1);
  expect(rows[0]!.handoff_id).toBe("h1111111-aaaa-bbbb-cccc-dddddddddddd");
});

test("runApprove resolves a short prefix to the matching pending handoff", async () => {
  const requests: RequestRecord[] = [];
  const root = mkRoot();
  const fetchImpl: FetchImpl = async (input, init) => {
    const req = toRequest(input, init);
    const url = new URL(req.url);
    if (url.pathname === "/handoffs/pending") {
      return Response.json({
        handoffs: [
          {
            handoff_id: "abcd1234-aaaa-bbbb-cccc-000000000000",
            ts: "t",
            from_agent: "a",
            to_agent: "b",
            message: "",
            status: "pending",
            conversation_id: "c",
            project_id: null,
            to_role: null,
            resolved_by: null,
            resolved_at: null,
            redirected_to: null,
            triggered_by_event_id: null,
          },
          {
            handoff_id: "ef567890-aaaa-bbbb-cccc-000000000000",
            ts: "t",
            from_agent: "a",
            to_agent: "b",
            message: "",
            status: "pending",
            conversation_id: "c",
            project_id: null,
            to_role: null,
            resolved_by: null,
            resolved_at: null,
            redirected_to: null,
            triggered_by_event_id: null,
          },
        ],
      });
    }
    requests.push({ url: url.pathname, body: await req.json() });
    return Response.json({
      handoff_id: "ef567890-aaaa-bbbb-cccc-000000000000",
      status: "rejected",
    });
  };

  const result = await runApprove({
    storageRoot: root,
    handoffId: "ef56789",
    reject: true,
    fetch: fetchImpl as typeof fetch,
  });
  expect(result.status).toBe("rejected");
  expect(requests[0]!.url).toBe("/handoffs/ef567890-aaaa-bbbb-cccc-000000000000/approve");
});

test("runApprove errors on ambiguous prefix", async () => {
  const root = mkRoot();
  const fetchImpl: FetchImpl = () =>
    Promise.resolve(
      Response.json({
        handoffs: [
          {
            handoff_id: "abcd1234-aaaa-bbbb-cccc-000000000000",
            ts: "t",
            from_agent: "a",
            to_agent: "b",
            message: "",
            status: "pending",
            conversation_id: "c",
            project_id: null,
            to_role: null,
            resolved_by: null,
            resolved_at: null,
            redirected_to: null,
            triggered_by_event_id: null,
          },
          {
            handoff_id: "abcd9999-aaaa-bbbb-cccc-000000000000",
            ts: "t",
            from_agent: "a",
            to_agent: "b",
            message: "",
            status: "pending",
            conversation_id: "c",
            project_id: null,
            to_role: null,
            resolved_by: null,
            resolved_at: null,
            redirected_to: null,
            triggered_by_event_id: null,
          },
        ],
      }),
    );

  await expectRejection(
    runApprove({ storageRoot: root, handoffId: "abcd", fetch: fetchImpl as typeof fetch }),
    /ambiguous/i,
  );
});

test("runApprove errors when prefix matches no pending handoff", async () => {
  const root = mkRoot();
  const fetchImpl: FetchImpl = () => Promise.resolve(Response.json({ handoffs: [] }));

  await expectRejection(
    runApprove({ storageRoot: root, handoffId: "deadbeef", fetch: fetchImpl as typeof fetch }),
    /no pending handoff/i,
  );
});

test("runApprove POSTs approve with optional redirect", async () => {
  let received: RequestRecord | null = null;
  const root = mkRoot();
  const fetchImpl: FetchImpl = async (input, init) => {
    const req = toRequest(input, init);
    received = { url: new URL(req.url).pathname, body: await req.json() };
    return Response.json({
      handoff_id: "h1111111-aaaa-bbbb-cccc-dddddddddddd",
      status: "approved",
    });
  };

  const result = await runApprove({
    storageRoot: root,
    handoffId: "h1111111-aaaa-bbbb-cccc-dddddddddddd",
    fetch: fetchImpl as typeof fetch,
  });
  expect(result.status).toBe("approved");
  expect(received!.url).toBe("/handoffs/h1111111-aaaa-bbbb-cccc-dddddddddddd/approve");

  await runApprove({
    storageRoot: root,
    handoffId: "h1111111-aaaa-bbbb-cccc-dddddddddddd",
    redirectTo: "codex",
    fetch: fetchImpl as typeof fetch,
  });
  expect(received!.body).toEqual({ redirect_to: "codex" });
});

test("runApprove passes resolved_by in the request body", async () => {
  let received: { body: unknown } | null = null;
  const root = mkRoot();
  const fetchImpl: FetchImpl = async (input, init) => {
    const req = toRequest(input, init);
    received = { body: await req.json() };
    return Response.json({
      handoff_id: "h2222222-aaaa-bbbb-cccc-dddddddddddd",
      status: "approved",
    });
  };

  await runApprove({
    storageRoot: root,
    handoffId: "h2222222-aaaa-bbbb-cccc-dddddddddddd",
    resolvedBy: "auto",
    fetch: fetchImpl as typeof fetch,
  });
  expect(received!.body).toEqual({ resolved_by: "auto" });
});
