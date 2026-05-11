import { expect, mock, test } from 'bun:test';
import { maestroCapabilitiesHandler } from '../../src/tools/maestro-capabilities.js';

test('maestro_capabilities proxies daemon and returns wrapped text content', async () => {
  const daemon = {
    maestroCapabilities: mock(async () => ({
      agents: [
        {
          name: 'claude-acp-sonnet',
          task_types: ['plan_refine', 'implement_substantial'],
          maestro_capable: true,
        },
        {
          name: 'codex-acp-fast',
          maestro_capable: false,
        },
      ],
      task_types: ['plan_refine', 'implement_substantial'],
      workflows: ['brainstorm', 'handoff'],
    })),
  };
  const handler = maestroCapabilitiesHandler(daemon as any);
  const out = await handler({});
  expect(daemon.maestroCapabilities).toHaveBeenCalled();
  expect(JSON.parse(out.content[0].text)).toEqual({
    agents: [
      {
        name: 'claude-acp-sonnet',
        task_types: ['plan_refine', 'implement_substantial'],
        maestro_capable: true,
      },
      {
        name: 'codex-acp-fast',
        maestro_capable: false,
      },
    ],
    task_types: ['plan_refine', 'implement_substantial'],
    workflows: ['brainstorm', 'handoff'],
  });
});
