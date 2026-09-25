import { describe, expect, test } from "bun:test";

import * as lib from "penumbra-exec-primitives";

// Re-expresses the [B10] namespace assertion from the package's
// single-owner.test.ts against the packed dist surface (repo-side module
// identity and script hooks do not exist in an installed consumer).

describe("packed export surface", () => {
  test("[B10] the package namespace contains exactly the documented exports", () => {
    const keys = Object.keys(lib).sort();
    const documented = [
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
    ];
    for (const name of documented) {
      expect(keys).toContain(name);
    }
    const runtimeKeys = keys.filter(
      (k) => typeof (lib as Record<string, unknown>)[k] !== "undefined",
    );
    expect(runtimeKeys).toEqual([...documented].sort());
  });
});
