import type { Database } from 'bun:sqlite';
import type { AgentDescriptor } from './eligibility.js';
import type { FileTaskInput } from './schema.js';

export class OrchestrateRequiresAllowAgents extends Error {
  constructor() {
    super('kind=orchestrate requires non-empty eligibility.allow_agents');
    this.name = 'OrchestrateRequiresAllowAgents';
  }
}

export class OrchestrateAgentNotMaestroCapable extends Error {
  constructor(
    public readonly agent_name: string,
    public readonly reason: 'unknown' | 'not_maestro_capable',
  ) {
    super(`orchestrate allow agent ${agent_name} is not maestro capable: ${reason}`);
    this.name = 'OrchestrateAgentNotMaestroCapable';
  }
}

export class OrchestrateRecursionForbidden extends Error {
  constructor(public readonly parent_task_id: string) {
    super(`orchestrate task ${parent_task_id} cannot file another orchestrate task`);
    this.name = 'OrchestrateRecursionForbidden';
  }
}

export function validateOrchestrateFile(
  db: Database,
  input: FileTaskInput,
  opts: { resolveAgent: (name: string) => AgentDescriptor | undefined },
): void {
  if (input.kind !== 'orchestrate') return;

  const allowAgents = input.eligibility?.allow_agents;
  if (!allowAgents || allowAgents.length === 0) {
    throw new OrchestrateRequiresAllowAgents();
  }

  for (const name of allowAgents) {
    const descriptor = opts.resolveAgent(name);
    if (descriptor === undefined) {
      throw new OrchestrateAgentNotMaestroCapable(name, 'unknown');
    }
    if (descriptor.maestro_capable !== true) {
      throw new OrchestrateAgentNotMaestroCapable(name, 'not_maestro_capable');
    }
  }

  if (input.parent_task_id) {
    const parent = db
      .query<{ kind: string }, [string]>(`SELECT kind FROM tasks WHERE id = ?`)
      .get(input.parent_task_id);
    if (parent?.kind === 'orchestrate') {
      throw new OrchestrateRecursionForbidden(input.parent_task_id);
    }
  }
}
