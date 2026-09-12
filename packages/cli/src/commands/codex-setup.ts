import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

/* eslint-disable sonarjs/cognitive-complexity -- Ownership preflight intentionally evaluates all conflict branches before mutation. */

export type CodexSetupState = "installed" | "absent" | "unavailable" | "unknown" | "conflict";
export type CodexSetupMode = "plugin" | "standalone";
export type CodexSetupAction = "install" | "status" | "repair" | "uninstall";

// prettier-ignore
export interface CodexSetupHostResult { ok: boolean; installed?: boolean; detail?: string }
// prettier-ignore
export interface CodexSetupHost { plugin: { state: "supported" | "unavailable" | "unknown"; detail?: string; identifier?: string; installArgv?: string[]; statusArgv?: string[]; uninstallArgv?: string[] }; invoke(argv: readonly string[]): Promise<CodexSetupHostResult> }
// prettier-ignore
export interface CodexSetupOptions { action: CodexSetupAction; mode: CodexSetupMode; codexDir: string; skillsDir: string; packageDir: string; storageRoot: string; mcpEntrypoint: string; host?: CodexSetupHost }
// prettier-ignore
export interface CodexSetupComponent { state: CodexSetupState; detail: string }
// prettier-ignore
export interface CodexSetupResult { ok: boolean; changed: boolean; reason?: string; mode: CodexSetupMode; components: { mcp: CodexSetupComponent; skills: CodexSetupComponent; hooks: CodexSetupComponent; telemetry: CodexSetupComponent } }
// prettier-ignore
interface ArtifactRecord { path: string; hash: string }
// prettier-ignore
interface SkillRecord { name: string; destination: string; artifacts: ArtifactRecord[]; conflictPaths?: string[] }
// prettier-ignore
interface InstallationManifest { schemaVersion: 1; mode: CodexSetupMode; codexDir: string; skillsDir: string; packageDir: string; storageRoot: string; mcpEntrypoint: string; mcp?: { configPath: string; blockHash: string; separator: string }; skills: SkillRecord[]; plugin?: { identifier: string } }
// prettier-ignore
interface SourceArtifact extends ArtifactRecord { source: string }
// prettier-ignore
interface SourceSkill { name: string; destination: string; artifacts: SourceArtifact[] }
// prettier-ignore
interface ManagedBlock { block: string; start: number; end: number }

const MCP_HEADER = "# penumbra: managed [mcp_servers.penumbra] block - do not edit between markers";
const MCP_FOOTER = "# penumbra: end managed [mcp_servers.penumbra] block";

type VerifiedPlugin = Required<Omit<CodexSetupHost["plugin"], "detail">> & { detail?: string };

class SetupFailure extends Error {
  constructor(
    message: string,
    readonly component: "mcp" | "skills" = "skills",
    readonly state: CodexSetupState = "conflict",
  ) {
    super(message);
  }
}

function requirePlugin(opts: CodexSetupOptions): { host: CodexSetupHost; plugin: VerifiedPlugin } {
  const host = opts.host;
  const plugin = host?.plugin;
  if (!host || plugin?.state !== "supported") {
    throw new SetupFailure(
      plugin?.detail ?? "Codex plugin installation support is unavailable",
      "skills",
      plugin?.state === "unknown" ? "unknown" : "unavailable",
    );
  }
  if (!plugin.identifier || !plugin.installArgv || !plugin.statusArgv || !plugin.uninstallArgv) {
    throw new SetupFailure(
      "supported plugin adapter is missing its verified identifier or argv arrays",
      "skills",
      "unavailable",
    );
  }
  return { host, plugin: plugin as VerifiedPlugin };
}

// prettier-ignore
function requirePluginInstalled(result: CodexSetupHostResult): void { if (!result.ok || result.installed !== true) throw new SetupFailure(result.detail ?? "verified Codex plugin adapter did not confirm installation", "skills", "unavailable") }

// prettier-ignore
function hash(content: Uint8Array | string): string { return createHash("sha256").update(content).digest("hex") }

// prettier-ignore
function component(state: CodexSetupState, detail: string): CodexSetupComponent { return { state, detail } }

