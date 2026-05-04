# Upstream patch: gemini-cli ACP ENOENT detection

**Status:** ready to submit. We applied a workaround on our side (commit 38f4ad1) that formats our `fs/read_text_file` errors to include the literal `ENOENT` substring so gemini's matcher catches them. The proper upstream fix is below.

**Repo:** https://github.com/google-gemini/gemini-cli
**File:** `packages/cli/src/acp/acpFileSystemService.ts`

## Problem

`AcpFileSystemService.normalizeFileSystemError` classifies a read failure as
file-not-found by string-matching the error message:

```ts
if (errorMessage.includes('Resource not found') ||
    errorMessage.includes('ENOENT') ||
    errorMessage.includes('does not exist') ||
    errorMessage.includes('No such file')) {
  // map to ENOENT
}
throw err; // anything else is propagated as a generic write-blocking error
```

JSON-RPC error responses also carry a structured `code` field, but this matcher
only looks at `message`. Any ACP server that throws errors using natural
phrasing other than these four substrings (e.g. `not_found`, `file_missing`,
or a localised message) is treated as a generic IO failure.

The downstream effect is severe: the `write-file` tool calls `readTextFile`
first to check existence; a "generic IO failure" return short-circuits the
write attempt. The agent's reasoning loop then sees the failure but commonly
hallucinates "the tool probably succeeded" and reports success in the
final `stop_reason: end_turn` response — a silent failure pattern.

## Patch

Add structured error-code recognition. ACP errors come from
`@agentclientprotocol/sdk` and carry a JSON-RPC `code`. Use `-32001`
(`outside_worktree`) and `-32002` (`not_a_file`) per the ACP spec, plus a
new `-32014` for not-found.

```ts
private normalizeFileSystemError(err: unknown): never {
  // Structured JSON-RPC error code is the authoritative signal.
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    // ACP-spec-aligned error code for "file not found":
    if (code === -32014 || code === 'ENOENT') {
      const newErr = new Error(
        err instanceof Error ? err.message : String(err),
      ) as NodeJS.ErrnoException;
      newErr.code = 'ENOENT';
      throw newErr;
    }
  }

  // Fallback: legacy substring match for servers that haven't migrated to
  // structured error codes yet.
  const errorMessage = err instanceof Error ? err.message : String(err);
  if (
    errorMessage.includes('Resource not found') ||
    errorMessage.includes('ENOENT') ||
    errorMessage.includes('does not exist') ||
    errorMessage.includes('No such file') ||
    errorMessage.includes('not_found') ||         // newly added
    errorMessage.includes('file not found')       // newly added
  ) {
    const newErr = new Error(errorMessage) as NodeJS.ErrnoException;
    newErr.code = 'ENOENT';
    throw newErr;
  }
  throw err;
}
```

## Tests to add

In `packages/cli/src/acp/acpFileSystemService.test.ts`:

```ts
test('normalizes structured -32014 error code as ENOENT', async () => {
  // mock a connection that throws { code: -32014, message: 'whatever' }
  // expect readTextFile to throw an ENOENT-coded error
});

test('normalizes "not_found" / "file not found" message variants as ENOENT', async () => {
  // legacy substring fallback for the snake_case phrasing
});
```

## Why this matters

Both `not_found` (snake_case) and `file not found` are common error phrasings
in JSON-RPC servers in the wild — they don't match `'No such file'` or
`'does not exist'` exactly. Aligning the matcher with structured codes (and
relaxing the legacy substring set) makes ACP file-system error handling
robust across server implementations.

## How we got here

Found while investigating a silent-failure pattern in penumbra's stdio-acp
adapter where every gemini-cli `write_file` call appeared to succeed but
produced no file changes. Traced the agent's tool failure to this string
match: our adapter threw `'fs/read_text_file not_found: file not found:
<path>'` for non-existent files, and gemini's matcher missed it. Documented
in penumbra's `project_acp_failure_modes.md` memory.

We applied the workaround on our side by reformatting our adapter's error
to include `'ENOENT: No such file or directory:'` (penumbra commit
`38f4ad1`). That's purely a string format change and doesn't fix the
matcher's narrow recognition, hence this upstream patch.
