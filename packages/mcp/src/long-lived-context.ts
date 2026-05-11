export interface LongLivedRuntimeContext {
  running_agent_id?: string;
  running_tick_id?: string;
}

let runtimeContext: LongLivedRuntimeContext = {};

function clean(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function setLongLivedRuntimeContextFromEnv(env: NodeJS.ProcessEnv = process.env): void {
  runtimeContext = {
    running_agent_id: clean(env.PENUMBRA_LONG_LIVED_AGENT_ID),
    running_tick_id: clean(env.PENUMBRA_LONG_LIVED_TICK_ID),
  };
}

export function getLongLivedRuntimeContext(): LongLivedRuntimeContext {
  return runtimeContext;
}