// prettier-ignore
function telemetryState(storageRoot: string): CodexSetupComponent {
  try {
    const stat = lstatSync(join(storageRoot, "port"), { throwIfNoEntry: false })
    if (!stat) return component("absent", "daemon connection state is absent; telemetry was not installed")
    return component("unknown", stat.isSymbolicLink() || !stat.isFile() ? "daemon connection state is not a regular file" : "daemon connection files exist; live telemetry was not probed")
  } catch { return component("unknown", "daemon connection state is unreadable") }
}

// prettier-ignore
function baseComponents(opts: CodexSetupOptions): CodexSetupResult["components"] { return {
  mcp: component("absent", "Penumbra MCP configuration is absent"), skills: component("absent", "Penumbra skill installation is absent"),
  hooks: component("absent", "Codex hooks remain absent until phase 3"), telemetry: telemetryState(opts.storageRoot),
} }

// prettier-ignore
function failureResult(opts: CodexSetupOptions, error: unknown): CodexSetupResult {
  const failure = error instanceof SetupFailure ? error : new SetupFailure(`${(error as NodeJS.ErrnoException).code ?? "error"}: ${error instanceof Error ? error.message : String(error)}`)
  const components = baseComponents(opts); components[failure.component] = component(failure.state, failure.message)
  return { ok: false, changed: false, reason: failure.message, mode: opts.mode, components }
}

// prettier-ignore
function validateAbsolutePaths(opts: CodexSetupOptions): void {
  const paths = { codexDir: opts.codexDir, skillsDir: opts.skillsDir, packageDir: opts.packageDir, storageRoot: opts.storageRoot, mcpEntrypoint: opts.mcpEntrypoint }
  for (const [name, value] of Object.entries(paths)) if (!isAbsolute(value) || resolve(value) !== value) throw new SetupFailure(`${name} must be an absolute normalized path: ${value}`)
}

// prettier-ignore
function assertContained(root: string, candidate: string, label: string): void {
  const rel = relative(root, candidate); if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) return
  throw new SetupFailure(`${label} escapes ${root}: ${candidate}`)
}

function assertNoSymlinkPath(path: string, requireExisting = false): void {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  const parts = absolute.slice(root.length).split(sep).filter(Boolean);
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    if (!part) continue;
    current = join(current, part);
    let stat;
    try {
      stat = lstatSync(current, { throwIfNoEntry: false });
    } catch (error) {
      throw new SetupFailure(
        `${(error as NodeJS.ErrnoException).code ?? "error"}: cannot inspect ${current}`,
      );
    }
    if (!stat) {
      if (requireExisting) throw new SetupFailure(`required path is absent: ${path}`);
      return;
    }
    if (stat.isSymbolicLink())
      throw new SetupFailure(`symlinked path component is not allowed: ${current}`);
    if (index < parts.length - 1 && !stat.isDirectory()) {
      throw new SetupFailure(`non-directory path component is not allowed: ${current}`);
    }
  }
  if (requireExisting && realpathSync(absolute) !== absolute) {
    throw new SetupFailure(`path is not canonical: ${path}`);
  }
}

// prettier-ignore
function assertRegularFile(path: string, label: string): void {
  assertNoSymlinkPath(path, true); if (!lstatSync(path).isFile()) throw new SetupFailure(`${label} is not a regular file: ${path}`)
}

function nearestExisting(path: string): string {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

function assertWritableTarget(path: string): void {
  const existing = nearestExisting(path);
  assertNoSymlinkPath(existing, true);
  try {
    accessSync(existing, constants.W_OK);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat?.isFile()) accessSync(path, constants.W_OK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "EACCES";
    throw new SetupFailure(`${code}: destination is not writable: ${path}`);
  }
}

function atomicWrite(path: string, content: Uint8Array | string, mode?: number): void {
  assertNoSymlinkPath(path);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${parse(path).base}.penumbra-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, content, { flag: "wx", ...(mode === undefined ? {} : { mode }) });
    renameSync(temporary, path);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // The rename already consumed the adjacent temporary file.
    }
  }
}

function parseToml(content: string): Record<string, unknown> {
  try {
    return Bun.TOML.parse(content) as Record<string, unknown>;
  } catch (error) {
    throw new SetupFailure(`malformed Codex config.toml: ${(error as Error).message}`, "mcp");
  }
}

