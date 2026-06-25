import { afterEach, beforeEach, expect, it } from "bun:test";

import { createResearchAdapter, FirecrawlAdapter } from "../../src/research/firecrawl-adapter.js";
import {
  isInternalOrMetadataHost,
  type PinnedFetch,
  WebFetchAdapter,
} from "../../src/research/webfetch-adapter.js";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// Bun's matcher chains (`.rejects.toMatch`) declare a void return but resolve
// asynchronously at runtime; this helper performs the rejection assertion
// directly against the promise so the file can stay strict-lint clean.
async function expectRejectsToMatch(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  let caught: unknown;
  let rejected = false;
  try {
    await promise;
  } catch (err) {
    caught = err;
    rejected = true;
  }
  if (!rejected) {
    throw new Error(`expected rejection matching ${String(pattern)}, but promise resolved`);
  }
  const message =
    typeof caught === "string"
      ? caught
      : caught instanceof Error
        ? caught.message
        : JSON.stringify(caught);
  if (!pattern.test(message)) {
    throw new Error(`expected rejection to match ${String(pattern)}, got: ${message}`);
  }
}

type HostResolver = (hostname: string) => Promise<string[]>;

it("blocks scrape of cloud metadata host even with no allowlist", async () => {
  const adapter = new WebFetchAdapter();
  await expectRejectsToMatch(
    adapter.scrape({ url: "http://169.254.169.254/latest/meta-data/" }),
    /internal host blocked/i,
  );
});

it("blocks scrape of loopback IPv4 even with no allowlist", async () => {
  const adapter = new WebFetchAdapter();
  await expectRejectsToMatch(
    adapter.scrape({ url: "http://127.0.0.1:8080/" }),
    /internal host blocked/i,
  );
});

it("blocks scrape of RFC1918 host even with no allowlist", async () => {
  const adapter = new WebFetchAdapter();
  await expectRejectsToMatch(
    adapter.scrape({ url: "http://10.0.0.5/admin" }),
    /internal host blocked/i,
  );
  await expectRejectsToMatch(
    adapter.scrape({ url: "http://192.168.1.1/" }),
    /internal host blocked/i,
  );
  await expectRejectsToMatch(
    adapter.scrape({ url: "http://172.20.5.5/" }),
    /internal host blocked/i,
  );
});

it("blocks scrape of localhost and metadata hostnames even with no allowlist", async () => {
  const adapter = new WebFetchAdapter();
  await expectRejectsToMatch(
    adapter.scrape({ url: "http://localhost/" }),
    /internal host blocked/i,
  );
  await expectRejectsToMatch(
    adapter.scrape({ url: "http://metadata.google.internal/" }),
    /internal host blocked/i,
  );
});

it("blocks scrape of IPv6 loopback and link-local even with no allowlist", async () => {
  const adapter = new WebFetchAdapter();
  await expectRejectsToMatch(adapter.scrape({ url: "http://[::1]/" }), /internal host blocked/i);
  await expectRejectsToMatch(
    adapter.scrape({ url: "http://[fe80::1]/" }),
    /internal host blocked/i,
  );
});

it("blocks scrape of disallowed public host when allowlist is set", async () => {
  const adapter = new WebFetchAdapter({ allowedDomains: ["example.com"] });
  await expectRejectsToMatch(adapter.scrape({ url: "https://evil.com/" }), /domain not allowed/i);
});

