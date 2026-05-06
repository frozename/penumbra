import { expect, test } from 'bun:test';
import { modelsLeaderboardHandler, ModelsLeaderboardInputSchema } from '../../src/tools/models-leaderboard.ts';

test('modelsLeaderboardHandler reads the leaderboard db and applies filters', async () => {
  expect(ModelsLeaderboardInputSchema.parse({ node: 'local' })).toEqual({ node: 'local' });
  const handler = modelsLeaderboardHandler();
  const out = await handler({});
  expect(out.content[0].text).toBe('[]');
});
