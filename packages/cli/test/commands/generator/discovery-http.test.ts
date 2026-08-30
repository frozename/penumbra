import {
  DEFAULT_HTTP_PROVIDER_SPECS,
  discoverHttpModels,
} from "@src/commands/generator/discovery-http.js";
import { describe, expect, test } from "bun:test";

describe("HTTP model discovery", () => {
  test("discoverHttpModels resolves a keychain bearer token and fetches /v1/models", async () => {
    let resolvedAccount: string | undefined;

    const result = await discoverHttpModels({
      provider: DEFAULT_HTTP_PROVIDER_SPECS[0],
      resolveKeychain: (account) => {
        resolvedAccount = account;
        return "resolved-sakana-token";
      },
      fetch: (input, init) => {
        expect(input).toBe("https://api.sakana.ai/v1/models");
        expect(new Headers(init?.headers).get("Authorization")).toBe(
          "Bearer resolved-sakana-token",
        );
        return Response.json({
          data: [{ id: "fugu-base", display_name: "Fugu Base" }],
        });
      },
    });

    expect(resolvedAccount).toBe("llamactl/sakana");
    expect(result).toEqual({
      outcome: "discovered",
      providerId: "sakana",
      models: [
        {
          sourceProviderId: "sakana",
          modelId: "fugu-base",
          displayName: "Fugu Base",
        },
      ],
    });
  });

  test("a 401 response produces a legible skip, not a crash", async () => {
    const result = await discoverHttpModels({
      provider: DEFAULT_HTTP_PROVIDER_SPECS[1],
      resolveKeychain: () => "resolved-deepseek-token",
      fetch: () =>
        new Response(JSON.stringify({ error: "invalid token" }), {
          status: 401,
          statusText: "Unauthorized",
        }),
    });

    expect(result).toEqual({
      outcome: "skipped",
      providerId: "deepseek",
      status: 401,
      reason: "deepseek model discovery skipped: HTTP 401 Unauthorized",
    });
    expect("models" in result).toBe(false);
  });
});
