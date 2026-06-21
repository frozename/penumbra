import { afterEach, beforeEach, expect, it } from "bun:test";
import { WebFetchAdapter, isInternalOrMetadataHost } from "../../src/research/webfetch-adapter.js";
import { createResearchAdapter } from "../../src/research/firecrawl-adapter.js";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

it("blocks scrape of cloud metadata host even with no allowlist", async () => {
  const adapter = new WebFetchAdapter();
  await expect(adapter.scrape({ url: "http://169.254.169.254/latest/meta-data/" })).rejects.toMatch(
    /internal host blocked/i,
  );
});

it("blocks scrape of loopback IPv4 even with no allowlist", async () => {
  const adapter = new WebFetchAdapter();
  await expect(adapter.scrape({ url: "http://127.0.0.1:8080/" })).rejects.toMatch(
    /internal host blocked/i,
  );
});

it("blocks scrape of RFC1918 host even with no allowlist", async () => {
  const adapter = new WebFetchAdapter();
  await expect(adapter.scrape({ url: "http://10.0.0.5/admin" })).rejects.toMatch(
    /internal host blocked/i,
  );
  await expect(adapter.scrape({ url: "http://192.168.1.1/" })).rejects.toMatch(
    /internal host blocked/i,
  );
  await expect(adapter.scrape({ url: "http://172.20.5.5/" })).rejects.toMatch(
    /internal host blocked/i,
  );
});

it("blocks scrape of localhost and metadata hostnames even with no allowlist", async () => {
  const adapter = new WebFetchAdapter();
  await expect(adapter.scrape({ url: "http://localhost/" })).rejects.toMatch(
    /internal host blocked/i,
  );
  await expect(adapter.scrape({ url: "http://metadata.google.internal/" })).rejects.toMatch(
    /internal host blocked/i,
  );
});

it("blocks scrape of IPv6 loopback and link-local even with no allowlist", async () => {
  const adapter = new WebFetchAdapter();
  await expect(adapter.scrape({ url: "http://[::1]/" })).rejects.toMatch(/internal host blocked/i);
  await expect(adapter.scrape({ url: "http://[fe80::1]/" })).rejects.toMatch(
    /internal host blocked/i,
  );
});

it("blocks scrape of disallowed public host when allowlist is set", async () => {
  const adapter = new WebFetchAdapter({ allowedDomains: ["example.com"] });
  await expect(adapter.scrape({ url: "https://evil.com/" })).rejects.toMatch(/domain not allowed/i);
});

it("allows scrape of public host on allowlist", async () => {
  let calledUrl: string | undefined;
  globalThis.fetch = (async (url: string | URL | Request) => {
    calledUrl = typeof url === "string" ? url : url.toString();
    return new Response("<html><body><p>hello world</p></body></html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  }) as unknown as typeof fetch;

  const adapter = new WebFetchAdapter({ allowedDomains: ["example.com"] });
  const result = await adapter.scrape({ url: "https://example.com/page" });
  expect(calledUrl).toBe("https://example.com/page");
  expect(result.source_provider).toBe("webfetch");
  expect(result.markdown).toContain("hello world");
});

it("allows scrape of public host when no allowlist is set", async () => {
  globalThis.fetch = (async () =>
    new Response("<html><body>ok</body></html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    })) as unknown as typeof fetch;

  const adapter = new WebFetchAdapter();
  const result = await adapter.scrape({ url: "https://example.com/" });
  expect(result.markdown).toContain("ok");
});

it("createResearchAdapter wires allowedDomains into webfetch adapter", async () => {
  const adapter = createResearchAdapter({
    provider: "webfetch",
    allowedDomains: ["example.com"],
  });
  await expect(adapter.scrape({ url: "https://evil.com/" })).rejects.toMatch(/domain not allowed/i);
  await expect(adapter.scrape({ url: "http://169.254.169.254/" })).rejects.toMatch(
    /internal host blocked/i,
  );
});

it("rejects malformed URLs", async () => {
  const adapter = new WebFetchAdapter();
  await expect(adapter.scrape({ url: "not a url" })).rejects.toMatch(/invalid URL/i);
});

it("isInternalOrMetadataHost flags expected ranges and passes public hosts", () => {
  expect(isInternalOrMetadataHost("127.0.0.1")).toBe(true);
  expect(isInternalOrMetadataHost("10.1.2.3")).toBe(true);
  expect(isInternalOrMetadataHost("172.16.0.1")).toBe(true);
  expect(isInternalOrMetadataHost("172.31.255.255")).toBe(true);
  expect(isInternalOrMetadataHost("192.168.0.1")).toBe(true);
  expect(isInternalOrMetadataHost("169.254.169.254")).toBe(true);
  expect(isInternalOrMetadataHost("0.0.0.0")).toBe(true);
  expect(isInternalOrMetadataHost("localhost")).toBe(true);
  expect(isInternalOrMetadataHost("metadata.google.internal")).toBe(true);
  expect(isInternalOrMetadataHost("::1")).toBe(true);
  expect(isInternalOrMetadataHost("fe80::1")).toBe(true);
  expect(isInternalOrMetadataHost("fc00::1")).toBe(true);

  expect(isInternalOrMetadataHost("example.com")).toBe(false);
  expect(isInternalOrMetadataHost("api.github.com")).toBe(false);
  expect(isInternalOrMetadataHost("172.15.0.1")).toBe(false);
  expect(isInternalOrMetadataHost("172.32.0.1")).toBe(false);
  expect(isInternalOrMetadataHost("169.253.0.1")).toBe(false);
});