it("allows scrape of public host on allowlist", async () => {
  let calledUrl: string | undefined;
  const pinnedFetch: PinnedFetch = (url) => {
    calledUrl = url;
    return Promise.resolve(
      new Response("<html><body><p>hello world</p></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
  };

  const adapter = new WebFetchAdapter({
    allowedDomains: ["example.com"],
    resolveHostAddresses: () => Promise.resolve(["93.184.216.34"]),
    pinnedFetch,
  });
  const result = await adapter.scrape({ url: "https://example.com/page" });
  expect(calledUrl).toBe("https://example.com/page");
  expect(result.source_provider).toBe("webfetch");
  expect(result.markdown).toContain("hello world");
});

it("allows scrape of public host when no allowlist is set", async () => {
  const pinnedFetch: PinnedFetch = () =>
    Promise.resolve(
      new Response("<html><body>ok</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );

  const adapter = new WebFetchAdapter({
    resolveHostAddresses: () => Promise.resolve(["93.184.216.34"]),
    pinnedFetch,
  });
  const result = await adapter.scrape({ url: "https://example.com/" });
  expect(result.markdown).toContain("ok");
});

it("blocks public hostname resolving to internal address and allows public resolution", async () => {
  const fetchedUrls: string[] = [];
  const pinnedFetch: PinnedFetch = (url) => {
    fetchedUrls.push(url);
    return Promise.resolve(
      new Response("<html><body>resolved ok</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
  };

  const resolveHostAddresses: HostResolver = (hostname) => {
    if (hostname === "rebind.example") return Promise.resolve(["93.184.216.34", "10.0.0.5"]);
    if (hostname === "public.example") return Promise.resolve(["93.184.216.34"]);
    return Promise.resolve([]);
  };
  const adapter = new WebFetchAdapter({
    resolveHostAddresses,
    pinnedFetch,
  });

  await expectRejectsToMatch(
    adapter.scrape({ url: "https://rebind.example/page" }),
    /resolved internal host blocked/i,
  );
  expect(fetchedUrls).toEqual([]);

  const result = await adapter.scrape({ url: "https://public.example/page" });
  expect(result.markdown).toContain("resolved ok");
  expect(fetchedUrls).toEqual(["https://public.example/page"]);
});

it("pins the validated address: connection uses the resolver's result, not a rebinding resolver", async () => {
  // Validator (resolver-1) returns ONLY a public address.
  const validatorResolver: HostResolver = () => Promise.resolve(["93.184.216.34"]);

  // pinnedFetch captures what the adapter passes as the pinned address. A
  // distinct "attacker resolver" (resolver-2) that would return an internal
  // address at connect time MUST NOT influence the address we pin to.
  let pinnedAt: string[] | undefined;
  const attackerWouldReturn = ["169.254.169.254"];
  const pinnedFetch: PinnedFetch = (_url, _init, addresses) => {
    pinnedAt = addresses;
    return Promise.resolve(
      new Response("<html><body>pinned ok</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
  };

  const adapter = new WebFetchAdapter({
    resolveHostAddresses: validatorResolver,
    pinnedFetch,
  });
  const result = await adapter.scrape({ url: "https://rebind-target.example/" });
  expect(pinnedAt).toEqual(["93.184.216.34"]);
  expect(pinnedAt).not.toEqual(attackerWouldReturn);
  expect(result.markdown).toContain("pinned ok");
});

it("rejects when resolver-1 and resolver-2 (rebind) disagree by surfacing any internal address", async () => {
  // If the validating resolver itself sees an internal address mixed in with a
  // public one (the rebinding window straddles validation), the adapter blocks
  // before any pinnedFetch call is issued.
  let pinnedFetchCalls = 0;
  const adapter = new WebFetchAdapter({
    resolveHostAddresses: () => Promise.resolve(["93.184.216.34", "169.254.169.254"]),
    pinnedFetch: (): Promise<Response> => {
      pinnedFetchCalls += 1;
      return Promise.resolve(new Response("never", { status: 200 }));
    },
  });

  await expectRejectsToMatch(
    adapter.scrape({ url: "https://straddle.example/" }),
    /resolved internal host blocked/i,
  );
  expect(pinnedFetchCalls).toBe(0);
});

it("createResearchAdapter wires allowedDomains into webfetch adapter", async () => {
  const adapter = createResearchAdapter({
    provider: "webfetch",
    allowedDomains: ["example.com"],
  });
  await expectRejectsToMatch(adapter.scrape({ url: "https://evil.com/" }), /domain not allowed/i);
  await expectRejectsToMatch(
    adapter.scrape({ url: "http://169.254.169.254/" }),
    /internal host blocked/i,
  );
});

it("rejects malformed URLs", async () => {
  const adapter = new WebFetchAdapter();
  await expectRejectsToMatch(adapter.scrape({ url: "not a url" }), /invalid URL/i);
});

it("blocks redirect target on internal/metadata host", async () => {
  const pinnedFetch: PinnedFetch = (url) => {
    if (url.startsWith("https://example.com")) {
      return Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data/" },
        }),
      );
    }
    return Promise.resolve(new Response("ok", { status: 200 }));
  };

  const adapter = new WebFetchAdapter({
    resolveHostAddresses: () => Promise.resolve(["93.184.216.34"]),
    pinnedFetch,
  });
  await expectRejectsToMatch(
    adapter.scrape({ url: "https://example.com/redir" }),
    /internal host blocked/i,
  );
});

it("blocks redirect target outside allowlist", async () => {
  const pinnedFetch: PinnedFetch = (url) => {
    if (url.startsWith("https://example.com")) {
      return Promise.resolve(
        new Response(null, {
          status: 301,
          headers: { location: "https://evil.com/exfil" },
        }),
      );
    }
    return Promise.resolve(new Response("ok", { status: 200 }));
  };

  const adapter = new WebFetchAdapter({
    allowedDomains: ["example.com"],
    resolveHostAddresses: () => Promise.resolve(["93.184.216.34"]),
    pinnedFetch,
  });
  await expectRejectsToMatch(
    adapter.scrape({ url: "https://example.com/redir" }),
    /domain not allowed/i,
  );
});

it("follows allowed redirects and returns final body", async () => {
  const visited: string[] = [];
  const pinnedFetch: PinnedFetch = (url) => {
    visited.push(url);
    if (url === "https://example.com/a") {
      return Promise.resolve(new Response(null, { status: 302, headers: { location: "/b" } }));
    }
    if (url === "https://example.com/b") {
      return Promise.resolve(
        new Response("<html><body>final</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      );
    }
    return Promise.resolve(new Response("unexpected", { status: 500 }));
  };

  const adapter = new WebFetchAdapter({
    allowedDomains: ["example.com"],
    resolveHostAddresses: () => Promise.resolve(["93.184.216.34"]),
    pinnedFetch,
  });
  const result = await adapter.scrape({ url: "https://example.com/a" });
  expect(visited).toEqual(["https://example.com/a", "https://example.com/b"]);
  expect(result.markdown).toContain("final");
  expect(result.url).toBe("https://example.com/b");
});

it("caps redirect chain length", async () => {
  let count = 0;
  const pinnedFetch: PinnedFetch = () => {
    count++;
    return Promise.resolve(
      new Response(null, {
        status: 302,
        headers: { location: "https://example.com/loop" },
      }),
    );
  };

  const adapter = new WebFetchAdapter({
    allowedDomains: ["example.com"],
    resolveHostAddresses: () => Promise.resolve(["93.184.216.34"]),
    pinnedFetch,
  });
  await expectRejectsToMatch(
    adapter.scrape({ url: "https://example.com/loop" }),
    /too many redirects/i,
  );
  expect(count).toBeLessThanOrEqual(6);
});

it("firecrawl-fallback path blocks redirect to internal host (401 -> webfetch)", async () => {
  // Build the fallback wrapper manually so we can inject pinnedFetch into the
  // inner WebFetchAdapter. createResearchAdapter does not expose that seam
  // (its production caller doesn't need it).
  const stubFirecrawl = {
    search: (): Promise<never> =>
      Promise.reject(Object.assign(new Error("unauthorized"), { status: 401 })),
    scrape: (): Promise<never> =>
      Promise.reject(Object.assign(new Error("unauthorized"), { status: 401 })),
  };

  const pinnedFetch: PinnedFetch = (url) => {
    if (url.startsWith("https://example.com")) {
      return Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data/" },
        }),
      );
    }
    return Promise.resolve(new Response("ok", { status: 200 }));
  };

  const fallback = new WebFetchAdapter({
    allowedDomains: ["example.com"],
    resolveHostAddresses: () => Promise.resolve(["93.184.216.34"]),
    pinnedFetch,
  });
  const primary = new FirecrawlAdapter({ allowedDomains: ["example.com"] }, stubFirecrawl);

  // Re-create the firecrawl-with-fallback wrapper's behaviour: on 401, defer
  // to the webfetch adapter.
  const adapter = {
    scrape: async (args: { url: string }) => {
      try {
        return await primary.scrape(args);
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status === 401) return await fallback.scrape(args);
        throw err;
      }
    },
  };

  await expectRejectsToMatch(
    adapter.scrape({ url: "https://example.com/redir" }),
    /internal host blocked/i,
  );
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
  expect(isInternalOrMetadataHost("::ffff:127.0.0.1")).toBe(true);
  expect(isInternalOrMetadataHost("::ffff:169.254.169.254")).toBe(true);
  expect(isInternalOrMetadataHost("::ffff:10.0.0.5")).toBe(true);
});
