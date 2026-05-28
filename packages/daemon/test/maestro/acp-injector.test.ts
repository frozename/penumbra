import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { createAcpInjector } from "../../src/maestro/acp-injector.js";

afterEach(() => {
  mock.restore();
});

test("inject fan-through: forwards message to live session inject handler", async () => {
  const inject = mock(async (_message: { role: "user"; text: string }) => {});
  const lookupSession = mock(async (_handoffId: string) => ({
    adapter: "claude-acp-sonnet",
    inject,
  }));

  const injector = createAcpInjector({
    workerManager: { lookupSession },
  });

  await injector.inject("h-1", { role: "user", text: "hello" });

  expect(lookupSession).toHaveBeenCalledTimes(1);
  expect(lookupSession).toHaveBeenCalledWith("h-1");
  expect(inject).toHaveBeenCalledTimes(1);
  expect(inject).toHaveBeenCalledWith({ role: "user", text: "hello" });
});

test("no live session: resolves and logs warning", async () => {
  const lookupSession = mock(async (_handoffId: string) => undefined);
  const warnSpy = spyOn(console, "warn").mockImplementation(() => undefined);

  const injector = createAcpInjector({
    workerManager: { lookupSession },
  });

  await expect(
    injector.inject("h-missing", { role: "user", text: "hello" }),
  ).resolves.toBeUndefined();
  expect(warnSpy).toHaveBeenCalledTimes(1);
  expect(String(warnSpy.mock.calls[0]?.[0])).toContain(
    "[acp-injector] no live session for chain_handoff_id=h-missing",
  );
});

test("unsupported adapter: resolves and logs warning without injecting", async () => {
  const inject = mock(async (_message: { role: "user"; text: string }) => {});
  const lookupSession = mock(async (_handoffId: string) => ({
    adapter: "openai-compat-http",
    inject,
  }));
  const warnSpy = spyOn(console, "warn").mockImplementation(() => undefined);

  const injector = createAcpInjector({
    workerManager: { lookupSession },
  });

  await expect(injector.inject("h-http", { role: "user", text: "hello" })).resolves.toBeUndefined();
  expect(inject).toHaveBeenCalledTimes(0);
  expect(warnSpy).toHaveBeenCalledTimes(1);
  expect(String(warnSpy.mock.calls[0]?.[0])).toContain(
    "adapter does not support mid-session injection",
  );
});

test("underlying inject throws: resolves and logs error", async () => {
  const inject = mock(async (_message: { role: "user"; text: string }) => {
    throw new Error("boom");
  });
  const lookupSession = mock(async (_handoffId: string) => ({
    adapter: "stdio-acp",
    inject,
  }));
  const errorSpy = spyOn(console, "error").mockImplementation(() => undefined);

  const injector = createAcpInjector({
    workerManager: { lookupSession },
  });

  await expect(injector.inject("h-fail", { role: "user", text: "hello" })).resolves.toBeUndefined();
  expect(inject).toHaveBeenCalledTimes(1);
  expect(errorSpy).toHaveBeenCalledTimes(1);
  expect(String(errorSpy.mock.calls[0]?.[0])).toContain("[acp-injector] inject failed");
});
