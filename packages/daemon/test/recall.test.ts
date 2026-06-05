import { expect } from "bun:test";
import { serviceTest } from "./helpers/service-gates.js";
import { makeTempDaemon } from "./helpers.js";

serviceTest("POST /recall returns empty array when DB is empty", async () => {
  const d = makeTempDaemon();
  try {
    const res = await fetch(`${d.url}/recall`, {
      method: "POST",
      headers: { authorization: `Bearer ${d.token}`, "content-type": "application/json" },
      body: JSON.stringify({ query: "x", project_id: null }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ results: [] });
  } finally {
    d.stop();
  }
});

serviceTest("POST /recall with invalid input returns 400", async () => {
  const d = makeTempDaemon();
  try {
    const res = await fetch(`${d.url}/recall`, {
      method: "POST",
      headers: { authorization: `Bearer ${d.token}`, "content-type": "application/json" },
      body: JSON.stringify({ query: "" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");
  } finally {
    d.stop();
  }
});

serviceTest("POST /recall accepts a body without project_id (omitted → null)", async () => {
  const d = makeTempDaemon();
  try {
    const res = await fetch(`${d.url}/recall`, {
      method: "POST",
      headers: { authorization: `Bearer ${d.token}`, "content-type": "application/json" },
      body: JSON.stringify({ query: "x" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ results: [] });
    const row = d.services.db
      .query<{ project_id: string | null }, []>("SELECT project_id FROM recall_audit")
      .get();
    expect(row?.project_id).toBeNull();
  } finally {
    d.stop();
  }
});

serviceTest("POST /recall strips <private> blocks from the query before audit", async () => {
  const d = makeTempDaemon();
  try {
    const res = await fetch(`${d.url}/recall`, {
      method: "POST",
      headers: { authorization: `Bearer ${d.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        query: "how do I <private>nuke-code-42</private>deploy the edge worker",
        project_id: null,
      }),
    });
    expect(res.status).toBe(200);
    const row = d.services.db
      .query<{ query_text: string }, []>("SELECT query_text FROM recall_audit")
      .get();
    expect(row?.query_text).toBe("how do I deploy the edge worker");
    expect(row?.query_text).not.toContain("nuke-code-42");
  } finally {
    d.stop();
  }
});
