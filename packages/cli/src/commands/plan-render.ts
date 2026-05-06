export interface PlanRenderInput {
  plan: {
    plan_id: string;
    file_path?: string;
    home_project: string;
    status: string;
    registered_at?: number;
  };
  tasks: Array<{
    task_meta_id: string;
    project_id: string;
    task_id_in_board: string | null;
    status: string;
  }>;
}

export function renderPlanTree(input: PlanRenderInput): string {
  const lines: string[] = [];
  lines.push(`plan ${input.plan.plan_id} (status: ${input.plan.status})`);
  for (const task of [...input.tasks].sort((a, b) => a.task_meta_id.localeCompare(b.task_meta_id))) {
    lines.push(`  [${task.status}] ${task.task_meta_id} · project=${task.project_id} · board=${task.task_id_in_board ?? '-'}`);
  }
  return lines.join('\n');
}
