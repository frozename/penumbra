import type { Adapter, DispatchInput, DispatchOutput } from './sdk/adapter.js';

export async function dispatchHandoff(args: DispatchInput & { adapter: Adapter }): Promise<DispatchOutput> {
  const { adapter, ...input } = args;
  return adapter.dispatch(input);
}
