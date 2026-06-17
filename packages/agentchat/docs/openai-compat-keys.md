# openai-compat-http credentials reference

The `openai-compat-http` adapter accepts four key sources in `agentchat.yaml`. They mirror llamactl's `keychain:` / `env:` / `file:` ref convention so secrets stay out of the YAML in plaintext.

## The four sources

```yaml
options:
  apiKey: nvapi-... # literal — back-compat, fine for trusted on-disk configs
  apiKeyEnv: NVIDIA_API_KEY # process.env lookup
  apiKeyKeychain: llamactl/nvidia # macOS Keychain ref: <service>/<account>
  apiKeyFile: /path/to/key.txt # trimmed file content
```

**Resolution precedence (first non-empty wins):** `apiKey` > `apiKeyEnv` > `apiKeyKeychain` > `apiKeyFile` > empty.

If none is provided the adapter sends an empty `Authorization: Bearer ` header — fine for anonymous endpoints (a dev llama-server on loopback). Cloud endpoints will return 401.

The legacy snake_case alias `api_key_env` is still accepted for back-compat.

## macOS Keychain cookbook (recommended for cloud keys)

Stash a key in the keychain:

```bash
security add-generic-password -U -s llamactl -a nvidia -T '' -w
# (paste the nvapi-... key when prompted; -w with no value reads from stdin)
```

`-U` overwrites if the entry exists (idempotent re-runs). `-T ''` restricts ACL so only apps that explicitly request access can read it — first read prompts you to "Always Allow" the bun binary.

Reference it from `agentchat.yaml`:

```yaml
- name: nv-qwen3-coder-480b
  adapter: openai-compat-http
  options:
    baseUrl: https://integrate.api.nvidia.com/v1
    apiKeyKeychain: llamactl/nvidia
    model: qwen/qwen3-coder-480b-a35b-instruct
    maxTokens: 1024
```

Verify the key resolves:

```bash
security find-generic-password -s llamactl -a nvidia -w
```

Outputs the value (with another keychain prompt the first time). To rotate, re-run `add-generic-password -U` with the new value.

## Env var pattern

When a key is already in env (e.g. CI, dotfile-managed):

```yaml
options:
  baseUrl: https://api.openai.com/v1
  apiKeyEnv: OPENAI_API_KEY
  model: gpt-4o-mini
```

The bin throws if `process.env.OPENAI_API_KEY` is unset/empty — the error names the var so misconfigs are obvious.

## File pattern

```yaml
options:
  apiKeyFile: /path/to/secret.key
```

The file's full content is read and trimmed (handles trailing newlines from text editors). No additional escaping or format requirement.

## Anonymous endpoints

For dev llama-server on loopback (no auth):

```yaml
- name: local-gemma26
  adapter: openai-compat-http
  options:
    baseUrl: http://127.0.0.1:8080/v1
    apiKey: local-no-auth
    model: local
```

Or simply omit all four key sources — the adapter sends an empty `Authorization` header which anonymous endpoints ignore. The literal `local-no-auth` is purely cosmetic; it documents intent.

## Concrete entries already in agentchat.yaml

- `planner` / `executor` (mac-mini gemma) — literal `apiKey` (LAN-private endpoint, low risk).
- `local-gemma26` — anonymous (`apiKey: local-no-auth`).
- `nv-llama4-maverick` / `nv-qwen3-coder-480b` / etc. — `apiKeyKeychain: llamactl/nvidia`.
- `local-qwen36-35b-moe` — anonymous, but wired with `extraBody.chat_template_kwargs.enable_thinking: false` to suppress qwen's thinking mode.
