#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ProfileAgreementReport } from "../packages/core/src/routing/profile-agreement.js";
import type { TypesafeFetch } from "../packages/integrations/typesafe/src/client.js";
import type { TypesafeEnvInput } from "../packages/integrations/typesafe/src/config.js";

import { getConfig, loadTaskRouterConfigFromDir } from "../packages/config/src/index.js";
import {
  dryRunProfileReport,
  fetchProfileReplayRows,
  replayTaskProfiles,
} from "../packages/core/src/routing/profile-agreement.js";
import { resolveAgentChatConfigPath } from "../packages/daemon/src/agentchat-config.js";
import { createTypesafeClient } from "../packages/integrations/typesafe/src/client.js";
import { resolveTypesafeSettings } from "../packages/integrations/typesafe/src/config.js";
import { createJevTaskProfileJudge } from "../packages/integrations/typesafe/src/task-profile.js";

export interface ProfileReplayArgs {
  db: string;
  since: string;
  until: string;
  limit: number;
  live: boolean;
  confidenceFloor: number;
}

export interface ProfileReplayDeps {
  fetch: TypesafeFetch;
  typesafeEnv: TypesafeEnvInput;
  maxRetries?: number;
}

export interface ProfileReplayRunResult {
  report: ProfileAgreementReport;
  db: Database;
}

const DEFAULT_DB_PATH = join(homedir(), ".penumbra", "db.sqlite");
const DEFAULT_LIMIT = 25;
const DEFAULT_UNTIL = "9999-12-31T23:59:59.999Z";

const HELP_TEXT = `Usage: bun scripts/jev-profile-replay.ts --since ISO [options]

Offline task-profile agreement replay over routing_decisions history.
Reads each routed decision's raw prompt (t0_events.payload_json $.prompt),
recomputes the deterministic profile to detect input drift, and — with
--live — re-judges every non-drifted row through Jev, reporting per-axis
agreement against the recorded profile. The DB is opened read-only.

Options:
  --db PATH             SQLite DB path (default ~/.penumbra/db.sqlite)
  --since ISO           required lower bound on routing_decisions.ts (inclusive)
  --until ISO           upper bound on routing_decisions.ts (inclusive)
  --limit N             max rows to replay (default 25)
  --confidence-floor X  Jev confidence floor in [0,1] (default:
                        thresholds.judge_confidence_floor from router.yaml in
                        the resolved penumbra config dir)
  --live                make Jev calls (default: dry run — row counts and
                        input drift only, no client built)
  --help                show this text
`;

export function parseProfileReplayArgs(argv: string[], env: NodeJS.ProcessEnv): ProfileReplayArgs {
  const configDir = resolveAgentChatConfigPath(env);
  const parsed: ProfileReplayArgs = {
    db: DEFAULT_DB_PATH,
    since: "",
    until: DEFAULT_UNTIL,
    limit: DEFAULT_LIMIT,
    live: false,
    confidenceFloor: loadTaskRouterConfigFromDir(configDir).thresholds.judge_confidence_floor,
  };

  const remaining = [...argv];
  const takeValue = (flag: string): string => {
    const value = remaining.shift();
    if (value === undefined) throw new Error(`${flag} requires a value`);
    return value;
  };
  while (remaining.length > 0) {
    const flag = remaining.shift();
    if (flag === undefined) break;
    switch (flag) {
      case "--db":
        parsed.db = takeValue(flag);
        break;
      case "--since":
        parsed.since = takeValue(flag);
        break;
      case "--until":
        parsed.until = takeValue(flag);
        break;
      case "--limit":
        parsed.limit = parsePositiveInt(flag, takeValue(flag));
        break;
      case "--confidence-floor":
        parsed.confidenceFloor = parseConfidenceFloor(takeValue(flag));
        break;
      case "--live":
        parsed.live = true;
        break;
      default:
        throw new Error(`unknown flag: ${flag}`);
    }
  }
  if (parsed.since === "") throw new Error("--since is required");
  return parsed;
}

export async function runProfileReplay(
  args: ProfileReplayArgs,
  deps: ProfileReplayDeps,
): Promise<ProfileReplayRunResult> {
  if (
    !Number.isFinite(args.confidenceFloor) ||
    args.confidenceFloor < 0 ||
    args.confidenceFloor > 1
  ) {
    throw new Error(
      `--confidence-floor must be a number in [0, 1], got ${String(args.confidenceFloor)}`,
    );
  }
  const db = new Database(args.db, { readonly: true });
  try {
    const fetched = fetchProfileReplayRows(db, {
      since: args.since,
      until: args.until,
      limit: args.limit,
    });

    if (!args.live) {
      const report = dryRunProfileReport(fetched);
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return { report, db };
    }

    const settings = resolveTypesafeSettings(deps.typesafeEnv);
    if (!settings.enabled) {
      throw new Error(settings.reason);
    }
    const client = createTypesafeClient({
      settings,
      fetch: deps.fetch,
      maxRetries: deps.maxRetries,
    });
    const judge = createJevTaskProfileJudge({ client, confidenceFloor: args.confidenceFloor });
    const report = await replayTaskProfiles(fetched, { judge });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return { report, db };
  } catch (error) {
    db.close();
    throw error;
  }
}

function parsePositiveInt(flag: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${flag} must be a positive integer, got ${raw}`);
  }
  return value;
}

function parseConfidenceFloor(raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`--confidence-floor must be a number in [0, 1], got ${raw}`);
  }
  return value;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP_TEXT);
    process.exit(0);
  }
  try {
    const args = parseProfileReplayArgs(argv, process.env);
    const { db } = await runProfileReplay(args, {
      fetch: globalThis.fetch,
      typesafeEnv: getConfig(process.env).env as unknown as TypesafeEnvInput,
    });
    db.close();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
