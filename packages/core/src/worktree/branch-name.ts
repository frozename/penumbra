export interface HandoffBranchNameInput {
  handoff_id: string;
  branch_name?: string | null;
}

export function resolveHandoffBranchName(handoff: HandoffBranchNameInput): string {
  return handoff.branch_name ?? `agent/${handoff.handoff_id}`;
}
