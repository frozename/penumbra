export interface ScheduledJob {
  id: string;
  schedule: string;
}

export interface CronScheduler {
  register(schedule: string, cb: () => void): string;
  cancel(id: string): boolean;
  list(): ScheduledJob[];
  testFire(id: string): void;
}

type JobRecord = ScheduledJob & { cb: () => void };

export function createCronScheduler(): CronScheduler {
  const jobs = new Map<string, JobRecord>();
  let nextId = 0;

  return {
    register(schedule: string, cb: () => void): string {
      const id = `cron-${++nextId}`;
      jobs.set(id, { id, schedule, cb });
      return id;
    },
    cancel(id: string): boolean {
      return jobs.delete(id);
    },
    list(): ScheduledJob[] {
      return Array.from(jobs.values(), ({ id, schedule }) => ({ id, schedule }));
    },
    testFire(id: string): void {
      const job = jobs.get(id);
      if (!job) throw new Error(`Unknown cron job: ${id}`);
      job.cb();
    },
  };
}
