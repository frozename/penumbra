import { test } from "bun:test";

export const RUN_AGENTCHAT_SERVICE_TESTS =
  process.env.PENUMBRA_AGENTCHAT_SERVICE_TESTS === "1" || process.env.PENUMBRA_E2E === "1";

export const serviceTest = test.skipIf(!RUN_AGENTCHAT_SERVICE_TESTS);
