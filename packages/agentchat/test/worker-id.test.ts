import { describe, expect, it } from "bun:test";
import { resolveWorkerId } from "../src/worker-id.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("resolveWorkerId", () => {
  it("flag wins over everything", () => {
    expect(
      resolveWorkerId({
        flag: "worker-abc",
        envValue: "worker-env",
        statePath: "/tmp/nonexistent",
      }),
    ).toBe("worker-abc");
  });

  it("env wins over file", () => {
    expect(resolveWorkerId({ envValue: "worker-env", statePath: "/tmp/nonexistent" })).toBe(
      "worker-env",
    );
  });

  it("file is read when no flag or env", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-id-test-"));
    const statePath = path.join(tmpDir, "worker-id");
    fs.writeFileSync(statePath, "worker-stable", "utf-8");
    try {
      expect(resolveWorkerId({ statePath })).toBe("worker-stable");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("file is created when missing", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-id-test-"));
    const statePath = path.join(tmpDir, "worker-id");
    try {
      expect(fs.existsSync(statePath)).toBe(false);
      const id = resolveWorkerId({ statePath });
      expect(id.startsWith("worker-")).toBe(true);
      expect(fs.existsSync(statePath)).toBe(true);
      expect(fs.readFileSync(statePath, "utf-8")).toBe(id);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("unwritable path falls back to random and warns", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-id-test-"));
    const unwritableDir = path.join(tmpDir, "unwritable");
    fs.mkdirSync(unwritableDir, { mode: 0o400 }); // read-only
    const statePath = path.join(unwritableDir, "subdir", "worker-id");

    let warned = false;
    const mockLog = {
      warn: () => {
        warned = true;
      },
    };

    try {
      const id = resolveWorkerId({ statePath, log: mockLog });
      expect(id.startsWith("worker-")).toBe(true);
      expect(warned).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("persisted id round-trips", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-id-test-"));
    const statePath = path.join(tmpDir, "worker-id");
    try {
      const id1 = resolveWorkerId({ statePath });
      const id2 = resolveWorkerId({ statePath });
      expect(id1).toBe(id2);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
