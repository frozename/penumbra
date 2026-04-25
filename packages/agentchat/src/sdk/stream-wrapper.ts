// packages/agentchat/src/sdk/stream-wrapper.ts
import type { Adapter, DispatchEvent, DispatchInput } from './adapter.js';

export async function* ensureDispatchStream(
  adapter: Adapter,
  input: DispatchInput,
): AsyncIterable<DispatchEvent> {
  if (adapter.dispatchStream) {
    yield* adapter.dispatchStream(input);
    return;
  }
  const result = await adapter.dispatch(input);
  yield { type: 'delta', text: result.text };
  yield { type: 'done', result };
}
