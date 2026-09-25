/**
 * Consumer smoke: prove the packed artifact resolves and drives a real process
 * through the shim surface. The deep wire behavior is covered by the parity
 * suite; this file is the "can the host import and run it" check.
 */
import * as primitives from "penumbra-exec-primitives";

import { spawnCliAdapter } from "./shim/cli-spawn.js";

const REQUIRED_EXPORTS = [
  "AcpResponseError",
  "AcpTransportClosedError",
  "HostInputError",
  "StdioAcpClient",
  "StdioAcpPermissionContext",
  "createAcpWarmPool",
  "detectCapacityError",
  "handleStdioAcpPermissionRequest",
  "initializeAcpSession",
  "poolKeyFor",
  "runProcess",
  "selectConfigOption",
  "selectTrustAllOption",
  "startStdioAcpServer",
  "superviseProcess",
] as const;

for (const name of REQUIRED_EXPORTS) {
  const value = (primitives as Record<string, unknown>)[name];
  if (typeof value !== "function" && typeof value !== "object") {
    throw new Error(`penumbra-exec-primitives export missing: ${name}`);
  }
}

const out = await spawnCliAdapter({
  command: "sh",
  args: ["-c", 'printf "smoke-ok"'],
  prompt: "",
  signal: new AbortController().signal,
  pass_via: "argv",
});
if (out.text !== "smoke-ok") {
  throw new Error(`smoke run returned unexpected text: ${JSON.stringify(out.text)}`);
}

console.log("penumbra-host smoke: OK");