// prettier-ignore
function markerRegex(marker: string): RegExp { return new RegExp(`^${marker.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "gm") }

function findManagedBlock(content: string): ManagedBlock | undefined {
  const headers = [...content.matchAll(markerRegex(MCP_HEADER))];
  const footers = [...content.matchAll(markerRegex(MCP_FOOTER))];
  if (headers.length !== footers.length || headers.length > 1) {
    throw new SetupFailure("malformed or duplicate Penumbra MCP ownership markers", "mcp");
  }
  const header = headers[0];
  const footer = footers[0];
  if (!header || !footer) return undefined;
  const start = header.index;
  const footerStart = footer.index;
  if (footerStart <= start)
    throw new SetupFailure("unbalanced Penumbra MCP ownership markers", "mcp");
  const footerEnd = footerStart + MCP_FOOTER.length;
  const end = content[footerEnd] === "\n" ? footerEnd + 1 : footerEnd;
  return { block: content.slice(start, end), start, end };
}

// prettier-ignore
function penumbraMcpEntry(parsed: Record<string, unknown>): unknown {
  const servers = parsed.mcp_servers; return servers && typeof servers === "object" ? (servers as Record<string, unknown>).penumbra : undefined
}

// prettier-ignore
function desiredMcpBlock(opts: CodexSetupOptions): string { return [
  MCP_HEADER, "[mcp_servers.penumbra]", `command = ${JSON.stringify(realpathSync(process.execPath))}`,
  `args = [${JSON.stringify(opts.mcpEntrypoint)}]`, `env = { PENUMBRA_STORAGE_ROOT = ${JSON.stringify(opts.storageRoot)} }`, MCP_FOOTER, "",
].join("\n") }

function validateManifest(candidate: InstallationManifest, opts: CodexSetupOptions): void {
  if (candidate.codexDir !== opts.codexDir || candidate.skillsDir !== opts.skillsDir) {
    throw new SetupFailure(
      "ownership record destinations do not match the requested Codex profile",
    );
  }
  if (
    candidate.mcp &&
    (candidate.mcp.configPath !== join(opts.codexDir, "config.toml") ||
      !/^[a-f0-9]{64}$/.test(candidate.mcp.blockHash) ||
      !["", "\n", "\n\n"].includes(candidate.mcp.separator))
  ) {
    throw new SetupFailure("ownership record contains an invalid MCP destination", "mcp");
  }
  const names = new Set<string>();
  for (const skill of candidate.skills) {
    if (
      typeof skill.name !== "string" ||
      !skill.name.startsWith("penumbra-") ||
      names.has(skill.name) ||
      skill.destination !== join(opts.skillsDir, skill.name) ||
      !Array.isArray(skill.artifacts)
    ) {
      throw new SetupFailure("ownership record contains an invalid skill destination");
    }
    names.add(skill.name);
    for (const artifact of skill.artifacts) {
      const destination = resolve(skill.destination, artifact.path);
      if (
        !artifact.path ||
        isAbsolute(artifact.path) ||
        relative(skill.destination, destination) !== artifact.path ||
        !/^[a-f0-9]{64}$/.test(artifact.hash)
      ) {
        throw new SetupFailure("ownership record contains an invalid skill artifact");
      }
      assertContained(skill.destination, destination, "owned skill artifact");
    }
    for (const conflictPath of skill.conflictPaths ?? []) {
      const destination = resolve(skill.destination, conflictPath);
      if (!conflictPath || isAbsolute(conflictPath)) {
        throw new SetupFailure("ownership record contains an invalid residual conflict path");
      }
      assertContained(skill.destination, destination, "residual conflict path");
    }
  }
}

function readManifest(path: string, opts: CodexSetupOptions): InstallationManifest | undefined {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return undefined;
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new SetupFailure(`ownership record is not a regular file: ${path}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new SetupFailure(`ownership record is unreadable: ${(error as Error).message}`);
  }
  const candidate = value as Partial<InstallationManifest>;
  if (
    candidate.schemaVersion !== 1 ||
    (candidate.mode !== "plugin" && candidate.mode !== "standalone") ||
    !Array.isArray(candidate.skills)
  ) {
    throw new SetupFailure("ownership record has an unsupported schema");
  }
  validateManifest(candidate as InstallationManifest, opts);
  return candidate as InstallationManifest;
}

