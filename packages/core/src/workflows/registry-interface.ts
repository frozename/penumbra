export type RegistryError = { path: string; error: string };

export type RegistryEntry<Spec = unknown> = {
  spec: Spec;
  source: 'markdown' | 'ts';
  path: string;
  fn?: (ctx: unknown, recall: unknown) => Promise<unknown>;
};

export interface WorkflowRegistry<Spec = unknown, TriggerEvent = unknown> {
  list(): Spec[];
  entries(): RegistryEntry<Spec>[];
  get(name: string): Spec | undefined;
  getEntry(name: string): RegistryEntry<Spec> | undefined;
  findByTrigger(event: TriggerEvent): Spec[];
  errors: RegistryError[];
}

export type BuildRegistryOpts = {
  playbooksDir: string;
  workflowsDir: string;
};
