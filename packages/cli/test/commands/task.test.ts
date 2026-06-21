import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  runTaskCancel,
  runTaskList,
  runTaskNew,
  runTaskReview,
  runTaskShow,
  runTaskWatch,
} from "../../src/commands/task.js";

let storageRoot = "";

beforeEach(() => {
  storageRoot = mkdtempSync(join(tmpdir(), "penumbra-task-cli-"));
  writeFileSync(join(storageRoot, "port"), "4242\n");
  writeFileSync(join(storageRoot, "token"), "tok\n");
});

afterEach(() => {
  if (storageRoot) rmSync(storageRoot, { recursive: true, force: true });
});

test("task new/list/show/cancel/list filter", async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  let taskId = "";
  let taskStatus = "pending";
  const fetch = (url: string | URL, init?: RequestInit): Promise<Response> => {
    const urlStr = typeof url === "string" ? url : url.toString();
    requests.push({ url: urlStr, init });
    const parsed = new URL(urlStr, "http://127.0.0.1:4242");
    const pathname = `${parsed.pathname}${parsed.search}`;
    if (pathname === "/tasks" && init?.method === "POST") {
      taskId = "task_123";
      return Promise.resolve(new Response(JSON.stringify({ task_id: taskId }), { status: 201 }));
    }
    if (pathname === `/tasks/${taskId}?include=lease,events` || pathname === `/tasks/${taskId}`) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: taskId,
            created_at: 1,
            updated_at: 1,
            created_by_kind: "human",
            created_by_id: "cli",
            parent_task_id: null,
            kind: "work",
            priority: "high",
            prompt: "test",
            acceptance_criteria: null,
            expected_artifacts: null,
            eligibility: {},
            review_eligibility: null,
            requires_review: false,
            status: taskStatus,
            result_summary: null,
            result_artifacts: null,
            failure_reason: null,
            chain_id: null,
            origin: "cli",
          }),
          { status: 200 },
        ),
      );
    }
    if (pathname === `/tasks/${taskId}/cancel` && init?.method === "POST") {
      taskStatus = "cancelled";
      return Promise.resolve(new Response(JSON.stringify({ task_id: taskId }), { status: 200 }));
    }
    if (pathname.startsWith("/tasks") && init?.method !== "POST" && !pathname.endsWith("/cancel")) {
      const task = {
        id: taskId,
        created_at: 1,
        updated_at: 1,
        created_by_kind: "human",
        created_by_id: "cli",
        parent_task_id: null,
        kind: "work",
        priority: "high",
        prompt: "test",
        acceptance_criteria: null,
        expected_artifacts: null,
        eligibility: {},
        review_eligibility: null,
        requires_review: false,
        status: taskStatus,
        result_summary: null,
        result_artifacts: null,
        failure_reason: null,
        chain_id: null,
        origin: "cli",
      };
      return Promise.resolve(
        new Response(JSON.stringify({ tasks: taskStatus === "pending" ? [task] : [] }), {
          status: 200,
        }),
      );
    }
    throw new Error(`unexpected ${pathname}`);
  };

  const created: string[] = [];
  await runTaskNew({
    prompt: "test",
    priority: "high",
    storageRoot,
    fetch,
    print: (line) => created.push(line),
  });
  expect(created).toEqual(["task_123"]);

  const listed: string[] = [];
  await runTaskList({ json: true, storageRoot, fetch, print: (line) => listed.push(line) });
  const listBody = JSON.parse(listed.join("\n")) as {
    tasks: { id: string; priority: string }[];
  };
  expect(listBody.tasks[0]?.id).toBe(taskId);
  expect(listBody.tasks[0]?.priority).toBe("high");

  const mine: string[] = [];
  await runTaskList({
    mine: true,
    json: true,
    storageRoot,
    fetch,
    print: (line) => mine.push(line),
  });
  expect(requests.some((req) => req.url.includes("origin=cli"))).toBe(true);

  const shown: string[] = [];
  await runTaskShow({
    id: taskId,
    json: true,
    storageRoot,
    fetch,
    print: (line) => shown.push(line),
  });
  const shownBody = JSON.parse(shown.join("\n")) as { id: string };
  expect(shownBody).toMatchObject({ id: taskId });

  await runTaskCancel({ id: taskId, storageRoot, fetch });

  const filtered: string[] = [];
  await runTaskList({
    status: "pending",
    json: true,
    storageRoot,
    fetch,
    print: (line) => filtered.push(line),
  });
  const filteredBody = JSON.parse(filtered.join("\n")) as { tasks: { id: string }[] };
  expect(filteredBody.tasks.some((task) => task.id === taskId)).toBe(false);
});