function readArtifacts(root: string): ArtifactRecord[] {
  const records: ArtifactRecord[] = [];
  const visit = (current: string): void => {
    assertContained(root, current, "skill artifact");
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new SetupFailure(`skill artifact is a symlink: ${current}`);
    if (stat.isDirectory()) {
      for (const name of readdirSync(current).sort()) visit(join(current, name));
      return;
    }
    if (!stat.isFile()) throw new SetupFailure(`skill artifact is not a regular file: ${current}`);
    records.push({ path: relative(root, current), hash: hash(readFileSync(current)) });
  };
  visit(root);
  return records;
}

function sourceInventory(opts: CodexSetupOptions): SourceSkill[] {
  assertNoSymlinkPath(opts.packageDir, true);
  assertRegularFile(
    join(opts.packageDir, ".codex-plugin", "plugin.json"),
    "Codex package manifest",
  );
  assertRegularFile(opts.mcpEntrypoint, "MCP entrypoint");
  const skillsRoot = join(opts.packageDir, "skills");
  assertNoSymlinkPath(skillsRoot, true);
  if (!lstatSync(skillsRoot).isDirectory())
    throw new SetupFailure(`skills root is not a directory: ${skillsRoot}`);
  const names = new Set<string>();
  const inventory: SourceSkill[] = [];
  for (const entry of readdirSync(skillsRoot, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const skillRoot = join(skillsRoot, entry.name);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new SetupFailure(`skill entry is not a regular directory: ${skillRoot}`);
    }
    assertNoSymlinkPath(skillRoot, true);
    const skillMd = join(skillRoot, "SKILL.md");
    assertRegularFile(skillMd, "skill manifest");
    const contents = readFileSync(skillMd, "utf8");
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(contents);
    const declaredName = /^name:\s*([^\s]+)\s*$/m.exec(frontmatter?.[1] ?? "")?.[1];
    if (!declaredName || declaredName !== entry.name || !declaredName.startsWith("penumbra-")) {
      throw new SetupFailure(`invalid Penumbra skill name in ${skillMd}`);
    }
    if (names.has(declaredName))
      throw new SetupFailure(`duplicate Penumbra skill name: ${declaredName}`);
    names.add(declaredName);
    const artifacts = readArtifacts(skillRoot).map((record) => ({
      ...record,
      source: join(skillRoot, record.path),
    }));
    inventory.push({
      name: declaredName,
      destination: join(opts.skillsDir, declaredName),
      artifacts,
    });
  }
  return inventory;
}

function artifactMap(records: ArtifactRecord[]): Map<string, string> {
  return new Map(records.map((record) => [record.path, record.hash]));
}

function inspectOwnedSkill(skill: SkillRecord): { missing: boolean; conflict?: string } {
  assertNoSymlinkPath(skill.destination);
  const stat = lstatSync(skill.destination, { throwIfNoEntry: false });
  if (!stat) return { missing: true };
  if (!stat.isDirectory())
    return { missing: false, conflict: `${skill.destination} is not a directory` };
  let actual: ArtifactRecord[];
  try {
    actual = readArtifacts(skill.destination);
  } catch (error) {
    return { missing: false, conflict: (error as Error).message };
  }
  const expected = artifactMap(skill.artifacts);
  const found = artifactMap(actual);
  for (const [path, actualHash] of found) {
    const expectedHash = expected.get(path);
    if (!expectedHash)
      return {
        missing: false,
        conflict: `unowned file exists in owned skill: ${join(skill.destination, path)}`,
      };
    if (expectedHash !== actualHash)
      return {
        missing: false,
        conflict: `owned skill was modified: ${join(skill.destination, path)}`,
      };
  }
  return { missing: [...expected.keys()].some((path) => !found.has(path)) };
}

