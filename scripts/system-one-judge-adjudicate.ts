import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { mergeReviewPackets } from "./system-one-judge-review.js";

const readRows = (path: string): unknown[] =>
  readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as unknown);

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    options: {
      packet: { type: "string" },
      a: { type: "string" },
      b: { type: "string" },
      adjudication: { type: "string" },
      out: { type: "string" },
    },
  });
  if (!values.packet || !values.a || !values.b || !values.out)
    throw new Error("--packet FILE --a FILE --b FILE [--adjudication FILE] --out NEW_PRIVATE_FILE");
  const packet = readRows(values.packet) as { caseId: string; body: string }[];
  const merged = mergeReviewPackets(
    packet,
    readRows(values.a),
    readRows(values.b),
    values.adjudication ? readRows(values.adjudication) : [],
  );
  writeFileSync(values.out, merged.map((row) => JSON.stringify(row)).join("\n") + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  process.stdout.write(
    JSON.stringify({
      records: merged.length,
      positive: merged.filter((row) => row.promote === true).length,
      negative: merged.filter((row) => row.promote === false).length,
      uncertain: merged.filter((row) => row.promote === null).length,
      method: "independent AI review, not human adjudication",
    }) + "\n",
  );
}
