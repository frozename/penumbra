import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface RunChainSendMessageOpts {
  handoff_id: string;
  content: string;
  storageRoot: string;
  fetch?: typeof fetch;
  print?: (line: string) => void;
}

function defaultPrint(line: string): void {
  process.stdout.write(`${line}\n`);
}

function resolveDaemon(storageRoot: string): { baseUrl: string; token: string } {
  const port = Number(readFileSync(join(storageRoot, "port"), "utf8").trim());
  const token = readFileSync(join(storageRoot, "token"), "utf8").trim();
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`penumbra chain: invalid daemon port in ${join(storageRoot, "port")}`);
  }
  if (!token) {
    throw new Error(`penumbra chain: empty daemon token in ${join(storageRoot, "token")}`);
  }
  return { baseUrl: `http://127.0.0.1:${port}`, token };
}

export async function runChainSendMessage(opts: RunChainSendMessageOpts): Promise<void> {
  const print = opts.print ?? defaultPrint;
  const daemon = resolveDaemon(opts.storageRoot);
  const path = `/chains/${encodeURIComponent(opts.handoff_id)}/messages`;
  const url = `${daemon.baseUrl}${path}`;
  const res = await (opts.fetch ?? fetch)(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${daemon.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ content: opts.content }),
  });
  if (res.ok) {
    print("ok");
    return;
  }
  let detail = "";
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    if (body?.error?.message) detail = body.error.message;
  } catch {
    /* ignore */
  }
  if (res.status === 404) {
    throw new Error(
      `penumbra chain send-message: no live session for handoff ${opts.handoff_id}${detail ? ` (${detail})` : ""}`,
    );
  }
  if (res.status === 409) {
    throw new Error(
      `penumbra chain send-message: adapter does not support mid-session inject${detail ? ` (${detail})` : ""}`,
    );
  }
  if (res.status === 410) {
    throw new Error(
      `penumbra chain send-message: handoff ${opts.handoff_id} is no longer running${detail ? ` (${detail})` : ""}`,
    );
  }
  throw new Error(
    `penumbra chain send-message: daemon ${path} returned HTTP ${res.status}${detail ? ` (${detail})` : ""}`,
  );
}
