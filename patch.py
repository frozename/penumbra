import re

app_module_path = '/Volumes/WorkSSD/repos/personal/sirius-gateway/apps/sirius-api/src/app.module.ts'
with open(app_module_path, 'r') as f:
    content = f.read()

content = re.sub(r"import \{ PenumbraMiddlewareModule \} from '@penumbra/sirius-middleware';\n", "", content)
content = re.sub(r"\s*// Penumbra observation \(opt-in, disabled when env vars are absent\)\n\s*PenumbraMiddlewareModule,?\n", "\n", content)

with open(app_module_path, 'w') as f:
    f.write(content)

main_ts_path = '/Volumes/WorkSSD/repos/personal/sirius-gateway/apps/sirius-api/src/main.ts'
with open(main_ts_path, 'r') as f:
    content = f.read()

if "penumbraObservePlugin" not in content:
    content = content.replace("import { ProviderRegistry } from '@sirius/core';", "import { ProviderRegistry } from '@sirius/core';\nimport { penumbraObservePlugin } from '@penumbra/sirius-middleware';")
    
    register_code = """
  await app.register(penumbraObservePlugin, {
    baseUrl: process.env.PENUMBRA_DAEMON_URL,
    token: process.env.PENUMBRA_DAEMON_TOKEN,
  });
"""
    content = content.replace("{ bufferLogs: true },\n  );", "{ bufferLogs: true },\n  );\n" + register_code)

with open(main_ts_path, 'w') as f:
    f.write(content)

agents_md_path = '/Volumes/WorkSSD/repos/personal/sirius-gateway/AGENTS.md'
with open(agents_md_path, 'r') as f:
    content = f.read()

old_penumbra_text = """## Penumbra observation (optional)

`apps/sirius-api` registers `@penumbra/sirius-middleware`'s
`PenumbraMiddlewareModule`."""

new_penumbra_text = """## Penumbra observation (optional)

`apps/sirius-api` registers `@penumbra/sirius-middleware`'s
fastify plugin `penumbraObservePlugin`. Verify on startup that the log emits `penumbra middleware disabled` or `penumbra middleware enabled` with the configured baseUrl."""

if old_penumbra_text in content:
    content = content.replace(old_penumbra_text, new_penumbra_text)
else:
    # Let's try another replace approach
    pass

with open(agents_md_path, 'w') as f:
    f.write(content)

print("Patch applied")