function preflightSkills(
  opts: CodexSetupOptions,
  previous: InstallationManifest | undefined,
  desired: SourceSkill[],
): void {
  assertNoSymlinkPath(opts.skillsDir);
  const previousByName = new Map((previous?.skills ?? []).map((skill) => [skill.name, skill]));
  for (const oldSkill of previousByName.values()) {
    const inspected = inspectOwnedSkill(oldSkill);
    if (inspected.conflict) throw new SetupFailure(inspected.conflict);
  }
  for (const skill of desired) {
    assertContained(opts.skillsDir, skill.destination, "skill destination");
    assertNoSymlinkPath(skill.destination);
    if (
      !previousByName.has(skill.name) &&
      lstatSync(skill.destination, { throwIfNoEntry: false })
    ) {
      throw new SetupFailure(`unowned destination skill already exists: ${skill.destination}`);
    }
    for (const artifact of skill.artifacts) {
      const destination = join(skill.destination, artifact.path);
      assertContained(skill.destination, destination, "skill artifact destination");
      assertNoSymlinkPath(destination);
    }
  }
}

function prepareMcp(
  opts: CodexSetupOptions,
  previous: InstallationManifest | undefined,
): { current: string; next: string; block: string; separator: string } {
  const configPath = join(opts.codexDir, "config.toml");
  assertNoSymlinkPath(configPath);
  const stat = lstatSync(configPath, { throwIfNoEntry: false });
  if (stat && !stat.isFile())
    throw new SetupFailure(`Codex config is not a regular file: ${configPath}`, "mcp");
  const current = stat ? readFileSync(configPath, "utf8") : "";
  const parsed = parseToml(current);
  const managed = findManagedBlock(current);
  const owned = previous?.mcp;
  if (!owned && (managed || penumbraMcpEntry(parsed) !== undefined)) {
    throw new SetupFailure("an unowned Penumbra MCP entry already exists", "mcp");
  }
  if (owned && managed && hash(managed.block) !== owned.blockHash) {
    throw new SetupFailure("owned Penumbra MCP configuration was modified", "mcp");
  }
  if (owned && !managed && penumbraMcpEntry(parsed) !== undefined) {
    throw new SetupFailure("Penumbra MCP entry exists outside its owned block", "mcp");
  }
  const block = desiredMcpBlock(opts);
  let separator = owned?.separator ?? "";
  let next: string;
  if (managed) {
    next = current.slice(0, managed.start) + block + current.slice(managed.end);
  } else {
    separator =
      current === "" || current.endsWith("\n\n") ? "" : current.endsWith("\n") ? "\n" : "\n\n";
    next = current + separator + block;
  }
  const entry = penumbraMcpEntry(parseToml(next)) as Record<string, unknown> | undefined;
  if (entry?.command !== realpathSync(process.execPath)) {
    throw new SetupFailure("generated Penumbra MCP configuration failed validation", "mcp");
  }
  return { current, next, block, separator };
}

// prettier-ignore
function desiredManifest(opts: CodexSetupOptions, mcp: { block: string; separator: string }, skills: SourceSkill[], pluginIdentifier?: string): InstallationManifest { return {
  schemaVersion: 1, mode: opts.mode, codexDir: opts.codexDir, skillsDir: opts.skillsDir,
  packageDir: realpathSync(opts.packageDir), storageRoot: opts.storageRoot, mcpEntrypoint: realpathSync(opts.mcpEntrypoint),
  mcp: { configPath: join(opts.codexDir, "config.toml"), blockHash: hash(mcp.block), separator: mcp.separator },
  skills: skills.map((skill) => ({ name: skill.name, destination: skill.destination, artifacts: skill.artifacts.map(({ path, hash: artifactHash }) => ({ path, hash: artifactHash })) })),
  ...(pluginIdentifier ? { plugin: { identifier: pluginIdentifier } } : {}),
} }

function removeEmptyParents(path: string, stop: string): void {
  let current = path;
  while (current !== stop) {
    try {
      rmdirSync(current);
    } catch {
      return;
    }
    current = dirname(current);
  }
}

