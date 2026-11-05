import { beforeAll, expect, test } from "bun:test";

interface Sanitizer {
  sanitizeString(value: string): string;
  sanitizeValue<T>(value: T): T;
  remaps(): ReadonlyMap<string, string>;
}

interface SanitizeModule {
  createSanitizer(): Sanitizer;
  isSanitized(value: unknown): boolean;
}

const MOD_URL = new URL("./sanitize.ts", import.meta.url).href;

let mod: SanitizeModule | null = null;

beforeAll(async () => {
  mod = (await import(MOD_URL).catch(() => null)) as SanitizeModule | null;
});

function api(): SanitizeModule {
  expect(mod).not.toBeNull();
  return mod!;
}

test("sanitizeString rewrites /Users home paths", () => {
  const out = api().createSanitizer().sanitizeString("open /Users/alice/projects/app/src/x.ts");
  expect(out).toBe("open /home/user/projects/app/src/x.ts");
});

test("sanitizeString rewrites /Volumes mounts", () => {
  const out = api().createSanitizer().sanitizeString("/Volumes/Scratch/repos/app");
  expect(out).toBe("/mnt/volume/repos/app");
});

test("sanitizeString rewrites non-example.com email domains only", () => {
  const out = api()
    .createSanitizer()
    .sanitizeString("mail alice@acme-corp.test and bob@example.com");
  expect(out).toBe("mail user@example.com and bob@example.com");
});

test("private hosts map to stable per-instance tokens in first-seen order", () => {
  const inst = api().createSanitizer();
  expect(inst.sanitizeString("ssh build-box.local then nas.lan then build-box.local")).toBe(
    "ssh h-001 then h-002 then h-001",
  );
  expect(inst.sanitizeString("build-box.local")).toBe("h-001");
  expect(inst.remaps().get("build-box.local")).toBe("h-001");
});

test("private IPv4 ranges map to tokens while public and loopback stay", () => {
  const inst = api().createSanitizer();
  expect(inst.sanitizeString("ping 192.168.1.20 and 10.0.0.7 and 172.20.3.4")).toBe(
    "ping h-001 and h-002 and h-003",
  );
  expect(inst.sanitizeString("127.0.0.1 8.8.8.8 172.32.0.1")).toBe("127.0.0.1 8.8.8.8 172.32.0.1");
});

test("privacy tags are stripped", () => {
  const out = api().createSanitizer().sanitizeString("a <private>plan</private> b");
  expect(out).toBe("a  b");
});

test("static secret rules redact known key paths", () => {
  const out = api().createSanitizer().sanitizeString("cat ~/.ssh/id_ed25519");
  expect(out).toContain("[REDACTED:ssh-key-path]");
});

test("sanitizeValue redacts secret-named keys and deep-sanitizes strings", () => {
  const inst = api().createSanitizer();
  const out = inst.sanitizeValue({
    api_key: "k",
    nested: { path: "/Users/alice/x", host: "nas.lan" },
  });
  expect(out).toEqual({
    api_key: "[REDACTED]",
    nested: { path: "/home/user/x", host: "h-001" },
  });
});

test("sanitization is idempotent across string and value passes", () => {
  const inst = api().createSanitizer();
  const planted = [
    "open /Users/alice/projects/app/src/x.ts",
    "/Volumes/Scratch/repos/app",
    "mail alice@acme-corp.test and bob@example.com",
    "ssh build-box.local then nas.lan then build-box.local",
    "ping 192.168.1.20 and 10.0.0.7 and 172.20.3.4",
    "a <private>plan</private> b",
    "cat ~/.ssh/id_ed25519",
  ].join("\n");
  const out = inst.sanitizeString(planted);
  const remapsAfterString = inst.remaps().size;
  expect(inst.sanitizeString(out)).toBe(out);
  expect(api().createSanitizer().sanitizeString(out)).toBe(out);
  expect(inst.remaps().size).toBe(remapsAfterString);
  expect(api().isSanitized(out)).toBe(true);

  const value = { api_key: "k", nested: { path: "/Users/alice/x", host: "nas.lan" } };
  const sanitized = inst.sanitizeValue(value);
  const remapsAfterValue = inst.remaps().size;
  expect(inst.sanitizeValue(sanitized)).toEqual(sanitized);
  expect(api().createSanitizer().sanitizeValue(sanitized)).toEqual(sanitized);
  expect(inst.remaps().size).toBe(remapsAfterValue);
});

test("isSanitized reports whether a value still carries private data", () => {
  const m = api();
  expect(m.isSanitized({ a: "/Users/alice" })).toBe(false);
  expect(m.isSanitized({ a: "plain text", b: ["h-001"] })).toBe(true);
});
