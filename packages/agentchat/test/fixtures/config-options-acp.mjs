import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [logPath, encoded] = process.argv.slice(2);
const scenario = JSON.parse(encoded);
let configOptions = scenario.configOptions;
let sets = 0;
let sessions = 0;
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  appendFileSync(logPath, JSON.stringify(request) + "\n");
  let result = {};
  if (request.method === "initialize") result = { protocolVersion: 1, authMethods: [] };
  if (request.method === "session/new") {
    sessions++;
    configOptions = structuredClone(scenario.configOptions);
    result = {
      sessionId: sessions === 1 ? "fixture-session" : `fixture-session-${sessions}`,
      configOptions,
      models: scenario.models,
    };
  }
  if (request.method === "session/set_config_option") {
    sets++;
    if (scenario.hangAt === sets) continue;
    if (scenario.rejectAt === sets) {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32602, message: "fixture refused pin" },
        }) + "\n",
      );
      continue;
    }
    configOptions = configOptions.map((option) =>
      option.id === request.params.configId
        ? { ...option, currentValue: request.params.value }
        : option,
    );
    result = scenario.responses?.[sets - 1] ?? { configOptions };
    if (result.configOptions !== undefined) configOptions = result.configOptions;
  }
  if (request.method === "session/prompt") result = { stopReason: "end_turn" };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
}
