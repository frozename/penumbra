export class TaskCooldowns {
  private readonly map = new Map<string, Map<string, number>>();

  add(task_id: string, agent_id: string, expires_at: number): void {
    const byAgent = this.map.get(task_id) ?? new Map<string, number>();
    byAgent.set(agent_id, expires_at);
    this.map.set(task_id, byAgent);
  }

  get(): Map<string, Map<string, number>> {
    return this.map;
  }

  prune(now: number): void {
    for (const [taskId, byAgent] of this.map.entries()) {
      for (const [agentId, expiresAt] of byAgent.entries()) {
        if (expiresAt <= now) {
          byAgent.delete(agentId);
        }
      }
      if (byAgent.size === 0) {
        this.map.delete(taskId);
      }
    }
  }
}
