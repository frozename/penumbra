import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import * as util from "node:util";

// Captured before any candidate code runs: the candidate module may patch
// globals (JSON.stringify, process.exit, Array.prototype methods, ...), so
// every builtin the result channel depends on is held by const reference.
const stringify = JSON.stringify;
const parseJson = JSON.parse;
const writeSync = fs.writeSync;
const readFileSync = fs.readFileSync;
const reflectHas = Reflect.has;
const reflectOwnKeys = Reflect.ownKeys;
const getPrototypeOf = Object.getPrototypeOf;
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const isArray = Array.isArray;
const objectPrototype = Object.prototype;
const arrayPrototype = Array.prototype;
const isProxy = util.types.isProxy;
const exit = process.exit.bind(process);
const isFiniteNumber = Number.isFinite;
const joinPath = path.join;
const toFileHref = url.pathToFileURL;

interface ProbeCallSpec {
  id: string;
  export: string;
  input: unknown;
}

interface ProbeRequest {
  nonce: string;
  module_rel: string;
  tree: string;
  calls: ProbeCallSpec[];
}

function readRequest(): ProbeRequest | null {
  const parsed = parseJson(readFileSync(0, "utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null || isArray(parsed)) {
    return null;
  }
  const req = parsed as Record<string, unknown>;
  const { nonce, module_rel, tree, calls } = req;
  if (
    typeof nonce !== "string" ||
    typeof module_rel !== "string" ||
    typeof tree !== "string" ||
    !isArray(calls)
  ) {
    return null;
  }
  return { nonce, module_rel, tree, calls: calls as ProbeCallSpec[] };
}

function alreadySeen(value: object, seen: unknown[]): boolean {
  let si = 0;
  while (si < seen.length) {
    if (seen[si] === value) {
      return true;
    }
    si += 1;
  }
  return false;
}

// stringify drops undefined/function/symbol property values outright, so they
// never reach the wire; bigint still rejects because it throws at serialize
// time rather than dropping.
function isPlainMember(value: object, key: string | symbol, seen: unknown[]): boolean {
  const desc = getOwnPropertyDescriptor(value, key);
  if (desc === undefined || !("value" in desc)) {
    return false;
  }
  const nested: unknown = desc.value;
  const nestedKind = typeof nested;
  if (nested === undefined || nestedKind === "function" || nestedKind === "symbol") {
    return true;
  }
  return isPlainJsonValue(nested, seen);
}

// A proxy, an accessor descriptor, a reachable toJSON, a foreign prototype, a
// non-finite number, or a bigint/function/symbol/undefined cannot cross the
// fd-3 JSON line without giving the candidate a code path in the parent.
// `seen` is indexed by hand: Array.prototype methods may be patched.
function isPlainContainerJson(value: object, seen: unknown[]): boolean {
  if (isProxy(value)) {
    return false;
  }
  const proto: unknown = getPrototypeOf(value);
  if (proto !== objectPrototype && proto !== arrayPrototype && proto !== null) {
    return false;
  }
  if (reflectHas(value, "toJSON") || alreadySeen(value, seen)) {
    return false;
  }
  seen[seen.length] = value;
  const keys = reflectOwnKeys(value);
  let ki = 0;
  while (ki < keys.length) {
    const key = keys[ki];
    ki += 1;
    if (key === undefined) {
      continue;
    }
    if (!isPlainMember(value, key, seen)) {
      return false;
    }
  }
  return true;
}

function isPlainJsonValue(value: unknown, seen: unknown[]): boolean {
  if (value === null) {
    return true;
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return isFiniteNumber(value);
  }
  if (typeof value !== "object") {
    return false;
  }
  return isPlainContainerJson(value, seen);
}

function renderOk(id: string, outJson: string): string {
  return `{"id":${stringify(id)},"output":${outJson}}`;
}

function renderError(id: string, error: string): string {
  return `{"id":${stringify(id)},"error":${stringify(error)}}`;
}

// plainJson + stringify run synchronously in the same tick as the call's
// return, so candidate code cannot patch between validation and serialize.
async function runCall(mod: Record<string, unknown>, call: ProbeCallSpec): Promise<string> {
  const fn = mod[call.export];
  if (typeof fn !== "function") {
    return renderError(call.id, "call_failed");
  }
  let value: unknown;
  try {
    value = await (fn as (input: unknown) => unknown)(call.input);
  } catch {
    return renderError(call.id, "call_failed");
  }
  if (!isPlainJsonValue(value, [])) {
    return renderError(call.id, "non_plain_output");
  }
  return renderOk(call.id, stringify(value));
}

// Entries are concatenated by hand: join/map/push on Array.prototype are all
// candidate-patchable after the first call executes.
function assembleLine(rendered: string[]): string {
  let line = "[";
  let sep = "";
  let i = 0;
  while (i < rendered.length) {
    const entry = rendered[i];
    i += 1;
    if (entry === undefined) {
      continue;
    }
    line += sep + entry;
    sep = ",";
  }
  return `${line}]`;
}

async function main(): Promise<void> {
  const req = readRequest();
  if (req === null) {
    exit(1);
    return;
  }
  let mod: Record<string, unknown> | null;
  try {
    mod = (await import(toFileHref(joinPath(req.tree, req.module_rel)).href)) as Record<
      string,
      unknown
    >;
  } catch {
    mod = null;
  }
  const rendered: string[] = [];
  let ci = 0;
  while (ci < req.calls.length) {
    const call = req.calls[ci];
    ci += 1;
    if (call === undefined) {
      continue;
    }
    rendered[rendered.length] =
      mod === null ? renderError(call.id, "import_failed") : await runCall(mod, call);
  }
  writeSync(3, `${req.nonce} ${assembleLine(rendered)}\n`);
  exit(0);
}

try {
  await main();
} catch {
  exit(1);
}
