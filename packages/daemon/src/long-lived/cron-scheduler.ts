import { Cron } from 'croner';

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

type JobRecord = ScheduledJob & { cb: () => void; job: Cron };

export function createCronScheduler(): CronScheduler {
  const jobs = new Map<string, JobRecord>();
  let nextId = 0;

  return {
    register(schedule: string, cb: () => void): string {
      const id = `cron-${++nextId}`;
      const job = new Cron(schedule, cb);
      jobs.set(id, { id, schedule, cb, job });
      return id;
    },
    cancel(id: string): boolean {
      const job = jobs.get(id);
      if (!job) return false;
      job.job.stop();
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