function applySkills(
  opts: CodexSetupOptions,
  previous: InstallationManifest | undefined,
  desired: SourceSkill[],
): boolean {
  let changed = false;
  const desiredByName = new Map(desired.map((skill) => [skill.name, skill]));
  for (const oldSkill of previous?.skills ?? []) {
    const nextPaths = new Set(
      desiredByName.get(oldSkill.name)?.artifacts.map((artifact) => artifact.path) ?? [],
    );
    for (const oldArtifact of oldSkill.artifacts) {
      if (nextPaths.has(oldArtifact.path)) continue;
      const destination = join(oldSkill.destination, oldArtifact.path);
      if (lstatSync(destination, { throwIfNoEntry: false })) {
        unlinkSync(destination);
        changed = true;
        removeEmptyParents(dirname(destination), opts.skillsDir);
      }
    }
  }
  for (const skill of desired) {
    for (const artifact of skill.artifacts) {
      const destination = join(skill.destination, artifact.path);
      const stat = lstatSync(destination, { throwIfNoEntry: false });
      if (stat?.isFile() && hash(readFileSync(destination)) === artifact.hash) continue;
      atomicWrite(destination, readFileSync(artifact.source));
      changed = true;
    }
  }
  return changed;
}

// prettier-ignore
function manifestJson(value: InstallationManifest): string { return `${JSON.stringify(value, null, 2)}\n` }

// prettier-ignore
async function status(opts: CodexSetupOptions, manifestPath: string): Promise<CodexSetupResult> {
  const components = baseComponents(opts)
  try {
    assertNoSymlinkPath(opts.codexDir); assertNoSymlinkPath(opts.skillsDir)
    const previous = readManifest(manifestPath, opts)
    if (previous && previous.mode !== opts.mode) throw new SetupFailure(`installed mode is ${previous.mode}; uninstall it before selecting ${opts.mode}`)
    const configPath = join(opts.codexDir, "config.toml"); const configStat = lstatSync(configPath, { throwIfNoEntry: false })
    if (configStat) {
      if (configStat.isSymbolicLink() || !configStat.isFile()) throw new SetupFailure("Codex config is not a regular file", "mcp")
      const current = readFileSync(configPath, "utf8"); const parsed = parseToml(current); const managed = findManagedBlock(current)
      if (previous?.mcp && managed && hash(managed.block) === previous.mcp.blockHash) components.mcp = component("installed", "owned Penumbra MCP configuration matches its recorded hash")
      else if (managed || penumbraMcpEntry(parsed) !== undefined) components.mcp = component("conflict", "Penumbra MCP configuration is present but not owned and unchanged")
    }
    if (previous?.mode === "standalone") {
      let missing = false
      for (const skill of previous.skills) {
        const inspected = inspectOwnedSkill(skill)
        if (inspected.conflict) { components.skills = component("conflict", inspected.conflict); missing = false; break }
        missing ||= inspected.missing
      }
      if (components.skills.state !== "conflict") components.skills = missing ? component("absent", "one or more owned skill artifacts are missing") : component("installed", `${String(previous.skills.length)} owned skills match their recorded hashes`)
    } else if (opts.mode === "plugin") {
      const host = opts.host; const plugin = host?.plugin
      if (plugin?.state !== "supported" || !plugin.statusArgv || !host) {
        const state = plugin?.state === "unavailable" ? "unavailable" : "unknown"
        components.skills = component(state, plugin?.detail ?? "plugin management support is unavailable")
      }
      else {
        const result = await host.invoke(plugin.statusArgv)
        components.skills = result.ok && result.installed === true ? component("installed", result.detail ?? "owned plugin is installed") : component(result.ok && result.installed === false ? "absent" : "unknown", result.detail ?? "plugin status is unavailable")
      }
    }
    const ok = components.mcp.state !== "conflict" && components.skills.state !== "conflict"
    return { ok, changed: false, ...(ok ? {} : { reason: "installation has ownership conflicts" }), mode: opts.mode, components }
  } catch (error) { return failureResult(opts, error) }
}

