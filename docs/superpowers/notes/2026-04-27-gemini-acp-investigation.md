# Gemini --acp Protocol Investigation

## TL;DR
- **Gemini --acp uses LSP-style framing (Content-Length)**, not line-delimited JSON.
- Current state: The Penumbra `stdio-acp` adapter currently sends raw JSON-RPC messages, which Gemini ignores or treats as malformed, resulting in no response.

## Probe results
### CLI Help
```
--acp                       Starts the agent in ACP mode  [boolean]
--experimental-acp          Starts the agent in ACP mode (deprecated, use --acp instead)  [boolean]
```

### Direct Probing
Running `gemini --acp < /dev/null` yields no output and hangs until killed, suggesting it is waiting for a valid Header-Content framed message on `stdin`.

## Vendor docs (from geminicli.com)
- **Transport:** Standard Input/Output (stdio).
- **Framing:** **Header-Content framing** (identical to Language Server Protocol).
  - Requires `Content-Length: <n>\r\n\r\n` header.
  - Body must be valid JSON-RPC 2.0.
- **Initialization:** Requires `initialize` method call to negotiate capabilities.
- **Reference:** `packages/cli/src/acp/acpClient.ts` (internal source).

## Penumbra fix path
- **File(s) to modify:** `packages/agentchat/src/adapters/stdio-acp.ts`
- **Specific changes:** 
  - Wrap outgoing JSON-RPC messages with `Content-Length` headers.
  - Implement a stateful parser for incoming messages to handle Header-Content framing (accumulate bytes until `Content-Length` is satisfied).
- **LoC estimate:** ~40-60 lines for the framing logic.
- **Note:** This framing should be toggled based on the vendor kind (`gemini`) to avoid breaking `codex` and `claude` adapters which use line-delimited JSON.
