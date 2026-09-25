import { describe, expect, test } from "bun:test";
import * as lib from "penumbra-exec-primitives";

describe("[B10] installed package namespace", () => {
  test("the installed package exports exactly the documented runtime surface", () => {
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
    const runtimeKeys = keys.filter(
      (k) => typeof (lib as Record<string, unknown>)[k] !== "undefined",
    );
    expect(runtimeKeys).toEqual([...documented].sort());
  });
});