test("task watch prints filed events", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller): void {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode(": ok\n\n"));
      setTimeout(() => {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ kind: "filed", task_id: "task_abc", actor: "cli", ts: "2026-05-05T12:00:00.000Z" })}\n\n`,
          ),
        );
        controller.close();
      }, 10);
    },
  });
  const lines: string[] = [];
  await runTaskWatch({
    storageRoot,
    fetch: () =>
      Promise.resolve(
        new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      ),
    print: (line) => lines.push(line),
  });
  expect(lines).toContain("[2026-05-05T12:00:00.000Z] filed task=task_abc actor=cli");
});

test("task review writes scaffold to a private mkdtemp dir, not a predictable shared path", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "penumbra-task-review-test-"));
  try {
    const capturePath = join(workDir, "captured");
    const editorScript = join(workDir, "editor.sh");
    writeFileSync(
      editorScript,
      [
        "#!/bin/sh",
        'parent=$(dirname "$1")',
        `mode=$(stat -f '%Lp' "$parent" 2>/dev/null || stat -c '%a' "$parent")`,
        `printf '%s\\n%s\\n' "$1" "$mode" > ${capturePath}`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    const id = "task_review_1";
    const predictablePath = join(process.env.TMPDIR ?? "/tmp", `penumbra-task-review-${id}.yaml`);

    const fetch = (url: string | URL, init?: RequestInit): Promise<Response> => {
      const urlStr = typeof url === "string" ? url : url.toString();
      const pathname = new URL(urlStr, "http://127.0.0.1:4242").pathname;
      if (pathname === "/tasks/lease" && init?.method === "POST") {
        return Promise.resolve(
          new Response(JSON.stringify({ task_id: id, lease_id: "lease_1", expires_at: 0 }), {
            status: 200,
          }),
        );
      }
      if (pathname === `/tasks/${id}`) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id,
              created_at: 1,
              updated_at: 1,
              created_by_kind: "human",
              created_by_id: "cli",
              parent_task_id: null,
              kind: "review",
              priority: "high",
              prompt: "p",
              acceptance_criteria: "ac",
              expected_artifacts: null,
              eligibility: {},
              review_eligibility: null,
              requires_review: false,
              status: "leased",
              result_summary: null,
              result_artifacts: null,
              failure_reason: null,
              chain_id: null,
              origin: "cli",
            }),
            { status: 200 },
          ),
        );
      }
      if (pathname === `/tasks/${id}/complete` && init?.method === "POST") {
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      }
      throw new Error(`unexpected ${pathname}`);
    };

    await runTaskReview({
      id,
      storageRoot,
      fetch,
      editor: editorScript,
      print: () => {
        /* discard */
      },
    });

    const captured = readFileSync(capturePath, "utf8").trim().split("\n");
    const usedPath = captured[0] ?? "";
    const parentMode = captured[1] ?? "";

    expect(usedPath).not.toBe(predictablePath);
    expect(usedPath.endsWith("/review.yaml")).toBe(true);
    expect(dirname(usedPath).startsWith(join(tmpdir(), "penumbra-task-review-"))).toBe(true);
    expect(parentMode).toBe("700");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("task new with gh_create prints task id and queued status", async () => {
  let postedBody: unknown;
  const lines: string[] = [];
  await runTaskNew({
    prompt: "wire task gh create",
    gh_repo: "acordeiro/penumbra",
    gh_title: "Custom GH title",
    gh_labels: ["tasks", "phase-2"],
    gh_assignees: ["acordeiro"],
    storageRoot,
    fetch: (_url, init) => {
      const bodyStr = typeof init?.body === "string" ? init.body : "{}";
      postedBody = JSON.parse(bodyStr);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            task_id: "task_gh_1",
            gh_create_status: "queued",
            gh_create_error: null,
          }),
          { status: 201 },
        ),
      );
    },
    print: (line) => lines.push(line),
  });

  expect(postedBody).toMatchObject({
    prompt: "wire task gh create",
    gh_create: {
      repo: "acordeiro/penumbra",
      title: "Custom GH title",
      labels: ["tasks", "phase-2"],
      assignees: ["acordeiro"],
    },
  });
  expect(lines).toEqual(["task_gh_1", "gh_create_status=queued"]);
});
