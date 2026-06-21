import { expect } from "bun:test";

type ThrowMatcher =
  | string
  | RegExp
  | Error
  | (new (...args: never[]) => Error)
  | { message?: string | RegExp; name?: string };

// bun-types declares Matchers.toThrow() as returning void even when invoked via
// `expect(promise).rejects.toThrow(...)`, so awaiting the matcher call trips
// await-thenable + no-confusing-void-expression at every call site. Implement
// the same assertion directly here over the awaited promise to keep the test
// surface clean.
export async function expectAsyncThrow(
  promise: Promise<unknown>,
  matcher: ThrowMatcher,
): Promise<void> {
  let caught: unknown;
  let threw = false;
  try {
    await promise;
  } catch (err) {
    threw = true;
    caught = err;
  }
  if (!threw) {
    throw new Error("expected promise to reject, but it resolved");
  }
  const message = caught instanceof Error ? caught.message : String(caught);
  if (matcher instanceof RegExp) {
    expect(message).toMatch(matcher);
    return;
  }
  if (typeof matcher === "string") {
    expect(message).toContain(matcher);
    return;
  }
  if (matcher instanceof Error) {
    expect(message).toBe(matcher.message);
    return;
  }
  if (typeof matcher === "function") {
    expect(caught).toBeInstanceOf(matcher);
    return;
  }
  if (matcher.message !== undefined) {
    if (matcher.message instanceof RegExp) {
      expect(message).toMatch(matcher.message);
    } else {
      expect(message).toContain(matcher.message);
    }
  }
}

// Mocked fetch callbacks receive `string | URL | Request` from typeof fetch;
// calling String() on a Request yields "[object Object]" and trips
// no-base-to-string. This helper narrows the union to a stable URL string.
export function urlToString(url: string | URL | Request): string {
  if (typeof url === "string") return url;
  if (url instanceof URL) return url.toString();
  return url.url;
}

// JSON.parse returns `any`. This helper makes the cast through unknown explicit
// at one place per call site; callers narrow further with property checks or
// `as` casts to typed shapes.
export function parseJson(text: string): unknown {
  return JSON.parse(text);
}