// prettier-ignore
async function installOrRepair(opts: CodexSetupOptions, manifestPath: string): Promise<CodexSetupResult> {
  try {
    const previous = readManifest(manifestPath, opts)
    if (previous && previous.mode !== opts.mode) throw new SetupFailure(`installed mode is ${previous.mode}; uninstall it before selecting ${opts.mode}`)
    const adapter = opts.mode === "plugin" ? requirePlugin(opts) : undefined
    const desiredSkills = opts.mode === "standalone" ? sourceInventory(opts) : []
    if (opts.mode === "plugin") {
      assertNoSymlinkPath(opts.packageDir, true)
      assertRegularFile(join(opts.packageDir, ".codex-plugin", "plugin.json"), "Codex package manifest")
      assertRegularFile(opts.mcpEntrypoint, "MCP entrypoint")
    }
    preflightSkills(opts, previous, desiredSkills); const mcp = prepareMcp(opts, previous)
    assertWritableTarget(join(opts.codexDir, "config.toml")); assertWritableTarget(manifestPath)
    if (opts.mode === "standalone") assertWritableTarget(opts.skillsDir)

    let hostChanged = false; let pluginIdentifier: string | undefined
    if (adapter) {
      pluginIdentifier = adapter.plugin.identifier
      if (previous?.plugin) {
        const hostResult = await adapter.host.invoke(adapter.plugin.statusArgv)
        if (hostResult.ok && hostResult.installed === false && opts.action === "repair") {
          requirePluginInstalled(await adapter.host.invoke(adapter.plugin.installArgv)); hostChanged = true
        } else requirePluginInstalled(hostResult)
      } else {
        requirePluginInstalled(await adapter.host.invoke(adapter.plugin.installArgv)); hostChanged = true
      }
    }

    let changed = hostChanged
    if (mcp.current !== mcp.next) {
      atomicWrite(join(opts.codexDir, "config.toml"), mcp.next); changed = true
    }
    if (opts.mode === "standalone") changed = applySkills(opts, previous, desiredSkills) || changed
    const nextManifest = desiredManifest(opts, mcp, desiredSkills, pluginIdentifier)
    const nextManifestJson = manifestJson(nextManifest); const currentManifestJson = existsSync(manifestPath) ? readFileSync(manifestPath, "utf8") : ""
    if (currentManifestJson !== nextManifestJson) {
      atomicWrite(manifestPath, nextManifestJson, 0o600); changed = true
    }
    const components = baseComponents(opts); components.mcp = component("installed", "owned Penumbra MCP configuration is installed")
    const detail = opts.mode === "standalone" ? `${String(desiredSkills.length)} ownership-tracked Penumbra skills are installed` : `host-managed plugin ${pluginIdentifier ?? "unknown"} is installed`
    components.skills = component("installed", detail)
    return { ok: true, changed, mode: opts.mode, components }
  } catch (error) { return failureResult(opts, error) }
}

function removeOwnedMcp(previous: InstallationManifest): { changed: boolean; conflict: boolean } {
  if (!previous.mcp) return { changed: false, conflict: false };
  const configPath = previous.mcp.configPath;
  assertNoSymlinkPath(configPath);
  const stat = lstatSync(configPath, { throwIfNoEntry: false });
  if (!stat) return { changed: false, conflict: false };
  if (!stat.isFile()) return { changed: false, conflict: true };
  const current = readFileSync(configPath, "utf8");
  const parsed = parseToml(current);
  const managed = findManagedBlock(current);
  if (!managed) return { changed: false, conflict: penumbraMcpEntry(parsed) !== undefined };
  if (hash(managed.block) !== previous.mcp.blockHash) return { changed: false, conflict: true };
  let start = managed.start;
  if (
    previous.mcp.separator &&
    current.slice(start - previous.mcp.separator.length, start) === previous.mcp.separator
  ) {
    start -= previous.mcp.separator.length;
  }
  const next = current.slice(0, start) + current.slice(managed.end);
  parseToml(next);
  atomicWrite(configPath, next);
  return { changed: true, conflict: false };
}

