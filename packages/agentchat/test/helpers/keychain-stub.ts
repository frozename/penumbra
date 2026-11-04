import { afterEach, beforeEach, type Mock, spyOn } from "bun:test";
import * as childProcess from "node:child_process";
import * as os from "node:os";

/**
 * `security find-generic-password -w` blocks on an ACL prompt under a
 * non-GUI session, so tests that reach `resolveAdapterApiKey`'s keychain path
 * (the opencode-cli adapter always does) stub the shell-out by spying on the
 * `execFileSync` and `platform` bindings secret.ts calls. Unlike `mock.module`,
 * which is process-global in bun and never undone, these spies are restored
 * after every test, so secret.test.ts still exercises the real module.
 */
export const STUBBED_KEYCHAIN_KEY = "stubbed-key";

export interface KeychainStub {
  exec: Mock<typeof childProcess.execFileSync>;
  restore: () => void;
}

export function stubSecurityKeychain(): KeychainStub {
  const platform = spyOn(os, "platform").mockReturnValue("darwin");
  const exec = spyOn(childProcess, "execFileSync").mockImplementation(((file: string): string => {
    if (file !== "security") throw new Error(`unexpected execFileSync: ${file}`);
    return `${STUBBED_KEYCHAIN_KEY}\n`;
  }) as typeof childProcess.execFileSync);
  return {
    exec,
    restore: (): void => {
      exec.mockRestore();
      platform.mockRestore();
    },
  };
}

/**
 * Registers beforeEach/afterEach hooks in the calling scope that stub the
 * keychain for each test and restore it afterwards. Returns a getter for the
 * current test's stub.
 */
export function useStubbedKeychain(): () => KeychainStub {
  let current: KeychainStub | undefined;
  beforeEach(() => {
    current = stubSecurityKeychain();
  });
  afterEach(() => {
    current?.restore();
    current = undefined;
  });
  return (): KeychainStub => {
    if (!current) throw new Error("keychain stub is only active inside a test");
    return current;
  };
}
