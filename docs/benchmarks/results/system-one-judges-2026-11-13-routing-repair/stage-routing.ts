import { getConfig } from "../../../../packages/config/src/index.ts";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { collectLlamactlInventory } from "../../../../packages/core/src/services/llamactl-inventory.ts";
import { buildDreamingConfig } from "../../../../packages/daemon/src/dreaming/config.ts";
import { createDreamingRewriterCandidates } from "../../../../packages/daemon/src/dreaming/deps.ts";
import { resolveRewriterCandidatesAgainstInventory } from "../../../../packages/daemon/src/dreaming/rewriter-inventory.ts";

if (!process.argv.includes("--live")) throw new Error("Read-only live proof requires --live");
const registry = await import("/Volumes/AI-DATA/maestro/repos/personal/llamactl/packages/core/src/config/kubeconfig.ts");
const path = registry.defaultConfigPath();
const before = readFileSync(path);
const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const config = registry.loadConfig(path);
const context = registry.currentContext(config);
const entry = { name: "mini-on-demand", kind: "gateway", endpoint: "", cloud: { provider: "openai-compatible", baseUrl: "http://127.0.0.1:18944/v1", displayName: "Mini on-demand judges" } };
const staged = registry.upsertNode(config, context.cluster, entry);
const clone = "/Volumes/AI-DATA/maestro/bench/system-one-judges-20261113-routing-repair/staged-llamactl-config.json";
writeFileSync(clone, JSON.stringify(staged), { flag: "wx", mode: 0o600 });
registry.loadConfig(clone);
const candidates = createDreamingRewriterCandidates(buildDreamingConfig(getConfig()));
const inventory = await collectLlamactlInventory({ env: { ...process.env, LLAMACTL_CONFIG: clone }, includeLocalGateways: true, includeCatalog: false, timeoutMs: 1000 });
const selected = await resolveRewriterCandidatesAgainstInventory({ candidates, inventory: { collect: () => Promise.resolve(inventory) } });
if (sha(readFileSync(path)) !== sha(before)) throw new Error("Live registry changed");
if (selected.length !== 1 || selected[0]?.baseUrl !== entry.cloud.baseUrl || !selected[0]?.model.toLowerCase().includes("granite"))
  throw new Error("Staged registry did not select exactly configured local Granite");
const proof = {
  liveRegistryUnchanged: true, liveRegistrySha256: sha(before), stagedRegistrySha256: sha(readFileSync(clone)),
  entry, inventoryStatus: inventory.status,
  modelCatalog: inventory.models.filter(x => x.node?.kind === "gateway").map(x => ({ id: x.id, experimental: x.experimental, node: x.node?.name, endpoint: x.node?.endpoint, healthy: x.node?.healthy })),
  configuredCandidates: candidates.map(x => ({ model: x.model, baseUrl: x.baseUrl })),
  selected: selected.map(x => ({ model: x.model, baseUrl: x.baseUrl })),
  method: "Current llamactl schema/load/upsert against a private clone; actual loopback GET /v1/models and actual role resolver/filter. No weight loading, credentials published, live registry writes, inference calls or production source cutover. Activate registration only after the safe source/cache migration is deployed."
};
writeFileSync(fileURLToPath(new URL("./staged-routing-proof.json", import.meta.url)), JSON.stringify(proof,null,2)+"\n", { flag: "wx" });
console.log(JSON.stringify(proof));