function uninstallSkills(
  opts: CodexSetupOptions,
  previous: InstallationManifest,
): { changed: boolean; residual: SkillRecord[] } {
  let changed = false;
  const residual: SkillRecord[] = [];
  for (const skill of previous.skills) {
    const keep: ArtifactRecord[] = [];
    let conflictPaths: string[] = [];
    const skillStat = lstatSync(skill.destination, { throwIfNoEntry: false });
    if (skillStat?.isDirectory()) {
      const expectedPaths = new Set(skill.artifacts.map((artifact) => artifact.path));
      try {
        conflictPaths = [
          ...new Set([
            ...conflictPaths,
            ...readArtifacts(skill.destination)
              .map((artifact) => artifact.path)
              .filter((path) => !expectedPaths.has(path)),
          ]),
        ];
      } catch {
        conflictPaths = [...new Set([...conflictPaths, "."])];
      }
    }
    for (const artifact of skill.artifacts) {
      const destination = join(skill.destination, artifact.path);
      try {
        assertNoSymlinkPath(destination);
        const stat = lstatSync(destination, { throwIfNoEntry: false });
        if (!stat) continue;
        if (!stat.isFile() || hash(readFileSync(destination)) !== artifact.hash) {
          keep.push(artifact);
          continue;
        }
        unlinkSync(destination);
        changed = true;
        removeEmptyParents(dirname(destination), opts.skillsDir);
      } catch {
        keep.push(artifact);
      }
    }
    if (keep.length || conflictPaths.length) {
      residual.push({
        ...skill,
        artifacts: keep,
        ...(conflictPaths.length ? { conflictPaths } : {}),
      });
    }
  }
  return { changed, residual };
}

async function uninstall(opts: CodexSetupOptions, manifestPath: string): Promise<CodexSetupResult> {
  try {
    const previous = readManifest(manifestPath, opts);
    if (!previous)
      return { ok: true, changed: false, mode: opts.mode, components: baseComponents(opts) };
    if (previous.mode !== opts.mode) {
      throw new SetupFailure(`installed mode is ${previous.mode}; uninstall it using that mode`);
    }
    assertWritableTarget(manifestPath);
    if (previous.mcp) assertWritableTarget(previous.mcp.configPath);
    if (opts.mode === "standalone") assertWritableTarget(opts.skillsDir);
    let pluginConflict = false;
    let pluginChanged = false;
    if (previous.plugin) {
      const host = opts.host;
      const plugin = host?.plugin;
      if (
        plugin?.state !== "supported" ||
        plugin.identifier !== previous.plugin.identifier ||
        !plugin.uninstallArgv ||
        !host
      ) {
        pluginConflict = true;
      } else {
        const hostResult = await host.invoke(plugin.uninstallArgv);
        pluginConflict = !hostResult.ok || hostResult.installed === true;
        pluginChanged = !pluginConflict;
      }
    }
    const mcpResult = removeOwnedMcp(previous);
    const skillResult =
      opts.mode === "standalone"
        ? uninstallSkills(opts, previous)
        : { changed: false, residual: [] as SkillRecord[] };
    const hasConflict = mcpResult.conflict || skillResult.residual.length > 0 || pluginConflict;
    const changed = mcpResult.changed || skillResult.changed || pluginChanged;
    if (hasConflict) {
      const residual: InstallationManifest = {
        ...previous,
        ...(mcpResult.conflict ? {} : { mcp: undefined }),
        skills: skillResult.residual,
        ...(pluginConflict ? {} : { plugin: undefined }),
      };
      atomicWrite(manifestPath, manifestJson(residual), 0o600);
    } else {
      unlinkSync(manifestPath);
      removeEmptyParents(dirname(manifestPath), opts.codexDir);
    }
    const components = baseComponents(opts);
    components.mcp = mcpResult.conflict
      ? component("conflict", "owned Penumbra MCP configuration was modified")
      : component("absent", "owned Penumbra MCP configuration was removed");
    components.skills =
      skillResult.residual.length || pluginConflict
        ? component("conflict", "user-modified or unavailable owned skill data was preserved")
        : component("absent", "owned Penumbra skill data was removed");
    return {
      ok: !hasConflict,
      changed,
      ...(hasConflict ? { reason: "uninstall preserved ownership conflicts" } : {}),
      mode: opts.mode,
      components,
    };
  } catch (error) {
    return failureResult(opts, error);
  }
}

export async function runCodexSetup(opts: CodexSetupOptions): Promise<CodexSetupResult> {
  try {
    validateAbsolutePaths(opts);
  } catch (error) {
    return failureResult(opts, error);
  }
  const manifestPath = join(opts.codexDir, "penumbra", "installation.json");
  if (opts.action === "status") return await status(opts, manifestPath);
  if (opts.action === "uninstall") return await uninstall(opts, manifestPath);
  return await installOrRepair(opts, manifestPath);
}
